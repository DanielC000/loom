# 99fb882e — gate suite-timing: DoD-A, DoD-1, DoD-2 findings

Read-only analysis run 2026-08-01 against card `99fb882e` ("gate test step hit 1561s — budget raised
to 1800s, ~10% margin left"). Scope was explicitly narrowed by kickoff to **DoD-A (the lead's own
hypothesis), DoD-1 (rising-floor test), and DoD-2 (chase the 1643s)** — DoD-3/4/5/6-9 from the card's
own definition-of-done are untouched and out of scope for this pass.

**No production code was changed. No suite/gate was run. No DB write occurred.** `loom.db` was opened
directly with `better-sqlite3({ readonly: true, fileMustExist: true })` — a readonly connection is safe
to open against the live WAL-mode DB while the daemon keeps writing to it; no copy was needed. Verified
`journal_mode` reads back `'wal'` on every run (see script output).

All numbers below are reproducible: `scripts/extract-gate-events.mjs` re-queries `loom.db` and
regenerates `data/loom-build-gate-series.json`; `scripts/rising-floor-report.mjs` reads that JSON (no DB
access) and reproduces every table in this document. Re-run both to check any claim here.

## DoD-A — does `build_gate` record rejected runs? **Yes. The manager's lead was correct.**

Source (`packages/daemon/src/sessions/service.ts:9439-9442`): `confirmWorkerMerge` calls

```js
evt("build_gate", {
  passed: gateResult.passed, durationMs: Date.now() - gateStartedAt, gateCap, concurrentGates: concurrentAtStart,
  ...(gateRan ? {} : { reused: true, reusedOpId }),
});
```

unconditionally, **before** the `if (!gateResult.passed)` branch at line 9496 — so a rejected merge gets
exactly the same audit event, with the same `durationMs`, as a passing one. `build_gate_retry`
(line 9484) does the same for the transient-kill retry path.

