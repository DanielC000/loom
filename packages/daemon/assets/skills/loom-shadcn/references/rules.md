# loom-shadcn: implementation rules

Condensed from the upstream shadcn/ui project's own skill rules (see this skill's own `NOTICE` file for
the source, licence and commit). Reworded into Loom's own voice; no upstream prose is reproduced
verbatim — these are the conventions, not the source text.

- **Theme via tokens, not per-component overrides.** Change the project's CSS theme variables (e.g.
  `--primary`, `--radius`); don't hardcode a color or radius on one component instance.
- **Merge class names with `cn()`**, never plain string concatenation — it resolves conflicting
  Tailwind utilities deterministically (last one wins per utility group), which a plain template
  string doesn't.
- **Spacing: `gap-*` over `space-*`** inside a flex/grid container. `space-*` only applies in one axis
  and breaks under `flex-wrap`; `gap-*` doesn't have that failure mode.
- **Variants before one-off overrides.** If a component needs a recurring visual shape, add a variant
  to its own variant config rather than scattering ad hoc class overrides at each call site.
- **One primitive family.** Prefer whichever underlying primitive library (Base UI or Radix UI) the
  project's `components.json`/existing components already use — don't mix both inside one component.
- **One icon library.** Use the icon set the project's existing components already import; don't add a
  second icon library for one new component.
- **Compose, don't duplicate.** Build new UI by composing existing primitives (e.g. wrap an existing
  dialog/popover component) rather than re-implementing the same interaction pattern from scratch.
- **Forms.** If the project already uses a form library/pattern, pair with it; don't introduce a second
  one for a single new form.
