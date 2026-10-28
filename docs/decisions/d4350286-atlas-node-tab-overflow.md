# Atlas node tabs: the overflow "More" menu

Card `d4350286` (Atlas, epic `9fe8cd4e`), from card `5968d7e0`'s own finding and owner decision
Request `5b91bcc0`: *"Build the overflow More menu (tabs that don't fit collapse into More)"*.

Card `5968d7e0` had already rejected the round-4 mockup's `More ⋯` popover as built: all seven rows it
drew were, by then, visible node tabs one row below (cards `41eab0eb` and `25c08fba`). What it named as
the variant that WOULD earn the menu is this one — an overflow, not a second navigation surface.

## What was actually two lines, and what was not

🔴 **The card's own headline sentence — "the 10-tab row returns to one line" — described something that
was already true.** Measured at 1440 on the unmodified build, every node's `.loom-atlas-tabrow` was 28px
tall with all of its tabs on a single `offsetTop`: project 715px of tabs in a 1156px column, Workspace
693px, Platform 325px. Nothing in the tab row was wrapping there.

What WAS two lines is the tab BLOCK, `.loom-atlas-tabs` — 35px on a tab with no KPI strip, **74px** on
every tab that carries one. The strip card `7874e8c2` put on every tab but Overview is 622px (Workspace)
to 686px (project) wide, so `tabs + gap + strip` came to 1331–1420px against a 1156px column and the
strip wrapped onto a line of its own. **That 39px is the "~39px" the card asks to recover**, and the
triage note says so in as many words — *"the tab row on ONE line together with the KPI strip"*.

⇒ So the budget the tabs are fitted into is the column **minus the row's trailing content**, not the
column. Fitting them against the full width would have left the measured block at 74px and satisfied
only a clause that could not fail. Same shape as the wrong DoD clauses cards `7874e8c2` and `49e883a9`
each found in their own briefs; this is the third.

Measured outcome, `.loom-atlas-tabs` height in px, before → after. Both halves measured on a real
build (the "before" column is the negative-control revert of exactly these two source files, rebuilt),
never computed:

| width | project `/board` | project `/settings` | Workspace `/home?tab=gates` | project `/project` (no strip) | Platform |
|---|---|---|---|---|---|
| 1440 | 74 → **35** | 74 → **35** | 74 → **35** | 35 → 35 | 35 → 35 |
| 720 | 138 → **102** | 138 → **102** | 110 → **74** | 71 → **35** | 35 → 35 |
| 420 | 138 → **102** | 138 → **102** | 174 → **102** | 71 → **35** | 35 → 35 |

The two right-hand columns are the inert cases and are byte-identical before and after: a row whose
tabs already fit grows no trigger. Below 820px the remaining height is the KPI strip's own line (and,
at 420, its second line of pills) — the TAB ROW is one line everywhere in the "after" column.

`/settings` is in the table because it is the active-tab case: Settings is the LAST tab, so it is
folded at every width, and the row shown is `Overview · Deck · Board · Sessions · Settings` at 1440 —
the active tab swapped in for the one its width displaced. (Measured when the node had ten tabs;
card `44f725fe` has since removed `Deck`, so the row reads one tab further down the declaration.)

## Do not

- **Do not budget the tabs against the container's full width when the row has trailing content.** The
  strip's wrapped line is the whole thing this collapse exists to reclaim; ignore it and the block stays
  74px at 1440 while every assertion about "the row" still passes.
- **Do not reserve that trailing content unconditionally either.** Below ~820px the strip stops
  right-aligning and is as wide as the whole column (`.loom-kpistrip { margin-left: 0 }`), so reserving
  it there leaves a negative budget and folds *every* tab into the menu. The reservation is taken only
  while it still leaves the row the active tab AND the trigger.
- **Do not move the trigger inside `role="tablist"`.** A tablist's children are tabs; a menu button is
  not one. It is a flex item of `.loom-atlas-tabs`, beside the row.
- **Do not park the menu in the DOM with `hidden` when closed.** Every overflowed tab's label would go
  back into the document as a second page-wide exact-text match — the trap
  `atlas-nav-labels-collide-with-exact-text-locators` records. It renders only while open. This is about
  the MENU only: the tab BODIES stay mounted exactly as before, which is the owner's standing rule and
  is asserted by this card's draft-survival leg.
- **Do not reach for a hidden mirror of the row to measure widths from.** It has the same defect for the
  same reason. Widths come from the real row during a pre-paint measuring pass (below).

## The active tab stays on the row

The card allowed either *"keep it in the row (swap out the last visible one)"* or *"mark More as active
and show the active tab's label"*. **This build keeps it in the row.**

- The phosphor underline IS this row's entire selected-state affordance. A row with nothing underlined,
  and the current tab shut inside a closed menu, leaves "which tab am I on" unreadable at a glance —
  the node head states the NODE's identity, never the tab's.
- The alternative gives the trigger a per-tab width, which the fit computation would then have to
  re-derive per tab, in an `inline-flex` chip that **cannot ellipsise** (card `f76b89b9` measured
  exactly that on `.loom-atlas-headpill`: `text-overflow` does not reach a bare text child of a flex
  container, so it clips mid-word with no `…` and no geometry assertion can see it).

Mechanically: the leading tabs that fit are shown; if the active tab is not among them, its width is
reserved first and the remaining room filled from the front, with the active tab appended last. Because
the active tab's index is by construction past the fitted prefix, appending it preserves declaration
order exactly. **Consequence worth knowing: the menu therefore never contains the active tab** — so there
is no "current item" for the menu to open onto, and it always opens on its first item.

## Measuring without a second copy of the row

`measure: true` renders every tab plus the trigger; a `useLayoutEffect` reads their widths off the real
row and settles on a real count **before the browser paints**, so the complete row is never seen. The
widths are cached and re-used for ordinary resizes; the measuring pass is re-entered only when the tab
signature (key + label + count) changes or `document.fonts.ready` resolves.

`.loom-atlas-tabrow` keeps the `flex-wrap` cards `25c08fba`/`41eab0eb` gave it — **as a safety net, not
as the primary behaviour**. A sub-pixel over-estimate then wraps rather than clips, which is the
survivable failure; the budget is shaded by 1px to make it unlikely. Deleting that wrap would turn a
mis-measure back into the silent off-screen clipping card `25c08fba` fixed.

## What this changed for every other spec

Folding a tab out of the row means `page.getByTestId("atlas-tab-<key>")` is **no longer a complete way to
reach a node tab** at any width where the row overflows — which, with a KPI strip on the row, includes
1440 and the e2e default 1280 viewport. A spec that enumerates or activates node tabs now has to read
both halves. `e2e/helpers/nodeTabs.ts` is that contract in one place; see its own header.
