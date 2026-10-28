# The board's geometry is read on a readiness signal, not on two agreeing reads 120ms apart

Card `4756e252`, discovered from card `5de98210`. Anchored from
`packages/web/e2e/atlas-board-dialog.spec.ts` (`boardReadyForGeometry`). Sibling to card `885e7a49`,
whose `data-nt-measuring` flag this reuses.

## The defect

Card `5de98210` put BOTH sides of `atlas-board-dialog.spec.ts`'s no-reflow compare through one
`settledBoardGeometry` helper, which settles when two reads taken 120ms apart agree. Its own worker
flagged the residual this card closes: **self-consistency over a 120ms window settles on any
intermediate state that merely outlives that window.** It cannot tell "the layout is finished" from
"the layout is between two stable phases", so the `before` baseline can be captured from a state the
page later leaves — and the open-leg compare then reports a reflow that never happened.

## What actually holds still and then moves

`styles/global.css` imports Google Fonts from the CDN with `display=swap`. The browser paints with the
fallback faces at once and **re-lays-out when the real faces land**, over two chained network hops
(`fonts.googleapis.com` CSS, then the `fonts.gstatic.com` woff2 files). The two blocks directly above
the board grid — `NewTask` and `FilterBar` — grow by 2px each at the swap, measured `73 -> 75` and
`25 -> 27`, and the whole board shifts down with them.

Instrument: an in-page `setInterval(16)` census installed via `addInitScript`, recording the
`.loom-board-grid` rect, lane count, the skeleton class, `data-nt-measuring`,
`document.fonts.status`/`.check()`, and the height of **every** preceding sibling up the ancestor chain
to `<main>`, so a shift attributes to whichever block grew. It samples at task granularity, which is
deliberately coarser than paint and finer than `page.evaluate` — the asymmetry card `885e7a49` named.

Three legs, two runs each, at 1600x1000:

| leg | measured |
| --- | --- |
| natural | the woff2 requests *completed* at 4180/4199ms and 4572/4594ms after navigation |
| fonts **aborted** | the board renders at **y=148** and stays there for the whole 3s dwell |
| fonts **delayed 1200ms** | the pre-swap **y=148 persists 1213ms / 1196ms**, then jumps to y=152 |

⚠️ Read the natural row as a **completion timestamp, not a latency**. A face is requested only when it
is first *used*, so a slow first render pushes that timestamp out without the fetch itself being slow;
the cold-cache control below measures the fetch instead, and gets **103-179ms across 24 fetches** on
this host. The window is therefore normally tens to low hundreds of ms — close enough to the 120ms
settle quantum to flake rather than fail outright, and wider on a slower network.

The aborted leg is the polarity control: remove the condition and the shift is gone, permanently. The
delayed leg is the magnitude: the intermediate state outlives the 120ms settle window by 10x.

### A second, larger mover in the same helper

`BoardSkeleton` (`pages/Board.tsx`) reuses the `.loom-board-grid` class for the first-load placeholder,
so `boardGeometry`'s own locator matches it: measured **y=30 against the real grid's y=152, a +122px
shift**, held for 98-251ms. Before this card the only thing excluding it was the *caller's*
`toHaveCount(DEFAULT_LANES)` gate — the helper itself was safe only by virtue of where it was called
from, which is the defect, not a mitigation. The guard now lives in the helper. The callers keep their
own lane assertion: `DEFAULT_LANES` pins the board layout, the helper's `not.toHaveCount(0)` only asks
whether the query resolved at all, and those are different claims.

## Why `document.fonts.ready`, and why not the obvious alternatives

- **`document.fonts.status` is unusable.** Measured: in the aborted leg it reads `"loaded"`, because the
  failed `@import` declares no `@font-face` rules and so nothing is pending. It also flips back to
  `"loading"` later in the same page, when opening the dialog first uses a new weight.
- **`document.fonts.check()` is unusable.** Measured: in the aborted leg it returns `true` for both
  families. `check()` asks whether all *matching* faces are loaded; with no face matching, it is
  vacuously true. Neither call can separate "the fonts are here" from "the fonts can never arrive".
- **`document.fonts.ready` is sound in both directions.** It resolves once the currently-pending loads
  settle, and resolves immediately when the CSS failed — which is correct, because no swap is coming.
  It also **re-arms** when a later face starts loading, which is why it is awaited before *every*
  sample rather than once up front.

Readiness decides only WHEN the first sample may be taken. Settling is still on self-consistency and
never on agreement with `before`, so a genuine reflow settles on its new box and still fails the 0px
compare. The compare itself is untouched, and no sleep or timeout was added or lengthened.

