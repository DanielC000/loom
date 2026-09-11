# 145e8d72 — `text` joins the PATCH model on update: omit to resend the stored body verbatim

## Narrative

Card 145e8d72: `text` joins the same patch model as `title`/`pinned`/`tags` (see `249004c3`) on an UPDATE — omitting it re-reads the existing row's own stored body and resends THAT value, never a caller-retyped copy, so the persisted text stays byte-identical across a metadata-only patch and every downstream cap/floor-tier check still runs against the note's real effective size rather than something the caller reconstructed. `text` stays REQUIRED to create a brand-new key, since there is nothing existing to fall back to — enforced by the function's own `!existing` check.

## Do not

- Do not let an update omitting `text` write anything other than the existing row's own stored body — resending a caller-retyped copy risks a byte-for-byte drift from what was actually persisted.
- Do not relax the `text` requirement on a brand-new key — omitting it there has nothing to fall back to and must still error.

## Source

JSDoc comment above `writeProjectMemory` in `packages/daemon/src/mcp/memory.ts`, condensed, not verbatim. Extracted by card `6fe7361d` (tranche 2 on this file).
