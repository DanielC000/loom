# 2a79a74c — a `notExecuted` structural failure refuses the retry outright, regardless of count

## Narrative

Card 2a79a74c finding #5: `test-daemon.mjs` can exit early on its own structural `notExecuted` invariant failure — some discovered hermetic test file(s) were never actually executed — via a `console.error` line matched by `HARNESS_NOT_EXECUTED_RE`, followed by `process.exit(1)`, fired BEFORE the run's own `FAILURES:` epilogue ever runs.

The risk this closes: that early exit does NOT suppress `runLane`'s own per-file wrapper line (`HARNESS_FAIL_WRAPPER_RE`) for whichever file(s) genuinely failed an assertion in the SAME run — `runLane` prints its `FAIL  <name>  (exit N)` line the moment that file's own child process settles, well before the later, separate `notExecuted` bookkeeping check even runs. So a run that BOTH genuinely fails exactly one test AND, via an unrelated structural bug, silently never executes some OTHER discovered file(s) still yields `failTierMatchCount() === 1` for the one genuine failure alone — `identifyRetriableTestFiles` would otherwise happily identify and retry that ONE file, and a pass on the isolated `--only=<name>` retry would let the merge proceed while the structural "some selected files never ran at all" defect is never re-observed (a single-file retry has no way to re-check it).

`identifyRetriableTestFiles` therefore refuses the retry outright (`declineReason: "harness-not-executed"`) whenever `harnessNotExecutedDetected` is true, REGARDLESS of the count — a co-occurring genuine failure's own wrapper line survives `test-daemon.mjs`'s early `notExecuted` exit untouched, so the count alone cannot see that other discovered files were structurally never run at all.

## Do not

- Do not let `identifyRetriableTestFiles` (or any successor) skip the `harnessNotExecutedDetected` check because the fail-tier count looks clean — the count is silent about files that never ran at all.
- Do not treat `HARNESS_NOT_EXECUTED_RE`'s match as merely diagnostic — it is a hard refusal signal for the single/multi-file retry, independent of `failTierMatchCount`.

## Source

JSDoc comments in `packages/daemon/src/orchestration/gate-runner.ts`: above `HARNESS_NOT_EXECUTED_RE` (originally lines 92-109) and the "CARD 2a79a74c FINDING #5" paragraph inside `identifyRetriableTestFiles`'s own doc (originally lines 1276-1280), both as of tranche 1's HEAD (commit `18bb69e3`). Extracted by tranche 2; no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*`/`⚠️`/`🎯` comment markers.
