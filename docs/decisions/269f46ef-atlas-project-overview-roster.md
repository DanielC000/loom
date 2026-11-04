# 269f46ef — the Atlas project Overview drops the board and becomes a roster page

Card `269f46ef` (parent `16106aaf`, the owner's 2026-11-03 Atlas feedback round). His words, verbatim, under Projects › tab "Overview":

> "Remove Board."
> "Dashboard cards too cluttered on narrower page width. Remove "AGENTS" card. Rework and Expand the rest of the cards now that the board is gone. Improve them."

Phase 1 filed three directions as rendered mockups (vault `Mockups/2026-11-04 Atlas Overview without board/`). He picked **C · Roster** on request `891ed41f`, with one amendment, also verbatim:

> "Overview C: "Needs you" should be on top in its own row so it has enough space"

**Scope: the ATLAS project node's Overview tab only** (`pages/ProjectHome.tsx`). The classic `pages/Overview.tsx` board embed is a different surface, is still the owner's primary board, and is untouched — project memory `overview-board-embed-position-is-owner-ruled` stays fully in force. The **Workspace** node keeps its KPI deck, its five-panel band and its project grid, byte-identically.

## What the page is now

One element per row, top to bottom, at the node's own `.loom-atlas-home` rhythm:

| | what | testid |
|---|---|---|
| 1 | **Briefing line** — four readings with breakdowns, plus a landed figure with its 14-day sparkline | `atlas-overview-brief`, `atlas-brief-<key>` |
| 2 | **Needs you**, full width | `atlas-band-needs` |
| 3 | **Work in flight** — the roster table, the page's primary surface | `atlas-overview-roster` |
| 4 | **Board** — the lane bar plus a label+count chip per lane | `atlas-overview-board` |
| 5 | **Pulse**, full width | `atlas-band-pulse` |

`components/atlasProjectOverview.tsx` (presentational) + `lib/atlasProjectOverview.ts` (pure derivations) are new and mounted by `ProjectHome` alone. `needs` and `pulse` keep the testids they had as band panels: they are the same cards reading the same data, and re-minting their ids would have reddened five sibling specs that are about merge actions and the pulse feed, not about this card.

### The two facts that are new to this page

Both come off reads `ProjectHome` already makes — no `api.ts` member and no request was added, the same rule the Atlas plan set for the original build:

- **the card a session is holding** — `Session.taskId` off `api.allSessions`, titled from the board roll-up's own task list;
- **a session's last event** — the `api.orchestrationEvents` stream the Pulse feed already assembles.

A manager and a worker resolve "last event" differently on purpose (`managerSessionId` vs `workerSessionId`) — a map keyed only on the worker id leaves every manager row blank.

## The inversion, and why it is not round 3 again

`KpiDeck`'s own note says **size is the feature** and "don't mint a compact twin anywhere else on the node", because round 3 shrank a node's readouts to pills and the owner read the page as "the board" rather than "an overview" (card `939922ee`). That rule held while the readouts were the only furniture competing with a board. This node has no board any more and it has a new primary surface, so the furniture's job inverts: **nothing in the briefing line may be larger than the roster table under it**, or the page is a dashboard with a list at the bottom again.

Two things make this a different move from round 3's, not a repeat of it:

1. It is a **replacement**, not a twin. The deck is not mounted on this node at all, so no figure is stated twice.
2. The owner picked it **knowingly**, from rendered mockups whose README states the inversion in those words.

Card `4a0ad464`'s prohibition is untouched and was never in tension with this: it forbids a compact figure strip on a node's **tab row**, which is not where this line lives.

## What was deliberately NOT reproduced from the mockup

The mockup's briefing line has six cells, including `HEAD main 57143a90`, and states `2 working` in its Fleet cell. The built node head already carries **both** of those, on every tab, as head pills — so the mockup draws each of them twice within ~40px of itself. Card `5968d7e0`'s own prohibition is exactly that ("never feed the head pills a figure the node's own readout already carries"), and it binds in whichever direction the duplication arrives from. The built line is therefore **five cells**: board · fleet · worst context · gate lanes · landed. Nothing is lost — both readings are still on screen, one row up.

## Capability: nothing was dropped

| removed | where it went |
|---|---|
| the embedded `<Board/>` | the node's **Board tab**, which mounts the real board, whole and unchanged |
| the **Agents** panel | the **Agents tab** and the tree's `＋` quick-spawn, which render the same `splitRoster` rows through the same `AgentActions`. The node head's own `Spawn +` is unchanged. |
| the **Fleet** panel | the roster table, which states everything that panel did plus the card and the last event |
| the **Gates** panel | the briefing line's `gate lanes` reading (its lane list is the breakdown behind the figure) and its `landed` sparkline |
| the **KPI deck** | the briefing line — the same four breakdowns, behind smaller figures |
| the **dashboard disclosure** | nothing to fold: every card is sized to its content, so an empty Needs-you card is one line rather than a 320px void |

## A card deep link still reaches a board

`/project?task=<id>` was served by the embed. With the embed gone, `ProjectHome` **normalizes the address** onto `/board`, carrying every query key but its own `tab` — the same move, for the same reason, as the Platform node's (`@decision 260fb29a`): rewrite the address, never merely derive a tab, because `Board` clears the param it consumes. The re-homed Board body also passes `deepLinks={tab === "board"}`, so the mounted-but-hidden board a first visit leaves behind can never eat the param where nobody can see the dialog.

## `AttentionRow`'s 0px-width text: fixed at the call site already, and the shared component must NOT be "fixed"

Card `c2968651` measured an attention row collapsing to **0px wide and ~230–490px tall** — one character per line, invisible — in a ~300px band column, and left it open because the text span is shared with Mission Control and the classic Overview. The phase-1 note for this card repeated that as still-open.

**It is not open on this surface, and the obvious shared-component fix would make things worse.** Card `d0d430d4` closed it in 2026-10, for every Atlas mount, with an opt-in `compact` layout that `AttentionList` passes — including the four mounts this page uses. Its own record states the measurement that decides the rest: *"`white-space: nowrap` alone does not fix this: the span would still shrink to 0 and show nothing at all."* `textBase`'s `textOverflow: "ellipsis"` is in fact inoperative today precisely because it has no `white-space: nowrap` beside it — but adding one to the shared default would turn an invisible wrapped row into an invisible **empty** row on the three classic surfaces, which is strictly worse than what they render now. The fix for a narrow column is the layout change, and it exists.

So this card changes `components/fleet.tsx` not at all. At this page's new width (1156px at a 1440 window) the collapse is unreachable in any case: the compact head line gives the text `flex: 1 1 80px` with `nowrap` against ~1100px of room.

⚠️ **Named residual, not closed here:** the non-`compact` one-line row (Mission Control, the classic Overview, the merge-gate escalation) still carries the latent shape at a narrow enough viewport. Closing it needs the same layout change those surfaces are currently forbidden from taking (`d0d430d4`: "the classic surfaces must keep the one-line shape"), which is its own card and its own owner question.

## Do not

- **Do not re-embed `<Board/>` in this tab, and do not re-add the `KpiDeck` or the `BandDisclosure` to it.** All three were removed on the owner's own instruction, not as a tidy-up. The standing directive that the embed is the primary board surface (card `c6bdf358`, restated on `fd99b2d7`, `25c08fba` and `44f725fe`) is overridden **here only** — on the classic `pages/Overview.tsx` it is untouched and still binds.
- **Do not move a shape out of `components/atlasProjectOverview.tsx` into `components/atlasHome.tsx` to "share" it.** That file is mounted by the Workspace node too; this composition is the project node's alone, and the Workspace node's byte-identical rendering is a stated constraint of this card.
- **Do not grow a briefing reading past the roster table's own type**, and never mount the deck and the line together. See the inversion above: the line only works because nothing in it out-shouts the table.
- **Do not drop a column from the roster row at narrow width.** The stacked form keeps all seven cells in the same order, each gaining its own label. Dropping one is the failure the fixed-height band had, and the reason a table was picked over another card grid.
- **Do not add `white-space: nowrap` to `AttentionRow`'s shared `textBase`** believing it fixes the 0px collapse. Measured on card `d0d430d4`: it does not — it replaces invisible wrapped text with an invisible empty box.
- **Do not remove the `?task=` address normalization** without putting a `<Board/>` back on whichever tab the link lands on, and do not let the re-homed Board body consume the param while it is hidden.
- **Do not restate a node-head pill's figure in the briefing line.** `working` and the repo head are head pills on every tab; the mockup drew both twice and that is the one thing in it this build does not reproduce.
