# 249004c3 — a `memory_write` update is a true PATCH, not a hard overwrite

## Narrative

Card 249004c3: updating an existing key is a true PATCH, not a hard overwrite — `title`/`pinned`/`tags` the caller OMITS from `input` are left unchanged on the stored row; only `text` and the version bump apply. Passing one of those fields explicitly — including the "falsy but meaningful" values `pinned: false` or `tags: []` — still writes it verbatim, so an explicit clear is distinguishable from an omission. `Db.upsertProjectMemory` implements this via COALESCE mechanics: the SQL update coalesces each omitted field against its own existing column value rather than overwriting it with an incoming `undefined`/null.

This landed alongside the `owner decision #2` "always-update in place" upsert model (see `sha:5a7c88e4b`) in the same commit that changed the upsert from a hard, whole-row overwrite to a field-level patch — see the commit's own diff for the exact before/after wording change.

## Do not

- Do not overwrite `title`/`pinned`/`tags` with a default/empty value just because the caller omitted them — only an explicitly-passed value (including `false`/`[]`) may change them.
- Do not bypass `Db.upsertProjectMemory`'s COALESCE mechanics with a hand-rolled update that assigns every column unconditionally — that reintroduces the hard-overwrite behavior this card replaced.

## Source

JSDoc comment above `writeProjectMemory` in `packages/daemon/src/mcp/memory.ts`, condensed, not verbatim. Extracted by card `6fe7361d` (tranche 2 on this file).
