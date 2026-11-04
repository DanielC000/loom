# 17420720 — the Atlas Terminals node IS the classic page, mounted

Owner intake `f791fe02` asked for an Atlas terminals page *"like the one on the current ui"*. Card
`b439c2dc` answered that with a single-column, single-mount list (`SessionTerminalList`) and argued
at length for why it should NOT be the classic tile grid. The owner's verdict on that answer,
verbatim:

> *"atlas terminals page sucks. it should be terminal cards in grid like in the old ui."*

This card supersedes that choice. `docs/decisions/b439c2dc-atlas-workspace-terminals-node.md` has
been amended in place so it no longer states a prohibition the owner has overruled; read it for the
parts that still stand (why the node lives at `/workspace-terminals` rather than `/terminals`).

## What shipped

`pages/WorkspaceTerminals.tsx` now renders `<Terminals layoutKey="workspace" />` — the classic page
itself. Four lines of render, and that is the whole feature.

There was nothing to extract. `pages/Terminals.tsx` was ALREADY a host-parameterised component:
cards `25c08fba` and `f3b18f27` made it one so the Atlas PROJECT node could mount it as its Sessions
tab, and its no-prop mount is exactly this page's god-eye grid — every running session as a
`TerminalTile` in the `AUTO_GRID_TEMPLATE` grid, manager-grouped rows, the project filter, maximize,
and the Shells lane (`ShellsSection`: the spawn modal, the shell tiles, the two-step Kill) above
them. "Reuse the classic components, do not fork them" is satisfied most completely by mounting the
component, not by lifting pieces out of it into a third place.

## The one change to the shared component: `layoutKey`

`Terminals` gained a third optional host prop. It names the storage slot the reader's grid layout is
kept under, and the columns picker, the per-tile order controls and the Reset button now gate on
`layoutScope = layoutKey ?? projectId` instead of on `projectId`.

That gate was conflating two different questions:

- **"Is there ONE project to start a session in?"** — the quick-start's question. Still `projectId`'s,
  unchanged. The workspace mount answers NO, and correctly renders no quick-start.
- **"Is there a slot to persist this grid's layout under?"** — the layout's question. The workspace
  mount answers YES: it is a standing page a reader lays out once and returns to, even though it
  spans every project.

`layoutKey` is consulted FIRST so a host passing both is naming the slot explicitly rather than
having its project id override what it asked for. A host passing NEITHER — the classic page — keeps
`DEFAULT_TILE_LAYOUT`, draws no picker and no reorder controls, byte-identically to before.

The workspace slot is the fixed literal `"workspace"` (`loom.sessionsLayout.workspace`), safe as a
literal because every project-scoped mount keys on a project UUID, so no real project can collide
with it. It is deliberately not shared with any project's key: the column count that suits one
project's two sessions is the wrong one for the whole fleet's nine — the same reason the per-project
keys are per-project in the first place.

## What single-mount means now, and what it stopped meaning

Card `b439c2dc`'s rule was "at most ONE terminal mounted on this page at a time." A god-eye grid
mounts N by design, so that rule did not survive the owner's call — it was a property of the shape
being replaced, not an invariant of the node.

What survives, and is asserted: **no session's terminal is mounted twice.** A duplicate card would be
a second live `/ws/term` attach to the same pty — wasted, and a source of interleaved stdin. The spec
measures it both ways (no duplicate short id in the rendered set, and exactly one socket per seeded
session id), because a short-id comparison alone could miss a second card for one session while a
second attach cannot.

The cost the old shape was avoiding is real and is now simply accepted, the same way the classic page
has always accepted it: this is a heavy page. `CLAUDE.md`'s own warning about a live-terminal page
freezing a CDP renderer still applies to anything automating it — eyeball it with a real browser
sparingly, and prefer the headless Playwright path.

## What was removed, and why it is dead rather than merely unused

Both removals exist only because this card replaced the shape that used them:

- **`SessionTerminalList`'s `atRest` prop** (`components/sessionTerminals.tsx`). Added by `b439c2dc`
  for its one whole-PAGE caller. That caller is gone; both remaining mounts are DECK cards and never
  passed it. Its own doc said "it exists for a caller that is a whole page", which had stopped being
  true — a dead prop carrying a false rationale is a worse artifact than a deletion.
- **The `.loom-termpage*` CSS block** (`styles/global.css`): a deeper scroll track, a band-head filter
  group, and the reserved-seat rules. Verified unreferenced across `packages/web/src` after the page
  changed.

The `.loom-wsession*` row grammar beside them is UNTOUCHED — it is the deck cards' own and was never
styled by what was removed.

## Do not

- **Do not re-point the Atlas tree's Terminals row at `/terminals`.** Unchanged from `b439c2dc`:
  under Atlas that address is the project node's Sessions tab (card `25c08fba`, routed at
  `<ProjectHome/>`), so a workspace-tier row pointing at it lands on the project node, and a second
  `<Route>` on one literal path is the precedence contest `AtlasShell`'s `REHOMED_TAB_PATHS` note
  forbids.
- **Do not add `/workspace-terminals` to `NAV_PAGES`.** It would put a second Terminals row in the
  classic rail for a user who never opted into Atlas.
- **Do not fork, copy or re-implement the grid, the shells lane or the controls in
  `WorkspaceTerminals.tsx`.** It renders by mounting `pages/Terminals.tsx`; anything that should
  change for both surfaces changes there.
- **Do not pass this mount a `projectId` or `projectName`.** A cross-project god-eye page has no
  single project to pre-filter to or to spawn into; passing one would narrow the page and offer a
  spawn into a project the reader never chose.
- **Do not re-gate the columns picker on `projectId`.** That is the conflation this card undid, and
  re-making it silently removes the control from this node.
- **Do not give the classic page a `layoutKey`.** Its having no layout slot — and therefore no
  columns picker and no reorder controls — is card `ac0cfe91`'s own god-eye contract, pinned by
  `atlas-sessions-layout.spec.ts` and again by this card's own switch-OFF leg.
- **Do not reintroduce `atRest` or `.loom-termpage*`** without a caller that needs them.
