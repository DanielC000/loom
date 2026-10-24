# ebbc4a70 — the terminal's font fit must SETTLE, and must be verified against the grid it actually rendered

`TerminalPane.applyFontSize` (`packages/web/src/components/Terminal.tsx`) solves the largest fontSize whose pinned `cols×rows` grid fits the pane. It used to do that in ONE pass and, in HUG mode, write the resulting grid height onto the very element its own `ResizeObserver` watches. A live terminal pane therefore changed geometry about 60 times a second, forever, while nothing at all was happening.

## What was measured

On `ab3f882b`, with a canned-pty session (120×40) on `/overview` at 1200×900, instrumented by wrapping `window.ResizeObserver` and `Element.prototype.replaceChildren` (filtered to `.xterm-selection`, which is exactly what `DomRenderer.handleResize` repaints) plus an rAF sampler over the geometry:

- **123 real `DomRenderer.handleResize` calls in 2000 ms — 61.5/s — indefinitely, at rest.**
- A clean 2-cycle, alternating every single animation frame, between
  - `pane 421px / screen 627×400px` (font 8.7, cell height 10px) and
  - `pane 419px / screen 655×440px` (font 9.1, cell height 11px).
- `0` `{type:"resize"}` frames on the websocket. The daemon never saw any of it (the loop is Claude mode, `resizable=false`, where `fitAndReport` is never called), so the pinned PTY geometry was never involved.

## The premise that was wrong

The card, and the project memory note that reported the specimen, both held that these were GENUINE grid resizes, reasoning that `CoreTerminal.resize` early-returns when `cols`/`rows` are unchanged. That is true of `CoreTerminal.resize` and irrelevant here, because that path is never entered.

Captured at rest (not at attach — the distinction is the whole point), the chain is:

```
DomRenderer.handleSelectionChanged
DomRenderer.handleResize
RenderService.handleResize            ← called with the UNCHANGED bufferService.cols/rows
  (RenderService's own onMultipleOptionChange(["…","fontSize","…"]) handler)
OptionsService.onMultipleOptionChange
EventEmitter.fire                     ← OptionsService._onOptionChange
OptionsService._setupOptions' setter
Terminal._publicOptions setter        ← `term.options.fontSize = next`
```

There is **no `BufferService.resize` frame**. xterm reaches `DomRenderer.handleResize` from a **fontSize option change**, at a constant grid:

```ts
// RenderService's constructor
this.register(optionsService.onMultipleOptionChange([
  'customGlyphs', …, 'fontSize', …
], () => {
  this.clear();
  this.handleResize(bufferService.cols, bufferService.rows);
  this._fullRefresh();
}));
```

The predecessor's stack, which does carry `BufferService.resize`, was captured at ATTACH time — `term.resize(cols, rows)` in the `geometry` frame handler, which fires once. Its bare `EventEmitter.fire` frame was `OptionsService._onOptionChange`, not `onResize`. Both stacks were reproduced side by side before this was concluded.

## The real mechanism

**(a) One solver pass is not a fixed point.** The solver derives a per-pixel cell ratio from the renderer's measured cell box:

```ts
const cellHPerPx = cell.height / curFont;
const fitH = ch / (rows * cellHPerPx);
```

`cell.height` is xterm's cell box ROUNDED to whole CSS pixels (`DomRenderer._updateDimensions`: `device.char.height = Math.ceil(charHeight * dpr)`, then `css.canvas.height = Math.round(…)`, `css.cell.height = css.canvas.height / rows`). So the ratio is a function of the font it was measured at, not a constant: **11/9.1 = 1.2088 against 10/8.7 = 1.1494 — a 5.2% swing, against a 0.1 font quantum.** The map `font → next` is non-contractive, and wherever the budget binds it has a 2-cycle instead of a fixed point. The arithmetic reproduces both measured states exactly at a budget of ~421px:

- font 9.1, ratio 1.2088 → `fitH = 421/48.35 = 8.71` → floor → **8.7**; grid height `ceil(40 × 1.2088 × 8.7) = 421`
- font 8.7, ratio 1.1494 → `fitH = 421/45.98 = 9.15` → floor → **9.1**; grid height `ceil(40 × 1.1494 × 9.1) = 419`

**(b) The write closed the loop.** `applyFontSize` wrote `el.style.height = gridH`, and the attach effect did `ro.observe(el)` — the same element. 421 ≠ 419, so every pass re-fired the observer that had invoked it.

FILL mode (`heightBudget` unset — `/session/:id` passes `height="76vh"`) was clean throughout: the `el.style.height` write is skipped there, so (a) was latent with nothing to drive it.

## It was never an Atlas defect, and a single viewport says nothing

