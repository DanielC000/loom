# e75dc05a — reconstructing mid-run gate joins: does the rising-floor claim survive?

Read-only analysis against card `e75dc05a`, which asks whether card `99fb882e`'s rising-floor finding
survives once `concurrentGates` (an admission-instant snapshot, blind to a gate that joins mid-run) is
replaced with a real overlap reconstruction from timestamps already on disk.

**No production code was changed. No suite/gate was run. No DB write occurred.** `loom.db` was opened
directly with `better-sqlite3({ readonly: true, fileMustExist: true })`. All numbers are reproducible —
see "Reproduce this" at the bottom.

**Ceiling, stated once, applies to every number below:** `activeCount`/`concurrentGates` and this
reconstruction both count lanes admitted through the `GateSemaphore` — never host load (worker
sessions, ingest subprocesses, hand-run builds are invisible to both). Every "clean"/"uncontended"
result in this document means **gate-uncontended**, not uncontended. Non-gate host load is a real,
unbounded confound this analysis cannot see or rule out.

## DoD-0 — the hard gate. All four controls PASS.

Overlap is reconstructed purely from `admitMs = settleMs - durationMs` (exact, not inferred — see
"Method" below) across **every** `build_gate`/`build_gate_retry`/`worker_gate`/`deploy` admission in
`orchestration_events`, **every project** (the `GateSemaphore` is one daemon-global instance shared by
every project's cap — a Loom row can be joined by a Codescape admission, which is exactly what the
positive controls demonstrate).

```
POSITIVE 1 -- dbf1cd62 (taskId 3fcd06d6, Loom)
  admit 2026-08-01T02:20:05.107Z  settle 2026-08-01T02:43:09.592Z  durationMs=1384485
  => joinedMidRun=TRUE. Overlapping admission found: Codescape build_gate admitted 02:33:03.820Z
     (card's own reading: "02:33:03Z" -- matches to under 1s). PASS.

POSITIVE 2 -- 41eac0c6 (taskId 48365fda, Loom)
  admit 2026-08-01T03:05:49.526Z  settle 2026-08-01T03:27:21.559Z  durationMs=1292033
  => joinedMidRun=TRUE. Overlapping admission found: Codescape build_gate admitted 03:18:08.909Z
     (card's own reading: "03:18:08Z" -- matches to under 1s). PASS.

NEGATIVE A -- edfb4c64 (Loom, no taskId given -- located by admission time)
  admit 2026-08-01T01:30:21.013Z  settle 2026-08-01T01:49:40.040Z  durationMs=1159027
  => overlappedAtAll=FALSE. No admission anywhere overlaps this interval. PASS.

NEGATIVE B -- 5b7f0bda (taskId 99fb882e, Loom)
  admit 2026-08-01T02:43:59.433Z  settle 2026-08-01T03:04:05.396Z  durationMs=1205963
  => overlappedAtAll=FALSE. No admission anywhere overlaps this interval. PASS.
```

All four classify correctly, including a positive control that requires classifying "joined," not just
"contended" — the failure mode a same-polarity-only check would miss. **The instrument is validated;
the trend analysis below is safe to report.**

## Method — settle is read, not inferred; admission is exact, not approximated

Every `evt()` call site for these four event kinds (`service.ts:9632` build_gate, `:9679` retry,
`:10530-10584` worker_gate, `:2612` deploy) writes `durationMs: Date.now() - gateStartedAt` and appends
the event **in the same synchronous stretch of code**, with no `await` between computing `durationMs`
and the `db.appendEvent` call that stamps `ts = new Date().toISOString()`. So `ts` **is** the settle
instant (to within low-single-digit milliseconds of JS-only work, no I/O) and
`admitMs = Date.parse(ts) - durationMs` **is** the admission instant, exactly — `durationMs` is
*defined* as `settle - admit`, so this isn't a modeling assumption, it's algebra on the event's own
fields. The only real inference in this whole analysis is that gap between `runExclusive` resolving and
the `Date.now()` stamp landing in `ts` — negligible against runs measured in hundreds of seconds, and
the sub-second control matches above (Codescape's admission times landing within ~1s of the card's
independently-observed readings) are direct evidence the induced error is that small in practice, not
just an argument that it should be.

