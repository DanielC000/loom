# Typography

Type is the highest-leverage surface in most UI — it's most of what a user looks at. Get the scale,
measure, and rhythm right and a page reads as designed before any color or motion lands.

## The modular scale

- Pick **one ratio** and stick to it: 1.25 (major third), 1.333 (perfect fourth), or 1.5 (perfect
  fifth). Larger ratios = more dramatic hierarchy; smaller = more even.
- Keep **at least a 1.25 ratio between adjacent steps** so the hierarchy is legible. Steps closer
  than that read as a flat, undifferentiated wall of text.
- **About five sizes cover most needs**: body, small, a couple of heading steps, and one display
  size. Resist inventing a one-off size for a single element — fit it into the scale or fix the scale.

## Body & measure

- **Body text ≥16px (1rem).** 14px is a hard floor for secondary text only; never smaller for reading
  copy. Don't disable user zoom.
- **Measure (line length) 45–75 characters; cap at 65–75ch.** Past ~80ch the eye loses its place
  returning to the next line. Use `max-width` in `ch` units or a sensible rem cap.

## Line height & spacing

- **Headings: 1.1–1.2.** Tighter as size grows.
- **Body: 1.5–1.7.** Generous leading is what makes long-form text comfortable.
- **ALL-CAPS labels** need extra tracking — **+0.05 to +0.12em** — or the letters jam together.
- **Display/hero type** can take slightly negative tracking, but **don't go below −0.04em** or it
  gets cramped. Body text should sit near 0; wide tracking (>0.05em) on body hurts readability.
- Use `text-wrap: balance` on h1–h3 (even line lengths) and `text-wrap: pretty` on prose (no orphans).

## Font pairing

- **≤3 font families**, **≤3–4 weights total.** More than that and the page loses coherence.
- A single font for the whole page is usually a missed opportunity — **pair a display face with a
  body face**, chosen on a contrast axis (serif + sans, or geometric + humanist). Same-category pairs
  fight each other.
- **Don't reflexively reach for the overused defaults** (Inter, Roboto, Geist, Plus Jakarta, Space
  Grotesk) when the work needs personality — they read as the safe AI choice. They're fine for neutral
  product UI; they're a tell on anything that should feel distinctive.
- An **oversized italic serif hero** (Fraunces, Playfair, Recoleta) is a common generated-look tell.
  Don't reach for it by reflex — but it's a legitimate choice in an editorial or magazine register.
  Judge by context, not by ban.

## Display sizing

- A hero headline can clamp large but keep the top end sane: **max ≤ ~6rem (~96px)**, and the
  fluid `max` no more than **~2.5× the `min`** so it doesn't explode on wide viewports.
- Don't let a long, multi-line hero sentence eat the entire fold — tighten the copy instead.

## Dark mode

- Type rendered on a dark surface looks heavier than the same weight on light. **Drop the body weight
  slightly** (e.g. 350 instead of 400) and **add a touch of tracking** (+0.01 to +0.02em) so dark-mode
  text reads as cleanly as its light-mode counterpart.

## Tokens

- Name type tokens **semantically** (`--text-body`, `--text-heading`), never by value
  (`--text-16`). Semantic names survive a scale change; value names lie the moment you retune.
