# f651aff0 — the write-path spill gap needed its own card; `7aeea78b`'s sweep was structurally scoped to `*_get`

## Narrative

`spillableTaskUpdateResult` is `spillableTaskGet`'s sibling for a WRITE result, applied to whatever
`updateProjectTask` returned. It's shared by both writers of that function's return shape — the
in-project `tasks_update` (mcp/server.ts) and the cross-project `project_task_update` (mcp/platform.ts)
— so the two callers share this one spill wiring rather than growing two independently-drifting copies
(the shared-unit-divergence rule card `7aeea78b` was built to satisfy).

This is also the exact reason THIS card exists as a SEPARATE card rather than a follow-up patch to
`7aeea78b`: that card's own sweep was scoped to `*_get` tools and could never have found a write-path gap
by construction — a sweep bounded to one shape of tool cannot discover a defect that only exists on a
different shape of tool.

## Do not

- Do not assume a sweep scoped to one class of tool (here, `*_get`) also covers a structurally different
  class (here, `*_update`/write results) — it cannot, by construction, and the gap has to be found and
  carded separately.

## Source

Inline JSDoc in `packages/daemon/src/mcp/tasks.ts` (`spillableTaskUpdateResult`'s own doc, lines 756-762
as of this tranche's HEAD).
