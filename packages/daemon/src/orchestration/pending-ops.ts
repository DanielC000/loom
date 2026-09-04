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
  /** Set ONLY for a genuinely fresh entry (never for one this call merely attached to as already-running,
   *  and never populated at all for a cache hit — see `attach()`'s own doc, card 615967c5, the
   *  cached-verdict-legibility fix). Carried on the entry itself (not just handed back to the minting
   *  call) so a LATER caller that attaches to this SAME still-running op — a poll — sees the identical
   *  reason, not `undefined`. */
  freshMint?: FreshMintInfo;
}

/** WHY a fresh op was just minted instead of the caller's `attach()` call being served from a cache — see
 *  the class doc's "UNTIL-SUPERSEDED VERDICT CACHE" section for the caching this classifies. Only ever
 *  set for a `key` that opted into `opts.retainVerdictUntilSuperseded` (today: merge); every other kind
 *  leaves this `undefined` (byte-identical to before this existed).
 *  - `"forced"`: `opts.bypassRetained` — the caller explicitly asked to skip every cache and run for real.
 *  - `"identity-mismatch"`: a cached verdict existed for this `key` but its `identity` did not match this
 *    call's `opts.verdictIdentity` — e.g. for merge, the branch tip moved. This is an OBSERVATION about
 *    the identity string, never a claim about WHY it moved: it collapses several distinct causes — main
 *    advanced under the branch (often via Loom's OWN pre-gate union-merge catching it up), a sibling's
 *    squash landed, or the worker itself pushed a new commit — that this registry has no way to tell apart.
 *  - `"genuinely-new"`: no cached verdict has ever been recorded for this `key` (in this daemon process —
 *    see the class doc's PROCESS-LOCAL note; a restart also produces this).
 *  `priorIdentity` is the identity recorded on the verdict this mint superseded/bypassed, when one
 *  existed — always present for `"identity-mismatch"`, present for `"forced"` only if a prior verdict
 *  happened to exist, absent for `"genuinely-new"`. This is an OBSERVED FIELD, not an assertion of cause:
 *  it names what the registry recorded, never why the identity changed. */
export interface FreshMintInfo {
  reason: "identity-mismatch" | "forced" | "genuinely-new";
  priorIdentity?: string;
  /** NEVER set by this registry — it only ever knows the identity a PAST settle recorded, not what a
   *  caller can freshly resolve NOW. A caller that also resolves its own "current" identity (e.g.
   *  confirmWorkerMergeTracked's `verdictIdentity`, read fresh before every `attach()` call) may fold it
   *  in here, on the result THIS registry already handed back, purely for reporting symmetry with
   *  `priorIdentity`. Left `undefined` by any caller that doesn't. */
  currentIdentity?: string;
}

/**
 * Card 4aedde84 — the mirror of {@link FreshMintInfo} for the branch that used to be silent: set on a
 * settled `AttachResult` ONLY when it was served from either cache read at the top of `attach()` (the
 * never-expiring `untilSupersededVerdicts` map, or the TTL'd `retained` map) rather than from a genuine
 * `run()` invocation. `identity` is the identity the REPLAYED verdict was validated against, when the
 * registry knows it — always present for an `untilSupersededVerdicts` hit (that map always records one,
 * even `undefined` for an identity-agnostic caller); a plain TTL `retained` hit only carries one when the
 * minting call passed `opts.verdictIdentity` (see `retain()`'s own doc — the field was added to
 * `RetainedView` by this same card). SET IN A DISJOINT BRANCH FROM `freshMint`: both are decided by the
 * SAME cache-read-vs-mint fork at the top of `attach()`, so a result can never carry both — never derive
 * "cache hit" from `!freshMint` at a call site when this field exists to say so directly. NEVER set on a
 * `{settled:false}` (pending) result — both cache-read branches this type comes from return SETTLED
 * results unconditionally (see attach()'s own code); a still-running op is always either a genuinely fresh
 * mint or an attach to one, never a cache replay, so `cacheHit` is structurally absent from the pending
 * variant of {@link AttachResult} below, not merely usually undefined.
 */
export interface CacheHitInfo {
  identity?: string;
}

export type AttachResult<T> =
  | { settled: true; ok: true; value: T; freshMint?: FreshMintInfo; cacheHit?: CacheHitInfo }
  | { settled: true; ok: false; error: unknown; freshMint?: FreshMintInfo; cacheHit?: CacheHitInfo }
  | { settled: false; op: PendingOpView; freshMint?: FreshMintInfo };

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
  /** Card 4aedde84 — the identity this view's minting call resolved (`opts.verdictIdentity`), carried so a
   *  later TTL `retained`-cache hit can report it via `CacheHitInfo.identity` exactly as the durable
   *  `untilSupersededVerdicts` map already does. `undefined` for a caller that never opts into identity
   *  tracking, byte-identical to before this field existed. */
  identity?: string;
}

