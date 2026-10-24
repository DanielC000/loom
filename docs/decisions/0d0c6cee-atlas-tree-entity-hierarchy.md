# 0d0c6cee — the Atlas tree is an entity hierarchy, not a page list

Card `0d0c6cee` (Atlas restructure 1 of 11, epic `9fe8cd4e`), after the owner's verdict on the phase-1/2 build: *"the worst of both worlds"* — a tree rail that costs 244px and has none of a tree's hierarchy. The gap audit that produced the card (`$LOOM_PROJECT_WORK_DIR/atlas-gap-audit/REPORT.md`) measured the cause: the design TOKENS are byte-identical to the approved round-4 V2 mockup, and the composition kit already exists; what never got built is the tree's own STRUCTURE and the node-tab model.

The approved design is the mockup's own declarations — `index.html`'s `<aside class="tree">` markup and `atlas.js`'s `NODES` / `ROOT_TABS` / `PROJ_TABS` — not the screenshots.

## What changed

The workspace tier used to be the classic rail's flat list of 12 destinations. It is now two rows: the Workspace home and the reserved **Platform** node. Everything below is **projects** — one row per project, each a branch that opens into that project's own surfaces.

### Expansion is not selection

A project row carries two separate controls: a **twist button** (`aria-expanded`, its own `data-testid`) that opens and closes the branch, and the **selector button** that writes the active project. They were one control before, which made the tier a one-open accordion keyed to selection — the reader could not look into a project without re-scoping the page they were reading.

`is-open` on the selector still means **selected**, and is still true for exactly one row ever (`atlas-project-selection.spec.ts` reads it). The class is mirrored onto the row wrapper only so the phosphor left-edge can sit at the rail's own edge, since the twist is no longer inside the button that draws it.

### A row in a branch you are not scoped to re-scopes before it navigates

Every expanded project renders its own copy of the project-scoped surfaces. Those pages read the ACTIVE project, so a row under project B that navigated without re-scoping would render project A's data under a row naming B. Each such row therefore calls `setProjectId` on click, before the navigation.

Two consequences follow, and both are load-bearing:

- Only the **selected** branch's rows are `NavLink`s; the rest are plain `Link`s. A `NavLink` computes its own `isActive` from the path alone, so the same destination would read as landed in every open branch at once — and would contribute an `aria-current` from each. `a.loom-atlas-node.is-active` stays exactly one element however many branches are open, which several specs assert.
- Only the **selected** branch's rows keep the unqualified `atlas-node-<to>` / `atlas-home-<key>` test ids. A row for the same destination in another branch is a different element, so it gets a `<projectId>-` stem. Reusing one id would resolve N elements the moment a second branch opened — the same strict-mode trap card `318b5a21` hit with the quick-spawn `＋`.

### Metrics come only from caches another surface already fills

Every figure on a row is composed client-side from a query key some other surface already polls — `["allSessions"]` (ActiveProjectProvider), `useAttention()` (mounted app-wide by `App.tsx` for both shells), `["agents", id]` and `["board", id]` (`pages/ProjectHome.tsx`). No `api.ts` member was added, per `docs/plans/atlas-ui/02-architecture.md`'s reuse rule.

Metrics are therefore on the **selected** branch's rows only, and stop at Agents and Board. Widening them to every open branch would mean a board read and an agent read per project on every Atlas page; Memory, Runs and Archive have no shell-shared cache at all. An absent metric is honest; an approximated one is not, and card `25c08fba` is about to own these counts as node-tab counts anyway.

### The ten re-homed destinations keep their addresses

Mission Control, Terminals, Inbox, Gates, Projects, Actors, Companion, Automation, Usage and the workspace Settings node all leave the tree — cards `41eab0eb` and `25c08fba` re-home them as node tabs. Until then they stay reachable from a `<details>` disclosure at the foot of the tree, named for what it is, which auto-opens on whichever of them you are looking at.

The disclosure's links are deliberately **not** `.loom-atlas-node` rows. A hierarchy with a flat page list bolted to its side is the thing this card exists to end; keeping them visually and structurally apart is what makes the removal real rather than cosmetic.

## Do not

- **Do not fold the twist back into the selector button.** Expansion and selection are different questions, and a reader must be able to open a branch without re-scoping the page they are reading.
- **Do not make a non-selected branch's rows `NavLink`s**, and do not give them the unqualified `atlas-node-<to>` test ids. Both turn "exactly one node is active" and "one element per node" into false statements as soon as a second branch opens.
- **Do not add an `api.ts` member, or a per-project query, for a row metric.** If no shell-shared cache answers it, the row carries no metric.
- **Do not let a row under project B navigate without re-scoping to B first.** The page it lands on reads the active project.
- **Do not re-add the "Not yet re-homed" disclosure.** It was scaffolding with a named demolition date, and that date has passed: cards `41eab0eb` and `25c08fba` re-homed eight of the ten destinations it held, and card `5afd71bd` retired the last two and DELETED the disclosure, its `unhomed` derivation and its whole `.loom-atlas-unhomed*` stylesheet block. An unscoped destination with no placement is now ABSENT from the tree, and `atlas-tree.spec.ts`'s four-way partition is what refuses to let that happen silently — decide the destination's placement instead of reinstating a flat list beside the hierarchy. See `docs/decisions/5afd71bd-atlas-retire-mission-control-and-projects.md`.
