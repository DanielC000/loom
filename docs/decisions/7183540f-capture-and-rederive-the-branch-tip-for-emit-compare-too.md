# 7183540f — capture and re-derive the branch tip before emit-compare classification too, mirroring db413510

## Narrative

Card 7183540f closes the identical ordering-trap shape [[db413510-capture-and-rederive-the-branch-tip-too]] closed for the inert-skip path, but for the emit-compare reduced-gate eligibility check instead: `emitComparePreWaitBranchHead` is captured via `resolveGitRef` strictly BEFORE `computeEmitCompareGate` runs, never after. `computeEmitCompareGate` resolves `branch` (its `ref` param) BY NAME internally — a `git diff --name-status base..branch` call, the same shape as `isInertMergeDiff`'s own `changedPathsBetween` call, which likewise takes a ref, not a pinned sha — so a capture placed after that call would leave a commit landing between classification and the (late) capture invisible to classification yet folded into "the tip classification already saw" — db413510's own ordering-trap mistake, recurring at this second call site. Capturing here, strictly before classification runs, closes it exactly as db413510 does: any commit landing between this capture and classification is seen BY classification, never missed, only possibly re-derived once more than strictly necessary.

`emitComparePreWaitMainHead` is a plain assignment, not a second git read: `gateBaseMainHead` is already resolved earlier in this same method, so this just snapshots what THIS classification actually ran against. A later admission-time reunion that advances `gateBaseMainHead` (main moved during the semaphore's CAP-queue wait) is then detectable by simple inequality against this snapshot, with no second HEAD read needed.

The admission-time re-derivation this capture feeds (`EMIT-COMPARE RE-DERIVATION AT ADMISSION`, the immediately-following use of both snapshots once the op is through the CAP-queue wait) is a separate call site, out of this tranche's own scope — it fails closed on the same "any doubt reads as moved" discipline db413510's own post-wait check uses, and re-runs the WHOLE `computeEmitCompareGate` call rather than just the boolean eligibility check, so a stale `emitCompareTestFiles` list can never ride through even when the eligibility verdict itself would have re-proven true.

## Do not

- Do not capture the post-classification branch tip only after `computeEmitCompareGate` runs — that function resolves `branch` BY NAME, so a commit landing before a late capture is misclassified as already-seen, exactly like db413510's inert-skip-path defect recurring at this second call site.
- Do not re-derive `emitComparePreWaitMainHead` with a second git read — `gateBaseMainHead` is already resolved by this point in the method; re-reading it would only reintroduce a second source of truth for the same value.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`confirmWorkerMerge`, the "PRE-CLASSIFICATION BRANCH-TIP CAPTURE" doc block above `emitComparePreWaitBranchHead`'s assignment), as of this tranche's HEAD before this extraction. Condensed: wrapped source lines joined into flowing paragraphs, `//` markers stripped, and the reference to the admission-time re-derivation's own discipline summarized rather than quoted (that block is a separate call site, out of this tranche's scope). See also [[db413510-capture-and-rederive-the-branch-tip-too]] — the sibling decision this one mirrors for the inert-skip path.