/** A settle verdict remembered UNTIL SUPERSEDED — never on a clock — for `opts.retainVerdictUntilSuperseded`
 *  (card 1555e361, the merge-gate re-call trap). PROCESS-LOCAL, NOT PERSISTED — see the class doc's
 *  "UNTIL-SUPERSEDED VERDICT CACHE" section for why this is named to avoid the DB-persisted sense
 *  "durable" carries elsewhere in this same file (e.g. the `pending_gate_ops` tombstone row). Deliberately
 *  NOT a `RetainedView`: it carries none of the display-facing fields (`peek()`/worker_list's
 *  `pendingMerge` never reads this map — that surfacing stays on the existing TTL'd `retained` map,
 *  unchanged, per its own doc), only what `attach()`'s dedupe check needs to hand back a cached answer
 *  instead of re-invoking `run()`.
 *
 *  `identity` (card 1555e361 CR follow-up — the SAME card, caught before merge): "until superseded" alone
 *  is NOT enough for merge — a plain re-call after the worker pushed a genuine fix must NOT return the
 *  cached REJECTION for a commit that no longer exists ("my fix didn't work" read by the manager on work
 *  that changed underneath the cache). `identity` is a caller-supplied opaque string identifying WHAT was
 *  validated (for merge: the worker branch's HEAD sha at call time) — `attach()` only serves this cached
 *  verdict when a re-call's OWN freshly-resolved identity matches exactly. A caller that never opts into an
 *  identity (`opts.verdictIdentity` omitted) leaves this `undefined` — matches only another `undefined`,
 *  i.e. identity-agnostic, byte-identical to the pre-identity behavior. See `attach()`'s own doc for the
 *  read-side matching rule. */
interface UntilSupersededVerdict {
  rawOutcome: { ok: true; value: unknown } | { ok: false; error: unknown };
  identity?: string;
}

