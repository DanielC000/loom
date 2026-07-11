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
 * BOUNDED, daemon-local, in-memory record of worker_spawn calls REJECTED purely because
 * `maxConcurrentWorkers` was at capacity. Before this, a cap-reject returned a bare `{error}` and
 * recorded NOTHING durable — the caller had to remember to re-spawn, and evidence showed a card sat
 * un-dispatched ~150 turns because a manager forgot. This registry makes the rejected intent VISIBLE
 * (worker_list surfaces a distinct placeholder row) instead of letting it silently disappear.
 *
 * This is a VISIBILITY MARKER ONLY — nothing here ever auto-dispatches a queued spawn. The manager
 * reads it via worker_list and re-drives it itself by re-calling worker_spawn once a slot frees. A
 * heavier auto-enqueue+auto-spawn-when-a-slot-frees subsystem (ordering/dedup/worktree coordination/
 * slot-free triggers) is deliberately OUT OF SCOPE — a future follow-up could build on top of this
 * marker, but that's a bigger change to the load-bearing spawn path than this one intends.
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
  private readonly entries = new Map<string, CapQueuedSpawn>();

  /** `now` is injectable — real `Date.now` in prod, a fake clock in tests (so TTL reap is testable
   *  without a real 30-minute wait). Defaults to `Date.now`, so every existing/production construction
   *  (`new CapQueueRegistry()`) is byte-identical. */
  constructor(private readonly now: () => number = Date.now) {}

  private prune(nowMs: number): void {
    for (const [key, e] of this.entries) {
      if (nowMs - Date.parse(e.queuedAt) >= CAP_QUEUE_TTL_MS) this.entries.delete(key);
    }
  }

  /** Record a cap-rejected spawn intent. Returns the recorded entry (opId + queuedAt) so the caller can
   *  echo it back on the enriched cap-reject error. */
  record(managerSessionId: string, agentId: string, taskId: string | null, kickoffPrompt: string): CapQueuedSpawn {
    const nowMs = this.now();
    this.prune(nowMs);
    if (this.entries.size >= CAP_QUEUE_MAX) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    const queuedAt = new Date(nowMs).toISOString();
    const key = taskId ?? `taskless:${agentId}:${queuedAt}:${randomUUID()}`;
    const entry: CapQueuedSpawn = {
      opId: randomUUID(),
      managerSessionId,
      agentId,
      taskId,
      kickoffLabel: kickoffPrompt.length > KICKOFF_LABEL_MAX ? `${kickoffPrompt.slice(0, KICKOFF_LABEL_MAX)}…` : kickoffPrompt,
      queuedAt,
    };
    this.entries.set(key, entry);
    return entry;
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
   *  cap-queued placeholder rows. Never consumes. */
  listByManager(managerSessionId: string): CapQueuedSpawn[] {
    this.prune(this.now());
    return [...this.entries.values()].filter((e) => e.managerSessionId === managerSessionId);
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
 */
export class CapQueueRejectedError extends Error {
  readonly capQueued: CapQueuedSpawn;
  constructor(cap: number, capQueued: CapQueuedSpawn) {
    super(`concurrency cap reached (${cap})`);
    this.name = "CapQueueRejectedError";
    this.capQueued = capQueued;
  }
}
