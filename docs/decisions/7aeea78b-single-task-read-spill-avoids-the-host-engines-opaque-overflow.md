# 7aeea78b — a single full task read spills through Loom's own writer, never the host engine's opaque one

## Narrative

`spillableTaskGet` wraps a single full task read (`getProjectTask` / `project_task_get`'s single-id path)
with the same Loom-controlled spill treatment `tasks_list`/`task_requests_list` already get via
`spillTextIfLarge`, instead of falling through — for an oversized `body` — to the HOST ENGINE's own
opaque overflow-spill, which JSON-escapes embedded newlines into one unpageable line (`spill.ts`'s own
doc comment names this exact failure mode).

It hands the primitive ALREADY-SHAPED plain text — `title`, a blank line, then `body`, real line breaks —
NEVER `JSON.stringify(task)`, which would re-escape the very newlines this exists to preserve and
reproduce the defect through Loom's own writer instead.

## Do not

- Do not let an oversized single-task-read fall through to the host engine's own tool-result overflow
  spill — it JSON-escapes embedded newlines into one unpageable line. Route it through `spillTextIfLarge`
  with plain, already-shaped text instead.
- Do not spill `JSON.stringify(task)` — that re-escapes the newlines this mechanism exists to preserve.

## Source

Inline JSDoc in `packages/daemon/src/mcp/tasks.ts` (`spillableTaskGet`'s own doc, lines 726-732 as of
this tranche's HEAD).
