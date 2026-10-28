# ec1aa18e — the Atlas tree's project branch lists what is RUNNING, not the project's own tabs

Card `ec1aa18e` (child of `93d50f2d`, the owner's Atlas sidebar feedback), on cards `0d0c6cee` (the tree is an entity hierarchy), `25c08fba` (the project surfaces became tabs on the project node) and `3b563642` (the tree's fourth level is an entity).

The owner's words, verbatim:

> projects tree on the sidebar show the pages instead of the running agent. We have the pages as tabs now. I doubt we need to have the tabs for each project in the sidebar too.

> Currently running projects should be ordered at the top, ordered alphabetically. Above projects that are not currently running.

## What changed

A project branch is now its **Home** row, then its **live sessions** (managers with their workers nested, unchanged from card `3b563642`), then the project-depth destinations the node's tab row does **not** carry — today that is `/overview` alone. The eight rows that duplicated a `PROJECT_NODE_TABS` entry (`/board`, `/terminals`, `/repository`, `/memory`, `/runs`, `/archive`, `/settings`, and the Agents node) are gone, and the project tier is ordered running-first, alphabetical within each group.

## Three consequences worth knowing before you touch this

**1. The Home row carries the landed mark for every tab.** With `/board` and friends no longer rows, nothing in the tree matched those addresses and the frame's "exactly one node reads as landed" claim would have read zero. `HomeNode`'s `alsoActiveAt` prop closes it, fed by `projectNodeTabAt` — the same resolver the node and the frame already read, so the tree cannot disagree with the crumbs. This is exactly the shape the Workspace home already had for its own seven `WORKSPACE_NODE_TABS`; the project tier simply had no equivalent until now.

**2. The destination partition is five-way.** `atlas-tree.spec.ts` partitions every rail destination into tree node / escape hatch / Workspace node tab / retirement. A project node tab is a fifth home, parsed from `PROJECT_NODE_TABS` with the same raw-marker control its siblings use. `atlas-legacy-redirects.spec.ts` needed the same bucket, since `/repository` is a redirect target that is now a project tab.

**3. The Board's card tier went with the Board's row.** Card `3b563642` hung a project's open cards under the `/board` row. That row is one of the duplicated tabs the owner asked to remove, and a card tier with no row to hang from would have had to invent a home nobody asked for — so `openCardsForTree`, `MAX_CARD_ROWS`, the `+N more` overflow row and the `entity="card"` branch of `EntityRow` are deleted, along with the half of `atlas-tree-entities.spec.ts` that measured them. **This is a deliberate removal, not an oversight.** If the cards are wanted back in the rail, they need their own placement decision; do not reinstate the `/board` row to get them.

## Do not

- **Do not re-add a tree row for a declared `PROJECT_NODE_TABS` destination.** That is the duplication this card removed, and `atlas-tree.spec.ts`'s partition now fails a destination that is both a row and a tab.
- **Do not give the Home row its landed mark from a hand-listed set of paths.** It reads `projectNodeTabAt`, so a tab added to the declaration is covered without touching this file.
- **Do not mark a NON-selected branch's Home row as landed.** A tab address renders the ACTIVE project's data; marking another branch would have the tree name a project the page is not showing.
- **Do not restore the card tier by putting the Board row back.** See consequence 3.
- **Do not re-sort the project tier by anything but `liveByProject`.** It is the same count the row's own live chip shows, so a project can never sort into the running group while its row reads no live sessions. A second liveness notion would let the two disagree.