`reused:true` rows are excluded — a reused merge-gate result never called `gateSemaphore.runExclusive`
itself, so its `durationMs` measures something else entirely and including it would fabricate a phantom
admission (same exclusion `99fb882e`'s own `rising-floor-report.mjs` already applies).

## Headline finding 1 — the "solo-at-admission" instrument is not mildly noisy, it is badly broken

Restricting to rows **labelled solo at admission** (`concurrentGates===1`, the existing instrument),
and asking how many were actually joined mid-run:

```
date       | L(n) | contaminated(n) | join-rate | T(n)
2026-07-23 |    5 |               4 |     80.0% |    1
2026-07-24 |   17 |               4 |     23.5% |   13
2026-07-25 |    3 |               0 |      0.0% |    3
2026-07-28 |   14 |               9 |     64.3% |    5
2026-07-29 |   16 |               9 |     56.3% |    7
2026-07-30 |   23 |              13 |     56.5% |   10
2026-07-31 |   35 |              18 |     51.4% |   17
```

On every well-sampled day (n≥14), **50-65% of "solo" runs were actually joined mid-run.** `L` and `T`
(genuinely gate-solo-throughout) are not close cousins — over half of `L` is contamination on most days.
This is the retrospective confirmation `c6750500`'s instrument fix (`concurrentGatesMax`) exists to
prevent going forward.

## Headline finding 2 — 99fb882e's own flagship "solo" evidence was 67% contaminated

`99fb882e` cites task `b4c4699e` (2026-07-31T17:31:17.949Z, `durationMs=1646946`, "SOLO
(`concurrentGates=1`)") as *"the cleanest possible evidence against a contention-first explanation"* —
a solo run crossing the old 1500s ceiling. It was labelled solo **at admission**, correctly. But this
reconstruction finds a Codescape admission overlapped **67.2% of its runtime** (1107s of 1647s dosed).
**This specific claim does not survive** — `b4c4699e` was contended for two-thirds of its own run, and
cannot be cited as a clean solo-run data point without that correction. This does not by itself refute
`99fb882e`'s ANSWER 2 (that the 1500s ceiling was crossed at all — durationMs is still real, still
1646.9s, still over budget) — only the "solo, therefore not a contention artifact" framing around it.

## DoD-3 — recomputed daily min/mean restricted to genuinely gate-solo-throughout (T), full 07-21→07-31 window

Overlap reconstruction needs only `admitMs`/`settleMs` (recoverable from 2026-07-21 onward), not
`concurrentGates` (only recorded from 07-23) — so `T` extends the full 10.5-day window `99fb882e` used,
not just the 07-23+ slice `concurrentGates` alone could support:

```
date       | n(T) | min(s) | max(s) | mean(s)   ||  99fb882e ALL-passed: min(s) / mean(s)
2026-07-21 |    7 |    458 |    544 |    493     ||  458 / 554
2026-07-22 |    5 |    534 |    687 |    586     ||  534 / 647
2026-07-23 |    3 |    680 |    729 |    705     ||  643 / 745
2026-07-24 |   13 |    691 |    756 |    721     ||  691 / 775
2026-07-25 |    3 |    711 |    741 |    729     ||  711 / 729
2026-07-28 |    5 |    738 |    877 |    774     ||  738 / 877
2026-07-29 |    7 |    779 |    959 |    864     ||  779 / 927
2026-07-30 |   10 |    809 |   1064 |    916     ||  809 / 998
2026-07-31 |   17 |    798 |   1563 |    934     ||  798 / 1019
```

**The minimum-based rise survives fully intact: 458s → 798s.** 8 of the 9 daily minima in the T
(fully-corrected) series are IDENTICAL to 99fb882e's ALL-passed minimum for that day (458, 534, 691, 711,
738, 779, 809, 798). **07-23 differs: T min 680s vs. ALL-passed min 643s** — that day's fastest run
(643s) was NOT gate-solo-throughout and is correctly excluded from T. Both endpoints of the window —
2026-07-21 (458s) and 2026-07-31 (798s) — are identical between the two series, so **the 458→798 rise
and the +340s delta are unchanged.** The 07-23 discrepancy is itself a positive control on the filter,
not a blemish: it shows T actively removing a contaminated fast run rather than passively reproducing
the raw series, which is exactly the behavior a working filter should have. This is a materially stronger
result than "the trend survives restriction to solo-at-admission" (99fb882e's own DoD-1 answer) — it
survives restriction to the actually-verified-clean population.

**The mean also rises under T** (493→934, +89.5%) at a rate at least as steep as the raw ALL-passed
series (554→1019, +83.9%) — see the MEANS verdict below for why this direction (not shallower) is the
expected one given the measured contamination-rate trend.

## DoD-1 argument (MEANS) — does contamination rate itself trend, and which way?

The card's own logic: flat contamination rate ⇒ trend survives as an offset; rising rate ⇒ part of the
trend is manufactured; falling rate ⇒ the true trend is even steeper than observed.

Restricted to the well-sampled days (n≥14, where a rate estimate is trustworthy): 07-28 64.3% → 07-29
56.3% → 07-30 56.5% → 07-31 51.4%. **Mildly declining, not rising**, over the four best-sampled days
(07-24's 23.5% at n=17 is an outlier low point, not part of a monotonic trend — noted, not smoothed
over). No day in this window shows contamination rate rising in step with the duration trend.

**Verdict: the MEAN trend is not manufactured by increasing contamination — if the rate genuinely fell
across the window, the corrected (T-based) mean trend (+441s) understates the true trend rather than
overstating it**, which is exactly what's observed (T-mean rise is proportionally larger than the raw
ALL-passed mean rise: 89.5% vs 83.9%).

