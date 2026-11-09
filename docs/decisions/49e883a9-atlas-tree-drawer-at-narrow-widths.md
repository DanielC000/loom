# The Atlas tree is an overlay drawer at ≤820px, never a stacked block

Card `49e883a9` — Atlas restructure 7 of 11, epic `9fe8cd4e`. Closes item 7 of the Atlas gap audit and supersedes backlog card `9477a5ed` (the crumb half). Builds on `0d0c6cee` (the entity hierarchy) and `3b563642` (the session/card entity tier).

## The problem, measured

Card `8cbb2ac2` gave the narrow viewport a tree that **restacks**: below 820px the frame's grid collapses to one column and the tree becomes a `33dvh`, self-scrolling strip *above* the content. That was the right call when the alternative on the table was hiding the only navigation the shell has — but it spends a third of a phone screen on chrome before the page says anything, and card `3b563642` made it worse by hanging live sessions and open cards in it.

Measured off the rendered app at 420×900, before and after this card (`/project`, a project named `atlas-narrow` with three open cards):

| width | tree `position` | tree height | node head `top` |
|---|---|---|---|
| 420 before | `static` | 297px | **350px** |
| 420 after | `fixed` | — (off-canvas) | **52px** |
| 720 before | `static` | 297px | **334px** |
| 720 after | `fixed` | — (off-canvas) | **52px** |
| 1440 before | `static` | 900px | 37px |
| 1440 after | `static` | 900px | 37px |

The gap audit's own "~290px" was an understatement at this height: the node head actually started 350px down a 900px viewport, so the first 39% of the page was navigation.

## What shipped

`position: fixed` + `transform: translateX(-100%)` at `≤820px` (originally `≤720px`; see the next section), toggled by one `is-open` class, with a scrim at z-index 44 under the drawer's 45 and the toggle's 46. `AtlasShell` owns the boolean; `AtlasTree` takes `open` and `onNavigate`.

## The 721–820px band, re-decided (card `cc0a6ff9`)

This card originally left 721–820px as `8cbb2ac2`'s stacked strip, on the grounds that a tablet-width strip is a different trade from a phone-width one. Card `cc0a6ff9` (Atlas audit A-08) re-decided that band on its own evidence, measured on the rendered app with nine projects (the current one sorting last):

| width | before: tree | before: content top | after: tree | after: content top |
|---|---|---|---|---|
| 721 × 1024 | 338px strip | 428px | `fixed`, off-canvas | 105px |
| 768 × 1024 | 338px strip | 428px | `fixed`, off-canvas | 105px |
| 820 × 1180 | 389px strip | 479px | `fixed`, off-canvas | 105px |
| 821 × 1180 | 244px rail | 90px | 244px rail (unchanged) | 90px |

Before the change, the strip's bottom edge cut a project row in half against the crumb bar, and the current project was scrolled out of the strip altogether, so the one row that says where you are was the one you couldn't see. Once the drawer opens, the current project row is in view at every one of these widths.

`8cbb2ac2`'s reason for the strip was "never leave the shell without navigation", and the drawer keeps to it: the toggle is in the crumb row at every drawer width, and the tree stays mounted. So the rule is now **one narrow line at 820px**, the same line the board chrome folds at (card `c315f579`, `FILTER_FOLD_BELOW = 820`). The tree, the board's filter fold and the crumb row's toggle all switch together.

**Only the drawer-coupled rules moved to `≤820px`:** the tree's position and transform, the scrim, the toggle, the drawer head's 56px clearance, and the crumb row's 52px `min-height`. The crumb row's phone compaction stays at `≤720px`. That covers the icon-only leave and jump buttons, the tightened gaps, the four-segment collapse (decision `9477a5ed`) and the request-pill reserve. Measured at 721, 768 and 820 with the toggle in the row, on `/project` (two segments) and `/board` (three), the full row fits: every crumb renders whole (`Workspace` 63/63px, the project 98/98px, `Board` 46/46px) and the row stays 52px tall.

### Why `visibility`, not just a transform

An off-canvas drawer that stays `visibility: visible` keeps every row in the tab order and in the accessibility tree — a keyboard reader would tab through a dozen hidden links before reaching the page. The closed state is `visibility: hidden`, held through the 180ms slide on the way out (`visibility 0s linear 180ms`) and taken immediately on the way in. That is also the one thing `prefers-reduced-motion` has to null, and it must be nulled at `.loom-atlas-tree.is-open`'s own specificity or the `.is-open` transition wins.

### Why no JS media query

