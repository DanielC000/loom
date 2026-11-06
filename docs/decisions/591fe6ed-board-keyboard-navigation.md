# 591fe6ed — the board is one Tab stop with a roving tabindex, and its focus position lives in one place

Card `591fe6ed`. Code: `packages/web/src/lib/boardFocus.ts` (model + pure nav), `pages/Board.tsx` (state, grid handlers, `n` shortcut), `components/boardLanes.tsx` (`LaneMenu` as the header item). Spec: `packages/web/e2e/board-keyboard-nav.spec.ts`, on `/overview` and `/board`. Shortcut inventory: `docs/decisions/a1c6e339-atlas-keyboard-shortcuts.md` §1.

## The model

- **Items are marked in the DOM, not registered.** Each lane (`[data-lane-key]`) lists its items in render order as `[data-board-nav]`: `head` (the ⋯ menu button, or a collapsed lane's rail), each rendered card's open target (its id), and `more` (the done lane's "Show N more"). The order is read off the DOM at keypress time, so the nav cannot disagree with what is rendered: the done cap/window, a filter, a collapse and the 4s poll all change that set.
- **The position is `Board`'s `BoardFocus` state** (`{lane, item, index}`), set by the grid's delegated `onFocus` from whatever the user focuses, pointer or keyboard. Each lane resolves which of its items gets `tabIndex=0` (`resolveLaneItem`): the wanted item if it is still rendered, else the item at the same index, else (no position yet) the lane's first card, else its header. A card that changed lane (from its dialog, or another process) is followed to its new lane.
- **Lost focus is put back.** When the focused node leaves the DOM (a card the poll moved, a reveal button that vanished or went disabled while its page loads, a dialog closing after its card moved), focus would drop to `<body>`. `repairIfLost` refocuses the current stop. It runs after every board and lane render, and only while the board last held focus, so a user who clicked elsewhere is never pulled back.

## How each awkward case behaves

- **Collapsed lane:** its rail is its only item. ←/→ land on it, ↑/↓ do nothing, Enter expands it (focus then moves to its ⋯ button, as before). Its cards are not in the DOM, so they cannot be focused.
- **Empty lane:** ←/→ land on its header; ↓ does nothing.
- **Done-lane cap / window:** only rendered cards are items. End stops at the last rendered card; ↓ from there reaches "Show N more"; activating it lands focus on the first newly revealed card (index fallback) once the button goes away.
- **Hierarchy:** a child card is an ordinary card in its lane. The parent chip and the blocker marker on a card are spans, not controls, so nothing inside a card is an extra stop.

## Do not

- **Do not give the card's drag grip its tab stop back.** dnd-kit's `attributes` set `tabIndex=0` on it; `Card` overrides that with -1 on purpose. Two stops per card is exactly the Tab walk this card removed. The keyboard way to move a card is its dialog's "Move to lane".
- **Do not re-add ↓/↑-opens-the-menu on the ⋯ button.** That button is the lane's header item, so plain arrows on it belong to the grid. Enter/Space and a click open the menu; Alt+←/→ still move the lane.
- **Do not keep a second focus/selection position elsewhere.** Multi-select (card `19074e42`) should read and extend `BoardFocus`, not grow a parallel one.
- **Do not let `n` fire from a field, a dialog or a menu, and do not answer it from more than one board.** `shortcutBlocked` and the first-visible-board check carry those two rules.
