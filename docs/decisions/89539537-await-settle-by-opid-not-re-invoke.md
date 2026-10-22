# 89539537 — recover a `{settled:false}` op's verdict by opId, never by re-invoking its closure

`PendingOpRegistry.attach()` degrades to `{settled:false, op}` for a slow op (see `SYNC_ATTACH_BUDGET_MS`).
The test helper `awaitTrackedSettle` (`packages/daemon/test/_settle-tracked-monotonic.mjs`) used to recover
from that degrade by re-calling the SAME tracked closure (e.g. `confirmWorkerMergeTracked`) in a loop until
it saw `{settled:true}`.

That is unsafe for any `key` whose outcome falls in `NEVER_CACHED_OUTCOMES` (a refusal, `stale-base`,
`worktree-dirty`, …) — those outcomes are deliberately never written to either the TTL'd `retained` cache
or the `untilSupersededVerdicts` cache, precisely so a manager's documented "just re-call" retry genuinely
re-gates. If the FIRST op happens to settle in the gap between the caller observing `{settled:false}` and
its next poll, a re-call under those conditions does not attach to anything — it legitimately mints a
genuinely SECOND real op. The loop then returned that second op's verdict as if it were the first's: a
test asserting on "the op it started" was actually asserting on a different run. Card `b2c5a8f9` observed
this concretely on a batch merge under a forced `syncAttachBudgetMs:1`, where the underlying op (a fast
gateless cross-lineage refusal) settled in low single-digit milliseconds — faster than the loop's own
call-await-call round trip.

`PendingOpRegistry.awaitSettleByOpId(opId, timeoutMs)` closes this by never touching the closure again:
it reads the one specific op named by `opId` — the live `Entry` by reference while it's still running
(unaffected by the registry's evict-on-settle, since a reference holder sees the entry's final
state/result/error regardless of map deletion), or, for the race where it already settled and evicted,
a short-lived, unconditional, opId-keyed record (`settledByOpId`) written at every real settle regardless
of `NEVER_CACHED_OUTCOMES`/`retainMs`/`retainVerdictUntilSuperseded` — none of which apply here, since this
is not a cache for a future caller under the same `key`, only a one-time record for the one caller who was
handed this exact opId.

## Do not

- Do not recover a `{settled:false}` op's outcome by re-calling the production closure that minted it —
  for a `NEVER_CACHED_OUTCOMES` key this can mint a genuinely second real op and silently report its
  verdict as the first op's.
- Do not gate the `settledByOpId` write on `NEVER_CACHED_OUTCOMES`, `retainMs`, or
  `retainVerdictUntilSuperseded`, and do not identity-guard it the way the `retained`/
  `untilSupersededVerdicts` writes are — it must record every real settle, including a
  dead-owner-evicted op's late settle, since the one caller holding that op's exact `opId` still deserves
  its real outcome independent of whatever replaced it under the shared `key`.
- Do not treat `awaitSettleByOpId` returning `undefined` as "this op never ran" — it only means the
  entry is still running past `timeoutMs`, or the bogus/aged-out opId. Poll promptly after a
  `{settled:false}` reply; do not hold onto an opId indefinitely before reading it.