**Confirmed against data, not just source.** Scanning the 500 most-recent `build_gate` rows across every
project: 449 passed, 51 failed, **0 of either missing `durationMs`**. Scoped to just the Loom project
(this task's own project, `c36e8691…`): of 67 `passed:false` rows, 45 carry a `durationMs` and 22 don't
— but every one of the 22 predates **2026-07-21** (see the instrumentation-boundary note below); every
`passed:false` row from 2026-07-21T03:24Z onward has a duration. **The claim "rejected runs report no
durations" does not hold against `orchestration_events` for the window this card actually needs.**

**So where did the selection-bias framing come from?** A real, narrower defect exists one layer down —
just not the one the card's SELECTION BIAS section describes. `gate_status(opId)` reads a *different*
table, `pending_gate_ops` (a per-op registry, now a **permanent tombstone** since card `e3e40167` — it no
longer 404s after settle). But its `verdict`/`verdict_payload_json` enrichment (which is where a
per-step breakdown would live) is populated **only for `kind='gate'` rows** (a worker's own `run_gate`
self-check) — confirmed empirically: **0 of 106 `kind='merge'` rows in `pending_gate_ops` have a
non-null `verdict_payload_json`**, vs. every sampled `kind='gate'` row carrying a full `steps` array.
That is exactly card `9f6598dd`'s own (already-corrected) Finding 1 — `gate_status` on a settled *merge*
op returns bare `{state:"settled", elapsedMs:null}` with no duration — and it is a **different mechanism
from `orchestration_events`**, which already has what this card needs.

**Net effect — the lead's reframing is right, precisely:** the historical series for merge-gate duration
was never lost. It sits in `orchestration_events` (`build_gate`/`build_gate_retry`), it is NOT exposed to
any agent tool (`grep -rn "listGateEvents" packages/daemon/src/mcp/` → **zero hits**; the only caller is
`gateway/server.ts:820`, the web "Gates page" REST endpoint), and `9f6598dd` is fixing a real but
*separate* gap (per-op `gate_status` durability for merge ops), not this one. **Don't conflate the two
when re-reading `9f6598dd` — it doesn't duplicate this finding, it complements it.**

## Instrumentation boundary — the honest window

Every `build_gate`/`build_gate_retry` row before **2026-07-21** (spanning back to the earliest recovered
row, 2026-07-11) lacks `durationMs` entirely, on both the pass and fail path — not a data-loss artifact,
an **instrumentation gap**: duration recording for the pass path shipped in card `a1c86452` (its own
db.ts doc: *"the HISTORY half of the Gates page"*), which is — not coincidentally — the taskId on the
very last duration-less `passed:true` row in the recovered series, at `2026-07-21T10:37:16.828Z`. From
`2026-07-21T11:43:39.874Z` (the first duration-bearing `passed:true` row) through the end of the
recovered window (`2026-07-31T23:40:06.750Z`), **every row has a duration.**

**So: the recovered, duration-complete series covers 2026-07-21 through 2026-07-31 — 10.5 days.** State
this window with every claim below; a trend drawn from a shorter or longer span is a different claim.

## DoD-1 — is the floor rising? **Yes, and it is not small.**

Per UTC day, **passed** runs only (a failed run can fail fast on lint/typecheck and would understate the
floor with a number that isn't measuring the same thing — mirrors the card's own table, which only lists
✅ rows):

```
date       | n  | min(s) | max(s) | mean(s)
2026-07-21 | 24 |    458 |    719 |    554
2026-07-22 | 42 |    534 |    844 |    647
2026-07-23 | 43 |    643 |   1020 |    745
2026-07-24 | 47 |    691 |    946 |    775
2026-07-25 |  3 |    711 |    741 |    729   (n=3 — thin, see caveat below)
2026-07-28 | 15 |    738 |   1084 |    877
2026-07-29 | 37 |    779 |   1203 |    927
2026-07-30 | 31 |    809 |   1333 |    998
2026-07-31 | 45 |    798 |   1647 |   1019
```

The daily **minimum** climbs on 8 of 8 day-to-day transitions (458→534→643→691→711→738→779→809→798,
the last a 1.4% dip within noise): **from 458s to ~800s, roughly a 75% rise in the observed floor over
10.5 days.** This is `durationMs` measured **from admission, excluding queue wait** (comment at
`service.ts:9406-9407`), so it is not queueing time bleeding into the number.

**Ruling out the obvious alternative — a mix-shift toward more contended runs, not a genuinely slower
suite.** `concurrentGates` (the semaphore's own active-run count *at admission*) is only populated from
2026-07-23 onward (an earlier, separate instrumentation boundary — card `424ed9a8`), so the solo/contended
split only covers 2026-07-23–07-31, not the full window:

```
SOLO-at-admission only (concurrentGates===1), n=113:
date       | n  | min(s) | max(s) | mean(s)
2026-07-23 |  5 |    729 |   1020 |    827
2026-07-24 | 17 |    691 |    802 |    729
2026-07-25 |  3 |    711 |    741 |    729
2026-07-28 | 14 |    738 |   1084 |    866
2026-07-29 | 16 |    779 |   1031 |    886
2026-07-30 | 23 |    809 |   1333 |    980
2026-07-31 | 35 |    798 |   1647 |  1024
```

The same rise (691s→798s+, allowing 07-23's n=5 as a noisy start) shows up **even restricted to runs
that were solo at admission** — so this is not simply "more overlap happened later." (Caveat, inherited
from this card's own pinned reading aids: `concurrentGates` is an admission-instant snapshot, not a
throughout-run measure — a "solo" run by this filter could still have had a peer gate start mid-run.)

**UPDATE (card `e75dc05a`, retrospective reconstruction) — that residual turned out to be measurable
after all, and large.** Reconstructing admission/settle intervals from `admitMs = settleMs - durationMs`
across every gate-semaphore admission (all four kinds, all projects — the semaphore is one daemon-global
instance) found **50-65% of "solo at admission" runs on every well-sampled day were actually joined
mid-run.** The rising-minimum verdict below *survives* this correction — recomputed against the fully
verified gate-solo-throughout population, every daily minimum in the 07-21→07-31 window is IDENTICAL to
the one reported here (458s→798s) — but the specific `b4c4699e` "solo run crossed the ceiling" citation
in this card's DoD-2 section below turned out to be 67.2%-dosed by a Codescape admission for most of its
runtime; see `docs/investigations/e75dc05a-mid-run-gate-overlap/findings.md` for the full reconstruction,
its DoD-0 controls, and that correction. **Also add the ceiling from that card here:** every
"solo"/"uncontended" claim in this document means gate-uncontended only — `concurrentGates`/`activeCount`
and the mid-run reconstruction both count only `GateSemaphore`-admitted lanes, never host load from
worker sessions, ingest subprocesses, or hand-run builds; neither instrument can rule out non-gate
contention.

**What the rise is NOT plausibly explained by:** the card's own build-log notes put suite size at ~607
files on 07-21ish and 616 by 07-31 — under 1.5% growth, nowhere near enough to explain a ~75% duration
rise on its own.

**Verdict: the data supports a genuine climbing minimum (hypothesis B), not intrinsic variance around a
flat floor (hypothesis A) — stated for the 10.5-day window 2026-07-21→2026-07-31 only.** I did not, and
was told not to, take a fresh reading at HEAD to extend this. Whether the rise continues, plateaus, or
was itself a temporary regime (the card's own v1/v2/v3 history is a standing reason for humility here) is
not something 10.5 days of daily-bucketed data — with two days (07-26/07-27) entirely missing and one
(07-25) at n=3 — can settle. **If the trend holds at its observed rate, the 1800s budget is not a
comfortable multi-week margin; if it doesn't, 1800s is fine.** This card cannot distinguish those without
more calendar time passing, which is exactly what DoD-1 asked to avoid manufacturing by sampling at HEAD.

## DoD-2 — the 1643s reading, resolved

**Found, with high confidence.** Across the *entire* DB (every project, every gate kind —
`build_gate`/`build_gate_retry`/`worker_gate`, 1785 rows scanned), exactly **one** reading falls within
±10s of 1643s:

```
ts:              2026-07-31T17:31:17.949Z
kind:             build_gate
project:          Loom
task:             b4c4699e — "fix(memory): the dropped-pinned-notes notice truncates its own key list…"
passed:           true
durationMs:       1646946   (1646.9s — 3.9s off the cited "1643s")
gateCap:          2
concurrentGates:  1  (solo at admission)
merged sha:       493dce1, mergedDate 2026-07-31T17:31:34.360Z (17s after this event — consistent
                   with gate-pass → squash-merge)
```

**⚠️ CORRECTION (card `e75dc05a`): `concurrentGates: 1` means solo AT ADMISSION only — it does not mean
solo throughout.** A retrospective overlap reconstruction found a Codescape admission overlapped **67.2%
of this run's own duration** (1107s of 1646.9s). This does NOT undo the 1646.9s duration or the "the old
1500s ceiling was crossed" fact below, but it DOES undo citing this run as clean solo-throughout evidence
against a contention-first explanation — it was contended for two-thirds of its runtime. See
`docs/investigations/e75dc05a-mid-run-gate-overlap/findings.md`, "Headline finding 2."

The ~4s gap between 1643 and the recovered 1646.9 is well within what a manual re-read (rounding, or
reading a slightly different reference point than `Date.now() - gateStartedAt`) would produce, and no
other candidate exists anywhere in the DB within ±10s — this is very likely the same event.

**This run happened at 17:31Z, well before the budget raise (~23:30Z that night), so it ran under the
OLD 1500000ms ceiling.** 1646.9s exceeds 1500s by 146.9s — it could only have passed by consuming the
one auto-extension a first attempt gets while still emitting output (memory
`gate-retry-runs-with-no-auto-extend`). **The old ceiling was measurably crossed, on a real, attributable
run, hours before anyone flagged it** — it was not noticed because it passed (an extended pass looks
identical to a comfortable one unless someone reads the `extended` flag, which — per `9f6598dd`'s
Finding 1 above — doesn't survive settle for merge ops today). ⚠️ *Per the correction above, this was NOT
a clean solo-throughout run (67.2% dosed) — the crossing-the-ceiling fact stands, the "solo, therefore
not a contention artifact" framing does not.*

## What this does not cover

- No attempt was made at DoD-3 (intrinsic variance vs. contention) — the card marks both as currently
  unmeasurable, and this kickoff scoped me out of it.
- No per-file/per-step breakdown (DoD-4) — confirmed while investigating DoD-A that no durable store
  carries step-level detail for **merge** gates (steps exist only in the synchronous return value handed
  to the calling code at `service.ts:9592`/`10378`/`10416`, never persisted); only worker self-check
  (`kind='gate'`) ops get a persisted `steps` array, via `pending_gate_ops.verdict_payload_json`. Total
  wall time is the only historically-recoverable granularity for merge gates today.
- Nothing here touches `gateCommandTimeoutMs`, `maxConcurrentGates`, or any other config — read-only
  throughout, per the card's own DoD-6/9 and this kickoff's hard constraints.

## Reproduce this

```sh
cd docs/investigations/99fb882e-gate-suite-timing
node scripts/extract-gate-events.mjs --project c36e8691-44d8-44ae-91ed-1bae3c632b33 --out data/loom-build-gate-series.json
node scripts/rising-floor-report.mjs
```

`extract-gate-events.mjs` is the only script that touches `loom.db`, and only ever with
`{ readonly: true, fileMustExist: true }`. `rising-floor-report.mjs` reads only the committed JSON.
