# d0d430d4 — the Atlas "Needs you" band stacks its attention row; the classic one-liner is untouched

Card `d0d430d4` (child of the Atlas epic `9fe8cd4e`), found by P2-11's eyeball (gen 432) and widened by a second measurement filed on card `c2968651` (gen 433). Both defects were pre-existing and shipped with P2-1's band layout (`fd99b2d7`), not with either of those cards.

## The two defects, as measured

`/home`, Atlas switch ON, a pending DECISION NEEDED Request with a realistic 110-character title plus a MERGE REQUEST row in the same band. Measured off the real DOM (`getBoundingClientRect`), not inferred:

| | 1600×1000 | 420×900 |
|---|---|---|
| band body (`.loom-bandbody`) | x 277, w **299** | x 33, w **354** |
| DECISION row | w 299, h **500** | w 354, h **500** |
| its text span | w **0**, h 486 | w **0**, h 486 |
| "Answer →" box | x 532 … **597** | x 288 … 353 |
| body right edge | **576** | 387 |

So at 1600 the action's box ended **21px past** the band body's right edge (and the × ended at 630, past the panel's own 589) — the clipping the card names. At both widths the text span was **0px wide and 486px tall**: 27 lines of one character each, invisible, inside a 500px row that pushed the merge rows below a 300px panel's fold at 420px.

## Why the text collapsed to zero

`overflow: hidden` on the text span makes its *automatic minimum size* resolve to 0 rather than its min-content width (CSS Sizing 3, `min-width: auto`). The span's flex basis is `auto`, i.e. its max-content width — by far the largest basis on the line — so flex shrink is distributed almost entirely onto it, and with a floor of 0 it takes all of it. With no `white-space: nowrap` the still-rendered text then wraps at one character per line, which is where the height came from.

`white-space: nowrap` alone does **not** fix this: the span would still shrink to 0 and show nothing at all. The width has to come from somewhere, which is the next point.

## The decision

The fix is a layout change scoped to the band, via a new **opt-in `compact`** prop on `AttentionRow` passed by exactly one caller — `AttentionList` in `pages/WorkspaceHome.tsx`, the Atlas-only list that feeds all four Atlas mounts (the band panel and the `needs you` KPI pop-over, at each of the two levels).

A one-line row is not reachable at 299px. The fixed parts alone — dot, the kind pill, the PENDING chip, "Answer →" and the × — need about 306px of the 279px content box before the text gets a single pixel. Something has to leave that line. So in `compact`:

- **head line** — dot, kind pill, text, and the dismiss ×; `flex-wrap: wrap`.
- **action line** — the chip, the rate-limit/snooze affordances and the open button, right-aligned, `flex-wrap: wrap`. Rendered only when at least one exists.
- **footer** — the `c2968651` slot, unchanged, below both.

The × sits on the head line rather than in that cluster on purpose: dismissing is a VIEW action on the row (`DISMISS_INVARIANT` — it hides the alert and changes nothing underneath), not a sibling of the row's actual answer. It is also the one control narrow enough to fit beside the text, and keeping it there is what holds a merge row to two lines — head, then its footer — instead of spending a whole line on one 23px button.

### Which property does which job

Each was reverted on its own and the e2e re-run, so none of these is a guess about CSS:

| reverted | what goes red |
|---|---|
| `white-space: nowrap` on the title | the title's height (486px) and `nowrap`, and the row height — **not** its width |
| `flex: 1 1 80px` → `flex: 1 1 auto` | the row height ALONE (64px → **106**): the title still renders, it just wraps to its own line |
| the whole `compact` wiring | everything above **plus** the action/dismiss boxes escaping the band at 1600, and the overflow sweep |

`flex-wrap: wrap` on the head line is the third property, and it is why the middle row above does not also lose the title's width: an item that cannot fit drops to its own full-width line instead of absorbing all of the shrink. It is also the long-kind safety net — a 28-character kind (`RECYCLE LINEAGE CONSOLIDATED`) leaves under 20px beside it at this width.

### The control that did NOT fire, and what it changed

A fourth control moved the action cluster back onto the head line, keeping everything else. **Every assertion stayed green** — the head line's own `flex-wrap` catches the actions and nothing is clipped. So "nothing overflows and the title is one visible line" does *not* discriminate the stacked shape from a ragged wrapped one; the stack is a design choice (a deterministic, right-aligned cluster rather than greedy packing), not the minimal fix.

Rather than leave that unpinned, the spec gained two assertions that *are* specific to the shape: the action cluster is its own element (`attention-row-actions`) holding the open button, and its box sits strictly below the title's line box. Those make the fourth control fire.
- **footer** — the `c2968651` slot, unchanged, below both.

This is the same two-line grammar the band's own operator and agent rows already use, so it adds no new visual language: no new token, no new colour, no new component.

## Do not

- **Do not make `compact` unconditional, item-derived, or passed from a classic surface.** Mission Control, the project Overview and the merge-gate escalation (`components/mergeGate.tsx`) must keep the one-line shape, with `head` as the frame's own direct flex children and **no wrapper element inserted around them** — the text's ellipsis and the `flex: 1` spacer both measure against that element. This is `c2968651`'s prohibition restated, and `atlas-band-row-shape.spec.ts`'s switch-OFF leg is what holds it: it pins the classic row to one DOM child level, one text line, and the absence of the action line.
- **Do not "simplify" the hoisted row parts back into one inline `head` fragment.** The parts exist so the band can re-order the same children without a second copy of any of them; a fragment emits no DOM node, which is what keeps the classic render identical.
- **Do not give the compact text `flex: auto`, drop its `nowrap`, or re-add a `flex: 1` spacer to the head line.** Each one on its own restores the 0px-wide, 486px-tall span.
- **Do not fix this in `styles/global.css` against `.loom-bandbody`.** The row's layout is inline-styled per shape; a stylesheet rule keyed to the band would also have to reach the KPI pop-over's copy of the same list, and the two would drift.
