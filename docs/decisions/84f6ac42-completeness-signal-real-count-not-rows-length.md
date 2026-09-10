# 84f6ac42 — a capped read's total/nextOffset must come from a real count, never `rows.length`

## Narrative

`tasks_list` returned a capped page (`rowCount == limit`) with no signal that it was capped —
indistinguishable from a complete answer, so a caller could mistake "capped at N" for "N total". The fix:
compute `total` via a cheap, dedicated count query (`countProjectTasks`, same filters, no merged-state
git enrichment, no body) rather than deriving it from `rows.length`, which is already post-slice and can
never tell "exactly at the cap" apart from "more remains". `nextOffset` is `offset + returned` while more
remains, else `null`.

The response stays a bare array when the whole matching set fits in one page and the caller didn't page
explicitly (today's pre-fix shape, unchanged in that case); any other case returns
`{total, returned, offset, nextOffset}` alongside the rows instead — mirroring `list_all_tasks`'s own
envelope ([[57cb355d]]) field-for-field. The same fix generalized the pattern into the shared
`okLinesSpillable` helper's opt-in `page` param (`packages/daemon/src/mcp/server.ts`), so a future caller
of that helper gets the same completeness guarantee for free rather than re-deriving it — while a caller
that never opts in (`task_requests_list`, as of this record) stays byte-identical to before.

## Do not

- Do not derive `total`/`nextOffset` from the already-sliced `rows.length` — it can never distinguish
  "exactly at the cap" from "more remains".
- Do not silently return a bare capped array when the caller explicitly paged (offset/limit passed) —
  even a `nextOffset:null` on that path is a meaningful "this really is the last page", not the same as
  an unpaged omission.

## Source

Inline JSDoc in `packages/daemon/src/mcp/server.ts` (`okLinesSpillable`'s own doc) and the `tasks_list`
implementation's own short inline comment nearby (same file, near its `total`/`nextOffset` computation).
Introducing commit: `bbf6ec265` ("fix(tasks): tasks_list gives no truncation signal — a capped read
returns rowCount == limit and reads exactly like a complete answer").
