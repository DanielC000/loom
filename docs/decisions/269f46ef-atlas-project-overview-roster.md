# 269f46ef — the Atlas project Overview drops the board and becomes a roster page

Card `269f46ef` (parent `16106aaf`, the owner's 2026-11-03 Atlas feedback round). His words, verbatim, under Projects › tab "Overview":

> "Remove Board."
> "Dashboard cards too cluttered on narrower page width. Remove "AGENTS" card. Rework and Expand the rest of the cards now that the board is gone. Improve them."

Phase 1 filed three mockups (vault `Mockups/2026-11-04 Atlas Overview without board/`); he picked **C · Roster** on request `891ed41f`, with one amendment, verbatim:

> "Overview C: "Needs you" should be on top in its own row so it has enough space"

**Scope: the ATLAS project node's Overview tab alone** (`pages/ProjectHome.tsx`). The classic `pages/Overview.tsx` embed and the **Workspace** node (KPI deck, five-panel band, project grid) are untouched, byte-identically; project memory `overview-board-embed-position-is-owner-ruled` stays fully in force.

## What the page is now

One element per row at the node's `.loom-atlas-home` rhythm: **briefing line** (four readings + a landed figure with its 14-day sparkline) → **Needs you**, full width → **Work in flight**, the roster table and primary surface → a **Board** lane bar of label+count chips → **Pulse**, full width. New: `components/atlasProjectOverview.tsx` + `lib/atlasProjectOverview.ts`, mounted by `ProjectHome` alone. `needs`/`pulse` keep their `atlas-band-*` testids — same cards, same data; re-minting them reddens five sibling specs.

Two facts are new, both off reads `ProjectHome` already makes (no `api.ts` member, no new request): **the card a session holds** (`Session.taskId` off `api.allSessions`, titled from the board roll-up) and **its last event** (the `api.orchestrationEvents` stream Pulse assembles). Managers and workers resolve "last event" differently on purpose (`managerSessionId` vs `workerSessionId`) — keying the map on the worker id alone blanks every manager row.

## Why these shapes

- **The inversion (not round 3 again).** `KpiDeck`'s note says size is the feature — round 3 shrank a node's readouts to pills and the owner read the page as "the board" (card `939922ee`). That held while the readouts were the only furniture competing with a board; this node has neither, so the job inverts. It is a **replacement**, not a twin (the deck is not mounted here, so no figure is stated twice), picked knowingly from mockups whose README states the inversion. Card `4a0ad464` governs a **tab row** — not in tension.
- **Five cells, not the mockup's six** — board · fleet · worst context · gate lanes · landed. The two dropped (`HEAD main …`, `2 working`) are head pills on every tab, so the mockup drew each twice within ~40px: card `5968d7e0`, which binds whichever direction the duplication arrives from.
- **Nothing was dropped**, only re-homed — board and Agents panel to their own tabs, Fleet to the roster table, Gates and the KPI deck into the line's readings and breakdowns. The **disclosure** has nothing left to fold: cards are content-sized, so an empty Needs-you card is one line, not a 320px void.
- **A card deep link still reaches a board.** `ProjectHome` **normalizes the address** onto `/board`, carrying every query key but its own `tab` — the Platform node's move, for its reason (`@decision 260fb29a`): rewrite the address, never merely derive a tab, because `Board` clears the param it consumes. The re-homed body passes `deepLinks={tab === "board"}` so a hidden board cannot eat the param unseen.
- **`AttentionRow`'s 0px collapse was ALREADY closed.** Card `c2968651` measured it (0px wide, ~230–490px tall, ~300px column) and left it open; this card's phase-1 note repeated that and was **wrong** — `d0d430d4` closed it in 2026-10 for every Atlas mount via the opt-in `compact` layout, and MEASURED the deciding part (see Do-not below). `components/fleet.tsx` is untouched; at 1156px the collapse is unreachable. ⚠️ **Residual:** the non-`compact` one-line row keeps the latent shape at a narrow viewport — its own card.

## Do not

- **Do not re-embed `<Board/>` in this tab, and do not re-add the `KpiDeck` or the `BandDisclosure` to it.** All three were removed on the owner's own instruction, not as a tidy-up. The standing directive that the embed is the primary board surface (card `c6bdf358`, restated on `fd99b2d7`, `25c08fba` and `44f725fe`) is overridden **here only** — on the classic `pages/Overview.tsx` it is untouched and still binds.
- **Do not move a shape out of `components/atlasProjectOverview.tsx` into `components/atlasHome.tsx` to "share" it.** That file is mounted by the Workspace node too; this composition is the project node's alone, and the Workspace node's byte-identical rendering is a stated constraint of this card.
- **Do not grow a briefing reading past the roster table's own type**, and never mount the deck and the line together. See the inversion above: the line only works because nothing in it out-shouts the table.
- **Do not drop a column from the roster row at narrow width.** The stacked form keeps all seven cells in the same order, each gaining its own label. Dropping one is the failure the fixed-height band had, and the reason a table was picked over another card grid.
- **Do not add `white-space: nowrap` to `AttentionRow`'s shared `textBase`** believing it fixes the 0px collapse. Measured on card `d0d430d4`: it does not — it replaces invisible wrapped text with an invisible empty box.
- **Do not remove the `?task=` address normalization** without putting a `<Board/>` back on whichever tab the link lands on, and do not let the re-homed Board body consume the param while it is hidden.
- **Do not restate a node-head pill's figure in the briefing line.** `working` and the repo head are head pills on every tab; the mockup drew both twice and that is the one thing in it this build does not reproduce.
