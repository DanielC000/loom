# aeec1880 — `triggerGlob`: gate a pinned memory note's delivery to a matching kickoff path

## Narrative

Card aeec1880 added `ProjectMemoryEntry.triggerGlob` — an OPTIONAL trigger predicate that gates a `pinned:true` note's delivery to kickoffs whose text names a matching path, instead of pinning it globally. `null` (the default, and every pre-existing note) means "no predicate" — behaves EXACTLY as `pinned` always has. A non-null value is a path glob (same `*`/`**`/`?` semantics used elsewhere in this codebase for path matching, e.g. `git/worktrees.ts`'s deny-glob matcher) tested against path-like tokens found in the kickoff/task text — see `sessions/project-memory-recall.ts`'s `triggerMatchesKickoff` for the match, and its own doc comment for the argument for this mechanism over the two rejected alternatives (tool name, card label).

Only meaningful on a `pinned:true` note that is NOT also tagged `"never-drop"` — a never-drop note always bypasses its own trigger (that floor is a guarantee; a predicate must never silently weaken it), and an unpinned note was never gated by `pinned` in the first place, so a trigger on it is inert. `memory_write`'s response reports which of these applies (see mcp/memory.ts's `TriggerGateSignal`).

Unlike an ordinary pinned note (excluded from the FTS "related" tier — see `db.ts`'s `searchProjectMemory` doc comment), a trigger-gated note stays FTS-reachable on a kickoff where its predicate does NOT fire — the whole point of gating is that the note competes on relevance instead of riding for free, so it must never become LESS reachable than an ordinary unpinned note would be.

## Do not

- Do not let a `"never-drop"`-tagged note's trigger silently weaken its guarantee — a never-drop note always bypasses its own trigger.
- Do not set a trigger on an unpinned note expecting it to gate anything — a trigger is inert unless the note is also `pinned:true`.
- Do not exclude a trigger-gated note from the FTS "related" tier the way an ordinary pinned note is excluded — it must stay FTS-reachable when its predicate doesn't fire, or gating would make it strictly worse than an unpinned note.

## Source

JSDoc comment in `packages/shared/src/types.ts` (`ProjectMemoryEntry.triggerGlob`'s own doc comment). Extracted by card 555f817f (tranche 3 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
