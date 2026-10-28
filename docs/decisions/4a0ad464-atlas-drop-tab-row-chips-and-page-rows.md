# Atlas: no tab-row chips, no project page rows, one Workspace home tab

Card `4a0ad464`. Owner feedback, 2026-10-28, plus the unfinished residue of his feedback on card
`93d50f2d`. Three parts, one coherent change to the Atlas IA.

## The owner's words

On the tab-row chips (verbatim):

> "Chips like \"21 needs you 1/1 mgr · workers 40% worst context 0·0 gate run·queued 83 open cards 4 merged today\" on the tabs row are not necessary and need too much space causing the need for a \"More..\" tab. remove them."

On the tree (card `93d50f2d` item 1, verbatim):

> "projects tree on the sidebar show the pages instead of the running agent. We have the pages as tabs now. I doubt we need to have the tabs for each project in the sidebar too."

On the two home tabs (card `93d50f2d` item 3, verbatim):

> "What is the need to have an overview tab, and a deck tab? Feels redundant to me. Unify the pages to one."

## A. The tab-row KPI strip is gone, everywhere

`KpiStrip`, `nodeTabShowsKpiStrip`, the `.loom-kpistrip` rules and `NodeTabs`' trailing-content slot
are deleted. `KpiPill` stays — it is also the shape the dashboard disclosure's collapsed bar states
its counts in (card `44f725fe`), which is a different readout on a different control.

This supersedes card `7874e8c2`'s prohibition ("never make the predicate return true for overview" —
the predicate no longer exists) and card `44f725fe`'s ("do not strip the re-homed tabs of their own
readout"). Both records carry a superseding section pointing here.

**It does NOT touch the full-size `KpiDeck`.** Those are a different component with a different
contract: card `939922ee`'s own diagnosis was that shrinking the readouts to pills is what made the
page stop reading as an overview, and that rule is now *why* there is no small copy anywhere, rather
than something this card overturns.

Measured at 1280 / 1440 / 1920, both home nodes, after the change: the tab block is **35px, one
line, every declared tab in the row, no More trigger, no document overflow**. See `d4350286`'s record
for the widths where the overflow menu still fires (900 and below with the rail present; 600 and
below once the rail is a drawer) and why the machinery stays.

## B. A project branch holds entities, never pages

Card `ec1aa18e` removed the eight rows the project node carries as TABS. This card removes the last
two — `Home` (the node's own address) and `Overview` — because the owner read them as the same
redundancy. A branch now holds live sessions and nothing else.

### The project row is the node's address now

With `Home` gone, nothing in the tree could reach `/project`. So `ProjectNode`'s selector does it:

> the row takes you to the project node, EXCEPT where clicking it has real work of its own to do.

Concretely (`selectAndOpenProject`): it navigates unless you are on one of that node's own tabs AND
clicking re-scopes to a *different* project. On a tab the address is project-agnostic and the page
reads the active project, so re-scoping alone already re-renders it — and yanking a reader off the
Board for picking a different project would lose the surface they deliberately chose. But clicking
the row you are ALREADY scoped to, from one of its tabs, has nothing to re-scope: without the
navigation that click would do nothing whatsoever, which is the one outcome a control must never
have. (That case is not hypothetical — it is what reddened `atlas-first-run-states.spec.ts` against a
first draft that navigated only off-tab.)

It stays a `<button>`, not a link: it does not always navigate, so an href would promise a
destination it sometimes declines to go to, and `aria-current` / `is-open` are what "the branch you
are inside" has meant since P1-4.

### An empty branch says so

Before this card an idle project's branch still held two page rows. Now it can be empty, and a twist
that opens onto nothing reads as broken. `.loom-atlas-idle` is one muted, non-interactive line —
"Nothing running" — carrying the same two leading spacers every row in the rail does, so its text
lands exactly where a sibling session row's label does. Deliberately not a link: the row above it is
already the way into the project, and a second one would be the page row this card just removed
wearing a different label.

### ⚠️ `/overview` now has NO Atlas navigation, and that is a loose end

It is the one destination left in neither bucket: not a node tab (the project node's own Overview tab
is a different component), not a tree row, not retired. Its address still routes and still renders
its own page under **both** shells, and `SetupWizard` still lands a freshly-created project on it —
so nothing is broken, but a reader reaches it only by URL.

`atlas-tree.spec.ts` names this as a sixth placement, `PAGE_ONLY_DESTINATIONS`, spelled out one entry
at a time rather than derived from "whatever fell out of the tree" — so a destination that falls out
by accident still fails that spec's partition.

**The tidier end state would be a retirement onto the project node**, the same shape card `5afd71bd`
gave Mission Control and `/projects`: the classic `/overview`'s panes are all on the project node now
(board → the home tab's embed, terminals → Sessions, agents → Agents, activity → Runs). That is NOT
done here. `@decision fd99b2d7` forbids re-pointing `/overview` inside `AtlasShell`, and overruling it
is an IA call of its own rather than a side effect of deleting a tree row. It wants its own card.

## C. The Workspace node has one home tab

The same D1 disclosure card `44f725fe` gave the project node. Full detail — including the three ways
this node's version deliberately differs, and the measured 324px lift — is in that record's own
appended section, not restated here.

## Do not

- **Do not put a compact figure strip back on a node's tab row.** The owner read the chips as space
  the tabs needed; a re-shrunk readout there is the same rejection in a new costume.
- **Do not add a page row to a project branch.** It holds entities. A surface that needs reaching
  goes on the node's tab row, which is where the owner says it already is.
- **Do not take the navigation back out of the project row** without putting a `Home` row back, and
  do not make it unconditional — both halves of its rule are asserted in
  `atlas-tree-hierarchy.spec.ts`, and each is what keeps the other honest.
- **Do not make `.loom-atlas-idle` a control.** It is the branch's empty state, not a destination.
- **Do not retire `/overview` as a tidy-up.** See part B above: it is a real IA decision that
  contradicts a standing `@decision`, and it needs its own card and the owner's eyes.
- **Do not delete the tab-overflow spec or the fold machinery it covers because no desktop width
  folds any more.** Part A's 35px/one-line measurement is at 1280/1440/1920 only — see `d4350286`'s
  record for the widths (900 and below with the rail present; 600 and below once it is a drawer) where
  the menu still fires. Phone width still folds; every leg that needs a fold asserts it rather than
  assuming it.
