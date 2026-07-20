import { randomUUID } from "node:crypto";

/**
 * Externally-visible projection of a cap-rejected worker_spawn intent — surfaced read-only via
 * worker_list's cap-queued placeholder row (see fleetView in mcp/orchestration.ts).
 */
export interface CapQueuedSpawn {
  opId: string;
  managerSessionId: string;
  agentId: string;
  taskId: string | null;
  kickoffLabel: string;
  queuedAt: string;
}

/** 30 min — a stale intent is reaped lazily (checked on every read/write, no separate timer), never surfaced forever. Exported for tests. */
export const CAP_QUEUE_TTL_MS = 30 * 60_000;
/** Hard bound — oldest entry evicted on overflow, so a runaway retry loop can't grow this unboundedly. Exported for tests. */
export const CAP_QUEUE_MAX = 200;
const KICKOFF_LABEL_MAX = 120;

/**
 * INTERNAL storage shape — a {@link CapQueuedSpawn} plus the FULL, untruncated kickoff prompt needed to
 * actually re-drive the spawn (`kickoffLabel` is a 120-char DISPLAY-ONLY projection of it). Never handed
 * back from `record()`/`listByManager()` (those return the public `CapQueuedSpawn` shape, so a cap-reject
 * error or a worker_list placeholder row never balloons with the full prompt text) — only
 * {@link CapQueueRegistry.takeOldest} returns it, for the daemon's own auto-drain to replay the spawn with.
 */
interface CapQueueEntry extends CapQueuedSpawn {
  kickoffPrompt: string;
}

function toPublic(e: CapQueueEntry): CapQueuedSpawn {
  const { opId, managerSessionId, agentId, taskId, kickoffLabel, queuedAt } = e;
  return { opId, managerSessionId, agentId, taskId, kickoffLabel, queuedAt };
}

/**
 * BOUNDED, daemon-local, in-memory record of worker_spawn calls REJECTED purely because
 * `maxConcurrentWorkers` was at capacity. Before this, a cap-reject returned a bare `{error}` and
 * recorded NOTHING durable — the caller had to remember to re-spawn, and evidence showed a card sat
 * un-dispatched ~150 turns because a manager forgot. This registry makes the rejected intent VISIBLE
 * (worker_list surfaces a distinct placeholder row) instead of letting it silently disappear.
 *
 * AUTO-DRAIN (card 81b7e346): this registry is the QUEUE OF RECORD, but it never dispatches anything
 * itself — {@link SessionService.maybeDrainCapQueue} owns draining it (FIFO, via {@link takeOldest}) at
 * every point a worker's concurrency slot actually frees, and replays a popped entry through the SAME
 * `spawnWorker` a manual `worker_spawn` call uses (so the atomic per-taskId claim + cap-admit guarantees
 * apply to an auto-fired spawn exactly as they do to a manual one). A manager can still read this via
 * worker_list and re-drive an entry by hand if it wants to — that path is unchanged — but it no longer
 * has to: the common case (a slot frees) now dispatches on its own.
 *
 * KEYING: a tasked spawn is keyed by `taskId`, so a later successful spawn for the SAME taskId clears
 * the marker (the natural "I re-drove it" signal — see {@link CapQueueRegistry.clearForTask}). A
 * taskless spawn has no stable per-call identity to key mutual exclusion off (distinct taskless spawns
 * must never collide with each other), so it's keyed by `agentId + queuedAt` instead and reaped purely
 * by TTL/overflow, or cleared in bulk on the next successful TASKLESS spawn by that same agentId (see
 * {@link CapQueueRegistry.clearTasklessForAgent}) — mirrors spawnWorker's own tasked-vs-taskless claim-key
 * split (see sessions/service.ts's `claimKey`).
 */
export class CapQueueRegistry {
  private readonly entries = new Map<string, CapQueueEntry>();

  /** `now` is injectable — real `Date.now` in prod, a fake clock in tests (so TTL reap is testable
   *  without a real 30-minute wait). Defaults to `Date.now`, so every existing/production construction
   *  (`new CapQueueRegistry()`) is byte-identical. */
  constructor(private readonly now: () => number = Date.now) {}

  private prune(nowMs: number): void {
    for (const [key, e] of this.entries) {
      if (nowMs - Date.parse(e.queuedAt) >= CAP_QUEUE_TTL_MS) this.entries.delete(key);
    }
  }

  /** Record a cap-rejected spawn intent. Returns the PUBLIC projection (opId + kickoffLabel + queuedAt —
   *  never the full kickoffPrompt) so the caller can echo it back on the enriched cap-reject error. */
  record(managerSessionId: string, agentId: string, taskId: string | null, kickoffPrompt: string): CapQueuedSpawn {
    const nowMs = this.now();
    this.prune(nowMs);
    if (this.entries.size >= CAP_QUEUE_MAX) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    const queuedAt = new Date(nowMs).toISOString();
    const key = taskId ?? `taskless:${agentId}:${queuedAt}:${randomUUID()}`;
    const entry: CapQueueEntry = {
      opId: randomUUID(),
      managerSessionId,
      agentId,
      taskId,
      kickoffLabel: kickoffPrompt.length > KICKOFF_LABEL_MAX ? `${kickoffPrompt.slice(0, KICKOFF_LABEL_MAX)}…` : kickoffPrompt,
      kickoffPrompt,
      queuedAt,
    };
    this.entries.set(key, entry);
    return toPublic(entry);
  }

