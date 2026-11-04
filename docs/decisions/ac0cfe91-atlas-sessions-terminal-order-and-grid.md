# ac0cfe91 — ordering and gridding the Atlas Sessions tab's terminals

Owner feedback (card `16106aaf`, verbatim), Projects › tab "Sessions": *"Provide user with terminal ordering and gridding features."*

Anchored at `packages/web/src/pages/Terminals.tsx` (the page) and `packages/web/src/lib/terminalLayout.ts` (the derivation). Builds directly on `@decision f3b18f27`, which declared the `.loom-sessionbar` this card's controls had to land in rather than opening a row of their own.

## Do not

- **Never resize a pty to fit a grid cell.** The daemon pins each Claude session's `cols`×`rows` and the client honours them; a narrower cell is answered by re-solving the FONT SIZE for that pinned grid, which `TerminalPane` already did before this card (`components/Terminal.tsx`, the non-`resizable` branch — no `FitAddon` at all, and a `ResizeObserver` that re-scales on width). The column control adds no sizing path of its own, and must not grow one.
- **Never wire `ShellsSection` to the column control.** A raw shell is the opposite case: it FITS its xterm grid to its pane and then tells the daemon to resize the real pty. Pointing a 3-column choice at that lane would resize live shell ptys as a side effect of a presentation preference — the exact thing the bullet above forbids for sessions. The shells grid keeps `AUTO_GRID_TEMPLATE` unconditionally.
- **Never let the saved order replace the derived one.** It is a ranking laid OVER `byManagerThenCreated`/`byCreatedStable`, and a session it does not name keeps the slot that shared key gave it. See *Why the order is a layer* below.
- **Never promote a worker above its own manager.** `RowHeader` reads `row.list[0]` as the row's manager and counts `length - 1` as its workers, so a reordered head relabels both. `applyTileOrder`'s `pinnedFirstId` holds the manager at slot 0 and the move controls start one slot later.
- **Never gate these controls on anything but `projectId`.** Same rule `f3b18f27` set for the quick-start, and here it is structural rather than merely consistent: the preference is stored per project, so a mount with no single project in scope has no key to store it under.
- **Never mount more tiles than the page mounted before this card.** Both controls are presentation only — the same `shown` set renders either way. A column count is not a reason to pre-expand, paginate, or mount anything extra on a page whose renderer is already the heavy one.
- **Never emit `repeat(N, …)` for an explicit count.** A chosen count is a maximum, floored at a tile width the shared card can actually draw — see *An explicit count is a MAXIMUM* below for the measured numbers and why a media query cannot express it.

## The grid scales because the client already did

This is why the "terminal geometry is FIXED" constraint (`CLAUDE.md`) costs this card nothing. `TerminalPane` has two modes, and the Claude one was already width-driven: `resizable: false` adopts the daemon's `cols`/`rows` verbatim and then solves the font size so that pinned grid just fills its container, re-solved by a `ResizeObserver` on the pane's own width; `resizable: true` (raw shells only) does the opposite, fitting the grid to the pane and pushing the result to the daemon as a `resize` frame. So narrowing a cell makes a Claude pane re-scale its font, with no frame sent and no pty touched.

The alternatives were a CSS `transform: scale()` on the pane (a second scaler competing with the one already there, and it blurs a canvas) and an overflow scroller (readable, but it hides exactly the rows a reader is watching). Neither was needed.

## An explicit count is a MAXIMUM, and the 320px floor is measured

Scaling has a bottom. The font solver floors at 6px, so an 80-column pane cannot render narrower than ~288px and starts clipping columns off its right instead; and at a ~291px tile the shared card's own header stops ellipsising cleanly and the identity text collides with its action cluster. Both were observed in the browser at a 291px tile (1180px viewport) and both were clean at 324px (1280px). Before this card no tile on this page could get that narrow at all — `auto`'s own 560px floor kept it out — so the floor is this control's to carry.

