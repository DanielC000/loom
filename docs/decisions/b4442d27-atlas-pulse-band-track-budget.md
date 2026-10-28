# b4442d27 — the Atlas dashboard band's track budget, and why Pulse is not a 1fr

The Atlas dashboard band (`.loom-atlas-band`, `packages/web/src/styles/global.css`) lays five panels across one line on both Atlas home nodes — Workspace (`pages/WorkspaceHome.tsx`) and project (`pages/ProjectHome.tsx`, behind card `44f725fe`'s disclosure). Its fifth panel is **Pulse** on both. This record is why that fifth track is a weighted track with a hard pixel floor rather than one of three equal `1fr`s, and why the band was not wrapped instead.

## The defect

Card `a7957bde` fixed the *row*: `EventRow` (`components/fleet.tsx`) is a four-column row — an un-shrinkable 72px timestamp, then a project chip, the event kind, and a worker/task detail — and that card gave the three shrinkable columns a fixed give-up order so the row stops overflowing its box. It could not make the box wider, and its own closing measurement named the band as the remaining defect: the Pulse column's **tightest** width is at desktop, not at phone width.

Measured on the pre-fix build (`repeat(3, minmax(0, 1fr))` for tracks 3–5), Workspace node, Pulse panel body width and the row columns inside it:

| viewport | content col | Pulse col | Pulse body | kind box | project chip CONTENT |
|---|---|---|---|---|---|
| 1280 | 1036 | 168 | 142 | **33.73** of 144 | **0.00** |
| 1440 | 1196 | 196 | 170 | **61.80** of 144 | **0.00** |
| 1920 | 1676 | 280 | 254 | 143.86 of 144 | **2.14** |

At 420px phone width the band folds to one column and Pulse gets ~354px — **wider than any desktop width gave it.** That inversion is why this never read as a narrow-width bug and why it survived two cards that looked at the row.

The chip readings are the load-bearing ones: ~10px of content box is the chip's own `min-content` (5px padding each side), i.e. a 12px empty bordered box rendering *no project name at all*. Every other panel in the band degrades by ellipsis against a `title` tooltip; Pulse degraded to an unreadable row, not a truncated one.

## The band is genuinely over-subscribed — this is an allocation decision, not a bug fix

Each panel's appetite was measured directly (a census of every `white-space: nowrap` box inside each panel whose `scrollWidth` exceeds its `clientWidth`), with **every panel populated** — including a seeded live `platform` + `assistant` session, because `OperatorList` renders an empty state otherwise and a census of an empty panel cannot say whether its content fits:

| panel | body px needed | notes |
|---|---|---|
| Needs you | **unbounded** | a real attention title measured 929px natural; it truncates by design at every width, so no width satisfies it |
| Operators · Agents | ~286 | a 158px agent name plus role badge and live pill (card `c6160c7d`) |
| Gate lanes · Fleet | ~185 | the `running·queued` meter label plus a 110px track and the `cap N` value |
| Plan usage | ≤142 | **clips nothing at any width measured** — the lowest appetite in the band |
| Pulse | 255 min · 328 comfortable · 479 full | 72px timestamp + chip + kind + detail, all additive |

Summing the *minimum acceptable* set gives ~1168px of band. The band has **1156px at 1440 and 996px at 1280.** So five-up cannot satisfy all five panels at either width, and the track weights are a budget that says which panel gives first — not a statement of what each one wants.

Pulse goes first because its appetite is the only one that is **bounded, additive, and satisfiable**, and because its failure mode was categorically worse than its neighbours'.

## What shipped

```css
grid-template-columns:
  minmax(0, 1.7fr) minmax(0, 1.3fr) minmax(0, 0.9fr) minmax(0, 0.8fr) minmax(300px, 1.9fr);
```

Measured after, Workspace node (same fixture, same build):

| viewport | Pulse col | Pulse body | kind box | chip CONTENT | Needs | Operators | Gates | Plan |
|---|---|---|---|---|---|---|---|---|
| 1280 | 300 | 274 | **143.89** | **22.11** | 237 | 181 | 126 | 112 |
| 1440 | 321 | 295 | **143.94** | **43.33** | 287 | 220 | 152 | 135 |
| 1920 | 459 | 433 | **144.00** | **77.75** | 411 | 314 | 218 | 193 |

Same fixture and same build on both tables; the chip column is directly comparable, 0.00 → 43.33 at 1440.

The shortfall lands where the census says it costs least: **Plan usage** gives the most (−61px at 1440) and still clips nothing at any width; **Gate lanes** gives 44px and keeps its `cap N` figure in the panel head and in the head count. **Operators** gives 25px at 1440 and 36px at 1920 — its weight went *up* (1.25 → 1.3) but the budget could not hold it flat; see the residuals below. **Needs-you** was the one track that had to grow.

### Why Needs-you went UP, not down (card `d0d430d4`'s guard)

The first draft of this budget took 43px off the Needs track at 1440 and reddened `atlas-band-row-shape.spec.ts`: its attention row went from 64px tall to 85px at 1600×1000, against that spec's `<= 80` guard. The cause is the compact row's HEAD line (kind badge + title) wrapping to two lines once the panel body drops below ~300px — **not** its action cluster.

Measuring the pre-fix build settled what that meant: the head line **already wrapped at 1280 (217px of body) and 1440 (258px)**, where `d0d430d4` never asserted. That guard only ever held at 1600 and 1920, and the first draft pushed 1600 across the same boundary.

So the Needs track is sized to **at least its pre-fix width at 1600** — the width `d0d430d4` actually pins — which `1.7fr` delivers (329px against 325px before). The guard's threshold was deliberately left alone: it is another card's defect boundary, calibrated against a 500px row, and widening it to admit this change would have traded a real guard for a convenient pass.

### The 300px floor is a measured threshold, not a round number

The project chip shrinks 1000× harder than the kind, so it only leaves `min-content` once the kind is **already** fully satisfied. That makes the chip a direct read on *surplus*: it needs 72 (timestamp) + 24 (three gaps) + 144 (kind) + ~13 = **~255px of body**, i.e. ~281px of column, before it can show a single character. 300px is that threshold plus margin.

The floor binds only below ~1300px viewport — at 1440 the 1.9fr share is already 339px and the floor is inert. Its job is to stop the catastrophic narrow-desktop case (the 1180–1300px range just above the band's own `auto-fit` fold), not to set the column's width.

## Do not

- **Do not return the fifth track to a bare `1fr`, and do not remove its `300px` floor.** At `1fr` the band gives Pulse less room at 1440 than the phone layout gives it at 420.
- **Do not take the floor's width back for a neighbouring column.** The floor is the chip-off-its-floor threshold; shaving it re-opens the exact defect, silently, because an over-shrunk chip renders as a plausible-looking small box rather than as a visible break.
- **Wrapping the band to a second row is no longer ruled out — see "The wrap ruling, amended" below.** It is still not what this card did, and it should not be attempted without the measurement that section asks for.
- **Do not re-tune tracks 3 and 4 for one node's content.** They are *Gate lanes · Plan usage* on the Workspace node but *Fleet · Gate lanes* on the project node, from one shared declaration. Only tracks 1, 2 and 5 hold the same panel on both.
- **Do not add a `max-width` cap to the Pulse track.** Above ~1600px the row reaches full fidelity and leaves trailing space, which is ordinary for a log and is what every other width already does to the detail column.

## The kind still loses its last glyph, and the band cannot fix it

⚠️ **`scrollWidth`, `clientWidth` and a `Range` are all blind to this, and the first two are what a census would naturally reach for.** For an ellipsised `overflow: hidden` flex item they report the *already-ellipsised* integer width, so they read "144 of 144, fits" on a box that is visibly truncating. Measured with a canvas text metric in the element's own resolved font instead, at 1440 on the shipped build:

| column | content box | natural text | short by | flex-shrink |
|---|---|---|---|---|
| time | 72.0000 | 72.0000 | 0 | 0 |
| project chip | 61.2812 | 78.0000 | +16.72 | 1000 |
| **kind** | **143.9688** | **143.9999** | **+0.0312** | 1 |
| detail | 0.0000 | 151.1999 | +151.20 | 100000 |

The kind is short by **1/32 of a pixel** — and that is enough to ellipsise its final character. The cause is that flex shrink is distributed **proportionally across every shrinkable column at once**, not in strict priority order: with the row 151px over, the kind's share is `(1 × 144) / (1×144 + 1000×78 + 100000×151.2)` ≈ 0.001% ≈ 0.03px. It is a property of `EventRow`'s own weights (card `a7957bde`), it is present at **every** width where the row overflows at all — including 1920, where the detail column is still 22px short — and **no band track width removes it**: widening the track hands the surplus to the chip, and the kind keeps its proportional sliver.

Deliberately **not** fixed here. `EventRow` is shared by six mounts and card `a7957bde`'s record forbids flattening its shrink weights; this card's scope is the band's track budget. What this card did fix is the 82px clip — the kind's box went from **61.80px** of 144 to **143.97px** of 144. The spec's tolerance is 0.5px, sized to let the residue through while still failing that 82px clip.

## The wrap ruling, amended (card 4a0ad464 landed 2026-10-28)

**One of the three grounds this card rejected a wrapped band on has since been falsified, and it was the strongest one.** The original ruling read: `.loom-bandpanel`'s fixed 320px height is what makes the band a band; the Workspace node has **no disclosure to fold**, so a second row costs ~330px directly above the Projects grid; and a 3-up fold forces Pulse to either ~767px of mostly dead space or a blank grid cell.

Card `4a0ad464` then gave the Workspace node exactly the disclosure that ground assumed it would never have (`BandDisclosure`, the same D1 shape `44f725fe` gave the project node). **That premise is dead. Recording it rather than quietly re-deriving the same conclusion on new grounds.**

What survives, and how strongly:

| ground | status |
|---|---|
| The fixed 320px panel height is what makes the band a band rather than five columns of unequal length | **Holds.** Independent of any disclosure. |
| A second row costs ~330px above the node's primary content | **Weakened, not dead.** `useDashboardOpen` defaults to OPEN (absent storage key ⇒ open), so the cost is still paid by default and by every first-time reader; it is now *escapable* in one persisted click rather than unavoidable. Opt-out, not absent. |
| A 3-up fold gives Pulse either ~767px (a 479px row with 262px of dead space) or a blank grid cell | **Holds.** Pure grid arithmetic over five panels. |

⇒ **Softened from a prohibition to a precondition.** A future card MAY wrap this band. It should not do so on the strength of this record's original reasoning, and it should bring three measurements this card did not need: how often the disclosure is actually folded in practice, what a two-row band does to the Projects grid's own above-the-fold position at 1280 and 1440, and whether a wrapped Pulse at ~767px reads better or worse than the 321px budgeted column it would replace — the dead-space question is a judgement a screenshot answers and arithmetic does not.

⛔ **What does NOT change either way:** the Pulse track's `300px` floor and its additive appetite. Those are properties of `EventRow`, not of how many rows the band has, and a wrapped band would still need them on whatever row Pulse lands on.

## Known, measured, and deliberately not closed

- **Needs-you still truncates at every width** (929px natural against 215px of body at 1440). Unbounded by construction; the full text stays reachable via the row's `title`.
- **Gate lanes' `running·queued` meter label is cut to ~13px at 1440** (from ~19px before this card). Pre-existing — it needed ~21px and never had it at this width — and marginally deepened here. The `cap N` figure it sits beside is `flex: none` and still renders, and the panel head carries the same count.
- **Operators' agent name clips harder.** Measured against a deliberately long 158px fixture name: 1920 goes from unclipped to 124px shown; 1440 from 54–91px to 30–66px; 1280 from 19px to ~0–27px. The fixture name is longer than any real operator's — a live `Platform Lead` measures ~98px — but this is the single largest cost this card imposes, and it is on the column card `c6160c7d` exists to protect. It was given the band's second-largest weight and still gives 25px at 1440; the band had no slack left that did not come out of a worse place.
- **At 1280 the Operators name was already effectively unreadable** — 19px of a 158px name on the pre-fix build. That column is past `c6160c7d`'s own stated threshold at 1280 and 1440 on the pre-fix build; this card neither created nor closed that.
- **The Needs-you head line still wraps at 1280 and 1440** (rowH 85 against the 64 it reaches at 1600+). Pre-existing, unchanged by this card, and unasserted — `d0d430d4`'s own spec tests 1600 and 420 only.
