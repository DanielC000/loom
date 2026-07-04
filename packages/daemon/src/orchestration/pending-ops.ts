import { randomUUID } from "node:crypto";

export type PendingOpKind = "spawn" | "merge";
export type PendingOpState = "running" | "done" | "failed";

/**
 * The externally-visible projection of a pending op — safe to serialize over MCP. Never carries the
 * settled `result`/`error` (those are delivered exactly once, via {@link PendingOpRegistry.attach}'s
 * consume-on-read) — surfacing (`peek()`/`listByManager()`, worker_list's `pendingMerge` field / the
 * pending-spawn placeholder row) only ever sees a RUNNING op's view; a settled one is EVICTED the moment
 * it settles (see `attach()`), so surfacing can never show a stale "done"/"failed" op as if it were still
 * in flight — its outcome is delivered via the re-call/consume path instead, never via surfacing.
 */
export interface PendingOpView {
  opId: string;
  kind: PendingOpKind;
  key: string;
  managerSessionId: string;
  startedAt: string;
  state: PendingOpState;
}

interface Entry<T> {
  opId: string;
  kind: PendingOpKind;
  key: string;
  managerSessionId: string;
  startedAt: string;
  state: PendingOpState;
  result?: T;
  /** The RAW thrown value (never stringified) — preserves error subclass identity (e.g. UsageLimitError
   *  + its `retryAfter`) through the settle/consume path, so a caller's `instanceof` check still works
   *  exactly as it would on a direct synchronous throw. */
  error?: unknown;
  /** Resolves once `state` leaves "running" — the seam every `attach()` call (fresh or retry) races
   *  against its own `waitMs`, so multiple concurrent callers can all observe the SAME single
   *  underlying `run()` outcome without triggering a second invocation. Each awaiter holds `e` by
   *  REFERENCE, so reading `e.state`/`e.result`/`e.error` after this resolves is safe even once the map
   *  entry itself has been evicted (see `attach()`'s settle callback). */
  settle: Promise<void>;
}

export type AttachResult<T> =
  | { settled: true; ok: true; value: T }
  | { settled: true; ok: false; error: unknown }
  | { settled: false; op: PendingOpView };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function view(e: Entry<unknown>): PendingOpView {
  return { opId: e.opId, kind: e.kind, key: e.key, managerSessionId: e.managerSessionId, startedAt: e.startedAt, state: e.state };
}

/**
 * Daemon-global registry of long-running orchestration ops (worker_spawn / worker_merge_confirm) that
 * can be POLLED and RE-ATTACHED — generalizes the old bare `inFlightSpawnTaskIds` claim Set (a
 * throw-on-retry mutex) into a record whose outcome a client can come back for. Fixes the Auditor
 * b9515beb friction: a client-side MCP timeout on a minutes-long gate run used to leave the manager
 * unable to tell whether the op landed, and a retry bounced off a hard "already in flight" error instead
 * of finding out. One op per `key` at a time (spawn: `spawn:${taskId}`; merge: `merge:${workerSessionId}`).
 *
 * EVICT-ON-SETTLE (not a TTL): the entry is deleted from the map the MOMENT it settles (inside the
 * `run().then/.catch` callback in `attach()`), not merely once someone happens to consume it. This closes
 * two real bugs a TTL-based reap would only paper over: (a) a slow op that settled but was never
 * re-polled would otherwise surface FOREVER via `peek()`/`listByManager()` — for a merge that means
 * `pendingMerge` stays non-null after the merge is done (contradicts "non-null = still running"); for a
 * spawn it means the placeholder row lingers ALONGSIDE the real worker row `spawnWorker` inserted once it
 * settled (duplicate/over-count) — or, on a FAILED spawn, lingers forever as a phony `processState:
 * "starting"` that never reports the failure; (b) an unbounded map leak on a long-running daemon. A
 * concurrent awaiter that is STILL racing `e.settle` when eviction happens is unaffected — it holds `e` by
 * reference, not by a live map lookup, so it reads the correct final state/result/error regardless. A
 * caller that arrives AFTER eviction (a genuine "no entry" state, indistinguishable from one that was
 * never started) safely re-invokes the real operation — safe because BOTH callers of this registry lean
 * on their OWN pre-existing idempotency: confirmWorkerMerge's ALREADY_MERGED re-derive-from-clean-index,
 * and spawnWorker's `liveSessionIdForTask` live-worker guard — neither of which this registry duplicates.
 */
