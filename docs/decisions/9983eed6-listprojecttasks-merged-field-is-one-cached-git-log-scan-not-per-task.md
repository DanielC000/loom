# 9983eed6 — `listProjectTasks`'s `merged` field is backed by ONE cached git-log scan per repo, not a per-task subprocess

## Narrative

Card `9983eed6` attaches `merged` to every row `listProjectTasks` (and `getProjectTask`) returns — the task's git-derived ship state, or `null` if not proven merged (see `getTaskMergedInfo`'s own fail-safe contract, and docs/decisions/52e978ad-merged-verification-mode-three-different-guarantees-not-interchangeable.md for what `null` does and doesn't mean). The lookup is ASYNC because it shells out to git, but stays cheap even over an unpaginated per-project call: ONE bounded, cached git-log scan backs every task's O(1) map lookup here — not one git subprocess spawned per task on the board. Skipped entirely when `includeMerged` is false (card `f6753002`).

## Do not

- Do not resolve `merged` with a per-task git subprocess — the shared cached git-log scan is what keeps an unpaginated per-project board read cheap regardless of board size.

## Source

Inline comment in `packages/daemon/src/mcp/tasks.ts` (`listProjectTasks`'s own doc comment), lines 367-384 as of this tranche's HEAD ("docs(tasks): extract decision prose from mcp/tasks.ts, tranche 2"). Relocated by this card; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
