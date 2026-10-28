# 44f725fe — the project node has one home tab, with the dashboard behind a disclosure

Card `44f725fe` (epic `9fe8cd4e`), from the owner's reading of `ProjectHome.tsx` on card `93d50f2d` item 3, verbatim: *"What is the need to have an overview tab, and a deck tab? Feels redundant to me. Unify the pages to one."* He picked **D1 · Disclosure** on request `fb8de852` (2026-10-28). Design set: vault `Mockups/2026-10-28 Atlas unified project page/`. Supersedes the home-tab half of `25c08fba`'s record.

## He was right at the level of the code, not just the pixels

There was never a second page. `Overview` and `Deck` were two `return` branches of ONE component, fed ONE `kpis` array and ONE set of five band-panel variables; `?tab=` only chose which ran. The Deck's only unique content was the `LaneBar`, and it alone DROPPED content — the Gates panel.

They were **two viewport budgets for one set of readings**, measured at 1600×1000 on one fixture (the mockup's figures, which reproduce the live app's):

| View | Board top | Board width |
|---|---|---|
| Overview (before) | y 670 | 1316px |
| Deck (before) | y 257 | 974px |
| **Unified, folded** | **y 386** | **1316px** |
| Unified, unfolded | y 710 | 1316px |

Note what the top two rows show: **neither tab gave the board both.** The widest board always started 670px down; the highest was always 342px narrower. Folding the band makes both available at once — which is why this is a CONTROL, not an address: no second crumb, no second `<Board/>` mount, no second tab.

## What shipped

`PROJECT_NODE_TABS` (`nav.tsx`) declares **nine** tabs: the `deck` row is gone and `overview` is the only home tab, at the node's own bare path.

- The five panels sit inside `BandDisclosure` (`components/atlasHome.tsx`) — a summary bar over the existing `.loom-atlas-band`. Collapsed it carries one live figure per panel it hid (`needs you`, `spawnable`, `gates`, `last event`), so folding costs the DETAIL and never the SIGNAL. The honest cost it does not deny: a folded band stops showing the Pulse feed ambiently.
- State persists per viewer under `localStorage` key `loom.atlasDashboardOpen`, via `useDashboardOpen()`. Encoded `"0"` = folded / **ABSENT = unfolded**, so an absent key is the same state as a never-visited browser — the discipline `ATLAS_UI_STORAGE_KEY` uses. Every read and write is wrapped; storage can throw, and the only safe answer to "can't tell" is the default.
- The `LaneBar` moved onto the board head permanently — the one thing genuinely unique to the removed tab, which is what makes the removal lossless. It replaces the sentence *"The same board, whole …"*, which only restated what the board underneath already shows. `KpiStrip`'s pill markup is factored into a shared `KpiPill` the summary row reuses.
- `nodeTabShowsKpiStrip` is **untouched**, and so is the strip on the eight RE-HOMED tabs (card `7874e8c2`). The card's "remove the `KpiStrip` on this node" is scoped to the HOME tab, where the Deck owned it: reading it as the whole node would have stripped a readout from eight tabs, reddened `atlas-node-kpi-strip.spec.ts`, and contradicted both `7874e8c2`'s prohibition and D1's own *"No content is dropped"*.

## `?tab=deck` needs no redirect, and must not get one

A legacy `?tab=deck` is an unrecognised home tab, which `projectNodeTabAt` already resolves to `PROJECT_NODE_TABS[0]` — the unified Overview. The dead param stays in the URL and nothing breaks: the deck renders, the board embeds, a `?task=` deep link alongside it still opens its card.

A `LEGACY_REDIRECTS` row would be actively wrong: that table is mounted by **both shells from one declaration** (card `25c08fba`), so a row pointing at the project node would redirect the CLASSIC shell too and break the switch-OFF contract. `/project` is Atlas-only regardless — there is no classic address to leave behind.

## The kit defect this design walks into

