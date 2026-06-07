# Anti-patterns — the don't-list

This is the highest-value content in the skill: a cross-corroborated catalogue of the tells that mark
UI as generated. Read it before building and check against it before shipping. Each entry is concrete
enough to spot in a screenshot or a diff.

**★ marks the strongest, most reliably AI-default tells** — the ones to internalize first.

## Color & contrast

- ★ **No AI palette** — purple/violet gradients and cyan-on-dark glow are the #1 generated-look tell.
- ★ **No reflexive cream/beige surface** — the warm-neutral band (OKLCH L 0.84–0.97, C<0.06, hue
  40–100; hexes like `#f5f1ea`, `#f7f5f1`) is the #2 tell. Fine as a real decision, never as a default.
- ★ **No gradient text** — especially on headings and big metric numbers.
- **No gray text on colored backgrounds** — use a darker shade of the background's own hue.
- **Don't ship below WCAG AA** (4.5:1 body, 3:1 large/UI); placeholder text counts.
- **"Alpha is a design smell"** — define explicit overlay/border colors, not reflexive transparency.

## Typography

- ★ **No overused default face** (Inter / Roboto / Geist / Plus Jakarta / Space Grotesk / Fraunces)
  when the work needs personality.
- **No single font for the whole page** — pair a display and a body face.
- **No flat type hierarchy** — keep ≥1.25 between scale steps.
- **No reflexive oversized italic serif hero** (Fraunces / Playfair / Recoleta) — advisory; legitimate
  in an editorial register, a tell everywhere else.
- **No body text under 16px** (14px floor for secondary only); no `px`-locked sizes that defeat zoom;
  no `user-scalable=no`.
- **No crushed letter-spacing** past legibility, **no wide tracking (>0.05em) on body**, no all-caps
  body passages.
- **No line length past ~80ch** (cap 65–75ch); no tight leading (<1.3) on body; no justified text
  without hyphenation.

## Layout & space

- ★ **No nested cards** (cards inside cards) — "cards are the lazy answer"; use a card only when
  elevation communicates something.
- ★ **No eyebrow chips** — the tiny uppercase tracked label floating above the hero, and repeating
  kicker labels as section scaffolding. (Eyebrow restraint is the single most-violated rule.)
- **No numbered section markers** (01 / 02 / 03) as default scaffolding.
- **No three-equal-feature-cards** row, and no icon-tile-stacked-above-heading feature template.
- **No oversized long-sentence hero headline** that eats the fold.
- **No monotonous/uniform spacing** — vary tight grouping vs section separation.
- **No content overflow / body text flush to the viewport edge / cramped padding** inside bordered
  containers.
- **No floating element clipped by an `overflow: hidden` ancestor** (tooltips, menus, dropdowns).

## Motion

- ★ **No bounce/elastic easing, no CSS-default easing, never `ease-in` for UI** — use custom
  decelerating curves.
- ★ **Animate only `transform`/`opacity`** — never width/height/margin/padding/top/left.
- ★ **Always respect `prefers-reduced-motion`.**
- ★ **Motion must be motivated** — no decorative animation on high-frequency actions; **never animate
  keyboard-initiated actions.**
- **No feedback animation over 500ms** (UI animations <300ms; exits ~75% of enter).
- **Never animate from `scale(0)`** — start at ≥0.95 + opacity.
- **No `scroll`-event-driven scroll animation** — use `IntersectionObserver` / scroll-driven timelines.

## Copy / UX writing

- ★ **No em-dashes** (`—` or `--`) — the strongest copy-level AI tell.
- ★ **No marketing buzzwords** (streamline / empower / supercharge / seamless / world-class /
  next-generation / leverage / robust / elevate / delve / tapestry / "in today's…" / "let's dive in").
- **No aphoristic "Not X — just Y." cadence** repeated across sections.
- **No generic button labels** (OK / Submit / Yes) — use verb+object; no vague errors; no humor in
  errors; never blame the user.
- **No "Jane Doe" / fake-perfect numbers (99.99%, 50%) / generic company names** as shipped placeholders.

## Quality & accessibility

- **Never `outline: none`** without a visible `:focus-visible` replacement.
- **No broken/placeholder `<img>`** (empty or missing `src`).
- **No skipped heading levels** (h1 → h3).
- **No placeholder-as-label**; **no touch targets under 44×44px**.

---

## Compressed review lens (for a full critique)

When asked for a deeper critique than a `Before / After / Why` table, run this compressed lens
(distilled from Nielsen's heuristics + cognitive-load research — not the full scoring machinery):

**Heuristics to check**: visibility of system status · match to the real world · user control & undo ·
consistency · error prevention · recognition over recall · flexibility · minimalist aesthetic · good
error messages · help where needed.

**Cognitive load**: working memory holds ~4 items — keep primary nav ≤5 items, pricing tiers ≤3,
and any single decision's options small. If a screen forces the user to hold several things in mind at
once to act, that's a critical finding.

**Persona lenses** — sanity-check the design against a few archetypes appropriate to the interface:
a first-time user (can they orient?), a power user (is it fast / keyboard-able?), a low-vision or
keyboard-only user (contrast, focus, targets), a mobile user (single column, thumb reach), a
hurried/distracted user (squint test). Each finding gets a rough severity (blocker → minor) so the
fixes can be prioritized.
