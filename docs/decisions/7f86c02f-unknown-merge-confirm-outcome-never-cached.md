# 7f86c02f — a thrown confirm's `"unknown"` outcome is never cached or replayed

## Narrative

Card 479f449f classified a thrown `confirmWorkerMerge` whose own race-recovery re-derive could not prove
either way whether the squash had already landed as `"unknown"` — a distinct, honest non-answer, never
`"failed"`. That classification was NOT originally added to `NEVER_CACHED_OUTCOMES`
(`orchestration/pending-ops.ts`), so `confirmWorkerMergeTracked`'s until-superseded verdict cache
(decision `1555e361`) happily stored it, keyed on the resolved `verdictIdentity` (branch tip + main tip).

This was reachable in production: nothing about reaching "unknown" requires the branch's identity to
have changed. A manager who plain-re-confirms (no new commit, main unchanged) at the exact same identity
got the stale cached `"unknown"` error replayed verbatim — `confirmWorkerMerge` was never invoked a second
time, so a transient fault in the first attempt's recovery (the only way `"unknown"` is ever reached —
see 479f449f) could never clear on retry. Reproduced directly: a thrown confirm classifies "unknown" and
writes `untilSupersededVerdicts` under a DEFINED, resolved identity; a second call with the identical
identity hits that cache (`cacheHit` set) without invoking `runGate` again. Card `3a460d4a` (landed just
before this one) does not touch this case — it only closes the narrower gap where BOTH sides' identity is
`undefined`; here both sides resolve the same real sha.

