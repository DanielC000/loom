# 08e4b661 — the REST until-settled merge loop waits on the op's opId, never re-invokes the closure

## The bug

`confirmWorkerMergeUntilSettled` (`sessions/service.ts`, the REST-only wrapper behind
`POST /api/sessions/:id/merge`) used to loop `while (!r.settled && Date.now() < deadline) { r = await
confirmWorkerMergeTracked(...) }` whenever its first call degraded to `{settled:false, op}` past
`SYNC_ATTACH_BUDGET_MS`. Each retry re-invoked `confirmWorkerMergeTracked`, which re-resolves its own
`verdictIdentity` via two pre-attach awaits (`confirmMergeBranchTipReader`/`confirmMergeMainlineHeadReader`)
*before* it ever calls `pendingOps.attach()` again.

If the first op settles (and evicts — `PendingOpRegistry` is evict-on-settle) during that pre-attach
window, the retry's own `attach()` call finds no running entry for `merge:${workerSessionId}` and — for
any outcome in `NEVER_CACHED_OUTCOMES`, or (after card 3a460d4a) an unresolved/mismatched
`verdictIdentity` — mints a genuinely SECOND real op instead of a cache hit. The loop then returned that
second op's outcome and opId as if it were the first's, silently dropping the first op's real verdict.
3a460d4a's own "Cost" section already named this shape; this card fixes it rather than merely documenting
it.

## Reproduction

Confirmed deterministically (2/2 runs) with a seam mirroring `merge-confirm-supersede-mint-window.mjs`:
stub `confirmMergeBranchTipReader` to force `verdictIdentity` to `undefined` on every call (the
documented fail-safe path), and on its 2nd invocation (the retry's own pre-attach read) release the first
op's held-open gate and await its real settle+eviction via `pendingOps.waitBriefly` before letting the
retry proceed into its own `attach()`. Result: exactly one retry iteration, the real gate command ran
only once (the second op's own idempotent "already landed" preflight short-circuited it rather than
re-running), but TWO distinct `pending_gate_ops` rows were minted for one logical call, and the returned
result carried the SECOND op's opId — never the first's. See
`packages/daemon/test/merge-until-settled-second-mint.mjs` for the committed version of this repro.

## The fix

Call `confirmWorkerMergeTracked` exactly once. If it degrades to `{settled:false, op}`, wait on THAT op's
own `opId` via `PendingOpRegistry.awaitSettleByOpId` (card 89539537) instead of re-invoking the closure —
mirroring the already-proven test helper `awaitTrackedSettle` (`test/_settle-tracked-monotonic.mjs`). The
loop's own deadline / `gateCommandTimeoutMs * 6` ceiling is unchanged: `remaining` (deadline minus now) is
simply what gets passed as `awaitSettleByOpId`'s own `timeoutMs`, so the total wall-clock bound a caller
can observe is identical to before.

## The one eviction residual (named, not closed)

`awaitSettleByOpId` can return `undefined` for two different reasons: the entry is still running past
`timeoutMs`, or a DIFFERENT caller's `evictDeadOwner()` removed the entry in the narrow window between
this call's first `attach()` returning pending and this call's own `awaitSettleByOpId` scan — before the
orphaned `run()` has written the unconditional `settledByOpId` record. In that second, narrow case, the
op is still genuinely running (just unobservable to this call for a moment), and `awaitSettleByOpId`'s own
doc already says not to treat `undefined` as "never ran."

This fix does not add a retry-on-undefined loop — matching `awaitTrackedSettle`'s own posture — and
instead degrades exactly as a timed-out poll always has: it returns the original `first` result
(`{settled:false}`, carrying the FIRST op's own `opId`), never synthesizing a result for a second op this
call never minted. What the REST client sees on this path is unchanged from before this card: a
`pending:true`/`merged:null` response naming the same op it was already told about. A later re-poll (the
client calling the REST route again) is a brand-new top-level `confirmWorkerMergeUntilSettled` call,
which still runs its own first `confirmWorkerMergeTracked` attempt exactly as it always has (dead-owner
check included) — that re-call path is untouched by this card.

The adjacent, narrower race IS covered deterministically: the first op settling strictly AFTER this
call's own `confirmWorkerMergeTracked` returns `{settled:false}` but BEFORE `awaitSettleByOpId` is called
at all. `recordSettleByOpId` writes unconditionally at settle time (before the identity-guarded
`entries.delete`), so by the time `awaitSettleByOpId` runs, the record is already there even though the
entry itself may already be evicted from `entries` — the wait returns the first op's real outcome
immediately, never `undefined`. See the same test file's second scenario.

## `skipDeadOwnerRecovery` is now dead in production

Its only production caller was the retry loop this card removes. It is kept (not removed) because
`merge-rest-route-tracked.mjs` scenario (7) still exercises it directly as a standalone probe of
`confirmWorkerMergeTracked`'s own tolerance for a stale, lineage-matching (not exact) caller attaching to
a running op — a correctness property worth keeping covered even though no production code path reaches
it with `true` anymore.

## Do not

- Do not recover a `{settled:false}` op's outcome by re-calling `confirmWorkerMergeTracked` a second time
  from `confirmWorkerMergeUntilSettled` — see 89539537 for why this is unsafe in general; this card is the
  concrete production instance of exactly that hazard.
- Do not add a retry-on-undefined loop around `awaitSettleByOpId` here — the one named residual above is
  accepted, matching the reference implementation's own posture, not a gap this card closes.
- Do not remove `confirmWorkerMergeTracked`'s `skipDeadOwnerRecovery` option on the theory that it has no
  production caller post-fix — `merge-rest-route-tracked.mjs` scenario (7) still needs it as a direct,
  standalone probe.

## Tests

`packages/daemon/test/merge-until-settled-second-mint.mjs` — scenario (1) proves exactly one
`pending_gate_ops` row is ever created per logical call and the returned opId matches the first (and
only) op minted; RED-proofed against pre-fix code via a temporary revert/rebuild/restore cycle (not a
baked-in negative control — there is no bogus-pattern equivalent for "which code path ran"). Scenario (2)
proves the adjacent settle-before-await race resolves to the first op's real outcome immediately, never
`undefined`.

`merge-rest-route-tracked.mjs` scenarios (4) and (7) had their own header/inline comments corrected: both
used to narrate the old internal retry loop's mechanics ("~100+ poll iterations", "mirrors exactly what
the loop's own while body does internally") — mechanics that no longer exist post-fix. Their actual
assertions were unaffected (traced line-by-line before this fix landed) and stay green; only the prose
was stale.