/**
 * Daemon-global registry of long-running orchestration ops (worker_spawn / worker_merge_confirm) that
 * can be POLLED and RE-ATTACHED — generalizes the old bare `inFlightSpawnTaskIds` claim Set (a
 * throw-on-retry mutex) into a record whose outcome a client can come back for. Fixes the Auditor
 * b9515beb friction: a client-side MCP timeout on a minutes-long gate run used to leave the manager
 * unable to tell whether the op landed, and a retry bounced off a hard "already in flight" error instead
 * of finding out. One op per `key` at a time (spawn: `spawn:${taskId}`; merge: `merge:${workerSessionId}`;
 * gate: `gate:${workerSessionId}` — card 7f96aa09, a worker's own daemon-mediated DoD self-check;
 * merge-batch: `merge-batch:${managerSessionId}:${sorted, comma-joined workerSessionIds of the resolved
 * candidate set}` — card f944d4e4, `SessionService.mergeBatchTracked`'s own doc has the full rationale for
 * why the key is the RESOLVED set, not the raw request, and why `baseMainSha` is deliberately excluded).
 * The
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
 *
 * The dedupe above hands back a live `retained` hit UNCONDITIONALLY BY DEFAULT — right for a "merge" op
 * (there is no such thing as a merge outcome that's "settled but already known unusable"; the WHY above is
 * entirely about not re-running against a torn-down worktree). `attach()`'s `opts.isRetainedResultUsable`
 * (card 79b0ee52) is the per-value escape hatch for a kind whose own settled outcome CAN self-declare
 * staleness — `run_gate`'s `headCurrent:false` — so a caller already told a specific cached answer is
 * contaminated is never handed that SAME answer again on the very next call. See `attach()`'s own doc for
 * the mechanics; this key point belongs here too since it changes the "unconditional" framing above.
 *
 * UNTIL-SUPERSEDED VERDICT CACHE (card 1555e361 — the merge-gate re-call trap): the `retained` dedupe
 * above is bounded by `retainMs`, and for "merge" that TTL was only 5s (`MERGE_OP_RETAIN_MS`) — a caller
 * polling for the outcome of a multi-minute gate run will, BY NATURE, usually land its re-call after that
 * window has closed, at which point the old dedupe found nothing and `attach()` re-invoked `run()` for
 * real: a "safe poll" that silently became a genuine, unrequested second gate run, and — for a
 * non-deterministic gate test — could launder a REJECTED branch into a merge with no decision anywhere in
 * the loop. `opts.retainVerdictUntilSuperseded` closes that: for a `key` that opts in, every settle whose
 * classified `outcome` (see `opts.classifyOutcome` below) is NOT the sentinel string `"cancelled"` also
 * writes into a SEPARATE `untilSupersededVerdicts` map that carries NO expiry timer at all — a re-call
 * finds it there regardless of how long it waited, and `attach()`'s dedupe hands back that SAME verdict
 * instead of minting a fresh entry. It is superseded, not expired: the only way to clear it is for a
 * genuinely fresh op under the same `key` to settle in turn (which overwrites the map entry the same way
 * `retain()` already overwrites `retained`) — reachable ONLY via `opts.bypassRetained` (today,
 * `forceRemoveWorktree:true`), an explicit caller-chosen escalation, never a clock.
 *
 * ⚠️ THE ONE HARDCODED EXCEPTION (card 171297dc — the gate_cancel-replayed-forever trap): a CANCELLED
 * settle (`gate_cancel` withdrew a QUEUED merge confirm — `confirmWorkerMergeTracked`'s own
 * `classifyOutcome` maps that shape to exactly the string `"cancelled"`, unchanged by this card) is NOT a
 * verdict — no gate ever ran, nothing was validated — so there is nothing here for a later plain re-call
 * to safely reuse, unlike a real PASS/REJECTION (this section's actual safety property, otherwise left
 * completely untouched). Before this card, the write above was truly unconditional: a cancelled outcome
 * got cached exactly like a real one and replayed to every future re-call FOREVER (this map has no expiry)
 * — a manager re-calling per the tool's own documented retry contract kept being handed back the SAME
 * stale "cancelled by manager … via gate_cancel" reason, tens of minutes after the fact, with no new op
 * ever minted. `attach()` now checks the classified outcome string directly (both at this write and at
 * the TTL'd `retained` read a few lines below) rather than adding a new per-call opt for it: `outcome` is
 * ordinarily caller-chosen, vocabulary-agnostic prose (see this file's own `PendingOpOutcome` doc) with no
 * meaning to this registry — `"cancelled"` is the ONE deliberate, narrowly-scoped exception, because it is
 * ALSO the exact string every "no verdict reached" settle across this codebase already converges on
 * (`ConfirmMergeResult.cancelled`/`WorkerGateResult.cancelled`, `gate_status`'s own `outcome` field) — see
 * `opts.classifyOutcome`'s own doc for why this doesn't need a new service-layer opt-in to take effect.
 *
 * ⚠️ NAMED DELIBERATELY, NOT "durable": this map is PROCESS-LOCAL, held ONLY in this registry's own
 * in-memory `Map` — it is NEVER written to the database and does NOT survive a daemon restart. "Durable"
 * already has an established, DIFFERENT meaning a few lines below in this same options block (the
 * `pending_gate_ops` DB tombstone row `onOpMinted`/`onSettle` maintain) — reusing it here for a plain
 * in-memory cache would mislead a reader into assuming restart-survival this map does not provide. A
 * re-call whose gap spans a daemon restart finds this map EMPTY and mints a genuinely fresh op, exactly as
 * it did before this card — the trap this section closes is a same-process TTL cliff, not a persistence
 * gap, and this fix does not claim to close the latter.
 *
 * Deliberately DECOUPLED from `retained`/`retainMs`: the two maps are written together at settle time but
 * read by different consumers — `peek()` (worker_list/Board display) keeps consulting ONLY the TTL'd
 * `retained` map and keeps reverting to nothing shown on the SAME schedule as before this existed, while
 * `attach()`'s own dedupe consults `untilSupersededVerdicts` first. So a settled merge can vanish from
 * worker_list's `pendingMerge` field after a few seconds (display, cosmetic) while a re-call minutes or
 * hours later still safely returns the cached verdict instead of re-running the gate (safety, load-bearing)
 * — the manager's call on card 1555e361: the safety property must never be allowed to depend on the
 * display window's cadence.
 *
 * IDENTITY-GATED SUPERSEDE (card 1555e361, caught at review before merge): "until superseded" via
 * `opts.bypassRetained` alone is not enough for merge — a manager who fixes a rejected branch and re-calls
 * PLAINLY (no `forceRemoveWorktree:true`) must NOT be told the cached REJECTION for a commit that no longer
 * exists; that reads as "my fix didn't work" and is a worse trap than the one this section fixes (silence
 * vs. a confidently wrong answer). `opts.verdictIdentity` closes this: an opaque, caller-supplied string
 * (for merge: the branch's HEAD sha, resolved fresh on every call, BEFORE the dedupe decision) recorded
 * alongside the verdict at settle time. A re-call's dedupe hit requires its OWN freshly-resolved identity to
 * match the STORED one exactly (`undefined` matches only `undefined` — a caller that never opts into
 * identity tracking is unaffected). A MISMATCH is treated as a genuine cache MISS, not merely "fall through
 * to the TTL'd `retained` check instead" — that map was written at the exact same (now-stale) settle and
 * would silently reproduce the identical wrong answer for its own few-second window, so a verdict-cache-hit
 * mismatch skips `retained` too and goes straight to a fresh mint. Same-identity re-calls (the actual poll
 * case this section exists for) are completely unaffected — the trap this section fixes and the one this
 * paragraph fixes are two different axes (WHEN you ask vs. WHAT you're asking about) and neither one's fix
 * weakens the other's.
 *
 * `opts.identityOptional` (card 1555e361 CR follow-up, ROUND 2 — caught by a regression in the SAME card's
 * own test suite before merge): strict identity comparison alone over-refuses. For merge specifically, a
 * SUCCESSFUL confirm deletes the worker's branch as part of its own completion (`finalizeMerge`) — so a
 * later re-call can never again resolve the SAME sha the cached verdict was validated against, EVEN THOUGH
 * nothing about the underlying answer changed and no new commit is possible (there is no live worktree left
 * to commit to). Without an escape hatch, that re-derives a fresh (though still safe — see the previous
 * paragraph) ALREADY_MERGED result on every poll instead of a pure cache hit, breaking a distinct,
 * previously-tested invariant ("re-poll after settle returns the EXACT SAME opId"). `identityOptional` lets
 * the CALLER declare, per call, "I know from context outside what this registry can see that identity
 * cannot meaningfully differ here" — `confirmWorkerMergeTracked` sets it exactly when the worker's task has
 * already reached its terminal lane (the SAME authoritative "already finished" signal
 * `confirmWorkerMerge`'s own early-idempotency check trusts), never merely because a git ref failed to
 * resolve (a live worktree's ref failing to resolve is usually TRANSIENT and must still fail closed to a
 * fresh mint — see `verdictIdentity`'s own doc). See `attach()`'s own doc for the mechanics.
 */
