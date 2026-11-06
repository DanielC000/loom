import type { PendingMerge, ServerFleetMessage, SessionListItem } from "@loom/shared";
import type { WebSocket } from "ws";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { WS_CLOSE_TRY_AGAIN_LATER, closeSlowSocket } from "./slow-socket.js";

/** Debounce window between a session becoming dirty and its coalesced delta going out — long enough to
 *  fold a burst of rapid mutations on one id into a single broadcast (see `markSessionDirty`). Exported
 *  so a hermetic test can DERIVE a wait window from this real constant instead of guessing one (card
 *  1addef27 — see test/ws-fleet-session-feed.mjs). */
export const DIRTY_FLUSH_MS = 200;

// @decision d5e3fa82 — do not remove this cap: /ws/fleet takes no credential on loopback, so an uncapped
// per-socket subscription map lets any co-resident process grow it without limit (memory DoS).
export const MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET = 128;

export { WS_CLOSE_TRY_AGAIN_LATER };

/** Unsent-bytes ceiling per /ws/fleet socket (card cfd1fe04). 4 MiB: a gate event's outputTail is ~4 KB and
 *  a full-feed burst is a few hundred KB at most, so a client that is merely slow/busy stays far below it,
 *  while a never-reading loopback client (no credential, d5e3fa82) hits it after ~1000 frames and is closed
 *  rather than pinning unbounded memory. The web client resyncs on reopen, so a close loses nothing.
 *  SOFT bound: the check runs BEFORE the send, so one socket can overshoot by at most one frame (a frame is
 *  far smaller than the ceiling; the true worst case is ceiling + one frame). */
export const MAX_FLEET_SOCKET_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Max concurrent /ws/fleet connections per process (card 1baf6fb6). Worst-case memory is
 *  N × (MAX_FLEET_SOCKET_BUFFERED_BYTES + one frame) plus slow sockets still inside their terminate grace
 *  window, so N is bounded: 64 × 4 MiB = 256 MiB worst case. 64 is far above real use (one socket per
 *  tab/device/remote client: a heavy user has a handful) while stopping a loopback process (no credential)
 *  opening sockets without limit. Independent of MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET, which bounds one
 *  socket's subscription map; the two multiply to at most 64 × 128 map entries. Slow sockets leave the
 *  registry (and so stop counting) the moment they are closed for being slow. A constant, not config. */
export const MAX_FLEET_CONNECTIONS = 64;

/**
 * C2/C3 of the WS delta-push umbrella (1efde4ba) — the registry backing `/ws/fleet`. Holds every connected
 * fleet socket (one per client/tab, NOT per session — contrast `/ws/term`'s per-sessionId subscribe) and,
 * per socket, the set of manager ids it has subscribed to for orchestration events. C3 adds the session
 * change-feed: `markSessionDirty` is the sink `Db.sessionChangeListener` is wired to, so every sessions-
 * table mutation resolves (after a short coalescing debounce) into a `session:upsert`/`session:remove`
 * delta.
 *
 * `broadcastEvent` stays unused until C7 streams orchestration events through it.
 */
export class FleetHub {
  private readonly sockets = new Map<WebSocket, Map<string, number>>();
  /** Cancel handles for slow sockets awaiting terminate(); cleared by `remove` (the route's close handler). */
  private readonly terminateTimers = new Map<WebSocket, () => void>();
  private readonly dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private db?: Db;
  private sessions?: SessionService;

  /**
   * Wire the DB/SessionService reads `markSessionDirty` needs to resolve a dirty id into a delta. Called
   * once from `buildServer` regardless of whether this hub was freshly constructed or test-injected (a
   * plain `new FleetHub()` has neither until this runs) — `markSessionDirty` is a no-op on an unattached
   * hub's flush (see below), so a hub that's never attached (e.g. a test that only exercises C2's
   * sub/unsub surface) stays exactly as inert as before this card.
   */
  attach(db: Db, sessions: SessionService): void {
    this.db = db;
    this.sessions = sessions;
  }

  /** Register a newly-connected fleet socket with no subscriptions yet. */
  add(socket: WebSocket): void {
    this.sockets.set(socket, new Map());
  }

  /** True when the process is at `MAX_FLEET_CONNECTIONS`; the route refuses a new socket instead of `add`ing. */
  get full(): boolean {
    return this.sockets.size >= MAX_FLEET_CONNECTIONS;
  }

  /** Drop a socket (on close) — idempotent, a no-op if already removed. Also cancels that socket's pending
   *  terminate-after-grace timer, so no timer outlives the socket. */
  remove(socket: WebSocket): void {
    this.sockets.delete(socket);
    const cancel = this.terminateTimers.get(socket);
    if (cancel) { this.terminateTimers.delete(socket); cancel(); }
  }

  /** Record (or update) this socket's subscription to a manager's event stream. Bookkeeping only in this
   *  card — `sinceSeq` is stored for a later card's replay logic (C7), not consumed here. A socket not
   *  currently registered (e.g. a race with `remove`) is a silent no-op. Updating an EXISTING subscription
   *  (same managerId, new sinceSeq) never grows the map, so it's always allowed; a NEW managerId past
   *  `MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET` is silently dropped (card d5e3fa82) rather than accepted — no
   *  real fleet client needs more managers than that on one socket, and the alternative (closing the
   *  socket) would take out every OTHER already-subscribed manager's feed on that same connection too. */
  subscribeEvents(socket: WebSocket, managerId: string, sinceSeq: number): void {
    const subs = this.sockets.get(socket);
    if (!subs) return;
    if (!subs.has(managerId) && subs.size >= MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET) return;
    subs.set(managerId, sinceSeq);
  }

