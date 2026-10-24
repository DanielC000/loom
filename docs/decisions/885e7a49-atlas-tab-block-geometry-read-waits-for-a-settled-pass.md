# The Atlas tab block's geometry is read only once the measuring pass has settled

Card `885e7a49`, discovered from card `485d67b4`. Anchored from
`packages/web/e2e/atlas-node-tab-overflow.spec.ts` (`blockGeometry`) and
`packages/web/src/components/atlasHome.tsx` (`data-nt-measuring`).

## The symptom

Card `485d67b4`'s worker saw `atlas-node-tab-overflow.spec.ts`'s leg 1 — "switch ON at 1440: the
project and Workspace blocks are ONE line, strip and all" — fail **once** on unchanged `HEAD` with
exactly two offenders:

```
workspace: block 74px, one line is 35px
workspace: the strip is not on the row's line
```

It did not recur in 40 later runs, and 0 of 20 further runs reproduced it on this card either. A
0/20 null at a ~2.4% true rate has P ≈ 61% of coming out clean, so **neither null cleared it** — the
question had to be settled by mechanism, not by repetition.

## The two candidate mechanisms, and why the offender SET discriminates them

`NodeTabs` deliberately draws every tab plus the trigger while measuring (`rowTabs = tabs` whenever
`layout.measure`) — that is how the per-chip widths are captured, and why there is no hidden mirror
of the row in the DOM. During such a pass the row holds all 10 tabs, which at 1440 still fits one
line (693–715px in a 1156px column), but the ~686px KPI strip then cannot fit *beside* it and wraps
underneath.

That predicts a very specific offender set: `blockH` 74 against a 35px line, the strip off the row's
line, **`rowTops` still 1**, and the trigger still on the row's line. The observed failure named
exactly those two offenders and no others — i.e. the row itself never wrapped. A rival mechanism (a
layout that *settled* on a wrong fit, e.g. widths captured before a late webfont widened the chips)
produces the same two offenders but is **persistent and user-visible**, so the offender set alone
could not separate them. Duration could.

## Measured: the wrap is never painted

A rAF sampler installed via `addInitScript` censused every painted frame of `.loom-atlas-tabs`
geometry — `blockH`, the derived `oneLineH`, `rowTops`, whether the strip shares the row's vertical
centre, and whether the wrap carried `data-nt-measuring` — over 24 loads (`/board` and
`/home?tab=gates`, 1440×1000, 2.5s dwell each).

**0 wrapped frames in 3,744 painted frames.** React flushes the settle scheduled from
`useLayoutEffect` synchronously at the end of the commit, before the browser paints, so the
measuring tree exists only inside that commit.

### Two controls, because that is an absence claim

A bespoke probe on card `485d67b4` already returned a false 12/12 green against reverted source, so
the instrument's sensitivity was proven rather than assumed:

1. **Reader control** — the same probe at 720px, where the block genuinely wraps: **158/158 frames
   flagged**, reporting `blockH 74, oneLineH 35, stripOnLine false`, the reported signature.
2. **Mechanism control** — `useLayoutEffect(() => { recomputeRef.current(); })` changed to defer the
   settle by one `requestAnimationFrame`, so a measuring pass survives to paint. The probe then
   caught it as **isolated single frames** (2–3 per load, `durMs` 0, `frames` 1), each carrying
   `blockH:74, oneLineH:35, rowTops:1, tabs:10, stripOnLine:false, measuring:true`. Sensitivity is
   therefore proven at **one-frame granularity** — finer than any window this defect could occupy.

Under that same mechanism control the real leg failed **3 of 10 runs**, reproducing the original
offender pair byte-for-byte. With the fix below in place and the control still applied it ran
**10/10 green** — a clean split, and a far stronger signal than the 0/20 baseline.

## The verdict, and the limit on it

**A test race, not a product defect.** The transient wrap is never painted, so no user can see it.

⚠️ Scope that claim precisely: the probe samples at rAF, which is pre-paint but *post*-task, so its
zero proves the **paint-visible** window is empty — it does not prove the **evaluate-visible** window
is, and a Playwright `page.evaluate` is its own task. That asymmetry is the whole finding: the state
is reachable by an instrument that can land between tasks and unreachable by a human looking at
pixels. The production trigger for the single observed sighting was not identified, and is not
claimed here.

## The fix

`blockGeometry` waits for `data-nt-measuring` to be **absent** before it reads, via `expect.poll`
over the attribute — no fixed sleep and no lengthened timeout, one extra evaluate on the settled
path. All seven geometry reads in the spec funnel through that one helper.

`data-nt-measuring` is rendered on `.loom-atlas-tabs` only while `layout.measure` is true. Nothing
about the rendered layout depends on it.

## Do not

- **Do not wait on the geometry this spec asserts** — e.g. polling until `blockH === oneLineH`. A
  layout that settled on a *wrong* fit still wraps and must still fail these legs; keying the wait on
  the assertion would make them unfalsifiable. The wait is on the component's own pass flag, which is
  independent of the figures under test.
- **Do not read this block's geometry on a bare `toBeVisible()`**, here or in a sibling spec.
- **Do not cite the 0/20 before-count, or the 0/3,744-frame census, as evidence the race does not
  exist.** Both are nulls; what rules the *product defect* out is the proven-sensitive instrument
  behind the census, and what rules the *race* in is the 3/10 reproduction under the mechanism
  control.
- **Do not delete `data-nt-measuring`** believing it to be unused: it has no runtime consumer by
  design, and the spec waits for its absence.
