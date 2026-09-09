# 6dcb9cd3 — `formatWeakerPassWarning` is the ONE place the "weaker pass" wording is authored

## Narrative

Card 6dcb9cd3: `formatWeakerPassWarning` is the ONE place the "⚠ WEAKER PASS" wording is authored — reused by BOTH the live `[loom:merge-done]` nudge (`confirmWorkerMergeTracked`'s `onSettle`, `sessions/service.ts`) and the pull-based `gate_status(opId)` settled-record read (`retryWarning`, same file). Before this card the nudge had its own inline template literal and `gate_status` had no warning at all — a manager who missed the nudge and polled `gate_status` instead saw `outcome:"pass"` next to a `steps[]` entry with a real failure and nothing explaining it (the card's own measured finding, op `3954a69f`). A single formatter means the two surfaces can never drift into two different tellings of the identical fact.

It takes `retriedFile` as callers already store it — a bare name, or (card 67030bb9, bounded multi-file retry) a comma-joined list of names, never containing a literal comma itself (the identifier guard in `identifyRetriableTestFiles` makes that structurally impossible). Never call this when no retry fired — every call site gates on a truthy `retriedFile` first.

Card 9966c52d: `outputTail` is OPTIONAL and additive, for `isTimeoutKillEntry`'s own timeout-vs-assertion classification — omitted (or not matching for every retried name), this returns the ORIGINAL cross-test-pollution wording, the fail-safe default.

Card 67030bb9: `batchBranchCount` is OPTIONAL and additive, passed only by the BATCH gate path — a batch retry is a STRONGER claim than a solo one when it lands (a green retry asserts every ASSEMBLED branch will land together on the strength of this ONE retry). CORRECTED (card 553ea58c): an earlier version claimed "a green retry lands EVERY branch in the batch" unconditionally — false whenever the retry's own gate passes but the batch's fast-forward afterward still forfeits, or its post-gate HEAD read fails. Every call site now passes `batchBranchCount:undefined` for exactly that shape, so this function never has to know WHY the count is absent.

Card 9bdc8ea5: this function's signature/body are unchanged by that card — see its sibling `formatRetryAlsoFailedWarning` for the FAILED-retry case. A `passed: boolean = true` default was tried and reverted (Code Review): it recreates the exact defect the card fixes for any future caller that forgets the 4th arg, and `tsc` cannot catch a missing defaulted arg. Making `passed` REQUIRED instead was also rejected: `gate-status.mjs` alone has eight existing call sites passing 1-2 args (a `.mjs` test file, zero `tsc` coverage), every one of which would start passing `passed: undefined` at runtime and silently flip into a fail-branch. A separate, distinctly-named function touches ZERO existing callers and removes the forgettable-boolean footgun outright.

## Do not

- Do not inline a second copy of this wording anywhere else (nudge or `gate_status`) — both surfaces must call this one formatter, or they will drift.
- Do not add a `passed` boolean parameter to this function to cover the failed-retry case — use the sibling `formatRetryAlsoFailedWarning` instead; a defaultable/forgettable boolean here previously produced a false "weaker pass" claim with no compiler catch.
- Do not claim a batch retry lands every assembled branch unconditionally — pass `batchBranchCount:undefined` whenever the batch's post-retry fast-forward could still forfeit.

## Source

JSDoc comment in `packages/daemon/src/orchestration/gate-runner.ts`, above `formatWeakerPassWarning`: originally lines 1527-1574, as of this tranche's HEAD. Relocated by card `b80a2d76` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
