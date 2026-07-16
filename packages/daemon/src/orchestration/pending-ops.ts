import { randomUUID } from "node:crypto";

export type PendingOpKind = "spawn" | "merge" | "gate";
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
  /** True once some `attach()` call has actually been told this op is still pending (a `waitMs` race that
   *  timed out before `run()` settled). Gates the completion callback below: a caller who observed the FAST
   *  path already has the outcome inline (nothing to push); a caller who was told "pending" may go do
   *  something else entirely instead of re-polling, so the terminal settle is the only guaranteed delivery
   *  moment for them — see `attach()`'s `onSettledAfterPending`. */
  surfacedPending: boolean;
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
 * of finding out. One op per `key` at a time (spawn: `spawn:${taskId}`; merge: `merge:${workerSessionId}`;
 * gate: `gate:${workerSessionId}` — card 7f96aa09, a worker's own daemon-mediated DoD self-check). The
 * "gate" kind has no separate owning manager: its `managerSessionId` field holds the CALLING WORKER's own
 * session id (the caller and the beneficiary of the completion nudge are the same session), so it needs
 * none of the dead-owner reconciliation the "merge" kind does — there is no cross-session ownership split
 * to reconcile when a key's only possible caller is the session named by the key itself.
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
 *
 * DEAD-OWNER RECOVERY (card 27ea069e, the ONE exception to evict-on-settle-only): a `run()` invocation
 * can outlive the manager session that started it (that manager crashed, was stopped, or is otherwise
 * gone) with no live caller left who could ever be handed its outcome through the normal settle path —
 * so `evictDeadOwner()` force-removes such an entry ahead of its own settlement, letting a fresh
 * `attach()` on the same `key` start a genuinely new invocation instead of dedup-attaching to (or
 * spin-polling) one that can never be delivered. See `SessionService.confirmWorkerMergeTracked`
 * (per-call defensive check) and `reconcileDeadOwnerMergeOps` (boot-time sweep).
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

  /** Read-only listing of every RUNNING `kind` op regardless of owning manager — for the dead-owner
   *  recovery sweep (SessionService.reconcileDeadOwnerMergeOps / confirmWorkerMergeTracked), which needs
   *  to check EVERY outstanding op's `managerSessionId` against current session state, not just one
   *  manager's own. Never consumes (mirrors peek()/listByManager()). */
  listAllOfKind(kind: PendingOpKind): PendingOpView[] {
    const out: PendingOpView[] = [];
    for (const e of this.entries.values()) if (e.kind === kind && e.state === "running") out.push(view(e));
    return out;
  }

  /** Force-remove a RUNNING entry keyed `key`, WITHOUT waiting for its `run()` to settle — the dead-owner
   *  recovery path (see the class doc's "DEAD-OWNER RECOVERY" note and SessionService's
   *  `confirmWorkerMergeTracked`/`reconcileDeadOwnerMergeOps`): once the op's owning manager session is
   *  confirmed gone (exited/archived/missing), nothing will ever consume this op's outcome through the
   *  normal attach()/settle path — the caller that could receive it no longer exists — so a fresh caller
   *  must be able to start a NEW invocation under the SAME key instead of dedup-attaching to (or
   *  spin-polling) one that can never be delivered. Returns `false` (no-op) if there's no RUNNING entry
   *  for `key` — e.g. it already settled naturally in the race, or there was never one. Never touches a
   *  settled entry (already evicted on settle — see the class doc), so this can't resurrect/duplicate a
   *  result that already landed.
   *
   *  ACCEPTED TRADEOFF (CR finding, card 27ea069e): this can only remove the MAP ENTRY, never cancel the
   *  orphaned `run()` itself (there's no handle to cancel a bare Promise) — the old op's real work keeps
   *  executing in the background, unreachable, until it eventually settles on its own. That late settle is
   *  now harmless: `attach()`'s identity-guarded delete (`this.entries.get(key) === fresh`) means it can
   *  only clear its OWN (already-detached) entry, never the successor `evictDeadOwner` made room for — so
   *  the tradeoff this trades "stuck pending forever" for is just a lingering, functionally-inert
   *  background call, not a resurrected/duplicated result. The remaining host-load question — could the
   *  orphaned run and its successor both drive a real gate command CONCURRENTLY — is bounded by the
   *  daemon-global {@link GateSemaphore} (`orchestration.maxConcurrentGates`, default 1): it serializes
   *  actual gate RUNS across the whole daemon, so the orphaned run and the fresh one can't execute gates
   *  at the same time even though both are technically "in flight" JS-side. */
  evictDeadOwner(key: string): boolean {
    const e = this.entries.get(key);
    if (!e || e.state !== "running") return false;
    this.entries.delete(key);
    return true;
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
   *
   * `onSettledAfterPending`, when given, fires EXACTLY ONCE — from inside the op's own terminal settle
   * callback (never from a caller's fast path) — but ONLY if this key was actually surfaced to some caller
   * as `{settled:false}` first. A call that observes the op resolve within its own `waitMs` already has the
   * outcome inline and needs no push; a call that was told "pending" may never come back to poll again, so
   * the terminal callback is the one delivery path guaranteed to fire for it. Only the FIRST (entry-creating)
   * call's callback is ever wired — later attach() calls on the same in-flight key pass their own callback
   * closure too, but it's a no-op (the entry already exists, so `run()`/its `.then` are not re-registered);
   * this is harmless as long as callers derive equivalent callback content from the same key (true here).
   *
   * `run` is handed this op's own `opId` (minted BEFORE `run()` starts, so it's stable across the whole
   * invocation) — a caller whose result carries a manager-facing correlation signal (e.g.
   * `confirmWorkerMergeTracked`'s `[loom:merge-*]` nudges, card 369d8824) threads it through so an async
   * completion push can be matched back to the SAME `opId` the caller was handed in its own `{status:
   * "pending", opId}` response. `onSettledAfterPending` is handed the same `opId` for the same reason —
   * covers the `{ok:false}` branch too, which has no `value` of its own to carry one.
   */
  async attach<T>(
    key: string, kind: PendingOpKind, managerSessionId: string, waitMs: number, run: (opId: string) => Promise<T>,
    onSettledAfterPending?: (outcome: { ok: true; value: T } | { ok: false; error: unknown }, opId: string) => void,
  ): Promise<AttachResult<T>> {
    let e = this.entries.get(key) as Entry<T> | undefined;
    if (!e) {
      const fresh: Entry<T> = {
        opId: randomUUID(), kind, key, managerSessionId, startedAt: new Date().toISOString(),
        state: "running", settle: Promise.resolve(), surfacedPending: false,
      };
      this.entries.set(key, fresh);
      // IDENTITY-GUARDED delete (card 27ea069e CR finding): a bare `this.entries.delete(key)` here was
      // safe ONLY under the old invariant that a new entry could never be created under `key` while an
      // older one for that same key was still settling — evictDeadOwner breaks that invariant on purpose
      // (it force-removes a RUNNING entry so a fresh attach() can start a genuinely new op under the SAME
      // key while the evicted op's own `run()` is still executing in the background, unreachable but not
      // cancellable). Without this guard, that orphaned run's EVENTUAL settle would delete-by-key and wipe
      // out the SUCCESSOR entry that replaced it — clearing worker_list's pendingMerge mid-merge, losing
      // dedup, and letting a further retry start a THIRD concurrent confirmWorkerMerge on one worktree.
      // `this.entries.get(key) === fresh` confirms THIS settle's own entry is still the one installed under
      // `key` before mutating/deleting it — a superseded (evicted) op's late settle then finds a DIFFERENT
      // object there and does nothing, touching only its own (already-detached) `fresh` reference. Applied
      // to both the delete AND the `surfacedPending` push below, so an evicted op's late settle can't
      // spuriously surface a completion nudge against its successor's op either.
      fresh.settle = run(fresh.opId).then(
        (value) => {
          fresh.state = "done"; fresh.result = value;
          if (this.entries.get(key) === fresh) {
            this.entries.delete(key);
            if (fresh.surfacedPending) onSettledAfterPending?.({ ok: true, value }, fresh.opId);
          }
        },
        (err) => {
          fresh.state = "failed"; fresh.error = err;
          if (this.entries.get(key) === fresh) {
            this.entries.delete(key);
            if (fresh.surfacedPending) onSettledAfterPending?.({ ok: false, error: err }, fresh.opId);
          }
        },
      );
      e = fresh;
    }
    if (e.state === "running") await Promise.race([e.settle, sleep(waitMs)]);
    if (e.state === "running") { e.surfacedPending = true; return { settled: false, op: view(e) }; }
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