## The controls, per leg

A permanent shift reddens the old and the new helper alike, so it cannot distinguish "strengthened"
from "loosened" — card `5de98210`'s lesson. Only a **transient** the old helper fails and the new one
passes shows a false positive being suppressed. Both were run, each leg on the real spec.

The transient is injected by holding the gstatic woff2 until the board has rendered, then 300ms longer,
pinning the swap into the window between the `before` read and the `after` read. That is fair by
construction: the request is **pending** throughout, so `fonts.ready` can anticipate it. A hold
released by the dialog opening would be a transient that no readiness signal could anticipate, and a
split against it would prove nothing about this change.

Every leg below ran the **real spec** — all four surfaces, `--repeat-each=3`, 12 executions per cell.
The only variable between the two columns is whether `settledBoardGeometry` awaits
`boardReadyForGeometry`; the injections are identical.

| leg | old helper | new helper |
| --- | --- | --- |
| **transient** (late webfont) | **12/12 RED** | **12/12 GREEN** |
| **permanent** (+60px on open) | **12/12 RED** | **12/12 RED** |
| clean (no injection) | 20/20 GREEN | **12/12 GREEN** |
| cold HTTP cache | not run | **12/12 GREEN** |

The transient row is the whole proof: same injected condition, opposite verdicts. All 12 old-helper
failures land at the open-leg compare, on all four surfaces, with the font swap's own signature —
y `786 -> 791`, `280 -> 285`, `300 -> 305`, `148 -> 152`. The permanent row is the anti-loosening
check: the new helper still reddens, at y `285 -> 345` and `791 -> 851`.

The cold-cache leg clears the HTTP cache over CDP (`Network.clearBrowserCache`) before each test
rather than assuming a fresh context is cold, and asserts the fetch really crossed the wire: 24 woff2
fetches, **103-179ms each**, none a cache hit.

## Do not

- **Do not reduce any readiness check to a one-shot gate before the sampling loop.** `fonts.ready`
  re-arms for a face that starts loading later, and that is the state the gate exists to catch.
- **Do not substitute `document.fonts.status` or `document.fonts.check()` for `document.fonts.ready`.**
  Both were measured returning a ready answer while the fonts had failed outright.
- **Do not loosen the 0px `toEqual` compare, and do not settle on agreement with `before`** — either
  change makes every reflow leg unfalsifiable. Wait on readiness, never on the geometry under test
  (the same rule card `885e7a49` states for the tab block).
- **Do not remove the skeleton guard on the grounds that the callers already assert the lane count.**
  A helper that is safe only because of its caller is what this card fixed.
- **Do not treat `data-nt-measuring` here as evidence from this card.** It is precautionary, carried
  from card `885e7a49`; this card's own 16ms census never observed it set.
- **Do not cite the `4a0ad464` sighting as explained by this mechanism.** It was never reproduced
  naturally, on this build or any other; the resemblance is a shape match and no more.

## What is NOT claimed

The `4a0ad464` sighting (Board node, `before` y=281 against y=287 at the open-leg compare) is **not
attributed to this mechanism**. It was seen on a different build and was never reproduced naturally
here. The injected transient fails at the same leg, the same compare, and in the same direction and
magnitude class — y 280 -> 285 — which is a **shape match and nothing more**; no mechanism was
established for the original sighting, and none is asserted.

The natural-reproduction attempt is likewise recorded at its true strength: the spec was **not
reproduced red in any clean trial** — 20/20 on the old helper, 12/12 on the new, plus 12/12 with the
cache explicitly cleared. That **clears nothing**. A null at an unmeasured rate is not a clearance, and
the verdict here rests on the transient split and the aborted/delayed polarity pair, never on these
greens. What the cold-cache leg does add is that the greens are no longer suspect for the reason
originally feared: the font fetch was confirmed cold in all 24 cases, so these were real trials of the
race rather than warm-cache runs that could never have shown it.

## Related

- Card `885e7a49` — `docs/decisions/885e7a49-atlas-tab-block-geometry-read-waits-for-a-settled-pass.md`:
  the same "wait on the component's pass flag, never on the geometry under test" rule, and the origin
  of `data-nt-measuring`.
- Card `5de98210` — put both sides of the compare through one helper, and filed this residual.
- The CDN font import itself is a product-side offline/latency dependency in a loopback-only app;
  `styles/global.css` already flags self-hosting it as a follow-up. That is a separate card, and this
  one deliberately does not touch it.
