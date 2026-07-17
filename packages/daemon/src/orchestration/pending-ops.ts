import { randomUUID } from "node:crypto";

export type PendingOpKind = "spawn" | "merge" | "gate";
export type PendingOpState = "running" | "done" | "failed";

/**
 * Caller-defined terminal classification, distinguishing WHY an op ended rather than just THAT it ended —
 * e.g. `confirmWorkerMergeTracked` classifies a settled "merge" op as `"merged"` | `"rejected"` |
 * `"failed"` (see its `classifyOutcome` — a resolved `{merged:false}` gate rejection and a resolved
 * `{merged:true}` success both settle to op-state `"done"`, so `state` alone can't tell them apart). The
 * registry itself is vocabulary-agnostic — plain caller-chosen strings, not a fixed union — so other kinds
 * (spawn/gate) can adopt it later with their own vocabulary, or never pass `classifyOutcome` at all (then
 * `outcome` is simply never set, byte-identical to before this existed).
 */
export type PendingOpOutcome = string;

/**
 * The externally-visible projection of a pending op — safe to serialize over MCP. Never carries the
 * settled `result`/`error` (those are delivered exactly once, via {@link PendingOpRegistry.attach}'s
 * consume-on-read) — surfacing (`peek()`/`listByManager()`, worker_list's `pendingMerge` field / the
 * pending-spawn placeholder row) sees a RUNNING op's view, OR — only for a `key` whose `attach()` call
 * opted into `retainMs` — a brief RETAINED terminal view after it settles (see the class doc's "RETAINED
 * TERMINAL VIEW" section). A key with no retention opts in still evicts on settle exactly as before, so
 * surfacing for spawn/gate ops is completely unchanged.
 */
