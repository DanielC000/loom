# 53dfa70c — the Terminals-page tile's HUG cap is 760, so its text fills a 1-column card

## Decision
`pages/Terminals.tsx` renders every session tile with `TILE_MAX_HEIGHT = 760` (was 540). It reaches the classic `/terminals`, the Atlas project node's Sessions tab and Atlas `/workspace-terminals` — all three mount the same `renderTile`.

## Why
The owner reported that, in the width band where the grid is still one column, the card widened with the window but the terminal text stopped growing part-way, until two cards fit in a row.

Cause: session terminals have a fixed pty geometry (80×24), and `components/Terminal.tsx`'s `solveFontSize` picks the largest font whose grid fits BOTH the pane's width and its height. A numeric tile height is a HUG cap; at 540 the pane topped out at 432px tall, the height term bound at ~15.9px font, and 80 columns at that font is ~763px. From a ~790px card upward the grid stayed 763px wide while the card kept widening — an empty strip of up to 323px at a 1100px card. Two columns shrink each card to ~570px, below the bound, which is why it looked right again.

Measured on the web e2e fixture daemon, viewport 700→1700px in 50px steps: with 760 the strip in the old plateau (vw 950–1200) dropped from 73–323px to 0–4px, and every row outside it (vw 700–850, 1250–1700) was identical to the 540 run.

## Do not
- Do not lower this cap back below the height the widest 1-column `auto` card needs (~1120px card ⇒ ~730px tile); the plateau comes straight back.
- Do not read it as a fixed height: it is a MAXIMUM, a tile is only as tall as its width-bound grid.

## Known residuals
- An explicit Columns=1 choice on the Atlas nodes can make a card wider than ~1120px; above that the height bound still wins and a smaller strip reappears.
- The classic project Overview's terminal grid (`pages/Overview.tsx`, cap 520) has the same plateau and is deliberately untouched here (it sits above the owner's board embed); it is carded separately.

Guarded by `e2e/terminal-tile-fills-card.spec.ts`.