export class PendingOpRegistry {
  private readonly entries = new Map<string, Entry<unknown>>();

  /** Read-only, NEVER consumes — for surfacing (worker_list's `pendingMerge` field). Only ever returns a
   *  RUNNING op's view (a settled one is evicted on settle — see the class doc — so there is nothing
   *  settled left to accidentally surface as still-in-flight). */
  peek(key: string): PendingOpView | undefined {
    const e = this.entries.get(key);
    return e && e.state === "running" ? view(e) : undefined;
  }

  /** Read-only listing of every RUNNING `kind` op owned by `managerSessionId` — for worker_list's
   *  pending-spawn placeholder rows (a pending spawn has no worker row yet to hang `peek()` off of, so
   *  worker_list enumerates by manager instead of by a per-worker key). Settled ops are excluded (evicted
   *  on settle — see the class doc), so a spawn that already landed a real worker row, or already failed,
   *  never shows a phantom/stale placeholder alongside or instead of the real outcome. Never consumes. */
  listByManager(managerSessionId: string, kind: PendingOpKind): PendingOpView[] {
    const out: PendingOpView[] = [];
    for (const e of this.entries.values()) {
      if (e.kind === kind && e.managerSessionId === managerSessionId && e.state === "running") out.push(view(e));
    }
    return out;
  }

  /**
   * Attach to (or start) the op for `key`. NO entry exists yet → `run()` is invoked exactly once,
   * SYNCHRONOUSLY registering the entry BEFORE `run()`'s first internal `await` (same no-await window as
   * the old Set-based claim this generalizes — see the ATOMICITY PROOF comment at spawnWorker's call
   * site). An entry ALREADY exists (a retry, or a fresh call that raced in first) → `run()` is NOT invoked
   * again; this call just races the EXISTING op's settlement — so two callers can never trigger two real
   * invocations for the same key.
   *
   * Either way, races the op's settlement against `waitMs`: settles in time → the settle callback has
   * ALREADY evicted the entry (see the class doc) — this call just reads the final state/result/error off
   * its own `e` reference and returns it (served exactly once per real invocation, mirroring inbox_pull's
   * consume-on-read); still running at the deadline → returns the PENDING view WITHOUT consuming (the op
   * keeps running in the background; a later call — retry or poll — attaches again, or `peek()`/
   * `listByManager()` surfaces it read-only).
   */
  async attach<T>(
    key: string, kind: PendingOpKind, managerSessionId: string, waitMs: number, run: () => Promise<T>,
  ): Promise<AttachResult<T>> {
    let e = this.entries.get(key) as Entry<T> | undefined;
    if (!e) {
      const fresh: Entry<T> = {
        opId: randomUUID(), kind, key, managerSessionId, startedAt: new Date().toISOString(),
        state: "running", settle: Promise.resolve(),
      };
      this.entries.set(key, fresh);
      fresh.settle = run().then(
        (value) => { fresh.state = "done"; fresh.result = value; this.entries.delete(key); },
        (err) => { fresh.state = "failed"; fresh.error = err; this.entries.delete(key); },
      );
      e = fresh;
    }
    if (e.state === "running") await Promise.race([e.settle, sleep(waitMs)]);
    if (e.state === "running") return { settled: false, op: view(e) };
    return e.state === "done"
      ? { settled: true, ok: true, value: e.result as T }
      : { settled: true, ok: false, error: e.error };
  }
}

/** How long worker_spawn/worker_merge_confirm stay SYNCHRONOUS before degrading to a pending handle —
 *  comfortably under the client-side MCP timeout that trips on a real multi-minute gate run (Auditor
 *  b9515beb), comfortably above a typical fast merge/spawn. Below this, both tools return their EXACT
 *  today's-shape result; only a genuinely slow op degrades. */
export const SYNC_ATTACH_BUDGET_MS = 12_000;