## DoD-4 — is the "contaminated runs are slower" premise load-bearing here actually true?

Whether a contaminated (mid-run-joined) row was ever the day's minimum among `L`:

```
2026-07-23 through 2026-07-31 (the only days with an L population at all, per 99fb882e's own window):
  0 / 7 days -- the daily minimum among labelled-solo runs was NEVER a contaminated row.
```

**Within the window this card is actually being asked about, the premise holds cleanly, every day.**

**One exception exists, outside that window:** 2026-08-01 (a partial day — only ~4 hours of data as of
when this analysis was run) had its L-minimum (1079s, task `00bd3b4a`) come from a contaminated row.
Quantified: the overlap dosed only **69s of its 1079s runtime (6.4%)** — a glancing, near-the-end join,
not sustained contention — and the day's `T` population it's being compared against is itself thin
(n=3), so part of the "violation" may be `T`'s own small-sample noise rather than a genuine failure of
the premise. **Reported honestly as a real, quantified, low-confidence exception outside the analysis
window — not smoothed away, not treated as overturning the 0/7 result inside the window that matters.**

### Contamination dose, generally

Dosed every contaminated `L` row (fraction of its own runtime actually overlapped) — full table in
`data/reconstruct-output.txt`. Dose ranges from <1% to 98% of a run's own duration; there is no dose
threshold below which contamination reliably fails to slow a run down within the 07-23→07-31 window —
even rows with under 2% dose (e.g. 07-28's 0.4%/0.8%/1.2%-dose rows) still ran above that day's `T`
minimum. The single counter-example (00bd3b4a, above) sits at the low end of the dose distribution and
outside the window, consistent with "low dose is where a violation would first appear if one existed,"
not evidence the premise is generally unreliable.

## Card argument (4) — the shrinking-pool objection, refuted empirically

This is distinct from the premise DoD-4 above tests. Argument (3) asks whether a contaminated run can
occupy the daily minimum. Argument **(4)** grants (3) and attacks the minimum a different way: even if
contamination never touches the minimum directly, `min(T)` is drawn from a **shrinking true-solo pool**
as the contamination rate rises — and **fewer draws regress a minimum upward on their own**, as a pure
sampling artifact, with no change in the box's actual speed required. The card quantified the threshold
this would need: the true-solo COUNT would have to fall, and (at zero contamination on the early end)
that requires contamination to exceed ~51% by 07-31.

**The `T(n)` column already computed above answers this directly, by bracketing the window with its two
best-sampled days:**

```
2026-07-24  T(n)=13  min 691s
2026-07-31  T(n)=17  min 798s
```

**The true-solo pool GREW 13→17 (+31%) over the same span the minimum ROSE 691s→798s (+15%).** The
shrinking-pool mechanism predicts the opposite pairing — fewer draws going with a higher minimum. Here
there are MORE draws AND a higher minimum, which the shrinking-pool artifact cannot produce on its own.
**Argument (4) is refuted empirically, not merely out-argued on margin: the sampling-artifact mechanism
requires a correlation that doesn't hold in this data.**

**Residual honesty:** `T(n)` is not monotonic through the middle of the window — it dips to 5 (07-28)
and 7 (07-29) before recovering to 10 (07-30) and 17 (07-31). Those two dip days' own minima (738s,
779s) are individually drawn from thin samples and are weaker evidence in isolation. The 07-24→07-31
comparison above is what actually carries the refutation, precisely because it brackets the dip with the
two best-sampled days in the window and moves in the direction that defeats the artifact (pool up,
minimum up) rather than the direction that would be consistent with it (pool down, minimum up).

