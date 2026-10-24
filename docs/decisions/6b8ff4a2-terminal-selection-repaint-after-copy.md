# 6b8ff4a2 — the terminal's smart copy collapses the selection to an empty range, it does not `clearSelection()`

`Terminal.tsx`'s smart-clipboard branch (`attachCustomKeyEventHandler`, the ⌘/Ctrl+C half) ends with `term.select(0, 0, 0)` where the obvious call is `term.clearSelection()`. That substitution is the whole fix for this card, and it is not a stylistic preference — `clearSelection()` leaves the highlight painted on screen.

## The defect, as reported

Found while measuring card `a1c6e339` (Atlas P2-8) and recorded in `docs/decisions/a1c6e339-atlas-keyboard-shortcuts.md` §5: ⌘/Ctrl+C copied correctly and the MODEL really cleared (a second ⌘/Ctrl+C fell through as SIGINT, proving `hasSelection()` had gone false), but `.xterm-selection` still held 2 painted, non-zero-area children afterwards — while an ordinary click elsewhere did take it back to 0. The user saw text still "selected" that was not.

## Root cause — an xterm 5.5.0 `DomRenderer` cache, not a missing repaint

`clearSelection()` does queue a repaint, and that repaint does run. The highlight comes BACK, from a stale cache, on the terminal's very next resize.

`DomRenderer` keeps its own `_selectionRenderModel` (`src/browser/renderer/dom/DomRenderer.ts`), and `handleResize()` repaints the selection layer from it:

```ts
public handleResize(cols: number, rows: number): void {
  this._refreshRowElements(cols, rows);
  this._updateDimensions();
  this.handleSelectionChanged(this._selectionRenderModel.selectionStart, this._selectionRenderModel.selectionEnd, this._selectionRenderModel.columnSelectMode);
}
```

But `handleSelectionChanged` returns BEFORE it ever updates that cache when the selection is empty:

```ts
public handleSelectionChanged(start, end, columnSelectMode): void {
  this._selectionContainer.replaceChildren();   // the clear DOES happen…
  this._rowFactory.handleSelectionChanged(start, end, columnSelectMode);
  this.renderRows(0, this._bufferService.rows - 1);
  if (!start || !end) {
    return;                                     // …and the cache is left holding the OLD coordinates
  }
  this._selectionRenderModel.update(this._terminal, start, end, columnSelectMode);
  …
}
```

So `clearSelection()` → `handleSelectionChanged(undefined, undefined)` → the layer is emptied and the cache keeps the pre-copy coordinates forever. The next resize repaints them. `SelectionRenderModel.update()` itself handles the empty case correctly (it calls its own `clear()` when `!start || !end` or when `start` equals `end`) — it is simply never reached on this path. The bug is the early return, upstream, in `DomRenderer`.

Measured here on 2026-10-24 with a throwaway diagnostic driving the real canned-pty terminal (wrapping `Element.prototype.appendChild`/`replaceChildren` on `.xterm-selection` and capturing a stack on the first repaint AFTER the copy):

```
at DomRenderer.handleSelectionChanged
at DomRenderer.handleResize
at RenderService.handleResize
at EventEmitter.fire            ← Terminal's onResize
```

Every frame, for as long as the pane stayed mounted: ~94 `replaceChildren` and ~94 matching `appendChild` calls on `.xterm-selection` in 1.5s. The terminal re-paints the stale selection as fast as it resizes.

## Why an empty range fixes it, and why a plain click always worked

`term.select(col, row, 0)` routes through `SelectionService.setSelection()`, which clears the model first and then records a ZERO-LENGTH range. `finalSelectionStart` and `finalSelectionEnd` are then both defined and equal, so:

- `hasSelection()` is still false (its getter is `start[0] !== end[0] || start[1] !== end[1]`), `getSelection()` is still `""`, and a second ⌘/Ctrl+C still falls through as SIGINT — the copy semantics are unchanged;
- but `handleSelectionChanged` no longer takes the early return, so `_selectionRenderModel.update()` runs, sees `start === end`, and CLEARS the cache. Every later resize then repaints nothing.

This is the same shape xterm's own single-click path uses — `_handleSingleClick` sets `selectionStartLength = 0` and `selectionEnd = undefined`, i.e. a zero-length range — which is exactly why the measured control (a click elsewhere) cleared the highlight when the copy did not. The fix is not a trick; it is the path the renderer is already known to handle.

## Deliberately not done

The per-frame resize storm above is a REAL second defect, and it is not this card's: it is why the stale repaint shows up instantly rather than at the next window resize, but it is not why the highlight survives the clear. Fixing it would only make this bug rarer (copy, then resize the pane, and the highlight returns), so it is not an alternative fix. It belongs to whoever owns `applyFontSize`/`fitAndReport` and the pane's height-budget feedback loop.

Nothing was patched inside `@xterm/xterm`, and no renderer private was reached into (`Terminal.tsx` does already read `_core._renderService.dimensions` for cell metrics, so that was available — `select()` is public API and does the same job).

## Do not

- **Do not swap `term.select(0, 0, 0)` back for `term.clearSelection()`** in the ⌘/Ctrl+C branch, however much it reads like the right call. `clearSelection()` leaves `DomRenderer`'s `_selectionRenderModel` holding the pre-copy coordinates, and the pane's next resize repaints the highlight the user just copied away.
- **Do not assert the cleared highlight by COUNTING `.xterm-selection div` elements.** An empty range still appends zero- and negative-geometry ghost children for the frame it is applied in, so a `toHaveCount(0)` check is timing-dependent. Count painted AREA (`getBoundingClientRect`), which is what "the highlight is gone" actually means — `atlas-keyboard-shortcuts.spec.ts`'s `selectionArea` helper is that measure.
- **Do not treat a one-shot "area is 0" reading as proof, and do not drop the delayed re-read from the spec.** The defect's signature is RESURRECTION, not a slow clear. MEASURED on the negative control for this card: with the fix reverted, the leading `expect.poll(() => selectionArea(page)).toBe(0)` passed — the area really does touch 0 in the frame between the clear and the stale repaint — and both shells failed on the 400ms-later re-read, and only on that.
