# db040811 — the kit Button's variant chrome lives in CSS classes, never inline

## Narrative

`Button` (`packages/web/src/components/ui/index.tsx`) used to render its variant chrome as an inline
`style`: `background: "transparent"`, `color: <tone>`, `border: 1px solid <tone>`, plus a flat
`cursor: "pointer"`. `packages/web/src/styles/global.css` separately declares the interaction states
as class rules — `.loom-btn-default:not(:disabled):hover { border-color: … }`,
`.loom-btn-primary:not(:disabled):hover { background: … }`, the `danger`/`ghost` twins, and
`.loom-btn:disabled { cursor: not-allowed; opacity: 0.45 }`.

Inline declarations outrank class rules, and none of those rules carries `!important`. The component
set every property the hover rules target, for every variant, unconditionally — so **all four hover
rules were dead**, and so was the 80ms `background`/`border-color`/`color` transition declared on
`.loom-btn` (there was no class-driven end state to transition toward). Measured on card `95eabed1`
and again here: `getComputedStyle` at rest and during a real `hover()` was byte-identical. This
predated `95eabed1` and affected every Button in the app.

The same shadowing killed `.loom-btn:disabled`'s `cursor: not-allowed` — the flat inline
`cursor: "pointer"` won, so a disabled kit Button still showed a pointer. (`opacity: 0.45` worked,
because opacity was never set inline. Card `db040811`'s body — and memory note
`kit-button-inline-style-kills-its-own-hover-rules` — both asserted `:disabled` was unaffected; that
was correct for `opacity` and wrong for `cursor`.)

The fix moves the four variants' rest chrome into `.loom-btn-<variant>` class rules reading the same
`var(--loom-*)` tokens the TS `color` map already pointed at, so the rest state is byte-identical
while `:hover` now wins on specificity (`:not(:disabled):hover` = 3 classes vs. the bare variant
class's 1). The component keeps only geometry/typography inline, and its `cursor` became
`disabled`-aware rather than flat.

Because the rules key on `.loom-btn-<variant>`, they also reach a RAW
`className="loom-btn loom-btn-<variant>"` element. Every such caller already stated its own chrome
inline — which still wins — except `PresetPrompts`'s `IconButton`, which relied on `.loom-btn`'s
transparent base border and would have gained a red 1px border in its `danger` form. It now states
`border: "1px solid transparent"` for itself.

## Do not

- Do not move `background` / `border-color` / `color` for a Button variant back into the component's
  inline `style` (nor into a `style` default spread ahead of `...style`) — inline beats class, and
  doing so silently re-kills all four `:hover` rules and the `.loom-btn` transition with no test or
  type error to catch it.
- Do not "fix" a shadowed interaction state by adding `!important` to the class rule — the component
  stating the property at all is the defect; remove it there instead.
- Do not set `cursor` flatly inline on `.loom-btn`-classed elements — it shadows
  `.loom-btn:disabled { cursor: not-allowed }`. Make it `disabled`-aware, or leave it to CSS.
- Do not add a raw `className="loom-btn loom-btn-<variant>"` element that wants no visible border
  without stating `border: 1px solid transparent` itself — it now inherits the variant's
  `border-color` from CSS.
- Do not trust `kit-button-inline-style-kills-its-own-hover-rules`' claim that `:disabled` is
  unaffected; `cursor` was shadowed too.

## Source

`packages/web/src/components/ui/index.tsx` (`Button`), `packages/web/src/styles/global.css`
(`.loom-btn-*`), `packages/web/src/components/PresetPrompts.tsx` (`IconButton`).
Verified by `getComputedStyle` rest-vs-hover in Playwright for all four variants on card `db040811`.