`.loom-atlas-band`'s own `display: grid` is an AUTHOR rule, so it **out-specifies the UA's `[hidden] { display: none }`** and a `hidden` band stays fully laid out and visible. Measured in the mockup before the explicit rule existed: the board sat 1199px down with the band "collapsed" — every aria assertion satisfied, nothing moved. `global.css` carries an explicit `.loom-atlas-band[hidden] { display: none; }`, and `BandDisclosure` renders the band element itself rather than taking it as a child, so the attribute and the rule that makes it bite cannot drift into two files. Same trap `25c08fba`'s record names from the tab-body side.

MEASURED control (rule removed, rebuilt): 2 of the spec's 3 legs go red at `toBeHidden()` — the band renders VISIBLE with `hidden` set — while the switch-OFF leg stays green.

## Do not

- **Do not re-add a second HOME tab to `PROJECT_NODE_TABS`,** `deck` least of all. The two were one component with one data set; a second reading of one node belongs behind a control, not an address.
- **Do not park this band with an inline `display`, and do not drop `.loom-atlas-band[hidden]` from `global.css`.** `hidden` alone loses to the band's `display: grid`, and the failure is silent in every assertion except a geometry one.
- **Do not add a `LEGACY_REDIRECTS` row for `?tab=deck`.** Both shells mount that table from one declaration; `projectNodeTabAt`'s fallback already handles it.
- **Do not shrink, summarize or gate the embedded `<Board/>`,** in either state. Standing owner directive (card `c6bdf358`): it is the primary board surface. Mount it ONCE — the fold changes the board's position, never its content.
- **Do not change the first-visit default to COLLAPSED without the owner.** Expanded is a deliberate ruling: it keeps a first visit identical to what shipped before, so nobody loses a panel they never chose to fold.
- **Do not make `nodeTabShowsKpiStrip` return true for `overview`,** and do not strip the re-homed tabs of their own readout. See `7874e8c2`.

---

## Extended to the WORKSPACE node by card `4a0ad464` (2026-10-28)

The owner's words on request `fb8de852` — *"What is the need to have an overview tab, and a deck tab?
Feels redundant to me. Unify the pages to one."* — covered both home nodes; this card unified only the
project one. Card `4a0ad464` applies the same D1 disclosure to `pages/WorkspaceHome.tsx`:
`HOME_TABS` is one row, the five band panels go behind the same `BandDisclosure`, and a legacy
`?tab=deck` falls back to Overview with **no** `LEGACY_REDIRECTS` row — for the same both-shells reason
stated above.

Three things are deliberately NOT copied verbatim from the project node:

1. **The summary row is THREE pills, not one per folded panel.** The full-size deck stays on screen
   when the band folds, and it already states `gate run·queued` and `plan 5h` verbatim — so a pill for
   either would be the same number twice within ~40px, the shape card `939922ee`'s owner rejection
   names. The bar carries what the fold actually takes OFF the page (`operators`, `last event`) plus
   `needs you`, kept across the same overlap for the reason this record already gives it.
2. **The two bands share ONE storage key** (`DASHBOARD_OPEN_STORAGE_KEY`). The band is the same
   furniture on both nodes; two keys would make "fold the dashboard away" mean two different things
   depending on which node you were standing on when you asked.
3. **The retired Deck tab's own line is kept**, under the project grid: its open-card total across
   every project is the one figure that tab stated and no tile on this node carries.

MEASURED at 1440 on the workspace node: the project grid's top moves **702 → 378** when the band folds
(a 324px lift, the same delta this record measured for the project node's board), at an unchanged
content width.

### Also superseded here

This record's last prohibition — *"do not strip the re-homed tabs of their own readout"* — is void.
Card `4a0ad464` removed the tab-row KPI strip from every node and every tab on the owner's explicit
instruction; see the superseding section appended to `7874e8c2`'s record.

### Do not (in addition to this record's own list above)

- **Do not re-add a second HOME tab to `WorkspaceHome.tsx`'s `HOME_TABS`,** `deck` least of all — the
  same prohibition this record already carries for `PROJECT_NODE_TABS`.
- **Do not give the workspace bar one pill per folded panel.** Two of the five are on the deck above
  it; a pill for either is the duplication the fold is supposed to avoid, not a completeness win.
- **Do not split the two nodes' fold state onto separate storage keys** without a reason the owner
  has actually asked for.
