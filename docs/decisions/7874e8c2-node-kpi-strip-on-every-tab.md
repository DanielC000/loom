# The node KPI strip rides every node tab except Overview

Card `7874e8c2` (Atlas restructure 5 of 11, epic `9fe8cd4e`). Closes item 5 of the Atlas gap audit.

## What changed

`KpiStrip` used to render on exactly one tab per home node — the Deck tab — so the other seventeen node tabs carried no readout of the node they belong to at all. It now renders on every tab of both home nodes, selected by one predicate, `nodeTabShowsKpiStrip` (`packages/web/src/components/atlasHome.tsx`), which both `ProjectHome` and `WorkspaceHome` call.

Measured before the change, at 1440, by collecting the tab keys off the rendered app: 2 of 19 node tabs showed a strip (`/project?tab=deck` and `/home?tab=deck`). After: 17 of 19 — every tab but the two Overviews.

## Why Overview is the exclusion

The predicate is not a list of tab keys. The rule is *every tab whose own body does not already carry the node's readout*, and Overview is the only tab that does: it renders the full-size `KpiDeck` roughly 50px below the tab row, fed the **same** `kpis` array the strip is fed.

This is also what the approved round-4 V2 mockup does. Read off the mockup captures rather than its prose: `mockup/project-overview-1440.png` and `mockup/root-overview-1440.png` carry no strip on their tab rows, while `memory-1440.png`, `runs-1440.png`, `inbox-1440.png` and `project-deck-1440.png` all do.

It was also rendered and looked at before being ruled out, not argued away on paper. With the predicate forced to `true`, the Overview tab shows `3 OPEN CARDS` as a pill directly above an `OPEN CARDS / 3` tile, `0 NEEDS YOU` above `NEEDS YOU / 0`, and so on for all six — a shrunken ghost of the deck immediately beneath it. That is the same "readouts as pills on the tab row" shape round 3 shipped and the owner rejected, recorded in `KpiDeck`'s own "SIZE IS THE FEATURE" note (card `939922ee`); re-adding it *above* the tiles that replaced it would be that regression plus the duplication.

Two sibling specs already pinned this from the other side before this card existed, each with its own reasoning: `atlas-home.spec.ts` ("the deck is the FULL-SIZE one, not the Deck tab's compact strip") and `atlas-deep-links.spec.ts` ("the Overview tab's own readout"). Both assert `atlas-kpi-strip` is absent on Overview and both still pass unchanged.

## Where this departs from the card's written DoD

The card's DoD asks the spec to assert the strip "reads it on the Board, Memory and Runs tabs as well as on Overview". The clause about Overview is the one part of it this change does not satisfy literally, for the reasons above. What ships instead: on Overview the node's readout reads the seeded count **in the deck**, and `atlas-node-kpi-strip.spec.ts` asserts exactly that, so every tab named in the DoD is covered by a real assertion against seeded data and Overview's is simply made against the tile rather than the pill.

## The strip takes a second line, and that is the better half of the trade

At 1440 the Atlas content column is 1156px. The project node's ten tabs measure 715px and the six-pill strip is around 690px, so the two cannot share a line; `.loom-atlas-tabs` already wraps, so the strip drops below the tabs and the tab block goes from 35px to 74px tall on every tab that carries one.

The mockup does not solve this — it overflows instead, and its tab row is visibly truncated: `memory-1440.png` cuts off mid-count at "Memory 8" and loses Runs, Archive and Settings entirely, with no scrollbar and no other way to reach them. Wrapping costs 39px; clipping costs three tabs. This is the same call card `25c08fba` made when it gave `.loom-atlas-tabrow` its own `flex-wrap`, and the wrapped placement is not new chrome either — it is exactly what the Deck tab has shipped since card `25c08fba` re-homed the project surfaces.

## Do not

- **Do not make `nodeTabShowsKpiStrip` return true for `overview`.** The strip and the deck are fed the same `kpis` array, so the node's six figures would be stated twice within 50px of each other, and `atlas-home.spec.ts` plus `atlas-deep-links.spec.ts` both assert the absence directly.
- **Do not re-express the rule as a list of tab keys.** It is a predicate so that a tab a later card re-homes onto a node inherits the strip without this file being edited; a list silently omits the new tab and nothing fails.
- **Do not "fix" the second line by removing `flex-wrap` from `.loom-atlas-tabs` or `.loom-atlas-tabrow`.** The row does not fit beside a six-pill strip at any supported width, so unwrapping it clips tabs off the row rather than tightening the layout — measured at 1440, not only at phone width.
