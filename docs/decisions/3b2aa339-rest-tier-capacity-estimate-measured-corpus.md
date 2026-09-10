# 3b2aa339 — REST tier write-time capacity estimate, and the measured corpus behind it

## Narrative

Card 3b2aa339 adds the REST sub-tier's (ordinary pinned, non-`never-drop`) write-time capacity estimate — the write-time-visible sibling of `computeFloorTierStatus` for the tier that actually starves under a shared budget. Measured live on this project (30 rotation-aware rounds against the real corpus): the floor tier is fixed overhead (≈66% of an 8000-token budget before a single REST note is considered) and REST rotates through the leftover at a mean ~1.6% per-note delivery rate, with most REST notes never delivered across 30 kickoffs. "Pinned" was never the guarantee for this sub-tier the way it is for `never-drop` — but that cost was invisible at the moment of the pin, which is the actual defect this function targets (see `writeProjectMemory`'s `restTierStatus`, `mcp/memory.ts`).

Unlike the floor tier (an exact fits-or-doesn't-fit pack against the FULL budget), REST competes with the RELATED tier's reserve (see [[738568b6-related-tier-reserve-probed-not-unconditional]]) and only ever gets a rotating slot under fair LRU packing (see [[6def8bf4-pinned-tier-lru-fairness-sort]]) — "will THIS note ever be delivered" isn't answerable exactly without simulating real kickoffs (there is no `kickoffText` yet at write time, so the actual per-round RELATED reserve consumption is unknowable here). This instead returns a CHEAP, deterministic, write-time estimate: REST's capacity under the WORST-CASE nominal RELATED reserve (the full `RELATED_RESERVE_FRACTION`, since a real kickoff could claim all of it), and the resulting expected full-rotation cycle length in kickoffs, so an author sees roughly "1 in every N kickoffs" for the REST tier as it stands the moment they're about to add to it. Advisory only — this never blocks a write, mirroring `computeFloorTierStatus`'s own posture.

## Do not

- Do not treat this estimate as a promise a given note WILL be delivered within N kickoffs — it's a worst-case, deterministic estimate, not a simulation of real kickoffs (no `kickoffText` exists at write time).
- Do not size the assumed RELATED reserve smaller than the full `RELATED_RESERVE_FRACTION` here — a real kickoff could claim all of it.

## Source

JSDoc comment above `computeRestTierStatus` in `packages/daemon/src/sessions/project-memory-recall.ts`, lines 308-328 as of tranche 1 on that file.
