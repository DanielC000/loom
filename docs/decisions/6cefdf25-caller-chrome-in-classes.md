# 6cefdf25 — a Button call site's chrome lives in a modifier class, never its inline style

## Narrative

Card `db040811` moved the kit `Button`'s own variant chrome out of its inline `style` and into
`.loom-btn-<variant>` class rules, so the four `:not(:disabled):hover` rules in
`packages/web/src/styles/global.css` finally won on specificity. That fixed the component. It did
nothing for a CALL SITE that states `color` or `background` inline — inline still beats class, by
correct cascade, so such a button is still visually inert on hover. `db040811`'s own measurement
caught one (`ColumnManager`'s `key` ghost button, identical rest-vs-hover before AND after) and
recorded it as a known residual; this card closed the four that existed:

- `App.tsx`'s first-run welcome "Maybe later" — inline `color: textMuted`.
- `ColumnManager`'s `key` toggle — inline `color`, cyan when open / muted when closed.
- `Composer`'s `PresetsButton` — inline `color` + `background` for the OPEN state only, so the
  trigger went inert exactly while the popover it controls was up.
- `PresetPrompts`'s `IconButton` — inline `color` restating the variant's OWN token
  (`--loom-red` / `--loom-text-dim`) verbatim. A no-op to look at, and still fully shadowing.

The fix adds three caller-level MODIFIER classes beside the variant rules — `.loom-btn-muted`,
`.loom-btn-accent`, `.loom-btn-on` — and the call sites pass one as `className` instead. They are
modifiers, not variants: they tune a variant's rest label/fill and compose with it. Each reads the
same `var(--loom-*)` token the inline value already used, so every rest state is byte-identical;
each carries its OWN 3-class `:not(:disabled):hover` so the hover end state belongs to the modifier
rather than to whichever variant it is composed with. `IconButton` needed no class at all — deleting
its inline `color` leaves the variant's identical rest color in place.

Ordering is load-bearing twice over. A modifier's rest rule is ONE class, exactly like a variant's,
so it must sit AFTER the variant block for the equal-specificity tie to resolve in the modifier's
favour. A modifier's hover rule is THREE classes, exactly like a variant's hover rule, so it must sit
after those too. Class order in the `className` attribute is irrelevant — only stylesheet source
order breaks these ties.

## Do not

- Do not set `color` or `background` in a Button call site's inline `style` (nor spread one in
  conditionally for an open/active state) — inline beats class, so it silently kills that button's
  own `:hover` rule and the 80ms `.loom-btn` transition, with no test or type error to catch it.
  Pass a `.loom-btn-muted` / `.loom-btn-accent` / `.loom-btn-on` modifier as `className` instead, or
  add a new modifier beside them.
- Do not restate a variant's own rest `color` inline even to the IDENTICAL token — it changes nothing
  visible at rest and shadows the hover rule just as completely as a different value would.
- Do not "fix" a shadowed call site with `!important`, and do not push its colors into the kit
  `Button` or into a variant rule — a variant is shared by every caller; a caller's tone is not.
- Do not move the modifier rules above the `.loom-btn-<variant>` block, or split a modifier's rest
  rule from its `:hover` rule across it — both ties resolve on source order alone.

## Source

`packages/web/src/styles/global.css` (`.loom-btn-muted` / `-accent` / `-on`),
`packages/web/src/App.tsx` (`FirstRunWelcome`), `packages/web/src/components/ColumnManager.tsx`,
`packages/web/src/components/Composer.tsx` (`PresetsButton`),
`packages/web/src/components/PresetPrompts.tsx` (`IconButton`).
Verified by `getComputedStyle` rest-vs-hover in Playwright for all four, with a pre-fix control
showing each pair identical: `packages/web/e2e/button-hover-states.spec.ts`.
