# Color & contrast

Color is where the generated look is most obvious — the AI-purple gradient and the reflexive beige
hero are the two most recognizable tells of 2026. Commit to a deliberate, restrained palette.

## Work in OKLCH

- **Use OKLCH, not HSL.** HSL's lightness is perceptually uneven — two colors at the same HSL
  lightness can look wildly different in brightness. OKLCH lightness is perceptually uniform, so a
  scale built in it stays even, and dark mode is far easier to reason about.
- Define color as `oklch(L C H)`: lightness, chroma (saturation), hue.

## Weight & commitment

- **60-30-10**: ~60% dominant/neutral surface, ~30% secondary, ~10% accent. The accent is a spice,
  not a base.
- **Commit to a level and hold it.** A useful mental ladder, from quiet to loud:
  1. *Restrained* — accent used on ≤10% of the surface (links, one CTA).
  2. *Committed* — accent carries 30–60% (a branded product).
  3. *Full palette* — 3–4 distinct color roles in play.
  4. *Drenched* — color is the whole identity.
  Pick one and design to it. Most product UI lives at *Restrained* or *Committed*.
- **One accent.** A second "accent" is usually a third color that dilutes the first.

## Neutrals

- **Pure gray is dead.** Tint your neutrals toward the brand hue — add a little chroma (**+0.005 to
  +0.015**). The page gains warmth/coolness and coherence without anyone noticing why.
- **Keep chroma low near white.** High chroma at very high lightness is exactly the saturated band
  that reads as the AI default (see the cream warning below).

## Dark mode

- Dark mode is **not an inverted light mode.** Build it as a **surface-lightness depth scale** — base,
  raised, and overlay surfaces stepping up in lightness (roughly a 15% / 20% / 25% lightness ladder).
  Elevation reads as a lighter surface, the way light falls on stacked paper.
- Re-check contrast in dark mode independently; an inverted palette almost never holds AA.

## Contrast (the floor)

- **WCAG AA: 4.5:1 for body text, 3:1 for large text and UI components.** AAA is 7:1 / 4.5:1.
- **Placeholder text counts** — it must clear 4.5:1 too. Faint placeholders are a frequent silent fail.
- Treat AA as a floor you never dip below, not a target you aim for.

## Dangerous combinations (avoid by reflex)

- **Light gray text on white** — the single most common accessibility failure.
- **Red/green** as the only distinction (color-blind users can't see it) — pair with shape/text.
- **Blue text on red**, **yellow on white** — vibrating or low-contrast pairings.
- **Gray text on a colored background** — use a darker shade of the background's own hue instead.

## Two rules of thumb

- **"Alpha is a design smell."** Reflexive `rgba(...)` transparency for overlays and borders produces
  muddy, unpredictable color over varying backgrounds. Define **explicit, opaque** overlay and border
  colors instead. (Genuine glass/scrim effects are the exception, used deliberately.)
- **Avoid the cream/beige reflex.** The warm-neutral band around **OKLCH L 0.84–0.97, C<0.06, hue
  40–100** (and its hex cousins like `#f5f1ea`, `#f7f5f1`) became *the* "premium" AI default. It's not
  wrong in the abstract — it's wrong as a reflex. If you reach for warm cream, make it a real decision,
  not a fallback.
