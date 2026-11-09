# 139cfc3d — a card is reordered within its lane only inside its priority band, and the line shows the real slot

Card `139cfc3d`. Code: `packages/web/src/lib/laneReorder.ts` (the pure slot / position / renumber maths), `pages/Board.tsx` (`onDragMove`, the `reorderCards` mutation, `reorderCardTo`, the Alt+↑/↓ branch of the grid's `onKeyDown`, `Column`'s `reorderIndex`). Tests: `packages/web/test/lane-reorder.mjs`, `packages/web/e2e/board-card-reorder.spec.ts` (on `/overview` and `/board`).

## The model

- **Order is the existing `Task.position` field, written through the existing `POST /api/tasks/:id`.** No daemon change. A field-only patch never bumps `version`, so it never meets the drawer's `baseVersion` gate.
- **Priority stays first.** A live lane sorts by priority, then position (`byPriorityThenPosition`), so a position can only order cards that share a priority. A drag or Alt+arrow past the band's edge is CLAMPED to that edge. The drop line is drawn at the clamped slot, so it always shows where the card will land; with no line, the drop leaves the card where it is.
- **One write in the normal case.** The card takes the midpoint of its new neighbours, or a neighbour's position ± `REORDER_STEP` at a band edge. When no such number exists (two neighbours with the same position, which legacy `DEFAULT 0` rows and same-millisecond creates both produce, or a gap a double cannot split), the WHOLE band is renumbered. That band is every card of that priority in the lane, including any a filter hides. Positions restart at the band's lowest value, and only changed cards are written.
- **The writes are sequential, and a failure shows the server's order.** The new order is painted optimistically and the 4s poll pauses until the writes settle (`useIsMutating` on `["board-card-reorder", projectId]`). If any write fails, the board refetches and shows what the server holds, with a `card-reorder-error` alert beside it. A half-renumbered band is never left on screen looking saved.
- **The pointer slot** is the number of the lane's other cards whose vertical midpoint sits above the lifted preview's centre (`active.rect.current.translated`), measured off `[data-card-id]` at move time, so lane scroll is accounted for.
- **Keyboard:** Alt+↑/↓ on a focused card moves it one slot (the same `reorderCardTo` as a drop). Focus stays on the card, and the live region says "moved to N of M in P2, <lane>", or that the card is already first or last in its band.
- **The done lane is never reorderable.** It sorts by recency, so a manual order would not show and would be clobbered by the `updatedAt` stamp.
- **A drop back on the card's own lane never sends a `columnKey` write.** It used to, which only stamped `updatedAt`. In the done lane that jumped the card to the top.

## Considered and deferred

- **Cross-lane pointer-slot landing.** A card dropped into ANOTHER lane still lands at the slot that lane's comparator gives it (card `68800f89`, unchanged): a lane move keeps priority and position. Making it land under the pointer, and write a position too, was considered. It was deferred because `68800f89` had just shipped and been reviewed.
- **REST `position` validation** (the route does not check that `position` is a finite number). Carded separately by the manager; this card is web-only.

## Do not

- **Do not let a drag or Alt+arrow change a card's priority.** Priority is read by the idle watchdog and by agents. It changes only through the dialog or the bulk bar, never as a side effect of order.
- **Do not switch the board to `@dnd-kit/sortable`.** Sortable reflows cards under the pointer, which `68800f89` deliberately avoided. The line is the only in-lane feedback.
- **Do not fire the renumber writes in parallel, or resume the poll before they settle.** Either lets a refetch paint a half-renumbered band as if it were saved.
- **Do not compute a renumber from the filtered list.** A hidden card in the same band would keep a stale, colliding position.
