# Motion

Motion is the area where good and bad design diverge most sharply, because most motion is
*unmotivated* — added because it can be, not because it helps. The first question is never "how should
this animate" but "**should this animate at all.**"

## Decide whether to animate first

Animation cost scales with frequency. Run an action's frequency through this before adding any motion:

| How often the user sees it | Verdict |
|---|---|
| 100+ times/day (e.g. a command-palette open) | **Never animate** — it becomes friction fast |
| Tens of times/day | Reduce — keep it minimal and very fast, or drop it |
| Occasional (modals, toasts) | Standard motion is fine |
| Rare / first-run | You can afford a touch of delight |

Two hard rules that fall out of this:

- **Never animate keyboard-initiated actions.** A user who hit a shortcut wants the result *now*;
  animation just delays them.
- **Motion must be motivated.** Every animation should do one of: maintain spatial continuity, show a
  state change, explain a relationship, or give feedback. If it does none of those, cut it.

## Duration

- **UI animations stay under 300ms.** A rough ladder: instant feedback 100–150ms, state changes
  200–300ms, larger layout shifts 300–500ms, full-screen entrances 500–800ms (rare).
- **Exits run faster than enters — about 75%.** Things should leave more briskly than they arrive.
- **~80ms is the perceived-instant threshold**; feedback slower than ~500ms feels laggy.
- Per-element rough durations: button ~100–160ms, tooltip ~125–200ms, dropdown ~150–250ms, modal
  ~200–500ms.

## Easing

- **Use custom decelerating curves.** The CSS built-ins (`ease`, `ease-in-out`) are too weak to feel
  intentional. Ship a small named palette and reuse it:
  - `--ease-decelerate: cubic-bezier(0.23, 1, 0.32, 1)` — for enters and most UI (fast then settles)
  - `--ease-smooth: cubic-bezier(0.77, 0, 0.175, 1)` — for on-screen moves (in-out)
  - `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)` — for sheets/drawers
  - Impeccable's alternatives are equally valid and reject the same defaults: quart
    `(0.25, 1, 0.5, 1)`, quint `(0.22, 1, 0.36, 1)`, expo `(0.16, 1, 0.3, 1)`.
- **Easing decision tree:** enter/exit → ease-out (decelerate); on-screen move → ease-in-out (smooth);
  hover/color → the gentle default `ease`; constant/linear motion (a spinner, a marquee) → `linear`.
- **Never `ease-in` for UI** (it starts slow — feels sluggish and unresponsive), and **never
  bounce/elastic** (it's playful noise that ages badly and reads as a toy).

## Springs

- Springs shine for **drag, momentum, interruptible, or decorative** motion. Their key property:
  **they preserve velocity when interrupted** — a CSS transition restarted mid-flight snaps and
  retargets, a keyframe animation restarts from zero, but a spring continues naturally from its
  current speed.
- Keep **bounce low (0.1–0.3)**; a typical config is a ~0.5s duration with ~0.2 bounce. High bounce is
  the elastic tell again.

## Component techniques

- **Never animate from `scale(0)`** — start at `scale(0.95)` with opacity 0. From zero it pops and
  warps; from 0.95 it grows into place.
- **Origin-aware popovers**: a popover should scale/fade *from the element that opened it*
  (`transform-origin` set to the trigger). Modals are the exception — they stay centered.
- **Buttons: `scale(0.97)` on `:active`** for tactile press feedback.
- **Transitions over keyframes for anything interruptible** — a hover that can reverse, a toggle. Use
  keyframes only for fire-and-forget, looping, or multi-step motion.
- **Mask imperfect crossfades with a small blur** (`filter: blur(2px)` during the transition; keep it
  <20px — it's costly to render). Hides the moment two mismatched layers cross.
- Use **`@starting-style`** to animate an element's entrance from `display: none` / freshly mounted.

## Gesture & drag

- Dismiss on **velocity** (a flick past ~0.11 px/ms), not just distance.
- Apply **boundary damping** (resistance/friction near edges) rather than a hard stop.
- Use **pointer capture** so a drag doesn't drop when the pointer leaves the element; guard against
  multi-touch interfering mid-gesture.

## Performance

- **Only animate `transform` and `opacity`.** Animating width/height/margin/padding/top/left forces
  layout on every frame and stutters. Transform and opacity are GPU-composited.
- A transform passed as separate `x`/`y` shorthands (some animation libraries) may **not** be
  hardware-accelerated — use a full `transform` string when you need the GPU path.
- CSS variables are **inheritable** — animating one on a parent can thrash every child that reads it;
  scope the animated var tightly.
- Under load, **CSS animations beat JS-driven ones** (they run off the main thread). Use the Web
  Animations API when you need programmatic control.

## Accessibility

- **Always respect `prefers-reduced-motion`.** Reduced motion means *fewer and gentler* animations
  (and no large movement / parallax), **not zero** — a quick opacity fade is still fine. Don't strip
  all feedback.
- Gate hover-only affordances behind `@media (hover: hover) and (pointer: fine)` so touch users aren't
  left with dead states.
- **Don't drive scroll animation off a `scroll` event listener.** Use `IntersectionObserver` or
  scroll-driven timelines — the listener approach janks and runs every frame.