This is exactly the same shape as the other transient-probe-failure entries already in
`NEVER_CACHED_OUTCOMES` (`"landed-tip-unverifiable"`, `"fork-point-unverified"`,
`"worktree-gone-landing-unconfirmed"`, `"branch-tip-unresolvable"`, `"canonical-repo-shallow"`): the
PROBE itself (here, `findLandedSquashCommit`'s re-derive) failed or was inconclusive, not a confirmed
fact about the branch — identity can stay identical across a re-call even though nothing about the
branch's real state has changed, so a cached replay cannot distinguish "still genuinely unknown" from "a
transient fault that would have cleared on a fresh attempt."

## "unknown" and a landing are not mutually exclusive (Code Review correction)

**RETRACTED** — this section originally claimed reaching `"unknown"` means the recovery's own
`finishAlreadyMerged`-shaped re-derive already failed to prove a landing, so a successful recovery
(`"merged"`/`ALREADY_MERGED`) and `"unknown"` were mutually exclusive by construction. **That is false.**
A confirm can throw AFTER its own squash has genuinely landed, and — in the specific shape below — AFTER
`finalizeMerge` has already run to full completion, INCLUDING its own `merge_done` append, the worktree
removal, and the task's move to its terminal column. If the REACTIVE recovery probe
(`tipAcrossLandedCheck`, the method `confirmWorkerMergeTracked`'s own catch block calls to re-derive the
truth from git) is ALSO transiently broken at that exact moment, the outer call still classifies
`"unknown"` — `merge_done` was already filed, the branch is really merged, and the reported outcome is
still `"unknown"`. Reproduced deterministically in
`packages/daemon/test/merge-confirm-post-squash-throw-recovery.mjs` (adapted from a Code Review fixture):
a "post" throw mode patches `finalizeMerge` to run its real work in full and then throw anyway, with
`tipAcrossLandedCheck` forced to return no result for that same window.

## Why a re-confirm still never double-lands or double-appends merge_done

The no-double guarantee is **NOT this card's own fix** — it is `finalizeMerge`'s own, independent,
pre-existing replay-suppression (@decision e34d475c round 7, card 1f395ce9): `service.ts`'s
`replayMergeDoneForThisBranch` check (~line 27327) matches a prior `merge_done` event on this exact
`taskId`+`branch` (comparing `detail.mergedSha` too whenever both sides carry one) and suppresses a
second append when it matches. That check is gated on `opts.suppressMergeDoneOnReplay`, set at exactly
ONE call site: `finishAlreadyMerged`'s own `finalizeMerge` call (~line 22218) — the SAME idempotent path
a re-confirm after `"unknown"` always goes through (never a second real squash; `mergeBranch` is never
called again — only `finalizeMerge`'s bookkeeping tail re-runs, and THAT is what gets suppressed). This
card's fix (excluding `"unknown"` from `NEVER_CACHED_OUTCOMES`) only changes whether the re-confirm is
ALLOWED to happen at all (vs. replaying the stale cached error forever) — it does not, and must not,
touch this suppression; removing `"unknown"` from the cache cannot cause a second real squash either way,
since the re-run's own `finishAlreadyMerged` short-circuit is what runs, not `mergeBranch`.

## Why "post" mode specifically needed this fix, and "pre" mode did not

The two throw-timing shapes in the test above ("pre": `finalizeMerge` throws before doing any real work;
"post": `finalizeMerge` completes in full, then throws anyway) differ in exactly one load-bearing way
pre-fix. `confirmWorkerMergeTracked` computes `alreadyFinished = worktreeGone || taskAlreadyTerminal`
from the CURRENT (pre-this-call) worker/task state and passes `identityOptional: alreadyFinished` into
`attach()` (see the "ALREADY-FINISHED OVERRIDE" doc at that call site). In "post" mode, by the time a
re-confirm runs, `finalizeMerge`'s own already-completed work has made BOTH halves of that condition true
(worktree gone, task terminal) — so the re-confirm's own `identityOptional` is `true`, which makes
`attach()`'s until-superseded cache check SKIP the identity comparison entirely
(`opts?.identityOptional || (priorVerdict.identity !== undefined && priorVerdict.identity ===
opts?.verdictIdentity)`) and, pre-fix, serve the stale cached `"unknown"` UNCONDITIONALLY — regardless of
whether anything else moved. In "pre" mode, the worktree still exists and the task is still in its
original column after the first throw, so `identityOptional` stays `false` — and the ordinary
identity-mismatch mechanism (the branch's own squash, already landed by call 1 via `mergeBranch`,
advances the canonical-main-tip half of the identity) already forces a fresh mint, independent of this
card. **Measured directly** (negative-control, reverting this card's own fix): only the 7 "post"-mode
checks in the test's full matrix go RED (both solo variants, batch-fallback, concurrent, and the
probe-throws variant) — every "pre"-mode check stays GREEN even pre-fix, because that mode happens to
carry its own, unrelated protection. **"post" mode is the one shape that actually needed this fix in
production**; "pre" mode would, by coincidence of the already-finished override's own scope, have been
safe even without it.

## Accepted cost: the 5s TTL retained-map duplicate-guard no longer covers "unknown"

`NEVER_CACHED_OUTCOMES` gates BOTH the until-superseded map (1555e361) and, via `usableRetainedHit`, the
5-second TTL `retained` map that decision `33172f01` added specifically to stop an accidental duplicate
re-confirm from re-running against a torn-down worktree. Adding `"unknown"` here removes that short-window
protection for it too — the SAME trade-off every other transient entry in this set already accepts. For
`"unknown"` specifically, reaching the classification at all means recovery did NOT find a landed squash,
so (barring the narrow window between a squash commit and `finalizeMerge`'s own worktree teardown) the
worktree is ordinarily still present; an accidental duplicate re-confirm within the 5s window runs a
genuinely fresh (and safe) attempt rather than being deduped, same as it would for
`"worktree-gone-landing-unconfirmed"` today.

## Do not

- Do not cache or replay a classified `"unknown"` merge-confirm outcome — reaching it means the recovery
  PROBE itself was inconclusive, not a resolved fact about the branch; a re-call at the identical identity
  must genuinely re-attempt the recovery + gate.
- Do not read this as a second door back into caching `"unknown"` via the 5s TTL `retained` map —
  `NEVER_CACHED_OUTCOMES` is consulted by both caches; excluding it from one and not the other would
  silently reopen the exact bug this card fixes for any re-call landing inside that short window.
- Do not conflate this with 1f395ce9's `merge_done` duplication guard — see "Why a re-confirm still
  never double-lands" above; `"unknown"` and a landing are NOT mutually exclusive, and the no-double
  guarantee is `finalizeMerge`'s own pre-existing replay-suppression, not this card's fix.
- Do not assume "pre" and "post" throw-timing modes carry the same risk pre-fix — only "post" mode's own
  `identityOptional` bypass (see "Why 'post' mode specifically needed this fix" above) makes the stale
  cache replay unconditional; "pre" mode happens to stay safe via an unrelated, pre-existing mechanism.

## merge_batch's own throw classification (Code Review S3)

`mergeBatchTracked`'s own `classifyOutcome` (`service.ts`, ~line 23728) maps EVERY thrown batch to the
SAME literal string `"unknown"` as the solo path — `(outcome) => (!outcome.ok ? "unknown" : ...)`. Since
`NEVER_CACHED_OUTCOMES` is one shared set consulted by both the solo and batch `classifyOutcome` lambdas,
this card's fix applies to `merge_batch` automatically, with no separate code change: a re-fire of
`merge_batch` with the SAME `workerSessionIds` after a thrown batch now genuinely re-assembles and
re-gates, rather than re-attaching to the stale "just-settled" op the way an ordinary re-fire does (see
`merge_batch`'s own tool description, `mcp/orchestration.ts`, for the general re-attach behavior this is
now a deliberate exception to). **Accepted, consistent with the solo ruling** — a thrown batch's own
recovery probe failing is exactly as uninformative about the resolved candidates as a thrown solo
confirm's probe failing is about the branch; caching it would risk the identical stale-replay hazard this
whole card exists to close, just for a batch instead of a solo worker.

Test: `packages/daemon/test/merge-batch-thrown-unknown-not-replayed.mjs` — a thrown batch (classified
`"unknown"`), then a re-fire with the identical `workerSessionIds`, genuinely re-runs (never a `cacheHit`)
and lands each candidate at MOST once (no double squash, no duplicate `merge_done`, mirroring the solo
no-double guarantee's own mechanism — see "Why a re-confirm still never double-lands" above, which
applies identically here since the batch path's own fallback routes through the SAME
`confirmWorkerMergeTracked`/`finishAlreadyMerged` idempotent machinery). The "may-have-landed rethrow"
case (the batch's own recovery probe itself throwing) is NOT separately covered for the batch path — a
residual, same shape as the solo path's own probe-throws coverage in
`merge-confirm-post-squash-throw-recovery.mjs`, not yet ported to the batch entrypoint.

### Do not (S3)

- Do not read `merge_batch`'s tool description's general "a re-fire re-attaches to the already-running
  (or just-settled) op" claim as unconditional — a thrown batch (`"unknown"`) is the one deliberate
  exception, and the description now states so.
- Do not assume this needed a code change — `NEVER_CACHED_OUTCOMES` is ONE shared set; adding `"unknown"`
  to it changed BOTH `classifyOutcome` lambdas' caching behavior in the same commit, by construction.

## Tests

`packages/daemon/test/pending-ops-registry.mjs` — a classified `"unknown"` outcome with a DEFINED,
matching `verdictIdentity` across two `attach()` calls mints fresh both times (no dedupe hit); a real
cached `"rejected"`/`"merged"` outcome at the same identity still dedupe-hits (the fix doesn't over-widen).
A moved-tip case (fresh identity after a new commit) and a re-fire-after-clear case (a later REAL settled
verdict at the same identity DOES cache) are both covered, per the standing "any cache-shape change needs
a moved-tip test AND a re-fire-after-clear test" rule.

`packages/daemon/test/merge-confirm-thrown-error-recovery.mjs` — scenario (B) extended with a 3rd, plain
re-confirm call asserting `runGate` is invoked a 2nd time (a genuine re-evaluation, no `cacheHit`).
Scenario (A) — see "Honest scope" below for why it does NOT exercise a thrown race at all — extended with
a plain re-confirm proving the idempotent ALREADY_MERGED finish still fires, exactly one `merge_done`
event is recorded, and the canonical repo gains no second commit. Scenario (C) (added, Code Review
condition 2): a genuinely `"unknown"` confirm whose worktree then disappears (an external cleanup,
independent of this confirm's own flow) resolves the EXACT `worktreeGoneLandingUnconfirmed` shape on
re-confirm — `ok:true`, `merged:false`, no `cacheHit`, `runGate` NOT re-invoked, the task left
`in_progress`, zero `merge_done` events, exactly one `[loom:merge-rejected]` nudge, and `peek()`'s own
`outcome` naming it — never an either/or with a thrown re-attempt (an earlier either/or shape let a
pre-fix cache REPLAY of the first call's own thrown error pass this check undetected, since
`result.error instanceof Error` is true for a replayed error too).

`packages/daemon/test/merge-batch-fallback-already-merged-idempotent.mjs` — the ALREADY_MERGED
idempotent-finish invariant (see "Honest scope" below for why it is NOT a thrown-"unknown" case) routed
through `merge_batch`'s fallback path (`runFallback` → `confirmWorkerMergeTracked`), proving the fallback
candidate's re-confirm also finishes idempotently rather than double-squashing or duplicating `merge_done`.

`packages/daemon/test/merge-confirm-post-squash-throw-recovery.mjs` (added, Code Review S2) — the actual
`"unknown"-after-a-real-landing` shape (see "'unknown' and a landing are not mutually exclusive" above),
covering "pre"/"post" throw timing x solo/solo-after-5s/batch-fallback/two-genuinely-concurrent
re-confirms, plus the recovery-probe-itself-throws variant, for solo pre/post.

## Honest scope: `merge-confirm-thrown-error-recovery.mjs`'s scenario (A) does not exercise a thrown race

Verified by instrumentation (a logging `runGate` stub, zero invocations observed): with `preLand:true`,
`confirmWorkerMerge`'s own EARLY `findLandedSquashCommit` preflight finds the work already on main and
resolves `{merged:true, gateSkipped:"already-landed"}` WITHOUT ever invoking the gate at all — this holds
both via `confirmWorkerMergeTracked` directly and via `mergeBatchTracked`'s fallback path. So scenario
(A), despite its header's "confirmWorkerMerge throws... the recovery re-derives the truth from git"
framing, does NOT exercise a genuine thrown-then-recovered race at all; it exercises the separate,
pre-existing "already-landed, skip gate" short-circuit. The injected `runGate` throw is reachable only
when the branch has NOT already landed (scenario (B), `preLand:false`).

The TRUE "confirm throws AFTER the squash committed, BEFORE or AFTER finalize completes" shape needs
either two genuinely overlapping confirms (a dead-owner eviction re-mint racing its predecessor's own
in-flight `finalizeMerge`) — which `merge-confirm-thrown-error-recovery.mjs`'s own header defers to
`merge-rest-route-tracked.mjs` block (4), ~4% natural rate, not a deterministic fixture — OR a single
confirm whose OWN `finalizeMerge`/`tipAcrossLandedCheck` calls are forced to fail transiently via an
injectable seam, which IS now covered deterministically by
`merge-confirm-post-squash-throw-recovery.mjs` (Code Review S2; see "'unknown' and a landing are not
mutually exclusive" above) — a single-confirm reproduction of the same outward shape (throw after a real
landing, recovery also broken), not the literal two-confirm race itself. What `merge-confirm-thrown-error-
recovery.mjs`'s own scenario (A) and `merge-batch-fallback-already-merged-idempotent.mjs` prove instead is
the narrower downstream idempotency invariant (exactly one `merge_done`, no double squash, task moved to
done) via the cheaper, deterministic `gateSkipped:"already-landed"` entrypoint — a DIFFERENT, non-throwing
shape (see "Honest scope" below), still useful as idempotency coverage but not a stand-in for the
throw-after-landing shape `merge-confirm-post-squash-throw-recovery.mjs` now covers directly.

### Do not (honest scope)

- Do not assume a `preLand:true`-shaped fixture anywhere in this test family exercises the gate/throw
  path — verify with a logging stub before relying on it; `findLandedSquashCommit`'s early preflight
  short-circuits before the gate whenever the content is already on main.
- Do not read `merge-confirm-thrown-error-recovery.mjs`'s scenario (A) as a reproduction of the
  dead-owner-eviction race — it demonstrates the SAME idempotency invariant via a different, deterministic
  entrypoint, not the race itself.
