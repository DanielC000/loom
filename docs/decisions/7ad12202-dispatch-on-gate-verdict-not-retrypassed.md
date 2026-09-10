# 7ad12202 — `retryWarning` dispatch checks the GATE's own verdict first, never `retryPassed` alone

## Narrative

Card 7ad12202 Code Review BLOCKING [1]: `gateStatus`'s `retryWarning` dispatch used to branch on `payload.retryPassed` ALONE — `formatWeakerPassWarning` on `true`, `formatRetryAlsoFailedWarning` on `false` — which was sound only as long as a `true` `retryPassed` could ONLY ever coexist with a genuinely PASSED gate. Card 7ad12202's own resume mechanism broke that: a rescued single-file retry can pass while a LATER step (one the original `&&` chain never reached) is resumed afterward and genuinely fails — `retryPassed:true` alongside `outcome:"fail"`/`t.record.verdict === "fail"`. Dispatching on `retryPassed` alone rendered `formatWeakerPassWarning`'s "WEAKER PASS" text on a REJECTED record — prose asserting a pass that did not happen, the exact defect class card `9bdc8ea5` exists to remove, reopened by a different mechanism.

Fixed by checking the GATE's own real verdict FIRST: `t.record.verdict === "pass"` (never `retryPassed`) decides whether the whole gate actually passed; `retryPassed` is consulted only WITHIN the rejected branch, to choose between `formatRetryAlsoFailedWarning` (the retry itself also failed) and `formatRetryRescuedButGateRejectedWarning` (the retry passed, but the resume then broke) — see that function's own doc for why neither of the other two formatters is honest for this case.

## Decision B: `gate-runner.ts`'s own resume mechanics — the discriminator and the field-merge rules

### Narrative

A `&&`-chained `gateCommand` whose NON-FINAL step fails short-circuits `runGateSequential` — steps AFTER the failing one never run, and `result.steps` only ever contains steps actually attempted. Narrowing the failure to a single re-runnable test file and re-running it in isolation says nothing about whether steps never reached would ALSO have passed — reporting the whole gate `passed:true` at that point is the exact defect this card fixes. `remainingGateSteps(effectiveGate, stepsAlreadyRun)` is the discriminator: given the FULL command actually executed (`effectiveGate`, never the raw configured `gateCommand`) and how many steps a result already accounts for, it returns every step not yet run, in order — pure step-string arithmetic; a caller calls this only after `classifyGateFailure`/`identifyRetriableTestFiles` have already said "yes, proceed."

`mergeResumedGateResult(original, resumed)` folds a RESUMED run's result (re-invoking `runGateSequential`/`runGateStep` against just the `remainingGateSteps` suffix, as its own separately-admitted gate call) back into the ORIGINAL. `steps` is NEVER taken from either side alone — `original.steps` plus `resumed.steps`, concatenated, is what makes the merged `steps[]` finally equal to EVERY step `effectiveGate` names, the exact visibility `gate_status`/`gate_history` was missing when this bug shipped silently.

CODE REVIEW FINDING [4]: every OTHER field is NOT simply "whichever side is newest" — which side wins depends on whether the resume itself passed, and conflating the two broke the retry-warning path this same card was fixing. (a) `resumed.passed === true` keeps `original`'s own `outputTail`/`failingTest`/etc., mirroring the plain no-resume single-file retry's own pass behavior — load-bearing, not cosmetic: `formatWeakerPassWarning`'s `isTimeoutKillEntry(retriedFile, outputTail)` check looks for `retriedFile`'s OWN `(exit timeout` line, which can only appear in ATTEMPT 1's tail; taking `resumed`'s tail here would silently mislabel a genuine timeout kill as order-dependent/cross-test-pollution. (b) `resumed.passed === false` (or cancelled) — a DIFFERENT, later step genuinely broke: `resumed`'s own fields win outright. Never invents a verdict, and must never be looped — a caller resumes once.

`formatRetryRescuedButGateRejectedWarning` is the THIRD warning case neither sibling formatter can honestly render — the isolated retry PASSED, but the gate is still REJECTED because the resumed step then failed for real. It deliberately takes NO `outputTail` — `isTimeoutKillEntry` classifies `retriedFile`'s OWN failure, no longer the actionable question once a different, later step is what actually rejected the gate.

## Do not

- Do not dispatch `retryWarning`'s formatter choice on `payload.retryPassed` alone — check `t.record.verdict === "pass"` first; `retryPassed` only disambiguates WITHIN the rejected branch.
- Do not assume a `true` `retryPassed` implies the whole gate passed — card 7ad12202's resume mechanism can rescue one step and still fail a later one, leaving `retryPassed:true` alongside a "fail" verdict.
- Do not report a gate `passed:true` after a rescued single-file retry without first checking `remainingGateSteps` — steps after the original failure may never have run at all.
- Do not take `resumed`'s diagnostic fields when `resumed.passed === true` — keep `original`'s, or `isTimeoutKillEntry` silently stops matching. Do not loop `mergeResumedGateResult` — a caller resumes once.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`'s `retryWarning` dispatch): lines 3837-3850, as of this tranche's HEAD (tranche 9). Decision B above was originally three separate JSDoc comments in `packages/daemon/src/orchestration/gate-runner.ts` — above `remainingGateSteps` (lines 1039-1058), `mergeResumedGateResult` (lines 1063-1101), and `formatRetryRescuedButGateRejectedWarning` (lines 1393-1412), all as of tranche 1's HEAD (commit `18bb69e3`); extracted here (same card id) by tranche 2, no wording changed beyond joining wrapped lines and stripping `*`/`⚠️` markers.
