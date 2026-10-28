# A four-segment Atlas crumb trail collapses its ancestors at phone width, by COUNT and never by measurement

Card `9477a5ed` (the crumb half of the backlog card card `49e883a9` superseded). Anchored from `packages/web/src/components/AtlasShell.tsx` and `packages/web/src/styles/global.css`.

## What happened

Decision `1d3192dc` gave the crumb row its lopsided shrink — the deepest crumb at `flexShrink: 1`, every ancestor at `999` — so a deficit lands on the ancestors and the segment naming where you actually are gives up width last. That is correct and it stays.

What it cannot do is help once the deficit exceeds the row, because a shrink ratio only decides how a deficit is SHARED OUT. At 420px a session address reaches exactly that state. Measured on the pre-change build, `/review/:workerId` at 420px:

| segment | rendered | wanted |
| --- | --- | --- |
| `Workspace` | **17px** | 62px |
| `live-40ad151b` (the project) | **15px** | 90px |
| `AtlasNarrowWorkerWithALongishName · worker · e2e-eyeb` | 89px | 366px |
| `Diff` | 28px | 28px |

`1d3192dc` was working as designed — `Diff`, the deepest, was the one thing rendered whole in this seed. But 17px and 15px of an 11.5px mono face is one character and none: the trail read `W… / / AtlasNarrowWorkerWi… / Diff`, with the project crumb painting its separator and no characters at all. The whole nav had 184px for four labels and three separators.

⚠️ **"The deepest crumb survives" is a property of the ratio, not a guarantee, and it does not hold at every seed.** The before/after capture used a shorter project name and the tab crumb itself truncated — `before-session-420.png` reads `W… / l… / CrumbWor… / Di…`, all four segments including the one naming where you are. So the pre-change state was not merely "the ancestors are unreadable"; past a certain total it took the deepest with it.

A verify-only pass on card `359bcdaa` established the contrast case: hiding the "Switch to the classic UI" button took the nav from 184px to 267px. So that button contributes, but it is not the cause — four segments do not fit at 420px however the row is rebudgeted.

## Do not

**Do not derive this collapse by measuring rendered boxes.** The frame's other overflow control, the node tab row's `More ⋯` menu (`components/atlasHome.tsx`), has to measure, because a tab's width is not knowable without rendering it. That measurement is what card `485d67b4` paid for: a re-measure forced the row's fit back to the full tab count, React destroyed the open menu's DOM while `open` stayed true, and the reader's keyboard focus fell to `<body>` and never came back. A trail's segment COUNT is known at render time. Paying that cost here would buy nothing and inherit the hazard.

**Do not express the collapse as a width cap on a segment.** `1d3192dc`'s own prohibition is unchanged and applies to this card's state too — both an absolute `ch` count and a percentage were tried there and both clipped a long detail label on a row that had the room for it.

**Do not put a segment's own layout on its inline `style`.** Inline beats class, so an inline `display: flex` on the `<li>` silently shadows the collapse rule. This is not hypothetical — it is how the first build of this change shipped: every segment still rendered at 420px with the disclosure sitting beside a full four-crumb trail, and the CSS looked correct in isolation. Only `flex-shrink` and `color`, which genuinely vary per segment, stay inline. The same trap applies to the leave button's padding, which moved to `.loom-atlas-leave` for exactly this reason.

**Do not give the disclosure an accessible name carrying the project or session name.** Every Atlas nav label is already a live page-wide text match in both shells; a name carrying one is one more string for an unrelated spec's by-name locator to collide with — the trap card `c6160c7d` hit when the quick-spawn button's label began naming the active project. The name is the generic, stable "Show the full path" / "Hide the full path"; the path itself is the `title`, and activating the control renders the real segments.

**Do not widen "no crumb is truncated" into a general invariant.** It is true of a 1-or-2-segment trail and of the collapsed state's deepest crumb. A session label is free text and can be 52 characters; at 420px it is legitimately ellipsised, with 143px (≈21 characters) rather than the 89px it had before. The claim this card makes is that every RENDERED segment keeps real width, not that nothing ellipsises.

## What it does instead

Below the `720px` breakpoint — the same one the tree drawer already uses — a trail longer than three segments renders its deepest TWO, with the leading ancestors behind one disclosure control.

- **The count is React's**, in `collapsibleTrail = crumbs.length > 3`, which decides only whether the control is RENDERED.
- **The width is CSS's**, in one rule: `.loom-atlas-crumblist.is-collapsible:not(.is-open) > li:nth-last-child(n+3) { display: none }` — every segment with two or more siblings after it. The `.is-collapsible` guard is load-bearing: without it the same selector would hide a three-segment trail's first segment, which fits today. A 1-or-2-segment trail matches nothing here at any width.
- **No media query and no resize listener in JS**, exactly like the drawer (`49e883a9`). A reader who expands the trail and then rotates to landscape gets the wide shell back with nothing to reconcile.
- **The expanded trail WRAPS rather than squeezing.** The row is already 52px tall for the drawer toggle and a single-line trail uses 17px of it, so two lines cost no extra chrome. Measured, the seeded worst case took three lines and grew the row 52px → 71px — `min-height`, not `height` — which is the honest outcome for a reveal the reader asked for.
- **It re-collapses on every address change.** "What is above me" is a question about THIS node.

The deepest two are the pair the node head below does not already state: for a session address the `<h1>` is the session label (the third crumb), so the trail's job here is the session's relationship to the tab inside it, not a second copy of the identity.

Two further pixels came from the row rather than the trail, both at the same breakpoint: the gaps tightened 8px → 5px (three separators' worth is ~35px of a 233px nav), and the "Switch to the classic UI" button dropped its remaining word to become a 34px icon, the same square as the drawer toggle at the other end of the row. Card `49e883a9` had already shortened that wording to "Classic" and freed ~110px; this takes the last 83px. Its accessible name was already stated as an `aria-label` precisely so it does not move with the breakpoint, so nothing a screen reader or a by-name locator sees changed — only the tooltip carries the wording for a sighted reader now.

Measured after, same seed, `/review/:workerId`:

| width | trail | leave button |
| --- | --- | --- |
| 420 | `⋯ / <session, 143px> / Diff (28px whole)`; ancestors `display:none` | 34px icon |
| 420 expanded | all four render over three lines, row 52 → 71px | 34px icon |
| 760 | all four render, three ancestors clipped, `Diff` whole | 155px, full wording |
| 1440 | all four render, **nothing clipped** | 195px, full wording |

The two-segment project trail is byte-identical at 420 and 1440: both crumbs at their full 62px and 90px, no disclosure rendered at all.

## How it is held

`packages/web/e2e/atlas-crumb-collapse.spec.ts` owns the narrow claim; it asserts the collapsed shape, that each RENDERED segment keeps real width, that the control has a stable accessible name and reveals all four segments, and that a two-segment trail is untouched at the same width.

`1d3192dc`'s own positive control — "the row is genuinely under width pressure, or 'the deepest crumb is not clipped' proves nothing" — **moved from 420px to 760px** in `atlas-param-routes.spec.ts`, because at 420px its premise now expires by construction: the ancestors it measured are no longer rendered. 760px is the nearest width where the full four-segment trail still draws and the row still runs out of room (measured: `Workspace` 46px of 62, the project 63px of 90, the session crumb 267px of 366, `Diff` whole at 28px). The 1500px half of that test is unchanged.