  /** Clear a tasked marker once a spawn actually succeeds for the same taskId — the natural "I re-drove
   *  it" signal. No-op if nothing was ever queued for it (the common case — most spawns never hit the cap). */
  clearForTask(taskId: string): void {
    this.entries.delete(taskId);
  }

  /** Clear every taskless marker for one agentId on this manager once a taskless spawn for that agentId
   *  actually succeeds — a taskless entry has no single stable key to delete directly (see class doc). */
  clearTasklessForAgent(managerSessionId: string, agentId: string): void {
    for (const [key, e] of this.entries) {
      if (e.taskId === null && e.managerSessionId === managerSessionId && e.agentId === agentId) this.entries.delete(key);
    }
  }

  /** Read-only listing of every still-live cap-queued entry for one manager — for worker_list's
   *  cap-queued placeholder rows. Never consumes, never leaks the full kickoffPrompt (public projection only). */
  listByManager(managerSessionId: string): CapQueuedSpawn[] {
    this.prune(this.now());
    return [...this.entries.values()].filter((e) => e.managerSessionId === managerSessionId).map(toPublic);
  }

  /**
   * Pop (remove + return) the OLDEST still-live queued entry for one manager, FIFO by original queue
   * position (the `entries` Map preserves insertion order; `record()` on an already-queued taskId
   * REPLACES in place without moving it, so a re-record never jumps the line). Returns the INTERNAL shape
   * (carries the full `kickoffPrompt`) — for {@link SessionService.maybeDrainCapQueue}'s own replay via
   * `spawnWorker`, never surfaced on any MCP response. `undefined` when this manager has nothing queued.
   */
  takeOldest(managerSessionId: string): CapQueueEntry | undefined {
    this.prune(this.now());
    for (const [key, e] of this.entries) {
      if (e.managerSessionId === managerSessionId) {
        this.entries.delete(key);
        return e;
      }
    }
    return undefined;
  }

  /**
   * Re-insert a previously-`takeOldest`'d entry at the FRONT of the queue (oldest position) — for a drain
   * attempt that hit a TRANSIENT condition (the manager is usage-limited) rather than a genuine failure of
   * this entry, so it must not lose its place or be dropped. Rebuilds the Map with `entry` first, then the
   * rest in their existing order (O(queue size), bounded by CAP_QUEUE_MAX) — Map has no cheaper
   * "reinsert at front" primitive. Keyed the same way `record()` would key it.
   */
  requeueFront(entry: CapQueueEntry): void {
    const key = entry.taskId ?? `taskless:${entry.agentId}:${entry.queuedAt}:${randomUUID()}`;
    const rest = [...this.entries];
    this.entries.clear();
    this.entries.set(key, entry);
    for (const [k, e] of rest) this.entries.set(k, e);
  }

  /** Cancel one queued entry by opId, scoped to the calling manager (never lets a manager cancel another
   *  manager's queued spawn). Returns whether an entry was actually found+removed. */
  cancel(managerSessionId: string, opId: string): boolean {
    for (const [key, e] of this.entries) {
      if (e.opId === opId && e.managerSessionId === managerSessionId) {
        this.entries.delete(key);
        return true;
      }
    }
    return false;
  }
}

/**
 * Thrown by spawnWorker when a spawn is rejected purely because the concurrency cap is at capacity.
 * Carries the recorded {@link CapQueuedSpawn} so the MCP surface can enrich the bare `{error}` shape
 * ADDITIVELY — `capQueued: {opId, taskId, queuedAt}` — telling the caller the intent was recorded and
 * is visible in worker_list, not lost. `.message` stays the EXACT pre-existing string
 * (`concurrency cap reached (${cap})`), so anything that only reads `.message` (e.g. the existing
 * "concurrency cap reached" assertions in worker-spawn-taskless.mjs / worker-spawn-cap-toctou-race.mjs)
 * is unaffected.
 *
 * `capQueued` is OPTIONAL: {@link SessionService.maybeDrainCapQueue}'s own internal re-call of spawnWorker
 * (via `internal.skipCapQueueRecord`) hits this SAME cap-reject branch when it races a slot back to full,
 * but must NOT have spawnWorker `record()` a brand-new entry for it — the drain already holds the ORIGINAL
 * popped entry and re-queues THAT at the front (preserving its opId/FIFO position — see
 * {@link CapQueueRegistry.requeueFront}) rather than letting record() mint a new opId at the BACK of the
 * queue, which would demote it behind younger entries and silently invalidate any `worker_stop({opId})`
 * a caller already holds for it. `capQueued` is `undefined` in exactly that internal-recall case; every
 * MANUAL worker_spawn cap-reject (the only case that reaches the MCP surface) still always carries it.
 */
export class CapQueueRejectedError extends Error {
  readonly capQueued: CapQueuedSpawn | undefined;
  constructor(cap: number, capQueued?: CapQueuedSpawn) {
    super(`concurrency cap reached (${cap})`);
    this.name = "CapQueueRejectedError";
    this.capQueued = capQueued;
  }
}
