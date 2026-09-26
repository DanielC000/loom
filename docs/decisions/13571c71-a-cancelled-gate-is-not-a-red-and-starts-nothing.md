# 13571c71 — a merge gate cancelled while queued is not a red, and a cancelled batch starts nothing

Follows 593cedc8 (the red is recorded before the admission releases) and 6f13746c (the merge-gate interval). A `merge_batch` withdrawn while still QUEUED never ran a gate, but it used to resolve as `{passed:false}`, which `runBatchedMerge` mapped to `gateFailed:true`; the post-release `result.gateFailed` fallback then recorded it as a red, and under an interval that set `gateOwed` although nothing had run. The solo cancel-while-queued path returns `{cancelled:true}` and records nothing, so the two paths disagreed. The same overloaded `passed:false` also made a cancelled batch fall into the per-candidate fallback (every candidate individually gated), and made `classifyOutcome` recognise a cancel by regex on `reason` text.

## Decision

- **One rule, one predicate.** `isMergeGateRed(v)` in `orchestration/gate-semaphore.ts` is `!v.passed && !v.cancelled`: a red is a settled failing verdict from a gate that ran; a cancel is not a verdict. The solo hook (`recordSoloRedOnce`) and the batch hook both decide through it, and `runBatchedMerge` sets `gateFailed` from it.
- **Explicit outcome, not an overloaded `passed:false`.** `BatchGateResult.cancelled` / `RunBatchedMergeResult.cancelled` / `MergeBatchResult.cancelled` carry the cancel from the `GateCancelledError` catch in `mergeBatchTracked` through `runBatchedMerge` to the result. `classifyOutcome` (never-cache veto) reads that field, not the `reason` string.
- **A cancel means stop.** A cancelled batch returns `{ok:false, cancelled:true}` before the per-candidate fallback: nothing is started, every candidate is reported `started:false` through `runFallback`'s no-start mode (the ONE reporting path: held / review-moved / stranded / dropped candidates keep their own reason text, plus " (batch cancelled — not started)"), and the settle nudge is `[loom:merge-batch-cancelled]` saying so (never `merge-batch-failed`). Matches the solo path, which ends at the cancel.
- **The post-release `result.gateFailed` fallback stays** as a backstop for a red exit that skipped the `beforeRelease` hook. No such exit was found by test; the plain red-gate exit is already recorded by the hook (once-flag) and skips it.
- **Where 90db13d8 extends it.** The retry-admission reunion failure is a different exit with a different result shape; it joins the rule inside `isMergeGateRed` (or the one call site that builds its verdict), not by adding a third hand-written condition in either path. The batch hook's `thrown === undefined` guard is left as is for that card.

## Do not

- Do not represent a cancel as `passed:false` alone: it is indistinguishable from a red, and every consumer that treats `passed:false` as a verdict (interval red recording, the fallback) will misfire.
- Do not add a second, hand-written definition of "red" or "cancelled" on either path, and do not detect a cancel by matching `reason` text.
- Do not route a cancelled batch into the per-candidate fallback: the manager who cancelled asked for a stop, and each fallback is a full solo gate on the shared lane.

## Source

`packages/daemon/src/orchestration/gate-semaphore.ts` (`isMergeGateRed`), `packages/daemon/src/git/batch-merge.ts` (`runBatchedMerge`), `packages/daemon/src/sessions/service.ts` (the `GateCancelledError` catch and the `result.cancelled` return in `mergeBatchTracked`, `recordSoloRedOnce`, `classifyOutcome`). Test: `packages/daemon/test/merge-batch-cancelled-not-red.mjs` (C1 batch, C2 solo parity, C3 real-red negative control, C4 a cancelled batch is never cached/replayed, C5 async nudge, C6 each candidate keeps its own reason); RED-proven against the pre-fix `service.ts`/`batch-merge.ts`.