export class PendingOpRegistry {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly retained = new Map<string, RetainedView>();
  /** See the class doc's "UNTIL-SUPERSEDED VERDICT CACHE" section. PROCESS-LOCAL, NOT PERSISTED — cleared
   *  on every daemon restart (see that section's own boundary note). Bounded the same way
   *  `lastWorkerGateCheck` (SessionService) is: one small entry per `key` that has ever opted in and
   *  settled at least once, never explicitly purged — an accepted, tiny, long-running-daemon leak, not a
   *  gap to fix. */
  private readonly untilSupersededVerdicts = new Map<string, UntilSupersededVerdict>();

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
  private retain(key: string, fresh: PendingOpView, retainMs: number, rawOutcome: RetainedView["rawOutcome"], identity?: string): void {
    const entry: RetainedView = { ...fresh, expiresAt: Date.now() + retainMs, rawOutcome, identity };
    this.retained.set(key, entry);
    setTimeout(() => {
      if (this.retained.get(key) === entry) this.retained.delete(key);
    }, retainMs).unref?.();
  }

  /** Wait UP TO `ms` for the op keyed `key` to leave "running" state — the bounded settle-wait
   *  `gate_cancel` (card 8d585277) needs after asking an already-running gate to stop: a manager-facing
   *  tool call must answer promptly, never hang for however long the underlying `gateTimeoutMs` backstop
   *  might take if the kill is never verified. Returns `true` immediately if there's nothing running under
   *  `key` at all (already settled, or never existed) — nothing to wait for. Reuses the SAME
   *  `Promise.race(e.settle, sleep(ms))` shape `attach()` itself races against its own `waitMs`, rather
   *  than inventing a second concurrency primitive. Never consumes (does not evict/read `result`/`error`)
   *  — the caller that eventually calls `attach()`/`peek()` still gets the real settled value normally. */
  async waitBriefly(key: string, ms: number): Promise<boolean> {
    const e = this.entries.get(key);
    if (!e || e.state !== "running") return true;
    await Promise.race([e.settle, sleep(ms)]);
    return e.state !== "running";
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
   * `outcome` is ordinarily just caller-chosen display vocabulary this registry never reasons about — see
   * `PendingOpOutcome`'s own doc — with ONE hardcoded exception (card 171297dc): a classified outcome of
   * exactly `"cancelled"` also gates BOTH `retainVerdictUntilSuperseded`'s write and the TTL'd `retained`
   * map's dedupe-serve (see the class doc's "UNTIL-SUPERSEDED VERDICT CACHE" section) — a cancellation is
   * never a verdict worth replaying to a later re-call. Every existing caller whose `classifyOutcome`
   * never returns that exact string (or omits it) is unaffected; `confirmWorkerMergeTracked`'s own
   * `classifyOutcome` already maps a cancelled merge confirm to `"cancelled"` (predates this card,
   * unchanged), so this closes the trap with no caller-side change at all.
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
   *
   * `opts.retainVerdictUntilSuperseded` (card 1555e361 — see the class doc's "UNTIL-SUPERSEDED VERDICT
   * CACHE" section for the full incident/rationale, INCLUDING its process-local/not-persisted boundary):
   * opts a `key` INTO the separate, never-expiring `untilSupersededVerdicts` dedupe IN ADDITION TO (never
   * instead of) the ordinary `retainMs`-bounded `retained` check above — both are consulted on a miss
   * against `entries`, the until-superseded cache first. `opts.bypassRetained` gates BOTH reads identically
   * (a forceful re-call skips every cached answer, either map, and always mints fresh) — there is no
   * separate bypass flag for the until-superseded map. Independent of `retainMs`/`classifyOutcome`: a
   * caller can opt into this dedupe with or without also wanting the TTL'd display view:
   * `confirmWorkerMergeTracked` wants BOTH (`retainMs` for worker_list's brief terminal fill, this for the
   * actual safety-critical re-call dedupe). Omit it (every call site except the merge one, today) and
   * behavior is byte-identical to before this existed.
   *
   * `opts.verdictIdentity` (card 1555e361 CR follow-up — see the class doc's "IDENTITY-GATED SUPERSEDE"
   * section): meaningful ONLY alongside `opts.retainVerdictUntilSuperseded`; ignored otherwise. An opaque
   * caller-supplied string (for merge: the branch's freshly-resolved HEAD sha) — the cache read above
   * requires THIS call's identity to match the identity recorded at the cached verdict's OWN settle time; a
   * mismatch is a MISS (falls through to a fresh mint, bypassing the TTL'd `retained` fallback too — see
   * the class doc for why). Omit it and the dedupe stays identity-agnostic (`undefined` matches only
   * `undefined`), exactly as `retainVerdictUntilSuperseded` behaved before this opt existed.
   *
   * `opts.identityOptional` (card 1555e361 CR follow-up, Round 2 — the finalized-worker false-mismatch):
   * a PER-CALL override that skips the identity comparison entirely and trusts the cached verdict
   * REGARDLESS of `verdictIdentity` (as if it weren't given at all, on this one call). Needed because "the
   * identity this call can currently resolve" and "the identity the cached verdict was written against" can
   * genuinely diverge WITHOUT anything new having happened — e.g. for merge, a SUCCESSFUL confirm deletes
   * the branch as part of its own completion, so a later re-call literally cannot re-derive the SAME sha it
   * validated; comparing them would misclassify a pure poll as "different input" and mint a wasted (though
   * still safe — see the class doc) fresh op. The caller decides this PER CALL from context the registry
   * itself has no way to know (for merge: the worker's task has already reached its terminal lane — see
   * `confirmWorkerMergeTracked`'s own resolution) — set it ONLY when that context makes a genuine identity
   * change structurally impossible, never as a blanket escape hatch, or it silently re-opens the exact trap
   * `verdictIdentity` exists to close.
   * `bypassRetained` (a per-CALL, caller-decided-in-advance escalation), this is a per-VALUE predicate
   * evaluated against the cached `ok:true` outcome itself, at read time. A retention hit whose own settled
   * value already told an earlier caller it was unusable (e.g. `runWorkerGate`'s `headCurrent:false` — the
   * worktree moved WHILE that run was executing) has nothing to protect by being handed back again: unlike
   * the merge-op precedent the base retention dedupe exists to serve (avoiding a real re-run against an
   * already-torn-down worktree), there is no correctness value in re-serving a result the caller has
   * already been told to discard. When given and it returns `false` for the cached value, THIS call's read
   * is treated as a miss — falls through to the same fresh-mint path as a genuine cache miss below — while
   * the cache is still WRITTEN on every settle exactly as always (this predicate only gates the READ,
   * mirroring `bypassRetained`'s own read/write split). Never consulted for an `ok:false` (thrown error)
   * retained hit — an error carries no analogous staleness signal, so those are unaffected. Re-serving one
   * is also the SAFER choice, not merely the default: for merge, a throw can strike after the squash
   * already landed, so re-running risks compounding an unknown mid-mutation state; for gate, this window
   * answers whether an already-kicked-off run finished, not whether to retry. Omit it (every call site
   * except `runWorkerGate`, today) and behavior is byte-identical to before this existed — a retained hit
   * is always usable.
   *
   * SINGLE-FLIGHT UNDER REPEATED REJECTION: this predicate only changes which VALUES pass the retained-hit
   * check above — it never touches the RUNNING-entry branch at the top of this method. So even a caller
   * that keeps re-calling against a persistently-contaminated key (the worktree keeps moving) can never
   * mint two CONCURRENT real invocations: the first rejecting call falls through and synchronously
   * registers a fresh `entries` row (the same no-await window the ATOMICITY PROOF above already relies on)
   * before any `run()` internals ever `await`; every other call arriving before that fresh op settles finds
   * a RUNNING entry and attaches to it via the ordinary dedupe, never re-evaluating the (already-superseded)
   * retained cache at all. Worst case is still exactly one real invocation in flight per `key` at a time —
   * this predicate can only remove a wasted cache-hit round-trip, never add a concurrent one.
   *
   * `opts.onSurfacedPending` (card edc1ec12 — the restart-orphan signaling gap): fired SYNCHRONOUSLY, from
   * inside THIS call's own `if (e.state === "running")` branch below, the instant this call is about to
   * return `{settled:false}` — i.e. exactly (and only) when a caller is actually told "pending". A caller
   * durably persisting that fact (so a real process death before the eventual settle can still be
   * reconciled at boot — see SessionService.reconcileOrphanedGateOps) needs this write to be strictly
   * ORDERED before any possible settle: because this hook runs inside the same synchronous branch that
   * requires `e.state === "running"`, and settling is exactly what flips `e.state` away from "running"
   * (inside the `.then`/`.catch` below), JS's run-to-completion semantics make it IMPOSSIBLE for the settle
   * callback to fire in between this check and this hook's call — so a caller's "write a durable marker
   * here, clear it in `onSettledAfterPending`" pairing can never observe the clear running before the
   * write. Fires on EVERY call that observes "still pending" (not just the entry-creating one, unlike
   * `onSettledAfterPending` below) — harmless for an idempotent upsert keyed by `opId`.
   */
  async attach<T>(
    key: string, kind: PendingOpKind, managerSessionId: string, waitMs: number, run: (opId: string) => Promise<T>,
    onSettledAfterPending?: (outcome: { ok: true; value: T } | { ok: false; error: unknown }, opId: string) => void,
    opts?: {
      retainMs?: number;
      classifyOutcome?: (outcome: { ok: true; value: T } | { ok: false; error: unknown }) => PendingOpOutcome;
      bypassRetained?: boolean;
      retainVerdictUntilSuperseded?: boolean;
      verdictIdentity?: string;
      identityOptional?: boolean;
      isRetainedResultUsable?: (value: T) => boolean;
      onSurfacedPending?: (op: PendingOpView, opId: string) => void;
      /** Fires SYNCHRONOUSLY, exactly once per genuinely fresh entry — right after it's minted (registered
       *  under `key`, opId assigned), strictly before `run()` is ever invoked. Unlike `onSurfacedPending`
       *  (which only fires for an op that loses its race against `waitMs`), this fires for EVERY fresh op,
       *  fast or slow — a caller durably recording "this op exists" (card e3e40167 — a fast op that settles
       *  within `waitMs` never surfaces pending, so `onSurfacedPending` alone can't be used to mint a durable
       *  row for it) needs a mint-time hook, not a surfaced-time one. Never fires on a retry that merely
       *  attaches to an already-running entry, and never on a retained-cache hit (no fresh entry is minted
       *  in either case). */
      onOpMinted?: (opId: string) => void;
      /** Fires from inside the SAME identity-guarded settle branch as the RETAINED-view write and
       *  `onSettledAfterPending` (see the class doc) — i.e. ONLY for the entry-creating call's own `run()`,
       *  and NEVER for an entry an `evictDeadOwner()` call force-removed (that op's late settle finds a
       *  different object under `key` and this branch is skipped entirely, by design — see the class doc's
       *  DEAD-OWNER RECOVERY note). UNLIKE `onSettledAfterPending`, fires regardless of `surfacedPending` —
       *  a caller that needs to know "this op is DONE" durably (as opposed to "a caller is owed an async
       *  nudge") needs both the fast and the surfaced-pending path covered, not just the latter. Fires
       *  BEFORE `onSettledAfterPending` in the same synchronous callback, so a caller pairing "mark settled
       *  here, push the terminal nudge there" sees its own durable state already updated by the time the
       *  nudge goes out. */
      onSettle?: (outcome: { ok: true; value: T } | { ok: false; error: unknown }, opId: string) => void;
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
      //
      // UNTIL-SUPERSEDED DEDUPE, CHECKED FIRST (card 1555e361 — see the class doc's "UNTIL-SUPERSEDED
      // VERDICT CACHE" section, INCLUDING its process-local/not-persisted boundary): for a `key` that
      // opted into `opts.retainVerdictUntilSuperseded`, a settle verdict never ages out of
      // `untilSupersededVerdicts` on its own — so this check alone is what makes a re-call landing AFTER
      // `retainMs` has already lapsed still safe, instead of falling through to the fresh-mint path below
      // and re-invoking `run()` for real. `opts.bypassRetained` gates this read identically to the TTL'd
      // one just below — a forceful re-call skips both. No usability-predicate gate ON THIS READ: a
      // CANCELLED settle (card 171297dc) never reaches this map in the first place — the write below is
      // itself gated on the classified `outcome` (see the class doc's hardcoded `"cancelled"` exception) —
      // so there is nothing left here for a read-side gate to filter out.
      //
      // IDENTITY-GATED (card 1555e361 CR follow-up — see the class doc's "IDENTITY-GATED SUPERSEDE"
      // section): a cache hit only counts as a HIT when THIS call's `opts.verdictIdentity` matches the
      // identity recorded at the cached verdict's OWN settle time (`undefined === undefined` for a caller
      // that never opts into identity tracking — unaffected), OR `opts.identityOptional` says the
      // comparison doesn't apply to this call at all (see that opt's own doc — the finalized-worker
      // false-mismatch this ROUND 2 fixes). A genuine mismatch is a MISS: `untilSupersededMiss` below ALSO
      // skips the TTL'd `retained` fallback just past this block, because that map was written at the exact
      // same (now-stale) settle and would otherwise silently serve the identical wrong answer for its own
      // few-second window — a mismatch here must fall all the way through to a fresh mint, not merely to
      // the next cache.
      // `priorVerdict` is read UNCONDITIONALLY whenever this `key` opted in — even under `bypassRetained`,
      // which only gates whether it's SERVED (below), never whether it's LOOKED AT. A plain `Map.get` has
      // no side effect, so this costs nothing and is what lets a FORCED fresh mint still report what it
      // superseded (card 615967c5's `FreshMintInfo.priorIdentity`) instead of only a mismatched one.
      let untilSupersededMiss = false;
      const priorVerdict = opts?.retainVerdictUntilSuperseded ? this.untilSupersededVerdicts.get(key) : undefined;
      if (priorVerdict && !opts?.bypassRetained) {
        if (opts?.identityOptional || priorVerdict.identity === opts?.verdictIdentity) {
          // CACHE-HIT ANNOUNCEMENT (card 4aedde84 — the mirror of the FRESH-MINT REASON below): this branch
          // is a genuine cache hit — no run() invocation happens on this call at all — so the result is
          // tagged `cacheHit` instead of leaving the caller to infer "nothing ran" from the ABSENCE of
          // `freshMint` (the exact defect this card fixes). See CacheHitInfo's own doc for why this can
          // never coexist with `freshMint` on the same result.
          const cacheHit: CacheHitInfo = { identity: priorVerdict.identity };
          return priorVerdict.rawOutcome.ok
            ? { settled: true, ok: true, value: priorVerdict.rawOutcome.value as T, cacheHit }
            : { settled: true, ok: false, error: priorVerdict.rawOutcome.error, cacheHit };
        }
        untilSupersededMiss = true;
      }
      const retainedHit = untilSupersededMiss ? undefined : this.retained.get(key);
      // CANCELLED SENTINEL (card 171297dc — mirrors the untilSupersededVerdicts write gate above, same
      // "cancelled" string, same reasoning): a cancellation is not a verdict, so a plain re-call landing
      // INSIDE this short TTL window must not replay it either — checked unconditionally, ahead of (and
      // regardless of) `isRetainedResultUsable` below, since this applies independent of whether a caller
      // ever opted into that predicate at all.
      if (!opts?.bypassRetained && retainedHit && Date.now() < retainedHit.expiresAt && retainedHit.outcome !== "cancelled") {
        // USABILITY GATE (card 79b0ee52): an `ok:false` hit, or an `ok:true` hit with no
        // `isRetainedResultUsable` opt, is unconditionally usable — byte-identical to before this opt
        // existed. The `ok:false` half is a DELIBERATE, pre-existing contract from card 33172f01 (predates
        // this opt) — locked by test/pending-ops-registry.mjs's "(retain dedupe/failed)" cases, not a gap
        // for this opt to also close; see this method's own `isRetainedResultUsable` doc for why re-serving
        // an error is correct. An `ok:true` hit whose value the predicate rejects is treated as a MISS:
        // falls through to the fresh-mint path below instead of returning here, exactly like a genuine
        // cache miss.
        const usable = !retainedHit.rawOutcome.ok || !opts?.isRetainedResultUsable || opts.isRetainedResultUsable(retainedHit.rawOutcome.value as T);
        if (usable) {
          // CACHE-HIT ANNOUNCEMENT (card 4aedde84) — same reasoning as the untilSupersededVerdicts hit
          // above: this TTL'd retained-view hit is also a genuine cache hit, no run() invocation this call.
          const cacheHit: CacheHitInfo = { identity: retainedHit.identity };
          return retainedHit.rawOutcome.ok
            ? { settled: true, ok: true, value: retainedHit.rawOutcome.value as T, cacheHit }
            : { settled: true, ok: false, error: retainedHit.rawOutcome.error, cacheHit };
        }
      }
      // FRESH-MINT REASON (card 615967c5 — the cached-verdict-legibility fix): reaching this line means
      // BOTH cache reads above missed, so a genuinely new op is about to run — record WHY, purely for
      // reporting (this never feeds back into the decision above). `opts?.retainVerdictUntilSuperseded`
      // false/omitted (every kind but merge, today) leaves this `undefined` — byte-identical to before.
      const freshMint: FreshMintInfo | undefined = !opts?.retainVerdictUntilSuperseded
        ? undefined
        : opts?.bypassRetained
        ? { reason: "forced", ...(priorVerdict?.identity !== undefined ? { priorIdentity: priorVerdict.identity } : {}) }
        : untilSupersededMiss
        ? { reason: "identity-mismatch", priorIdentity: priorVerdict?.identity }
        : { reason: "genuinely-new" };
      const fresh: Entry<T> = {
        opId: randomUUID(), kind, key, managerSessionId, startedAt: new Date().toISOString(),
        state: "running", settle: Promise.resolve(), surfacedPending: false, freshMint,
      };
      this.entries.set(key, fresh);
      // MINT HOOK (card e3e40167): fires here, synchronously, before `run()` is ever invoked — see
      // `opts.onOpMinted`'s own doc for why this must be unconditional (not gated on surfacedPending like
      // onSurfacedPending below) and why it fires for every fresh entry, not just this one branch's own.
      opts?.onOpMinted?.(fresh.opId);
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
            if (opts?.retainMs) this.retain(key, projectView(fresh), opts.retainMs, { ok: true, value }, opts.verdictIdentity);
            // UNTIL-SUPERSEDED WRITE (card 1555e361): same identity-guarded branch as the TTL'd retain()
            // above, same reason (an evicted dead-owner op's late settle must never resurrect/overwrite a
            // live successor's verdict) — see the class doc's "UNTIL-SUPERSEDED VERDICT CACHE" section
            // (PROCESS-LOCAL, NOT PERSISTED — a daemon restart clears this map). A genuinely fresh op
            // settling later under the same key (reachable via opts.bypassRetained, OR — card 1555e361 CR
            // follow-up — via a mismatched opts.verdictIdentity, see "IDENTITY-GATED SUPERSEDE") reaches
            // this SAME line again and its `.set()` naturally supersedes this entry — no separate eviction
            // path needed. `opts` here is the MINTING call's own closure (a retry that merely attached never
            // re-registers this callback), so the identity stamped is exactly what was fresh at the moment
            // this specific run() was actually kicked off, never a later re-poller's.
            // CANCELLED SENTINEL (card 171297dc): `fresh.outcome === "cancelled"` (set two lines above, from
            // this SAME call's `classifyOutcome`) vetoes this write — see the class doc's "ONE HARDCODED
            // EXCEPTION" note. Every other classified outcome (or no classifyOutcome at all) is unaffected —
            // byte-identical to the unconditional write this line used to be.
            if (opts?.retainVerdictUntilSuperseded && fresh.outcome !== "cancelled") this.untilSupersededVerdicts.set(key, { rawOutcome: { ok: true, value }, identity: opts.verdictIdentity });
            opts?.onSettle?.({ ok: true, value }, fresh.opId);
            if (fresh.surfacedPending) onSettledAfterPending?.({ ok: true, value }, fresh.opId);
          }
        },
        (err) => {
          fresh.state = "failed"; fresh.error = err;
          fresh.outcome = opts?.classifyOutcome?.({ ok: false, error: err });
          if (this.entries.get(key) === fresh) {
            this.entries.delete(key);
            if (opts?.retainMs) this.retain(key, projectView(fresh), opts.retainMs, { ok: false, error: err }, opts.verdictIdentity);
            // UNTIL-SUPERSEDED WRITE — mirrors the `ok:true` branch above, same doc, same "cancelled" veto
            // (a thrown error has no analogous cancelled shape today, so this is unaffected in practice).
            if (opts?.retainVerdictUntilSuperseded && fresh.outcome !== "cancelled") this.untilSupersededVerdicts.set(key, { rawOutcome: { ok: false, error: err }, identity: opts.verdictIdentity });
            opts?.onSettle?.({ ok: false, error: err }, fresh.opId);
            if (fresh.surfacedPending) onSettledAfterPending?.({ ok: false, error: err }, fresh.opId);
          }
        },
      );
      e = fresh;
    }
    if (e.state === "running") await Promise.race([e.settle, sleep(waitMs)]);
    if (e.state === "running") {
      e.surfacedPending = true;
      const view = projectView(e);
      opts?.onSurfacedPending?.(view, e.opId);
      // `e.freshMint` is read off the ENTRY (not the local `freshMint` computed above), so a caller who
      // merely attached to an already-running op — a poll, never having minted anything itself this call —
      // still sees the SAME reason the entry-creating call recorded. See the class doc + `Entry.freshMint`.
      return { settled: false, op: view, freshMint: e.freshMint };
    }
    return e.state === "done"
      ? { settled: true, ok: true, value: e.result as T, freshMint: e.freshMint }
      : { settled: true, ok: false, error: e.error, freshMint: e.freshMint };
  }
}

/** How long worker_spawn/worker_merge_confirm stay SYNCHRONOUS before degrading to a pending handle —
 *  comfortably under the client-side MCP timeout that trips on a real multi-minute gate run (Auditor
 *  b9515beb), comfortably above a typical fast merge/spawn. Below this, both tools return their EXACT
 *  today's-shape result; only a genuinely slow op degrades. */
export const SYNC_ATTACH_BUDGET_MS = 12_000;
