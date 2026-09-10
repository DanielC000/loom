# e4e180ad — project-memory backlinks close the one-way-link gap

## Narrative

A byte-capped canonical memory note (`MAX_TEXT_BYTES`, `mcp/memory.ts`) often has no room left to add a forward `[[wikilink]]` back to every OTHER note that already links TO it — an overflow companion note can carry the reverse link, but the canonical note itself stays silent about being linked-to. Card e4e180ad's `backlinks` field closes this one-way-link gap: every note's INBOUND `[[wikilink]]`s are resolved fresh at read time (kickoff digest injection, `memory_read`, `memory_list`) via `project-memory-backlinks.ts`, rather than requiring the linked-to note's own stored text to list them.

`backlinks` is kept as its own field, deliberately never merged into `requestAnnotations` (card `e6d270b3`'s live-resolved Request-link annotations) — the two are unrelated kinds of link, one to an owner-decision Request, the other to another memory note. It is ALWAYS an array, never omitted, so an empty `backlinks: []` is a MEASURED zero ("this note has no inbound links"), structurally distinguishable from the field being absent altogether.

The resolution shape deliberately mirrors `project-memory-request-links.ts`'s live-resolved-at-read-time pattern, rather than introducing a second style for the same kind of problem. Resolving fresh at read time (rather than storing backlinks on the note itself) means this cost can NEVER count against either of the note's own stored `text` byte caps — the general `MAX_TEXT_BYTES` or the wider `MAX_NEVER_DROP_TEXT_BYTES` a pinned/never-drop note gets. A backlink match is a plain substring scan for a literal `[[key]]` token — deliberately not Obsidian's `[[key|alias]]` piping syntax, since no note observed in this project's own store has ever used it (the store's own too-long-rejection message in `mcp/memory.ts` only ever recommends the bare `[[key]]` form), so supporting alias-piping would add complexity the corpus has never actually needed.

## Digest cap is tighter than the on-demand cap (`MAX_BACKLINKS` vs `MAX_BACKLINKS_DIGEST`)

Every note the kickoff digest renders is SIZED against the shared memory budget on every kickoff, whether or not it survives the pack — an ordinary pinned note that later gets dropped for budget still paid this sizing cost first. This is a "does the digest render this note at all" cost, not a `never-drop`-specific one, so the general on-demand cap (`MAX_BACKLINKS`, `memory_read`/`memory_list`) is too expensive to also use for every digest-rendered note's backlinks.

Measured live against this project's real corpus (2026-08-28, 400 notes / 31 pinned): at `MAX_BACKLINKS=20`, the 8 real floor-tier (`pinned && never-drop`) notes would add ≈10,370 bytes / ≈2,593 estimated tokens combined — but the 23 ORDINARY pinned notes add a comparable ≈10,594 bytes / ≈2,649 estimated tokens too (all pinned combined: ≈20,964 bytes / ≈5,241 est tokens), on a project whose digest was already reported dropping 21 pinned notes for budget.

An earlier version of `MAX_BACKLINKS_DIGEST` applied only to the floor tier — that predicate was an unexamined default (it happened to be the tier the original evidence led with), not a reasoned boundary. The actual line is DIGEST vs ON-DEMAND: every digest-rendered note sits on the same side of it regardless of tier. At `cap=5` the same 31 pinned notes add only ≈8,586 bytes / ≈2,147 est tokens combined — roughly a 59% reduction. The goal is only "tell the reader an overflow companion exists" — never the content — which a handful of names satisfies as well as twenty.

## Do not

- Do not merge `backlinks` into `requestAnnotations` — they resolve unrelated kinds of link and are kept separate deliberately.
- Do not treat an omitted `backlinks` field as "no links" — it is always present as an array; only `[]` means genuinely zero.
- Do not implement `[[key|alias]]` alias-piping support for backlink matching — the corpus has never used it, and the store's own guidance only ever recommends the bare `[[key]]` form.
- Do not scope `MAX_BACKLINKS_DIGEST` to only the floor (`pinned && never-drop`) tier — every digest-rendered note pays this sizing cost, not just that tier.
- Do not raise `MAX_BACKLINKS_DIGEST` toward `MAX_BACKLINKS` without re-measuring against a real corpus — at cap=20 the ordinary-pinned cost alone was comparable to the floor-tier cost.

## Source

JSDoc comment above `ProjectMemoryEntryWithLinks` in `packages/daemon/src/mcp/memory.ts`, lines 414-429 as of commit `1cbc0d74` (the `backlinks` clause specifically). Extracted by card `2329ac06` (tranche 1 on this file). Also cited (recap only, no new content) at the same file's `computeNeverDropStatus`. Extended by card `6c7d80e1` (tranche 1 on `packages/daemon/src/sessions/project-memory-backlinks.ts`) with the file-header and `MAX_BACKLINKS_DIGEST` doc-comment content, lines 4-21 and 51-72 as of commit `dcbd50bc`.
