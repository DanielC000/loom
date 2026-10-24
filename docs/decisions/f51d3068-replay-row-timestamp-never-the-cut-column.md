# f51d3068 — the replay event row gives its columns a shrink PRIORITY so the timestamp is never the one that gets cut

`ReplayEvent` (`packages/web/src/components/auditReplay.tsx`) renders one line of the Run Replay audit stream: `seq · dot · kind · actor · detail · timestamp`. It is mounted by BOTH surfaces that carry wave replay — the Atlas Workspace node's Replay tab (`pages/WorkspaceHome.tsx` → `components/workspaceReplay.tsx`) and classic Mission Control's own collapsible Wave replay section — so a row-layout change lands on both at once. That shared-ness is why card `ff6123de` left the defect alone and filed this card instead.

## Do not

- **Do not drop `minWidth: 0` + `overflow: hidden` + `textOverflow: ellipsis` from the kind, actor or detail columns.** Each column carried `whiteSpace: "nowrap"` with no `overflow`, so its flex automatic minimum size resolved to its full content width and the column could not shrink at all. Those three properties together are what make it shrinkable; removing any one of them restores the defect.
- **Do not flatten the `flexShrink` weights to a uniform value.** The weights ARE the fix's quality: `detail: 100000` greater than `actor: 1000` greater than `kind: 1`. Uniform weights shrink all three together and start eating the kind — the row's primary scan token — while the detail still has width to give.
- **Do not put a flex spacer (`<span style={{flex:1}}/>`) back in place of the timestamp's `marginLeft: "auto"`,** and do not remove the timestamp's `flexShrink: 0`. The auto margin is what holds the timestamp's right-edge alignment once its neighbours are shrinking.
- **Do not drop the `title` on the kind/actor/detail columns.** They are the columns that can ellipsize, and the hover is the only way a truncated value stays recoverable.
- **Do not make the row `flex-wrap: wrap`.** It was built and measured first; see below for why it was rejected.

## What was measured, and why the timestamp specifically

Every column in the row was effectively non-shrinkable: `kind`, `actor` and the timestamp all carried `whiteSpace: "nowrap"` with no `overflow` set. Only `detail` (which does set `overflow: hidden`) could shrink at all. Once `detail` reached zero the row simply overflowed its own box, and because overflow accumulates toward the end of the main axis, **the entire overflow landed on the last item — the timestamp.**

Measured at a 420px viewport on the pre-fix bundle, 15 seeded events spanning the real kind vocabulary:

| Surface | Row box | Worst row content | Timestamp past the row's right edge |
|---|---|---|---|
| Atlas Replay tab | 354px | 446px | **+94px**, 12 of 15 rows |
| Mission Control | 294px | 446px | **+154px**, 15 of 15 rows |

At 1440 every row on both surfaces measured `-6px` — the timestamp sitting exactly inside the row's own 6px right padding. That was the baseline the fix had to preserve, and after the fix all four readings (both surfaces by both widths) are `-6px` on every row.

The timestamp is the column that must not be cut because it is the only one a forensic reader cannot reconstruct from its neighbours. `kind` and `actor` repeat down the stream and are recoverable from context (and now from a hover `title`); `seq` is ordinal. A wall-clock time is the single value that anchors the replay to anything outside it.

## What the priority actually costs, measured at 420

Read per SURFACE — the two row boxes differ, and the answer differs with them.

**Atlas Replay tab (354px row box).** The kind is never truncated: all 15 rows render it at full content width (`clientWidth == scrollWidth`), including the longest in the vocabulary, `session_recovery_abandoned` at 187px. The actor absorbs the entire deficit, from 0px on short kinds up to 100px of its natural 115px on the longest (rendering as `m…`, with the full `manager <id8>` on hover).

**Mission Control (294px row box).** 60px narrower, so there is not always enough to go round. The kind is still untouched on 10 of 15 rows — every kind up to 122px — and the 5 longest give 9–43px, but ONLY on the rows where the actor has already been spent to zero (`actor` cut 115 of 115 on exactly those 5 rows, and on no others). The priority holds; that surface simply runs out of width.

The detail column goes before either, on both surfaces.

⛔ Do not restate the Replay tab's "the kind is never truncated" as a property of the ROW — it is a property of that surface's width. What the row itself guarantees is the ORDER in which columns give (detail, then actor, then kind), and that the timestamp is never in that order at all.

That ordering is the authority for this design, not the arithmetic: flexbox distributes a deficit proportionally to `flex-shrink` times `flex-base-size`, which does not give a strictly sequential cascade, so the ordering was confirmed by measuring the rendered columns rather than derived from the weights.

## Why not `flex-wrap: wrap`

Wrapping was implemented and measured first. It passes the same assertion — every column stays whole and the timestamp is never cut — and was rejected on the rendered result: **at 420 the timestamp wrapped onto a line of its own, right-aligned under an otherwise empty row.** A wrapped line does not bind visually to the event above it any more tightly than to the event below, so in a dense stream the reader cannot reliably tell which event a given timestamp belongs to. Trading a legible truncation (an ellipsis says "there is more here", and hover recovers it) for an ambiguous row binding is the wrong trade in a forensic tool, where the timestamp's whole job is to anchor one specific event.

Ellipsis also keeps the timestamp in an aligned right-hand column on every row, which is what makes the stream scannable at all; wrapping breaks that column on exactly the rows that overflow.

## What this did NOT fix, measured

Mission Control's whole page also scrolls sideways at 420px (`documentElement.scrollWidth` 453 against a 420px viewport). The card named that, and it is tempting to read it as the same defect — it is not. **Measured after this fix: the page is still 453px, and it is still 453px with the Wave Replay section COLLAPSED and its panel unmounted entirely.** The overflow is the god-eye ACTIVITY feed's own `EventRow` (`pages/MissionControl.tsx`) — a different component, whose project chip and kind columns are un-shrinkable in the same way this row's were. It is pre-existing, out of this card's scope, and left open; Mission Control is in any case retired as an Atlas destination (card `5afd71bd`). Do not assert a page-width claim against the replay row, on either surface — it does not own one.

## The e2e claim

`atlas-wave-replay.spec.ts` and `mission-control-wave-replay.spec.ts` each assert, at a 420px viewport, that **every** rendered row's `audit-replay-event-time` box sits inside its own row's box, and that the same holds at 1440 so the desktop layout is pinned rather than merely unexamined. The shared reader is `e2e/helpers/replayRow.ts`. Three legs guard the box check against passing for the wrong reason: the row COUNT is pinned (an empty stream satisfies "every row fits"), an empty timestamp string fails, and a timestamp that fits only by ellipsizing its own text fails.

The timestamp carries `data-testid="audit-replay-event-time"` for exactly this — the assertion addresses it directly instead of indexing the row's nth `<span>`, which the `Dot` primitive (itself a `<span>`) would otherwise make fragile.

⚠️ The 420 assertion is RED against the pre-fix layout by a wide margin (94px / 154px), not by a sub-pixel one — if a future change makes it fail by ~1px, suspect a measurement/rounding issue in the test before assuming the row regressed.
