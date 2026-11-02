# 57a91801 — `expiresAt` gates KICKOFF DELIVERY only, never existence, the eviction cap, or dedup candidacy

`ProjectMemoryEntry.expiresAt` (optional, ISO date or datetime, UTC) is the mem0-comparison idea #3 field
(`Projects/Loom/Design/Project Memory vs mem0 — Comparison.md` §3): a note whose `expiresAt` has passed is
excluded from every KICKOFF tier — the pinned floor/REST sub-tiers and the FTS "related" tier
(`db.ts`'s `listPinnedProjectMemory`/`searchProjectMemory`, and defensively again in
`project-memory-recall.ts`'s `composeProjectMemoryDigest`/`computeFloorTierStatus`/`computeRestTierStatus`)
— via the single shared predicate `isProjectMemoryExpired` (`packages/shared/src/types.ts`). `null`
(every pre-existing note, and every hermetic test fixture that never sets it) behaves byte-identically to
before this field existed.

Three questions the card asked to be decided explicitly, answered here:

1. **Does an expired note still count toward the unpinned `memory.maxNotes` eviction cap?** YES. An
   expired unpinned note is not specially exempted from `evictProjectMemoryOverCap`/
   `projectMemoryEvictionRank` — it is evicted by the exact same never-retrieved-then-oldest-created
   order as any other unpinned row. In practice it tends to drift toward the front of that order on its
   own: once excluded from every kickoff tier, it can no longer accrue a fresh `lastRetrievedAt` touch,
   so no special-casing was needed for it to behave sensibly under eviction.
2. **Is an expired note still a near-duplicate candidate?** YES. `findNearDuplicateProjectMemory`'s FTS
   corpus is never filtered by expiry. Expiry is a statement about delivery scheduling, not about whether
   the note's CONTENT is still real, useful knowledge — an author about to write a near-duplicate of an
   expired note should still be nudged to update that key (and reconsider clearing its `expiresAt`)
   instead of minting a fresh one.
3. **Is an expired note deleted?** NO. `memory_read`/`memory_list` still return it in full, annotated
   `expired:true` (mirrors mem0's own `show_expired` escape hatch) — `memory_forget` remains the only way
   to actually remove a note.

A PINNED note's expiry works the same way: pinned rows are never evicted regardless of expiry, but an
expired pinned note stops riding the floor/REST tier just like an expired unpinned note stops riding
RELATED — it simply sits in the store, readable on demand, until its `expiresAt` is cleared (pass `""`)
or it's forgotten.

## Do not

- Do not read `expiresAt` as a deletion mechanism, or wire `memory_forget` into it — expiry only gates
  kickoff-tier delivery; `memory_read`/`memory_list` must keep returning an expired note in full.
- Do not exempt an expired UNPINNED note from the `memory.maxNotes` eviction sweep, and do not give it a
  SEPARATE eviction order from an ordinary unpinned row — one shared order, no special-casing.
- Do not filter `findNearDuplicateProjectMemory`'s corpus by expiry — an expired note's content is still
  a legitimate near-duplicate candidate.
- Do not duplicate the "is this expired" time comparison in more than one place — `db.ts`,
  `project-memory-recall.ts`, and `mcp/memory.ts` must all defer to the single shared
  `isProjectMemoryExpired` predicate in `packages/shared/src/types.ts`, never a second independently-
  written comparison that could silently drift from it.
- Do not treat a stored `expiresAt` that fails to parse as a date as expired — a corrupt/legacy value
  must fail toward NOT hiding the note, never toward wrongly hiding it.
