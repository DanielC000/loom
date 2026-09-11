# cf8d773f — `evictionStatus` warns at write time; only a rendered kickoff resets eviction rank

## Narrative

Card cf8d773f adds `evictionStatus`, an informational signal returned alongside a successful `memory_write` for an UNPINNED note once the project's memory store is at (or over) its `memory.maxNotes` cap — mirroring `NeverDropSignal`/`RestTierSignal`/`TriggerGateSignal`'s "compute the consequence at the ONE moment the author can act on it, never block the write" posture. It is `undefined` when the note is pinned (pinned rows are never evicted), the cap is disabled (`maxNotes <= 0`), or the store isn't yet at cap.

Root cause this closes: a brand-new, never-retrieved note written at a project already sitting at `maxNotes` is, by construction, in the most-evictable class. The eviction sweep that runs after EVERY subsequent write in the project (by anyone) deletes it the moment it becomes the sweep's top candidate — often within minutes — with no prior signal to the writer that it happened.

Computed via `Db.projectMemoryEvictionRank`, which shares its candidate `ORDER BY` with the real sweep (`Db.evictProjectMemoryOverCap`) through one constant, so this signal can never silently diverge from what the sweep actually deletes.

MEASURED (manager review of the first cut, 2026-09-10): `last_retrieved_at` — the column this signal's rank is computed against — is written by exactly ONE production-reachable call site, `db.touchProjectMemoryRetrieved`, called from `sessions/project-memory-recall.ts`'s `retrieveProjectMemoryForKickoff` (`if (framed) db.touchProjectMemoryRetrieved(includedIds)`) — i.e. only a note ACTUALLY RENDERED into an injected kickoff digest resets its rank. `gateway/server.ts`'s `/internal/test/seed` route also calls it, but that route is gated `if (inTestMode())` — structurally absent from a real daemon's route table, not a second production retrieval path. An explicit `memory_read`/`memory_list` call does NOT touch this column at all — a clean read-back is NOT a reprieve, which is exactly the confusion (a clean write + clean read-back, then silent deletion) that is the card's own root incident.

## Do not

- Do not treat `evictionStatus` as a way to prevent the eviction it reports — like its sibling signals, it is purely advisory and can never turn a write into a rejection.
- Do not assume an explicit `memory_read` or `memory_list` call resets a note's eviction rank — only a note actually landing in a rendered kickoff digest does.
- Do not compute eviction rank independently of `Db.evictProjectMemoryOverCap`'s own `ORDER BY` — route both through the same constant so the reported rank and the real sweep can never diverge.

## Source

JSDoc comment above the `EvictionCandidateSignal` interface in `packages/daemon/src/mcp/memory.ts`, condensed, not verbatim. Extracted by card `6fe7361d` (tranche 2 on this file).