export interface PendingOpView {
  opId: string;
  kind: PendingOpKind;
  key: string;
  managerSessionId: string;
  startedAt: string;
  state: PendingOpState;
  /** Set only when the settling `attach()` call passed `classifyOutcome`; absent otherwise (e.g. every
   *  RUNNING view, and every settled spawn/gate op today). */
  outcome?: PendingOpOutcome;
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
  /** Set from `attach()`'s `classifyOutcome` opt at settle time, BEFORE eviction — so the `projectView()`
   *  this registry hands to a RETAINED-view write already carries it. Undefined when no `classifyOutcome`
   *  was given (every call site except confirmWorkerMergeTracked, today). */
  outcome?: PendingOpOutcome;
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

/** The common allowlisted-fields shape both `Entry` and `RetainedView` satisfy — used ONLY to type
 *  {@link projectView}'s input, so that function is the single place either internal shape is narrowed
 *  down to the caller-facing {@link PendingOpView}. */
type ViewSource = Pick<PendingOpView, "opId" | "kind" | "key" | "managerSessionId" | "startedAt" | "state" | "outcome">;

/** ALLOWLIST projection (CR nitpick, card 33172f01): builds the caller-facing view by naming exactly the
 *  fields that belong on it, rather than destructuring the internal source and denying specific ones. An
 *  allowlist makes a future internal-only field (like `RetainedView.rawOutcome`) leak-proof by
 *  construction — adding one never requires remembering to also add it to a denylist. */
function projectView(e: ViewSource): PendingOpView {
  return {
    opId: e.opId, kind: e.kind, key: e.key, managerSessionId: e.managerSessionId, startedAt: e.startedAt, state: e.state,
    ...(e.outcome !== undefined ? { outcome: e.outcome } : {}),
  };
}

/** A retained terminal view plus its expiry — see the class doc's "RETAINED TERMINAL VIEW" section. */
interface RetainedView extends PendingOpView {
  expiresAt: number; // epoch ms (Date.now())
  /** The RAW settled outcome (value or error — never stringified), separate from the classified `outcome`
   *  string above. Lets `attach()` short-circuit a re-call landing within the retention window by handing
   *  this back directly instead of starting a genuinely fresh op (card 33172f01) — `peek()` never surfaces
   *  this field (it's stripped in the same projection that already drops `expiresAt`), so it stays purely
   *  an internal dedupe channel, not a caller-facing one. */
  rawOutcome: { ok: true; value: unknown } | { ok: false; error: unknown };
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
 *
 * RETAINED TERMINAL VIEW (card d1aee5f1 follow-up — the Board merge-gate card's merged/rejected/failed
 * fill): evict-on-settle above is right for the `entries` map (attach()'s own dedup/idempotency depends on
 * it — a `key` must go back to "nothing running" the instant it settles, or a retry would dedup-attach to
 * a stale terminal result instead of starting fresh). But it means a settled op's terminal state is
 * essentially never observable via `peek()` — for the Board that meant the merged/rejected/failed hairline
 * fill had at most one poll's worth of a chance to render before reverting. Opt-in per `attach()` call via
 * `opts.retainMs`: at settle time, ONCE the identity-guarded delete from `entries` happens (same guard,
 * same place), the settled view is ALSO written into a SEPARATE `retained` map (keyed the same) with an
 * expiry — `peek()` falls back to it (lazily self-evicting once expired) so a viewer sees the terminal
 * state for a brief window instead of it vanishing the instant the gate settles.
 *
 * `retained` ALSO stores the settled op's RAW outcome (`RetainedView.rawOutcome` — the actual value/error,
 * not just the classified display string), and `attach()` consults it BEFORE minting a fresh `entries` row
 * (card 33172f01): a `key` miss on `entries` that still has a live, unexpired `retained` hit means some
 * `run()` for this exact key produced a definitive answer moments ago, so `attach()` hands that back
 * directly instead of re-invoking `run()`. WHY: for `confirmWorkerMergeTracked`, a `key` miss used to mean
 * "genuinely nothing outstanding," so an accidental duplicate re-confirm landing in the few seconds after a
 * merge just settled would re-run `confirmWorkerMerge` for real — against a worktree/branch the FIRST call
 * had already torn down, which could reproduce a false `[loom:merge-failed]` instead of returning the
 * merge (or rejection, or thrown-error) that already happened. This dedupe is STRICTLY bounded by
 * `retainMs`: `attach()`'s check is a plain `Date.now() < retainedHit.expiresAt` against the SAME timer
 * that already governs the Board-facing view — once it expires (and self-evicts, unchanged), a fresh call
 * finds nothing retained and runs for real exactly as before this existed, so a genuine retry after the
 * window is never blocked. The short-circuit returns before any `fresh.settle` chain is created, so it can
 * never invoke `onSettledAfterPending` either — re-confirming within the window can't re-emit a duplicate
 * completion nudge, whether the cached outcome was a success, a resolved rejection, or a thrown error. The
 * identity guard on `entries` (see `attach()`) still gates the `retained` write exactly as before: an
 * orphaned dead-owner op's late settle (its identity check on `entries` already fails, per the DEAD-OWNER
 * RECOVERY note above) never reaches the `retained` write, so it can't resurrect a stale view — or a stale
 * dedupe target — over a live successor's. A SECOND, separate identity guard on `retained` itself (via a
 * captured object reference, not just the key) protects the delayed cleanup timer from deleting a NEWER
 * retained view a successor op wrote under the same key before the OLDER view's own timer fires — and by
 * the same token, that successor's own `retained` write is what a THIRD call would dedupe against once
 * installed, never the stale one the timer is about to (or already did) evict.
 */
export class PendingOpRegistry {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly retained = new Map<string, RetainedView>();

  /** Read-only, NEVER consumes — for surfacing (worker_list's `pendingMerge` field). Returns a RUNNING
   *  op's view, or — if `key` has no running entry but a not-yet-expired RETAINED terminal view (see the
   *  class doc's "RETAINED TERMINAL VIEW" section; only `attach()` calls that opted into `retainMs` ever
   *  populate this) — that view instead, PROJECTED down to a bare `PendingOpView` via the SAME allowlist
   *  {@link projectView} uses for a running entry, so its internal-only fields (`expiresAt`, `rawOutcome`)
   *  can never leak onto a caller-facing surface (worker_list/worker_status/`/api/sessions` all spread this
   *  verbatim) even if a future field is added to `RetainedView` — an allowlist can't forget to exclude
   *  something new the way a denylist destructure could. Otherwise undefined, lazily evicting an expired
   *  retained view as a side effect so a stale one is never handed out. */
  peek(key: string): PendingOpView | undefined {
    const e = this.entries.get(key);
    if (e && e.state === "running") return projectView(e);
    const r = this.retained.get(key);
    if (!r) return undefined;
    if (Date.now() >= r.expiresAt) { this.retained.delete(key); return undefined; }
    return projectView(r);
  }

