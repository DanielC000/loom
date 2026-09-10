# aeec1880 — `triggerGlob`: gate a pinned memory note's delivery to a matching kickoff path

## Narrative

Card aeec1880 added `ProjectMemoryEntry.triggerGlob` — an OPTIONAL trigger predicate that gates a `pinned:true` note's delivery to kickoffs whose text names a matching path, instead of pinning it globally. `null` (the default, and every pre-existing note) means "no predicate" — behaves EXACTLY as `pinned` always has. A non-null value is a path glob (same `*`/`**`/`?` semantics used elsewhere in this codebase for path matching, e.g. `git/worktrees.ts`'s deny-glob matcher) tested against path-like tokens found in the kickoff/task text — see `sessions/project-memory-recall.ts`'s `triggerMatchesKickoff` for the match, and its own doc comment for the argument for this mechanism over the two rejected alternatives (tool name, card label).

Only meaningful on a `pinned:true` note that is NOT also tagged `"never-drop"` — a never-drop note always bypasses its own trigger (that floor is a guarantee; a predicate must never silently weaken it), and an unpinned note was never gated by `pinned` in the first place, so a trigger on it is inert. `memory_write`'s response reports which of these applies (see mcp/memory.ts's `TriggerGateSignal`).

Unlike an ordinary pinned note (excluded from the FTS "related" tier — see `db.ts`'s `searchProjectMemory` doc comment), a trigger-gated note stays FTS-reachable on a kickoff where its predicate does NOT fire — the whole point of gating is that the note competes on relevance instead of riding for free, so it must never become LESS reachable than an ordinary unpinned note would be.

## Mechanism chosen, and the two rejected alternatives

MECHANISM CHOSEN: a touched-path GLOB, matched against path-like tokens found literally in the kickoff/task text — the SAME text `retrieveProjectMemoryForKickoff` already threads through to the FTS "related" query via its own `kickoffText` param — not the actual files a worker's branch ends up touching (unknowable at kickoff time, before the worker has touched anything; the git-diff-based deny-glob matcher in `git/worktrees.ts` operates on REAL touched files, but only exists post-hoc at merge review, a different moment entirely). A Loom task card routinely names the files it concerns literally in its own title/body (this project's own board cards do this constantly, including the card that filed this feature) — a worker-spawn `kickoffText` is exactly `${task.title}\n${task.body}` (`sessions/service.ts`) — so a glob predicate over that text needs ZERO new plumbing: the data it needs already exists at the one place this note is composed, for every kickoff shape (fresh spawn, resume, fork, recycle) `retrieveProjectMemoryForKickoff` already covers.

REJECTED — tool name: no tool has been invoked yet at kickoff time (the session hasn't taken a turn), so gating on "the next tool this session calls" isn't a kickoff-time predicate at all — it would need the note re-evaluated and injected MID-session, on every tool call, which needs new runtime plumbing inside every MCP router (a materially bigger surface than this card's scope, and would touch `mcp/orchestration.ts` — a file this card's own kickoff flagged as held by another live worker at the time).

REJECTED — card label: `Task` (`packages/shared/src/types.ts`) has no modeled "label" concept at all — only `title`/`body`/`columnKey`/`priority`/etc. (verified by reading the interface directly). This predicate would first require adding an entirely new task field (schema + validation + UI) — a separate, larger card of its own — where a touched-path glob needs none of that.

## Do not

- Do not let a `"never-drop"`-tagged note's trigger silently weaken its guarantee — a never-drop note always bypasses its own trigger.
- Do not set a trigger on an unpinned note expecting it to gate anything — a trigger is inert unless the note is also `pinned:true`.
- Do not exclude a trigger-gated note from the FTS "related" tier the way an ordinary pinned note is excluded — it must stay FTS-reachable when its predicate doesn't fire, or gating would make it strictly worse than an unpinned note.

## Source

JSDoc comment in `packages/shared/src/types.ts` (`ProjectMemoryEntry.triggerGlob`'s own doc comment). Extracted by card 555f817f (tranche 3 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

"Mechanism chosen, and the two rejected alternatives" above is a SECOND site for the same card id: the JSDoc comment above `retrieveProjectMemoryForKickoff`'s `PATH_TOKEN_RE` in `packages/daemon/src/sessions/project-memory-recall.ts`, lines 606-634 as of tranche 1 on that file. Same decision, not a second one — extracted into this file rather than a new one per the "one record file per id" rule.
