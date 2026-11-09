# Atlas crumb ancestors keep a legibility floor; the deepest crumb keeps none

Card `c88ac078` (Atlas audit findings A-02 and A-14, epic `898a64ef`). Anchored from `packages/web/src/components/AtlasShell.tsx`. Builds on `1d3192dc` (the deepest crumb shrinks last) and `9477a5ed` (the count-based collapse at phone width).

## What went wrong

Decision `1d3192dc`'s lopsided shrink (`flex-shrink: 999` on ancestors, `1` on the deepest crumb) hands the deficit to the ancestors, but nothing stopped them at zero. A 186-character request title on `/question/:id` at 1440px measured `Workspace` and `Inbox` at 0px wide while their `/` separators still painted, so the trail read `/ /`. The same over-full row squeezed "Switch to the classic UI" onto two lines (46px tall). At 390px a three-segment trail (`Workspace / <long project> / Agents`) clipped its leaf to "Agen…" because the four-segment collapse from `9477a5ed` only applies to trails longer than three.

## What this card does

- An ancestor whose label is longer than `CRUMB_FLOOR_CHARS` (5) gets `.is-floored`: a `min-width` on the `<li>` of about four characters plus the ellipsis (`--loom-crumb-floor`, plus the separator and gap for every segment but the first). An ancestor no longer than that gets `flex-shrink: 0` and renders whole.
- `.loom-atlas-leave` is `flex: none; white-space: nowrap` at every width.
- A three-segment trail renders the same `…` disclosure, shown only at `max-width: 480px`, where it collapses to its deepest segment alone. The four-segment rule from `9477a5ed` is unchanged.

Measured after the change at 1440: `Work… / Inbox / <title>…`, leave button 28px. At 390: `… / Agents`, with the leaf unclipped.

## Do not

- **Do not put the floor on the deepest crumb.** `1d3192dc` forbids a width cap there, and a floor would also take room from it. The floor goes on ancestors only.
- **Do not apply the floor to every ancestor unconditionally.** A `min-width` larger than a short label's own width (a project named "Fox") pads it with blank space. Short labels opt out of shrinking instead.
- **Do not move the floor from the `<li>` to the label span.** The `<li>` is the flex item the shrink ratio acts on. A floor on its child alone lets the `<li>` keep shrinking, and the label paints over its neighbour.
- **Do not decide the phone collapse by measuring boxes.** It is count-based in CSS, like `9477a5ed`.
