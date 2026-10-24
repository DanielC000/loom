# a7957bde — Mission Control at narrow widths: three defects, and the page overflow was never the activity row

Card `a7957bde` was filed off card `f51d3068`'s own closing measurement, which attributed classic Mission Control's horizontal page overflow at 420px (`documentElement.scrollWidth` 453) to the god-eye activity feed's `EventRow` — "a different component, whose project chip and kind columns are un-shrinkable in the same way this row's were". The shape claim was right. The attribution was not, and it had been carried as fact into this card's body and its DoD.

## Do not

- **Do not re-attribute Mission Control's page overflow to `EventRow`.** It is the four `Stat` tiles in the global status strip. Measured below, with a causal control.
- **Do not flatten `EventRow`'s `flexShrink` weights** (`detail: 100000` > `project chip: 1000` > `kind: 1`), and do not drop any column's `minWidth: 0` + `overflow: hidden` + `textOverflow: ellipsis` trio. Each column carried `whiteSpace: "nowrap"` with no `overflow`, so its flex automatic minimum size resolved to its full content width and it could not shrink at all. All three properties together are what make a column shrinkable; removing any one restores the defect.
- **Do not give the timestamp a shrink factor, and do not drop its `flexShrink: 0`.** It leads the row here (it trails in `ReplayEvent`), so it was never the column overflow landed on — but it is still the one value a reader cannot reconstruct from the row's neighbours.
- **Do not drop the `title` on the chip, kind or detail columns.** They are the columns that can ellipsize, and the hover is the only way a truncated value stays recoverable.
- **Do not restore `.loom-mc-split`'s two-column grid at phone width.** A 1.4fr/1fr split held at 420 gives the Activity track 101px, which is less than the row's own un-shrinkable timestamp — every row then renders as a bare time with its kind ellipsized to nothing.
- **Do not make `EventRow` wrap.** `f51d3068`'s rejection of `flex-wrap` applies unchanged: a wrapped line binds no more tightly to the event above it than the one below, which in a dense forensic stream is worse than a legible, hover-recoverable truncation.

## The attribution was wrong, and one control settled it

A census of every element whose border box reached past a 420px viewport, filtered to those with `overflow-x: visible` on **every** ancestor up to the root — the only elements that can contribute to `documentElement.scrollWidth` — returned four, all of them the status strip:

| Element | Right edge | Width |
|---|---|---|
| the four-`Stat` flex row | 444 | 364 |
| its `attention` tile | 444 | 65 |
| that tile's two spans | 431 | 39 |

`EventRow` appears nowhere in that set. Its columns *do* reach to 685px at 420 — 34 elements past the edge in an unfiltered census — but the Activity `Panel` sets `overflow: auto`, so every one of them is clipped by a scroll container and none reaches the document.

The control that proved it rather than merely arguing it: patching **every** `EventRow` column in the live DOM to `flexShrink: 1; minWidth: 0; overflow: hidden` (15 rows patched) and re-reading the page. `documentElement.scrollWidth` stayed at **453, unchanged**. Had the row owned the overflow, that patch alone would have collapsed it.

This is the same failure `f51d3068`'s record warns about one paragraph later — "a DoD clause inherited from a card's framing still needs its own control" — reaching the next card anyway, because it arrived as a measured-looking fact in a card body rather than as a framing to test. The cheap check is the one used here: before fixing the thing a card names, ask what would have to be true, and find the control that would come out differently if it weren't.

## What each fix is, and what it is worth

Measured on the fixture daemon at 420x900 and 1440x900, seeding the 15 real event kinds from `e2e/helpers/replayRow.ts` (the long ones — `session_recovery_abandoned` at 187px — are the point) plus one row carrying a non-empty detail column.

**1. The status strip (`pages/MissionControl.tsx`).** The four `Stat` tiles sat in `display: flex` with no `flexWrap` and no `minWidth`, inside an outer strip that *does* wrap. 364px that could neither wrap nor shrink. They now wrap, like the strip that holds them: each `Stat` is a self-contained labelled tile, so re-flowing to 2x2 at phone width costs nothing. `documentElement.scrollWidth` 453 -> **420**; unclipped elements past the edge 4 -> **0**.

**2. The page grid (`.loom-mc-split`, `styles/global.css`).** The fleet/activity split moved from an inline `gridTemplateColumns` to a class and folds to one column at the same 820px used by `.loom-bandpanel` and `.loom-kpideck`. The Activity track at 420 goes 101px -> **294px**. Without this, fix 3 is a regression rather than an improvement: at 101px the timestamp alone (79px) plus the row's gaps exceeds the track, so every column after it ellipsizes to zero width — strictly less readable than the pre-fix overflow, which at least left a horizontal scrollbar on the panel.

**3. The row (`components/fleet.tsx`'s `EventRow`).** Shrink weights plus the `minWidth`/`overflow`/`textOverflow` trio and hover titles. Every mount of the row benefits; the two that pass `projectName` are classic Mission Control and the Atlas Workspace Pulse band.

| Surface | Row box | Row content before | Row content after |
|---|---|---|---|
| Mission Control @420 | 101 -> 294 | 254–398 (overflowing) | 294 (fits) |
| Mission Control @1440 | 526 | 526 (fits) | 526 (fits, unchanged) |
| Atlas Pulse band @420 | 354 | 354–398 (overflowing) | 354 (fits) |
| Atlas Pulse band @1440 | 170 | 362–391 (overflowing) | 170 (fits) |

The Atlas band at 1440 is the tightest box of the four, not the loosest: the band lays five panels across one row, so Pulse gets ~170px there against ~354px at 420 in a single column. Pre-fix the row overflowed that box by up to 221px and the kind was simply not on screen; it is now ellipsized and hover-recoverable. That column is still too narrow for a four-column row — the chip is spent to its ~10px floor on every row and the kind renders at 55px — but that is the band's own layout, not this row's, and it is left open.

## What the shrink order actually costs at 420 on Mission Control

Read per surface; the row boxes differ and the answer differs with them. On the 294px Mission Control track, the kind renders at full content width on **13 of 15** rows, including `build_gate_retry_attempt` at 173px. The two longest — `worker_report_undelivered` (180px) and `session_recovery_abandoned` (187px) — give 1px and 8px respectively, and only on the rows where the project chip has already been spent to its 10px floor. The chip gives on every row in between, from 2px up to 104px. The detail column goes before either.

That ordering is the authority for the design, not the arithmetic: flexbox distributes a deficit proportionally to `flex-shrink` x `flex-base-size`, which is not a strictly sequential cascade, so it was confirmed by measuring rendered columns rather than derived from the weights. The e2e assertion is written the same way — it fails any row that ellipsizes the kind while the chip still has more than 14px to give, rather than asserting the weights themselves.

## The e2e claim

`e2e/mission-control-activity-row.spec.ts` asserts, at 420 and at 1440, on classic Mission Control and on the Atlas Pulse band: the page does not scroll sideways, the stat strip's right edge is inside the viewport, no row pushes content past its own box, no row cuts or ellipsizes its timestamp, and no row ellipsizes its kind while the chip still has width. The fit legs run over **every** rendered row — the feed is cross-project, so a sibling spec's rows ride along and holding the claim over the superset is strictly stronger — while a separate leg pins this spec's own seeded rows as the population, since an empty feed would satisfy "every row fits" and a feed of only short kinds would never have been red pre-fix.

The row carries `data-testid="activity-event"` with `activity-event-time` / `-project` / `-kind` / `-detail` on its columns, so the assertion addresses each column directly rather than indexing the row's nth `<span>`.