`gridTemplateColumns` therefore emits `repeat(auto-fill, minmax(min(100%, max(320px, <an exact 1/N share>)), 1fr))`, not `repeat(N, …)`. While a 1/N share clears 320px, `auto-fill` resolves to exactly N; once the row is too narrow it resolves to however many DO clear it, each stretched by `1fr`. The reader's choice is honoured wherever it can be drawn and gives up one column at a time where it cannot, and the stored choice is untouched — widening the window brings the third column straight back. The outer `min(100%, …)` is what keeps the floor from becoming a sideways scrollbar on a container narrower than it.

No breakpoint is involved, deliberately: the content column's width depends on whether the Atlas rail is a column or a drawer, so the same viewport width yields different row widths either side of that fold (measured: "3 columns" draws 1 track at 900px and 2 at 820px, because the rail hands the column 244px back). A media query here could not name that.

Measured at "3 columns", tile width in brackets: 1600 → 3 (431px), 1440 → 3 (377px), 1280 → 3 (324px), 1180 → 2 (442px), 1100 → 2 (402px), 1000 → 2 (352px), 900 → 1 (616px), 820 → 2 (384px), 720 → 2 (334px). Nothing clips at any of them.

## Why the order is a layer, not a replacement

A session id is ephemeral — a session stops and its replacement gets a new one — so a stored order is always decaying into ids that are no longer live, and a design treating it as THE order would have to migrate or garbage-collect it. `applyTileOrder` instead ranks the ids it recognises and leaves the rest where the derived key put them, which degrades to the default on its own as ids age out and keeps the preference composable with a grouping it knows nothing about (it is applied per row; the rows are still `groupSessionRows`' own).

Unranked tiles land AFTER the ranked ones, deliberately, even though the derived key is newest-first: a reader who placed four tiles keeps those four places, and the fifth session to appear does not displace them. The cost is that a new worker on a custom-ordered grid arrives at the bottom; `Reset order` is the way back to newest-first.

Every move rewrites the whole saved order from what is on screen, not just the pair that swapped — the stored list is one flat snapshot across every row, so writing back the full rendered sequence keeps it a faithful description of the grid, and quietly drops the ids of sessions that have since exited. That is the only cleanup the scheme needs.

## Two buttons, not a drag handle

The card offered either ("drag, or move controls; keyboard-accessible either way"). Buttons won on three counts:

1. **The body is a live terminal.** Selecting text in it is the same press-and-move gesture a drag would have to claim. Confining the handle to the header avoids that, but then the drop targets are full-height cards that each mount a terminal, and a dragover-driven reflow here is a reflow of the heavy renderer.
2. **Keyboard and touch come free.** A real `<button>` pair is already operable both ways; an accessible drag needs a parallel keyboard affordance built anyway, which is this one.
3. **One mechanism, not two.** Shipping both would put the same action on screen twice — the duplicate-affordance defect card `03d9db6e` found in a screenshot after all its assertions had passed.

The cost is that a long move is N presses rather than one drag, acceptable on a grid whose readable size is a handful of tiles.

The labels say **earlier**/**later**, not left/right or up/down, because the same press moves a tile sideways at three columns and vertically at one — a direction word would be wrong in one of the two layouts this card ships. The glyphs (`‹` `›`) are neutral for the same reason. A row with fewer than two movable tiles draws no controls at all rather than a permanently-disabled pair: there is nothing in it to put in an order.

## Two smaller choices

**`Reset order` is hidden until there is an order.** With none saved there is nothing to reset, and a control whose only state is disabled teaches a reader nothing about what it would undo. The ordering affordance is on the tiles, where the thing being ordered is; the bar carries only the way back out.

**The layout is read in an effect, not a `useState` initialiser.** This page stays MOUNTED across a project switch — the Atlas project node parks every visited tab body with `hidden` instead of unmounting it (`pages/ProjectHome.tsx`) — so an initialiser would pin the first project's layout and apply it to every project visited afterwards. Same trap, and the same fix, as the project filter's own re-sync effect directly above it.