  /** Clear this socket's subscription to a manager's event stream. Silent no-op if not subscribed. */
  unsubscribeEvents(socket: WebSocket, managerId: string): void {
    this.sockets.get(socket)?.delete(managerId);
  }

  /**
   * Mark a session dirty — called from `Db.sessionChangeListener` on every sessions-table mutation.
   * EARLY-OUT: with no fleet socket connected, this is a pure no-op (no accumulation, no point-read, no
   * broadcast later) — the change-feed stays inert until a client connects (C4), per the event-loop
   * discipline every other opt-in capability in this codebase follows (no work when nobody's listening).
   * Otherwise the id is added to the dirty set and a single debounce timer (shared across every dirty id)
   * is armed if one isn't already running — so N rapid mutations of the same id, or of several different
   * ids, within the debounce window collapse into ONE flush and one delta per id.
   */
  markSessionDirty(id: string): void {
    if (this.sockets.size === 0) return;
    this.dirty.add(id);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushDirty(), DIRTY_FLUSH_MS);
    this.flushTimer.unref?.();
  }

  /** Resolve every currently-dirty id into a delta and broadcast it. Re-checks `size === 0` at fire time
   *  too (not just at `markSessionDirty` time) — the last socket may have disconnected while this was
   *  debouncing, and a delta nobody will receive is exactly the wasted work the early-out exists to avoid.
   *  Best-effort per id, like `Db.notifySessionChanged`: a read/broadcast fault for one dirty id (e.g. a
   *  DB read racing a shutdown-time close) must never abort the flush for every OTHER dirty id in this
   *  batch, and must never throw out of a bare `setTimeout` tick (an unhandled exception there). */
  private flushDirty(): void {
    this.flushTimer = null;
    const ids = [...this.dirty];
    this.dirty.clear();
    if (ids.length === 0 || this.sockets.size === 0 || !this.db || !this.sessions) return;
    for (const id of ids) {
      try {
        const row = this.db.getSessionListItemById(id);
        if (!row) {
          this.broadcast({ t: "session:remove", id });
          continue;
        }
        const pm = this.sessions.peekPendingMerge(row);
        // pm.outcome is PendingOpOutcome (a bare `string`) — narrower-cast to PendingMerge's outcome union,
        // same as the REST /api/sessions handler this mirrors (server.ts's peekPendingMerge projection).
        // gatePhase (card 53ad9ed3) is reused the SAME way — see server.ts's own doc for the full reading
        // guide — so this live WS push never drifts from what a fresh REST poll of the same session would
        // show.
        const gatePhase = pm && pm.state === "running" ? this.sessions.gatePhaseForOpId(pm.opId) : undefined;
        const pendingMerge: PendingMerge | null = pm
          ? { opId: pm.opId, state: pm.state, startedAt: pm.startedAt, outcome: pm.outcome as PendingMerge["outcome"], gatePhase, predecessorSessionId: pm.predecessorSessionId }
          : null;
        const session: SessionListItem & { pendingMerge: PendingMerge | null } = { ...row, pendingMerge };
        this.broadcast({ t: "session:upsert", session });
      } catch { /* one dirty id's fault must never break the flush for the rest of the batch */ }
    }
  }

  /** The ONE send path for every fleet frame. A socket whose unsent backlog (`bufferedAmount`) is already
   *  over `MAX_FLEET_SOCKET_BUFFERED_BYTES` is a client that is not reading: it is closed (1013) and dropped
   *  from the registry instead of being sent to, so `ws` can't buffer frames in daemon memory without
   *  bound. Never throws (a send/close fault on one socket must not skip the rest of a fan-out). */
  private deliver(socket: WebSocket, data: string): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      if (socket.bufferedAmount > MAX_FLEET_SOCKET_BUFFERED_BYTES) {
        this.sockets.delete(socket);
        // Deliberately logs counts only — never frame content.
        console.warn(`[fleet] closing slow /ws/fleet client: bufferedAmount=${socket.bufferedAmount} > ${MAX_FLEET_SOCKET_BUFFERED_BYTES}`);
        // close(1013) then terminate() after a grace: ws queues the close frame behind the backlog, so a
        // non-reading client would otherwise keep ~MAX bytes pinned until closeTimeout (30 s).
        this.terminateTimers.set(socket, closeSlowSocket(socket, "slow consumer"));
        return;
      }
      socket.send(data);
    } catch { /* one socket's fault must never break the fan-out for the others */ }
  }

  /** Fan out a message to every connected fleet socket (used by C3/C5). */
  broadcast(msg: ServerFleetMessage): void {
    const data = JSON.stringify(msg);
    for (const socket of [...this.sockets.keys()]) this.deliver(socket, data);
  }

  /** Fan out a message only to sockets currently subscribed to `managerId`'s events (used by C7). */
  broadcastEvent(managerId: string, msg: ServerFleetMessage): void {
    const data = JSON.stringify(msg);
    for (const [socket, subs] of [...this.sockets]) {
      if (subs.has(managerId)) this.deliver(socket, data);
    }
  }

  /** Test/introspection seam: this socket's current subscriptions (managerId → sinceSeq), or `undefined`
   *  if the socket isn't registered. */
  subscriptionsFor(socket: WebSocket): ReadonlyMap<string, number> | undefined {
    return this.sockets.get(socket);
  }

  /** Count of currently-connected fleet sockets. */
  get size(): number {
    return this.sockets.size;
  }
}
