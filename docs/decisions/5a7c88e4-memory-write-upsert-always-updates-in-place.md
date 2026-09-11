# sha:5a7c88e4 — `memory_write` upserts by key, always updating in place

## Narrative

`memory_write` upserts by `key` (owner decision #2: always-update in place) — a second write to the same key updates the note rather than piling a contradictory duplicate. Every write also enforces the per-project bounded-store cap (`memory.maxNotes`, via `resolveConfig`); pinned notes are exempt from that cap (see `evictProjectMemoryOverCap` in `db.ts`).

Source: commit `5a7c88e4b7ed3fccc787ee351cfcaf4af5d6edb7`, no board card — the paragraph cites no id anywhere in the file, and `git blame` traces it to the original feature commit that created the project memory tool (`feat(memory): project-scoped shared agent memory with FTS5 kickoff injection`), which is where this exact upsert-in-place design was first stated, not a later bulk move or reformat.

## Do not

- Do not change `memory_write` to reject a second write to an existing key, or to append a new row instead of updating in place — the always-update model is the deliberate design.
- Do not exempt an unpinned note from the `memory.maxNotes` cap, and do not apply the cap to a pinned note — only pinned rows are exempt.

## Source

JSDoc comment above `writeProjectMemory` in `packages/daemon/src/mcp/memory.ts`, condensed, not verbatim. Extracted by card `6fe7361d` (tranche 2 on this file).