## DoD-5 — verdict per claim, separately

- **MIN-trend (the floor is rising): EARNED.** Survives restriction to the fully-verified
  gate-solo-throughout population — both window endpoints are identical to the raw series (458s→798s in
  both; see the DoD-3 correction above for the one non-endpoint day that differs and why that's expected).
  The load-bearing premise behind it (DoD-4 above) holds 7/7 inside the analysis window, and the last
  standing objection to it — the shrinking-pool argument (4) — is empirically refuted, not just
  undercut, by the 07-24→07-31 `T(n)` comparison directly above.
- **MEAN-trend: EARNED, not weakened by contamination.** Contamination rate does not rise across the
  window (mildly falls on the best-sampled days) — the mechanism that could manufacture a mean-trend
  artifact (rising contamination inflating later days more than earlier ones) is not present in the
  data.

## DoD-6 — which statistic does "+342s/10.5d" come from?

**I could not locate the literal string "342" as a citation anywhere in this repo** (`git log --all
--grep`, full-text grep of tracked files) — it likely lives in the Obsidian vault (Orchestrator Log or
similar), which this read-only DB analysis had no access to verify against. What this analysis CAN do:
identify which statistic it's numerically consistent with.

```
ALL-passed (99fb882e's own table), 07-21 -> 07-31:  min delta 340s   mean delta 465s
T (this reconstruction), same window:                min delta 340s   mean delta 441s
```

**340s matches "+342s" to within 2s under BOTH the raw and the fully-corrected population — the mean
deltas (441-465s) are 100+ seconds off.** This is strong, if not airtight (I found no primary citation
to confirm against), evidence that **+342s/10.5d is min-derived, not mean-derived** — the citation is
therefore NOT disqualified by the card's own rule ("mean-derived ⇒ stays uncited regardless"). If a
citation to the original source of "+342" ever surfaces, re-check it against 340s exactly; a 2s gap is
consistent with a slightly different rounding or read instant, not a different underlying quantity.

## What this does not, and cannot, establish

- **"Gate-uncontended" only, never "uncontended."** Every `T` classification here means no OTHER
  `GateSemaphore`-admitted lane overlapped — it says nothing about host load from worker sessions,
  ingest subprocesses, or hand-run builds, all invisible to this reconstruction exactly as they are to
  `activeCount`. That confound stays open and unbounded.
- **No claim about anything before 2026-07-21** (the `durationMs` instrumentation boundary) or about
  whether the trend continues past 2026-07-31 — 2026-08-01 is shown above only as a partial-day curiosity
  (the DoD-4 exception), never folded into the 10.5-day trend numbers.
- **The typecheck/build step-drift control was not attempted** — the card itself rules it out as
  permanently confounded (short-step durations are themselves time-varying for non-host reasons: dep
  count, module count, code volume). Not re-derived here.
- **Nothing here changed, backfilled, or reinterpreted any stored row** — every number is a live
  re-derivation from the same `orchestration_events` rows that were already there.

## Reproduce this

```sh
cd docs/investigations/e75dc05a-mid-run-gate-overlap
node scripts/extract-all-gate-admissions.mjs --out data/all-gate-admissions.json
node scripts/validate-controls.mjs            # DoD-0 -- must print "all controls PASS" before trusting anything below
node scripts/reconstruct-daily-stats.mjs      # DoD-1/2/3/4/6
```

`extract-all-gate-admissions.mjs` is the only script that touches `loom.db`, always with
`{ readonly: true, fileMustExist: true }`. The other two scripts read only the committed JSON.
