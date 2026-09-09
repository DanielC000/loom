# d422e279 — `formatReducedGateWarning` is the shared builder for the solo AND batch reduced-gate text

## Narrative

Card d422e279 (Code Review blocker [2]): `formatReducedGateWarning` is the SHARED builder for the "merge gate reduced: ..." warning a reduced merge surfaces — extracted because the solo path (`confirmWorkerMergeTracked`, `sessions/service.ts`) and the batch path (`mergeBatchTracked`, same file) had grown TWO hand-written copies of this text that had ALREADY diverged: the batch copy's asset clause dropped the changed-path LIST and the "ran the N certified asset-reading test(s) too" statement the solo copy carries, so a manager reading a reduced BATCH's warning on an asset-touching diff saw "skipped the full daemon test suite" with no mention that `ASSET_READING_TEST_REPO_PATHS` had actually run — wrong about what executed, not merely less detailed. This is this repo's own named shared-unit-divergence anti-pattern (see `CLAUDE.md`) — one builder, reused by both call sites, is what keeps the two texts from drifting apart again.

`assetReadingTestCount` is a plain number (not the `ASSET_READING_TEST_REPO_PATHS` array itself) so this file — spawn/process-timing plumbing — doesn't pick up a dependency on the git layer just to read `.length`; both call sites already import that array for their own gate-command construction and pass its length through.

`batchLandedCount` is OPTIONAL and additive, mirroring `formatWeakerPassWarning`'s own convention for the identical solo-vs-batch distinction: omitted (the solo path) renders "merge gate reduced: ..." byte-identical to the pre-extraction text; passed (the batch path) renders "batch merge gate reduced across N landed branch(es): ..." and scales the isolation caveat's own "this green is not evidence either way" to name every landed branch, not just one. The isolation caveat's own singular/plural ("this changed test file was" / "these N changed test files were") is driven ENTIRELY by `changedTestFiles.length` in both modes — never hardcoded to plural for a batch, which would misreport a batch whose union touched exactly one test file.

## Do not

- Do not write a second, hand-authored copy of this warning text at either call site — both the solo and batch paths must call this one builder, or their texts will diverge again exactly as they did before this card.
- Do not omit a `NOT_HERMETIC`-excluded file from `notHermeticExcluded` (card 17cd1f30) — a bare count would gate a diff while quietly verifying nothing for those specific files, leaving a reader no way to tell WHICH changed test(s) went unrun.
- Do not omit a skipped-as-inert path from `inertPathsSkipped` (card 8ee4f11e) — a mixed diff (a compiled file plus an inert path) must name the inert path too, not just count the compiled files, or it reads as silently dropped.

## Source

JSDoc comment in `packages/daemon/src/orchestration/gate-runner.ts`, above `formatReducedGateWarning`: originally lines 1690-1725, as of this tranche's HEAD. Relocated by card `b80a2d76` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
