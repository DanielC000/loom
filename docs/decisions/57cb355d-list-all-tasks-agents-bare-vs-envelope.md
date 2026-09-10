# 57cb355d — list_all_tasks/list_all_agents: bare array only when uncapped and unpaged, else the envelope

## Narrative

`list_all_tasks` and `list_all_agents` (`packages/daemon/src/mcp/platform.ts`) returned a capped read
with no signal that it was capped — a caller could mistake "capped at N" for "N total". The fix mirrors
`session_transcript`'s own shape: return the bare array only when the whole matching set fits in one page
AND the caller didn't page explicitly (today's pre-fix behavior, unchanged in that case); any other case
returns an envelope — `{…rows, total, returned, offset, nextOffset}` — instead. `total` is the true
matching-row count before the offset/limit slice; `nextOffset` is `offset + returned` while more remains,
else `null`.

This is the same field-for-field shape `tasks_list`'s own completeness signal ([[84f6ac42]]) later used,
and the shape the shared `okLinesSpillable` helper's opt-in `page` param was generalized from — so a
capped/partial read is never indistinguishable from a complete one across any of these call sites.

## Do not

- Do not return a bare array on an explicitly-paged or genuinely-partial read — that is exactly the shape
  this fix closes.

## Source

`packages/daemon/src/mcp/platform.ts` (`list_all_agents`, `list_all_tasks` — two near-identical inline
comments; out of this tranche's file fence, not edited by it). Also cited, not edited, in
`packages/daemon/src/mcp/setup.ts`. Cross-referenced from `packages/daemon/src/mcp/server.ts`'s
`okLinesSpillable` JSDoc — this tranche's actual edit site. Introducing commit: `a33a713ae` ("fix(mcp):
return a cap/pagination envelope from list_all_tasks + list_all_agents").