The first reading showed classic `/overview` clean and Atlas `/overview` red at 1280×900, which would have supported an Atlas-shell attribution. Sweeping the viewport 1000→1600px under both shells killed it:

| shell | red widths | clean widths |
|---|---|---|
| classic | 8 of 13 | 1250–1450 |
| atlas | 9 of 13 | 1450–1600 |

Same code, same mode, identical `419↔421` cycle. The only discriminator is whether the fit is height-bound, i.e. whether the resolved HUG budget binds — a property of the layout, not the shell. 1280×900 is simply a fixed point in classic.

## The fix

Two parts. Both are required; the first alone is not safe.

1. **In HUG mode, only re-run `applyFontSize` when the observed WIDTH changes.** Width is the only box dimension that is an INPUT: in HUG mode the function reads `el.clientWidth` and `budgetRef.current`, never `el.clientHeight`, and a budget change already arrives on its own path (the `heightBudget` effect). So a height-only entry carries no new input by construction. FILL mode is the opposite case — there `ch` IS `el.clientHeight` and nothing writes it — so every entry is honored.

2. **Settle the font, then verify against the realized grid and descend.** A bounded settle loop (≤3 passes, with revisit detection, taking the smallest member of a cycle) followed by a bounded descent (≤4) that re-measures the cell box and steps the font down until `rows × cell.height ≤ ch` and `cols × cell.width ≤ cw`. The pane height is then derived from the CURRENT cell box, never from a stale ratio times a new font.

### Why observing an ancestor is NOT the fix

The obvious form of part 1 — observe the pane's parent instead of the pane — was measured and rejected. Across the two oscillation states the parent tracks the pane exactly (`parentClientH` 421 ↔ 419), and the panel above it moves too (514 ↔ 512): in this path the wrapper carries only `min-height:0; overflow:hidden` with `flex: 0 1 auto` and the panel is `max-height:520px; display:flex`, so both content-size to the pane. Writing `el.style.height` still changes their boxes, and the loop would simply have survived by a longer route.

### Why the descent is not belt-and-braces

Breaking the observer loop alone freezes the pane on whichever member it lands on — and one member, `pane 419px` around a `440px` grid, loses about two rows to the pane's `overflow:hidden`. Settling and not-clipping are INDEPENDENT properties.

The first attempt at part 2 creeped down by 0.1 for at most 2 passes, and the viewport sweep caught it settling at `pane 421px / screen 440px` at one width — the clipping state, reached because the settle loop can exit on its pass budget without reaching a fixed point, and two 0.1 steps were not enough to cross a rounding boundary. The shipped descent re-solves from the realized ratio each pass, clamped strictly below the current font, so it jumps to the right neighbourhood in one step and still terminates monotonically. After it: **0 of 13 widths red and 0 of 13 clipped, under both shells.**

A true fixed point cannot clip, since its ratio was measured at the very font it returns; only a budget-exhausted exit can, which is what the descent exists to catch.

## Do not

- **Do not reduce `applyFontSize` to a single solver pass, and do not derive the pane height from a cell ratio measured at a DIFFERENT font.** Both were the defect: the pair oscillated at ~62 fontSize changes per second forever, and one of its two states clipped about two terminal rows.
- **Do not make the HUG-mode ResizeObserver react to a height-only entry again.** That height is this component's own write; reacting to it re-enters the function through its own output. Observing an ancestor is not an escape — measured, they content-size to the pane.
- **Do not replace the realized-grid descent with a fixed number of 0.1 steps, and do not drop it because the settle loop "already converges."** The settle can exit on its pass budget, and the measured consequence was a clipping pane.
- **Do not assert this at rest from one geometry reading, and do not assert it with only a height fingerprint.** The defect is an oscillation, so a single read passes on the broken code; and `css.canvas.height` is `rows × round(cell.height)`, so a real refit can land on the same rounded height at a different font while the width moves — which false-failed this spec's own positive control until the width was sampled too.
- **Do not leave `terminal-resize-at-rest.spec.ts` at Playwright's default viewport.** Whether the pane oscillates depends on the resolved budget: 1280×900 is a fixed point in classic, so the default would have false-greened half the legs. It is pinned to 1200×900 (red in both shells on the broken code) with 1450×900 as the already-stable contrast case, and its positive control is pinned to 640×900 because several wider candidates do not move the settled geometry at all.
- **Do not reach for `locator.screenshot()` on anything terminal-adjacent to prove this.** See `@decision 6b8ff4a2`: it cannot satisfy Playwright's stability check while this class of motion exists. Sample inline style strings instead; `.xterm-screen`'s own inline size IS the rendered grid.
