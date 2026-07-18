import type { PendingMerge, ServerFleetMessage, SessionListItem } from "@loom/shared";
import type { WebSocket } from "ws";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";

/** Debounce window between a session becoming dirty and its coalesced delta going out — long enough to
 *  fold a burst of rapid mutations on one id into a single broadcast (see `markSessionDirty`). */
const DIRTY_FLUSH_MS = 200;

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

  /** Drop a socket (on close) — idempotent, a no-op if already removed. */
  remove(socket: WebSocket): void {
    this.sockets.delete(socket);
  }

  /** Record (or update) this socket's subscription to a manager's event stream. Bookkeeping only in this
   *  card — `sinceSeq` is stored for a later card's replay logic (C7), not consumed here. A socket not
   *  currently registered (e.g. a race with `remove`) is a silent no-op. */
  subscribeEvents(socket: WebSocket, managerId: string, sinceSeq: number): void {
    this.sockets.get(socket)?.set(managerId, sinceSeq);
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
        const pm = this.sessions.peekPendingMerge(id);
        // pm.outcome is PendingOpOutcome (a bare `string`) — narrower-cast to PendingMerge's outcome union,
        // same as the REST /api/sessions handler this mirrors (server.ts's peekPendingMerge projection).
        const pendingMerge: PendingMerge | null = pm
          ? { opId: pm.opId, state: pm.state, startedAt: pm.startedAt, outcome: pm.outcome as PendingMerge["outcome"] }
          : null;
        const session: SessionListItem & { pendingMerge: PendingMerge | null } = { ...row, pendingMerge };
        this.broadcast({ t: "session:upsert", session });
      } catch { /* one dirty id's fault must never break the flush for the rest of the batch */ }
    }
  }

  /** Fan out a message to every connected fleet socket (used by C3/C5). */
  broadcast(msg: ServerFleetMessage): void {
    const data = JSON.stringify(msg);
    for (const socket of this.sockets.keys()) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  /** Fan out a message only to sockets currently subscribed to `managerId`'s events (used by C7). */
  broadcastEvent(managerId: string, msg: ServerFleetMessage): void {
    const data = JSON.stringify(msg);
    for (const [socket, subs] of this.sockets) {
      if (subs.has(managerId) && socket.readyState === socket.OPEN) socket.send(data);
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
