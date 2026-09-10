# e4e180ad — project-memory backlinks close the one-way-link gap

## Narrative

A byte-capped canonical memory note (`MAX_TEXT_BYTES`, `mcp/memory.ts`) often has no room left to add a forward `[[wikilink]]` back to every OTHER note that already links TO it — an overflow companion note can carry the reverse link, but the canonical note itself stays silent about being linked-to. Card e4e180ad's `backlinks` field closes this one-way-link gap: every note's INBOUND `[[wikilink]]`s are resolved fresh at read time (kickoff digest injection, `memory_read`, `memory_list`) via `project-memory-backlinks.ts`, rather than requiring the linked-to note's own stored text to list them.

`backlinks` is kept as its own field, deliberately never merged into `requestAnnotations` (card `e6d270b3`'s live-resolved Request-link annotations) — the two are unrelated kinds of link, one to an owner-decision Request, the other to another memory note. It is ALWAYS an array, never omitted, so an empty `backlinks: []` is a MEASURED zero ("this note has no inbound links"), structurally distinguishable from the field being absent altogether.

## Do not

- Do not merge `backlinks` into `requestAnnotations` — they resolve unrelated kinds of link and are kept separate deliberately.
- Do not treat an omitted `backlinks` field as "no links" — it is always present as an array; only `[]` means genuinely zero.

## Source

JSDoc comment above `ProjectMemoryEntryWithLinks` in `packages/daemon/src/mcp/memory.ts`, lines 414-429 as of commit `1cbc0d74` (the `backlinks` clause specifically). Extracted by card `2329ac06` (tranche 1 on this file). Also cited (recap only, no new content) at the same file's `computeNeverDropStatus`.