  /** Write `fresh`'s just-settled state (plus its RAW outcome — see `RetainedView.rawOutcome`) into the
   *  retained-view cache for `retainMs`, then self-evict via a timer — called ONLY from inside `attach()`'s
   *  identity-guarded settle callback (so an orphaned dead-owner op's late settle, whose identity check
   *  already failed, never reaches here — see the class doc). The timer's own delete is identity-guarded
   *  against the `RetainedView` OBJECT this call installs (not just the key), so a NEWER retained view a
   *  successor op writes under the same key before this timer fires survives it untouched. Under NORMAL
   *  scheduling this guard's false branch is effectively unreachable post-card-33172f01 (`attach()`'s own
   *  dedupe means a genuinely second real op for one key can only start once the first's retained view has
   *  expired) — but `attach()`'s expiry check and this timer race the SAME clock independently, so under
   *  real event-loop congestion (long synchronous handlers delaying this timer's callback) a fresh op COULD
   *  still start while the old entry is technically present; keep this guard even though no current test
   *  exercises that skew. */
  private retain(key: string, fresh: PendingOpView, retainMs: number, rawOutcome: RetainedView["rawOutcome"]): void {
    const entry: RetainedView = { ...fresh, expiresAt: Date.now() + retainMs, rawOutcome };
    this.retained.set(key, entry);
    setTimeout(() => {
      if (this.retained.get(key) === entry) this.retained.delete(key);
    }, retainMs).unref?.();
  }

  /** Read-only listing of every RUNNING `kind` op owned by `managerSessionId` — for worker_list's
   *  pending-spawn placeholder rows (a pending spawn has no worker row yet to hang `peek()` off of, so
   *  worker_list enumerates by manager instead of by a per-worker key). Settled ops are excluded (evicted
   *  on settle — see the class doc), so a spawn that already landed a real worker row, or already failed,
   *  never shows a phantom/stale placeholder alongside or instead of the real outcome. Never consumes. */
  listByManager(managerSessionId: string, kind: PendingOpKind): PendingOpView[] {
    const out: PendingOpView[] = [];
    for (const e of this.entries.values()) {
      if (e.kind === kind && e.managerSessionId === managerSessionId && e.state === "running") out.push(projectView(e));
    }
    return out;
  }

