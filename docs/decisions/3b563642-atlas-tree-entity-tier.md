# 3b563642 — the Atlas tree's fourth level is an ENTITY, not a page

Card `3b563642` (Atlas restructure 8 of 11, epic `9fe8cd4e`), on card `0d0c6cee`'s entity hierarchy. The approved design is the round-4 V2 mockup's own tree markup, not the screenshots: `Workspace › Loom › {Orchestrator › (Web Designer, Dev, Bugfix, QA Tester), Agents, Board › raise maxConcurrentGates, …}`. Card `0d0c6cee` built the first three levels; this one builds the fourth — a live session under the manager that dispatched it, and an open board card under the Board row.

Under every project branch the live sessions now lead its surfaces: one row per manager, its workers nested under it, and the sessions no live manager owns beside them. The Board row gained a tier of its own — the project's open cards, in the board's own order, each opening that card in the centred dialog. The partition is `lib/sessions`' existing `groupSessionRows`, reused rather than re-spelled, so the rail and the Terminals grid cannot disagree about who dispatched whom (and companions stay excluded at the source).

### A session row is a NODE; a card row is not

A session row is a `NavLink` on the selected branch, so `/session/:id` finally marks a row — `AtlasShell`'s own comment used to defer that to "phase 2" and mark nothing. `/review/:workerId` is the SAME node (that worker node's Diff tab), so `activeNodeTo` resolves to `/session/<workerId>` there; `isActive` cannot see that by path, as it cannot for a `/question/:id` detail row.

A CARD row is a plain `Link` in every branch — the one place that does not follow from card `0d0c6cee`'s selected-branch rule. `?task=` is a SEARCH param, which `isActive` ignores entirely, so every card row would read as landed the moment a reader was anywhere on `/board`.

### Entity rows are marked, because they are not destinations

Three specs police the tree by partitioning every `src/nav.tsx` address into node / escape-hatch / node-tab. An address minted per ROW is in none of those three, so every entity row carries `data-atlas-entity` — without it those collectors need a per-session, per-card exemption list.

### Session rows are free; card rows are not

`["allSessions"]` is ONE cross-project cache entry that is already polled, so a session row costs the same in any branch and renders in all of them. `["board", id]` is `projectId`-KEYED, so a card tier on a non-selected branch would mean a board read per open branch — the per-project query card `0d0c6cee` forbids. The split between the tiers is that distinction, not a preference.

### Each sub-tier owns its own expansion state, with opposite defaults

A manager opens by default (a live worker you cannot see is one you forget is running); the Board stays shut until asked (an open-card list is as long as the board is busy, and the mockup draws its own card node under a CLOSED Board row in every captured view). Both live in a second map, never `openBranches` — a sub-branch keyed there would collide with a project id and make a manager's twist close the project it sits in.

### The twist is laid OVER the anchor's reserved column

The project branch row hoists its twist out in front of its selector, because that row is a `<button>` whose branch edge belongs at the rail's own left edge. An entity or destination row is an `<a>` that must keep its own 2px left border — that border IS the landed edge — so its twist is absolutely positioned over the anchor's blank twist column instead, still a real sibling of it.

### Two readings the rail cannot afford

A session row's metric is context occupancy, only that. The mockup reads `gen 412` on its manager and `10% / 71% / 28%` on its workers — two rules for one column; the generation now sits on the session node head (card `5968d7e0`'s `gen · turns` pill), and context is the figure that decides which session gets recycled next.

A card row's label drops its Conventional Commits prefix, as the mockup's card node does. MEASURED: at this depth the rail leaves ~18 characters and `feat(daemon): ` is 14 of them, so the untrimmed form ellipsised every row to its type and scope. The full title stays on the row's `title`.

## Do not

- **Do not make a card row a `NavLink`.** Its `?task=` is a search param that `isActive` ignores, so every card row would read as landed anywhere on `/board` — N active nodes beside the one that really is.
- **Do not drop `data-atlas-entity` from an entity row**, and do not add an entity row that lacks it. The destination-partition specs read `src/nav.tsx`, and a per-row address belongs to none of their three homes.
- **Do not give a non-selected branch a card tier.** It needs a `["board", <that id>]` read per open branch, which is the per-project query card `0d0c6cee` forbids. Session rows are the opposite case and are deliberately rendered everywhere.
- **Do not key a sub-tier's expansion into `openBranches`.** It collides with a project id, and a manager's twist would then close the project it lives in.
- **Do not hoist an entity row's twist out of the anchor.** The anchor's own 2px left border is the landed edge and must stay at the same x as its siblings; hoisting it moves every label in the tier off one origin. Nor may the absolute rule drop its explicit `width` — out of flow is out of FLEX, so `flex: 0 0 12px` stops sizing it (measured: 5.3px, a third of the project row's hit area for the identical control).
- **Do not render the card tier unbounded.** The cap reports itself as a trailing row; a list a reader takes for complete is worse than one that admits its bound.

## Not carried

The mockup also hangs `Platform Lead` under the reserved Platform node — a WORKSPACE-tier row, not a project branch, and this card's scope is the project branch. The Platform node keeps the `N live` metric card `0d0c6cee` gave it; a later card can hang its operator sessions there off the same partition and the same cache.
