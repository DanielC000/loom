# Layout & spacing

Spacing is the cheapest way to look expensive. A consistent rhythm and a clear hierarchy do more for
perceived quality than any decoration.

## The spacing scale

- **Use a 4pt base scale**: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96. Every margin, padding, and gap
  comes from this set. Off-scale values (13px, 21px) are what make a layout feel slightly off without
  anyone being able to say why.
- **Group tightly, separate generously.** Related elements sit **8–12px** apart; distinct sections
  are **48–96px** apart. The contrast between the two is what communicates structure — proximity is
  grouping.
- **Don't use uniform spacing everywhere.** A page where everything is 16px apart has no rhythm and no
  hierarchy. Vary deliberately.

## Hierarchy

- Hierarchy comes from combining **size, weight, color, and space** — lean on 2–3 of these at once,
  not one alone.
- For a size relationship to read as *strong* hierarchy, aim for **≥3:1** between the two elements; a
  ratio **<2:1** reads as weak/ambiguous (the reader isn't sure which is more important).
- **The squint test**: blur your eyes (or actually squint at a screenshot) — the most important
  element should still jump out within ~2 seconds. If everything is equally loud, nothing is.

## Layout mechanics

- **Flexbox for one-dimensional** layouts (a row or a column); **grid for two-dimensional** (rows and
  columns together). Don't force a grid to do a flex job or vice versa.
- For responsive card/tile grids, `repeat(auto-fit, minmax(280px, 1fr))` adapts without media-query
  soup.
- Use **container queries** for components that need to respond to *their own* width rather than the
  viewport's — a card in a sidebar and the same card full-width should be able to differ.
- **Single-column on mobile.** Whatever the desktop layout, collapse to one column below ~768px.

## Z-index

- Use a **semantic z-index scale** — named tiers like `--z-dropdown`, `--z-overlay`, `--z-modal`,
  `--z-toast`, each a small deliberate number. **Never `z-index: 9999`** — it's an admission that the
  stacking order isn't being managed, and the next "on top" element just escalates the arms race.

## Touch & target size

- **Interactive targets ≥44×44px.** Smaller and they're hard to hit on touch, and they read as
  cramped on desktop too. Pad small icons up to the target even when the glyph is tiny.

## Cards

- **Never nest cards inside cards.** A card-in-a-card is almost always a sign the hierarchy wasn't
  thought through — flatten it or use spacing/dividers instead.
- **"Cards are the lazy answer."** Reaching for a bordered, shadowed card around every group is the
  default that makes layouts look generated. Use a card only when **elevation actually communicates
  something** (this thing is interactive, or floats above the rest). Otherwise group with space.

## Containment

- Don't let body text run flush to the viewport edge — give it a gutter.
- Don't cram content against the inside of a bordered container — bordered boxes need internal padding.
- Watch for a positioned child (tooltip, menu, dropdown) being **clipped by an `overflow: hidden`
  ancestor** — a classic bug. Either remove the clipping, or render the floating element in a portal /
  at the top layer.
