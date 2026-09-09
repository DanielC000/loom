# d371a9bf — the human memory-list route's `backlinks` field is structured, not the agent-facing prose form

## Narrative

Card `d371a9bf` is the human-UI half of card `e4e180ad`'s agent-facing field: `GET /api/projects/:id/memory` resolves `backlinks` HERE, over the corpus the route already fetched — deliberately NOT by repointing this route at `mcp/memory.ts`'s `listProjectMemoryEntries` wrapper, which would also drag in `requestAnnotations` and `everDelivered`. This card's own decision excludes both: the first is redundant with the Requests UI already shown on this page, and the second is undecidable between never-matched and matched-then-evicted, so it would mislead a human reader.

Shaped as structured `{ keys, totalFound }` (`ProjectMemoryBacklinks`), not the prose annotation LINES `ProjectMemoryEntryWithLinks.backlinks: string[]` renders for agents — the UI needs a bare key to link to, not text to parse. Capped at `findInboundBacklinksBulk`'s own default (`MAX_BACKLINKS`), same "N of M" truncation contract the agent-facing tools already use — never silent.

## Do not

- Do not repoint this route at `mcp/memory.ts`'s `listProjectMemoryEntries` — it drags in `requestAnnotations` (redundant with the Requests UI already on this page) and `everDelivered` (undecidable between never-matched and matched-then-evicted; would mislead a human reader).
- Do not return the agent-facing prose annotation lines (`ProjectMemoryEntryWithLinks.backlinks: string[]`) here — the UI needs the structured `{ keys, totalFound }` shape to link to, not text to parse.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`GET /api/projects/:id/memory`, lines 3768-3801 as of commit `a9b55042`). Relocated by card `2bf0b41d`; wording condensed, no substantive detail dropped.