Nothing in the component knows the breakpoint. The boolean is meaningless above 820px because the CSS says so: the drawer rules live inside the media query, and the toggle plus the scrim are `display: none` outside it. A reader who opens the drawer and then rotates to landscape gets the persistent rail back with no state to reconcile, and the wide shell renders byte-identically to before this card whatever the boolean holds.

### Why the toggle floats above the drawer

The drawer covers its own top-left corner, so a toggle left under it would make "the toggle closes it" true only in prose. It takes `position: relative; z-index: 46` while open, and `.loom-atlas-treehead` gains `padding-left: 56px` to clear it. The crumb row's `min-height` is set to **52px at this width to match the drawer head's own 52px**, so the toggle and the drawer's logo share a centre line whether the panel is open or shut — measured, after 44px left the toggle 4.5px high against the wordmark.

### Why close-on-navigate is one delegated handler

A single `onClick` on the `<nav>`, gated on `(e.target).closest("a")`, rather than an `onNavigate` threaded through every row factory. A later card adding a row would have to remember to thread it, and a row that forgot would leave the drawer standing over the page it just navigated to. The anchor gate is what keeps card `0d0c6cee`'s expansion-is-not-selection split meaningful at this width: a twist, the project selector and the quick-spawn `＋` are all `<button>`s, so a reader can open a branch and look before committing to a row.

## The crumb half of `9477a5ed`, and what actually discriminates

`9477a5ed` reported the trail squeezing to `"W… / live-a305eb…"` because the frame's own "Switch to the classic UI" button ate the row. The button now renders a short `Classic` label below the breakpoint, with the full wording kept as an explicit `aria-label` so the **accessible name does not change with viewport width** — a control named differently at every size is a different control to a screen reader, and every by-name locator would have to know which width it is at.

⚠️ **The DoD's own wording for this half is not a discriminating check.** "The deepest crumb is not truncated (`scrollWidth <= clientWidth`)" passed on the **pre-fix** build too: at 420px the deepest crumb measured 83px of the 83px it needs, because decision `1d3192dc`'s lopsided shrink was already handing the width to the last segment. What the old row could not do was fit the trail at all — `"Workspace"` was squeezed to **23px** of its own 62. So the spec asserts the ancestors as well, and that is the assertion that reddens.

That second assertion is **scoped to the project node's two-segment trail and must never be widened into "no crumb is ever truncated."** A four-segment session address at 420px legitimately ellipsises its ancestors; that is what `1d3192dc` chose, and the lopsided ratio is the whole mechanism.

The other half of `9477a5ed` — the selected node scrolled out of a `33dvh` strip — is answered by the drawer's full height plus a `scrollIntoView({ block: "nearest" })` on the landed row when it opens.

## Do not

- **Do not express the drawer by unmounting anything** — not the tree, not the content column, not a page panel. Unmounting the content discards unfinished input (the owner's standing rule); unmounting the tree throws away its own branch-expansion state, so a reader who opened three branches would find them shut on the next open. The spec's draft-survival leg is what holds this behaviourally rather than by reading the CSS back.
- **Do not assert the drawer's state with `toHaveCount(0)` under Atlas.** The tree is in the document at every width; computed `visibility` is the state. `toHaveCount(0)` is correct only in the classic shell, where none of this machinery exists.
- **Do not read that visibility with a one-shot `getComputedStyle` right after `aria-expanded` flips.** The drawer deliberately holds `visible` for the 180ms slide-out, so a bare read measures the transition, not the state (measured: two legs red on `"visible"`). Use Playwright's auto-waiting `toBeVisible`/`toBeHidden`.
- **Do not raise the scrim to a modal z-index.** It sits at 44, under the 50-and-up every dialog in this app uses, so a board card opened from the tree still arrives as the centred dialog on top of it. The tree drawer is navigation chrome, not a card surface.
- **Do not give the toggle a text label.** Every Atlas nav label is already a live page-wide exact-text match in both shells, and a worded button here is one more string for an unrelated spec's text locator to collide with. The name is the `aria-label`.
- **Do not let the leave button's accessible name vary by breakpoint.** Both spans ship at all widths; CSS chooses which one displays, and `aria-label` fixes the name.
- **Do not split the drawer's line from the shell's other narrow line again.** It is 820px, shared with the board chrome (card `c315f579`). Card `cc0a6ff9` measured what a separate tablet band costs: a third of the screen spent on a strip that cut a row in half and hid the current project. Moving the line means moving the board's fold with it, on new evidence.
- **Do not move the crumb row's phone compaction up to the drawer's line just because they used to share a query.** At 721–820 the full row fits beside the toggle (measured above). Compacting it there would hide the leave button's wording and the ⌘K hint for no width gain.
