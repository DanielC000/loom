# 9798200c — `filterProjectTasks` split out so a counts-only read never pays for the `merged` lookup

## Narrative

`filterProjectTasks` is the FILTER core shared by `listProjectTasks` and `countProjectTasks` — it applies every column/priority/id/title filter but does no pagination, projection, or merged-state enrichment. Card `9798200c` split it out from `listProjectTasks` specifically so a counts-only read never pays for the per-task git-derived `merged` lookup (see docs/decisions/9983eed6-listprojecttasks-merged-field-is-one-cached-git-log-scan-not-per-task.md) just to total up rows it's about to discard.

## Do not

- Do not fold the merged-state enrichment back into the shared filter core — a counts-only caller must be able to filter without ever paying for the per-task `merged` lookup.

## Source

Inline comment in `packages/daemon/src/mcp/tasks.ts` (`filterProjectTasks`'s own doc comment), lines 385-390 as of this tranche's HEAD ("docs(tasks): extract decision prose from mcp/tasks.ts, tranche 2"). Relocated by this card; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