  /** Read-only listing of every RUNNING `kind` op regardless of owning manager — for the dead-owner
   *  recovery sweep (SessionService.reconcileDeadOwnerMergeOps / confirmWorkerMergeTracked), which needs
   *  to check EVERY outstanding op's `managerSessionId` against current session state, not just one
   *  manager's own. Never consumes (mirrors peek()/listByManager()). */
  listAllOfKind(kind: PendingOpKind): PendingOpView[] {
    const out: PendingOpView[] = [];
    for (const e of this.entries.values()) if (e.kind === kind && e.state === "running") out.push(projectView(e));
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
   * Attach to (or start) the op for `key`. NO entry exists yet AND no live retained result for `key` either
   * → `run()` is invoked exactly once, SYNCHRONOUSLY registering the entry BEFORE `run()`'s first internal
   * `await` (same no-await window as the old Set-based claim this generalizes — see the ATOMICITY PROOF
   * comment at spawnWorker's call site). An entry ALREADY exists (a retry, or a fresh call that raced in
   * first) → `run()` is NOT invoked again; this call just races the EXISTING op's settlement — so two
   * callers can never trigger two real invocations for the same key. NO entry exists but a live, unexpired
   * RETAINED result does (a re-call landing within `opts.retainMs` of the prior invocation's settle — see
   * the class doc's "RETAINED TERMINAL VIEW" section) → also no new invocation: that cached outcome is
   * returned directly as a settled `AttachResult`, just as if this call had raced the original op's own
   * settlement.
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
   *
   * `opts.classifyOutcome`/`opts.retainMs` (see the class doc's "RETAINED TERMINAL VIEW" section) are both
   * optional and independent of everything above: they run AFTER the existing identity-guarded
   * delete+nudge logic, inside the SAME identity-guarded branch, so an orphaned dead-owner op's late settle
   * (identity check already fails) never classifies or retains either. `classifyOutcome` alone (no
   * `retainMs`) just stamps `outcome` on the terminal `AttachResult` value this call itself returns/awaits
   * — harmless but pointless without retention, since nothing else would ever observe it once evicted.
   *
   * `opts.bypassRetained` (card 33172f01 CR finding): the retention-window dedupe below is arg-agnostic BY
   * DESIGN — `key` alone decides it, deliberately NOT widened to include `run`'s actual arguments (that
   * would ALSO fracture the RUNNING-op dedupe above, letting two differently-parameterized calls race two
   * real concurrent invocations against the same underlying resource — exactly the bug this registry
   * exists to prevent). But that means a caller whose args carry an explicit one-shot ESCALATION — e.g.
   * `confirmWorkerMergeTracked`'s `forceRemoveWorktree` — would otherwise have that escalation SILENTLY
   * swallowed by a cache hit built from an EARLIER call that didn't set it. `bypassRetained:true` is the
   * opt-out: THIS call skips the retained-cache read (still fully participates in the RUNNING-op dedupe
   * below — force never starts a second CONCURRENT real op on top of one still executing) and always mints
   * a fresh invocation carrying its own (forceful) args. The cache is still WRITTEN on this call's own
   * settle (ungated by this flag), so a later NON-forced re-confirm within ITS window correctly dedupes
   * against the fresh (forced) outcome, not the stale pre-force one.
   */
  async attach<T>(
    key: string, kind: PendingOpKind, managerSessionId: string, waitMs: number, run: (opId: string) => Promise<T>,
    onSettledAfterPending?: (outcome: { ok: true; value: T } | { ok: false; error: unknown }, opId: string) => void,
    opts?: {
      retainMs?: number;
      classifyOutcome?: (outcome: { ok: true; value: T } | { ok: false; error: unknown }) => PendingOpOutcome;
      bypassRetained?: boolean;
    },
  ): Promise<AttachResult<T>> {
    let e = this.entries.get(key) as Entry<T> | undefined;
    if (!e) {
      // RETENTION-WINDOW DEDUPE (card 33172f01): no RUNNING entry for `key` — this could be a genuinely
      // fresh call, OR an accidental duplicate re-confirm landing WHILE the prior op's settled result is
      // still in its brief retained window (see `retain()`/the class doc's "RETAINED TERMINAL VIEW"
      // section). Check the retained cache FIRST (unless `opts.bypassRetained` — see its doc above): a
      // live, unexpired hit means some `run()` for this exact key already produced a definitive answer
      // moments ago — hand it back directly instead of minting a fresh entry and re-invoking `run()`. This
      // returns before any `fresh.settle` chain is created, so it can never re-trigger `onSettledAfterPending`
      // either — a within-window re-confirm on a FAILED/rejected op can't re-emit a duplicate completion
      // nudge. Bounded by the SAME `retainMs` timer that already governs the Board-facing retained view:
      // once it expires (and self-evicts), this check finds nothing and falls through to the normal
      // fresh-op path below exactly as before — a genuine retry after the window still runs for real.
      const retainedHit = this.retained.get(key);
      if (!opts?.bypassRetained && retainedHit && Date.now() < retainedHit.expiresAt) {
        return retainedHit.rawOutcome.ok
          ? { settled: true, ok: true, value: retainedHit.rawOutcome.value as T }
          : { settled: true, ok: false, error: retainedHit.rawOutcome.error };
      }
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
      // spuriously surface a completion nudge against its successor's op either. The RETAINED-view write
      // (opts.retainMs) sits inside the SAME guarded branch for the identical reason — see the class doc.
      fresh.settle = run(fresh.opId).then(
        (value) => {
          fresh.state = "done"; fresh.result = value;
          fresh.outcome = opts?.classifyOutcome?.({ ok: true, value });
          if (this.entries.get(key) === fresh) {
            this.entries.delete(key);
            if (opts?.retainMs) this.retain(key, projectView(fresh), opts.retainMs, { ok: true, value });
            if (fresh.surfacedPending) onSettledAfterPending?.({ ok: true, value }, fresh.opId);
          }
        },
        (err) => {
          fresh.state = "failed"; fresh.error = err;
          fresh.outcome = opts?.classifyOutcome?.({ ok: false, error: err });
          if (this.entries.get(key) === fresh) {
            this.entries.delete(key);
            if (opts?.retainMs) this.retain(key, projectView(fresh), opts.retainMs, { ok: false, error: err });
            if (fresh.surfacedPending) onSettledAfterPending?.({ ok: false, error: err }, fresh.opId);
          }
        },
      );
      e = fresh;
    }
    if (e.state === "running") await Promise.race([e.settle, sleep(waitMs)]);
    if (e.state === "running") { e.surfacedPending = true; return { settled: false, op: projectView(e) }; }
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
