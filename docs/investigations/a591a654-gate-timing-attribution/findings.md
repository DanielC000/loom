# a591a654 — in-gate suite slowdown: confirmed, partially decomposed

Read-only measurement pass against card `a591a654` ("the SAME suite runs ~40-50% slower inside the
merge gate than standalone"). **No production code changed. No gate run. No load generated** — every
number below comes from the four in-gate runs already banked at
`~/.loom/gate-timing/daemon-per-file-timing.ndjson` (snapshotted into `data/in-gate-per-file-timing.ndjson`
for reproducibility — re-read at analysis time: still exactly 4 `run-summary` rows, no new runs landed),
the standalone baseline already committed at `docs/investigations/6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson`,
and one **readonly** query against `loom.db`'s `orchestration_events` table (same pattern as
`docs/investigations/99fb882e-gate-suite-timing/scripts/extract-gate-events.mjs`).

**Verdict: the delta is CONFIRMED, not a measurement artifact. One candidate contributor (foreign-project
gate concurrency) is suggestive but NOT established at n=4 — the middle two runs contradict it as
cleanly as the extremes support it, see §5. A separate floor is present even at zero measured
contention and remains fully unattributed. Reported in that order.**

## Positive control, re-verified

`git log` was not needed to establish the runUid→merge mapping — `orchestration_events.build_gate`
carries `taskId` directly, and every taskId in the DB matches the card's own table. The DB's own
`durationMs` for each merge task matches the ndjson `run-summary.durationMs` to within ~20s (see
"Gate-op vs suite-wall gap" below) — two independently-written instruments agree.

## 1. THE DISCRIMINATOR (method step 1) — reproduce with `scripts/compute-sum-wall-slack.mjs`

```
node docs/investigations/a591a654-gate-timing-attribution/scripts/compute-sum-wall-slack.mjs
```

**Standalone** (`docs/investigations/6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson`, poolSize 2 throughout):

| runIndex | nFiles | testCount | WALL(s) | SUM(s) | SUM/pool(s) | slack(s) |
|---|---|---|---|---|---|---|
| 1 | 617 | 617 | 1424.8 | 2841.8 | 1420.9 | 3.9 |
| 2 | 617 | 617 | 1086.6 | 2163.3 | 1081.7 | 4.9 |
| 3 | 627 | 627 | 1111.6 | 2216.0 | 1108.0 | 3.6 |
| 6 | 627 | 627 | 950.1 | 1893.4 | 946.7 | 3.4 |
| 7 | 627 | 627 | 1003.3 | 1999.9 | 999.9 | 3.4 |
| **8** | **627** | **627** | **894.6** | **1782.0** | **891.0** | **3.7** |

⚠️ **`runIndex` reaches 8 but only SIX rows exist** (1,2,3,6,7,8 — 4 and 5 are absent from this file).
The card's own body already corrected an older "≥8 recorded runs" claim; re-confirmed here — do not
inherit "8 runs" from anywhere upstream of this document. Run **8** (894.6s, 627 files) is the row every
downstream comparison below uses, per the card's own framing.

**In-gate** (`data/in-gate-per-file-timing.ndjson`, poolSize 2 throughout, INSTRUMENT: the per-file gate
emission from card `17069e7e`/`commit c6b649c`):

| runUid | condition | nFiles | testCount | WALL(s) | SUM(s) | SUM/pool(s) | slack(s) | SUM vs standalone-run8 |
|---|---|---|---|---|---|---|---|---|
| `1785610717955-42224` | merge `17069e7e` | 631 | 631 | 1262.3 | 2511.1 | 1255.5 | 6.8 | **+40.9%** |
| `1785612035741-19384` | merge `63bdd2cc`, **REJECTED** (failing suite) | 631 | 631 | 1339.6 | 2663.6 | 1331.8 | 7.8 | **+49.5%** |
| `1785613469275-30256` | merge `753d9911`, fastest | 632 | 632 | 1088.7 | 2162.2 | 1081.1 | 7.6 | **+21.3%** |
| `1785614606189-57096` | merge `867e64f1`, slowest | 632 | 632 | 1580.5 | 3144.6 | 1572.3 | 8.2 | **+76.5%** |

**Reading the discriminator:** slack (WALL − SUM/poolSize) is **6.8–8.2s across all four in-gate
runs** — the same order of magnitude as the standalone arm's own **3.4–4.9s** slack, and both are
*tiny* relative to WALL (≤0.8% of WALL in every row, either arm). Meanwhile SUM itself is **21–77%
higher than the standalone SUM at the identical poolSize**, in **every one of the four** in-gate runs.

⇒ **This is the "SUM higher" branch, cleanly, in all four runs — not the "WALL ≫ SUM/pool" branch.**
The ~6–8 minute premium is **not** hiding in scheduling, queue-wait, worktree prep, or teardown outside
test execution — those would show up as elevated *slack*, and slack barely moves. **Every file is
genuinely taking longer to execute inside the gate.** This one comparison is decisive on its own; the
rest of this document decomposes *why*.

## 2. Population growth — excluded by arithmetic, not merely unchecked

627 (standalone) → 631–632 (in-gate) = **+0.6% to +0.8%** file count. Cannot explain a 21–77% SUM
increase. **Excluded.**

## 3. Per-file ratio distribution — broad-based, not a few outliers

`scripts/compute-sum-wall-slack.mjs`'s third table, per-file `in-gate / standalone-run8` duration ratio
(matched by file name, 627 files matched in every run):

| runUid | median | mean | p10 | p90 | frac > 1.05× | frac < 0.95× |
|---|---|---|---|---|---|---|
| `17069e7e` | 1.24× | 1.37× | 0.99× | 2.00× | 0.81 | 0.06 |
| `63bdd2cc` (REJ) | 1.23× | 1.39× | 0.98× | 1.78× | 0.75 | 0.08 |
| `753d9911` | 1.11× | 1.20× | 0.88× | 1.64× | 0.61 | 0.16 |
| `867e64f1` (cont) | 1.60× | 2.14× | 1.06× | 4.01× | 0.91 | 0.02 |

61–91% of files run measurably slower (>1.05×) in every in-gate run, vs. only 2–16% running measurably
faster. This is a **host/environment-wide effect on most files**, not a handful of pathological tests —
consistent with the SUM-side verdict above, and inconsistent with "a few flaky/slow files distort the
mean."

## 4. Gate-op-vs-suite-wall gap — the non-test portion of the gate is a small, near-constant tax, NOT the premium

`scripts/extract-gate-events.mjs`'s own-row table gives each merge's `orchestration_events.build_gate`
`durationMs` (this daemon's own end-to-end timer around the gate's test step — includes admission,
whatever bookkeeping wraps the `pnpm --filter @loom/daemon test:daemon` call). Diffed against the
ndjson's own `run-summary.durationMs` for the same task:

| task | gate-step durationMs (DB) | suite WALL (ndjson) | gap (non-suite time) |
|---|---|---|---|
| `17069e7e` | 1278313ms | 1262300ms | **16.0s** |
| `63bdd2cc` | 1356744ms | 1339600ms | **17.1s** |
| `753d9911` | 1106807ms | 1088700ms | **18.1s** |
| `867e64f1` | 1601239ms | 1580500ms | **20.7s** |

The gap is **16–21s in every run — tight, and NOT correlated with which run was fast or slow.** Whatever
this gap represents (some mix of gate-admission bookkeeping and the `pnpm build`/typecheck steps the
card already excluded as candidates, ~2-3s per the card's own note), **it is a near-constant ~17-20s
tax, not the ~6-8 minute unexplained delta.** Combined with §1, this pins the *entire* premium inside
the measured test-execution window — worktree prep / union-merge / squash / queue-wait (to the extent
any of them fall outside this ~17-20s gap) are not visible in this data as material contributors, and
this gap is too small and too flat across runs to be where 6-8 minutes hides.

## 5. The internal contrast case (method step 2) — a DB-derived instrument, genuine, but NOT decisive at n=4

The card's own table LABELS `867e64f1` as "ran CONTENDED with a Codescape gate." **That label is a
claim from the card, not something this pass had independently verified going in — checked, not
inherited (per this project's own standing rule that a corroborated PREMISE is not a corroborated
INFERENCE).**

`scripts/extract-gate-events.mjs` queries `orchestration_events` (`kind IN ('build_gate',
'build_gate_retry')`) across **all projects**, reconstructs each foreign gate's own window as
`[ts − durationMs, ts]` (a `build_gate` row's `ts` is logged at gate-FINISH, so this is the only correct
direction — the first version of this query had it backwards and was caught by comparing the reported
window against the ndjson's own timestamps before trusting it), and computes what fraction of each of
our four runs' wall-clock window a **foreign** project's own merge gate actually overlapped:

| run | foreign-gate coverage | foreign gate(s) found |
|---|---|---|
| `17069e7e` | **63.6%** | two back-to-back Codescape (`046fda54…`) gates, 18:51:41–19:02:11 and 19:02:51–19:12:41 |
| `63bdd2cc` (REJ) | **0.0%** | none |
| `753d9911` (fastest) | **0.0%** | none |
| `867e64f1` (slowest) | **61.1%** | one Codescape (`046fda54…`) gate, 20:13:13–20:29:20 |

**The overlap query itself is real — the DB verifies the PREMISE (a foreign gate genuinely occupied
60%+ of two of these four windows). It does NOT, by itself, verify the INFERENCE that this occupancy
caused the slowdown — welding those two together in one phrase ("DB-verified contributor") is exactly
the failure this project's own pinned doctrine names (a verified premise does not transfer its
credibility to an unverified inference). Corrected here rather than repeated.**

🔴 **Line up the middle two rows and the correlation stops looking clean:**

| run | foreign-gate coverage | median per-file ratio (§3) |
|---|---|---|
| `63bdd2cc` (REJECTED — failing suite) | **0.0%** | **1.23×** |
| `17069e7e` | **63.6%** | **1.24×** |

**Zero contention and 63.6% contention produce the same ratio to within 0.01×.** That is a condition
(foreign-gate overlap) present in one run and absent in another equally-slow run — precisely the test
this project's own doctrine requires a candidate cause to survive, and here it **fails** that test, not
passes it. The correlation that looks clean is carried entirely by the two extremes: `753d9911` (0%
coverage, quietest, 1.11× — the single fastest run) and `867e64f1` (61.1% coverage, busiest, 1.60× —
the single slowest run). The middle pair is indistinguishable despite opposite contention states, and
coverage fraction does not rank-order any pair beyond those two extremes.

⚠️ **`63bdd2cc` is also the REJECTED run — a failing suite (§1 already flagged it "distinct
condition").** A failing run's per-file durations are not obviously comparable to a passing run's (a
test file can abort early, or the harness can behave differently around a failure). No mechanism in
this data explains HOW a single failing assertion would move the median of 627 *other* matched files by
+0.12× over `753d9911`'s median — so this pass does not use the failure to explain away the
63bdd2cc/17069e7e collision, only to flag it as a second reason not to trust `63bdd2cc` as a clean data
point. Dropping it would leave n=3 (`17069e7e` 63.6%→1.24×, `753d9911` 0%→1.11×, `867e64f1` 61.1%→
1.60×) — a monotonic-looking triple, but `17069e7e` and `867e64f1` still have near-identical coverage
(63.6% vs 61.1%) for meaningfully different ratios (1.24× vs 1.60×), so coverage fraction still doesn't
cleanly rank-order even the reduced set.

⇒ **Verdict on this section: SUGGESTIVE, NOT ESTABLISHED, at n=4 (n=3 if the failing run is excluded).**
The extremes are consistent with a contention story; the middle pair actively contradicts it. State
both, not just the extremes. What would settle it: this session's own daemon restart landed while this
pass was running — two distinct, later events, not two readings of one: **process start**
2026-08-01T21:03:50.053Z (`served_status`'s `deployStaleness.processStartedAt`, computed as
`Date.now() - process.uptime() * 1000` — the moment this daemon process began executing its
currently-loaded `dist` code, per `deploy-staleness.ts`'s own documented semantics; not independently
re-read by this worker session, which has no `served_status` access, but the module source confirms
the field means what it's claimed to mean) and **boot-reconcile finished** 2026-08-01T21:08:47Z (the
`[boot] orchestration reconcile: finished…` line in `daemon-output.log`, read directly) — necessarily
later, since reconcile is housekeeping the already-running new code performs, not a precondition for it
being live. **This claim needs only the earlier bound:** `commit 593f5f93` (committed 2026-08-01T07:30:24Z,
well before either, and confirmed an ancestor of `main` via `git merge-base --is-ancestor 593f5f93
main`) was live from **process start**, so `concurrentGatesMax` (true max-over-run contention, not a
point-in-time admission snapshot) has stamped every gate since **21:03:50Z**, and `gate_history` is
queryable — the right instrument for a future pass's WHOLE-RUN premium claim, span-matched to it, and it
accumulates from the restart forward. **It is not the only path, and does not need to be waited on:**
exact-window overlap reconstruction (rebuilding each gate's true `[startedAt, startedAt+durationMs]`
window from event rows that already exist — `startedAt = ts − durationMs`, admission time, excluding
queue wait per `service.ts:9700`'s own comment) has no backfill problem, since it needs no stamped field
— it reaches this pass's own n=4 and the whole historical corpus today, which is exactly what §5's
coverage-fraction table above already did. **Governing principle: match the instrument's span to the
claim's span** — a whole-run claim wants `concurrentGatesMax` or a whole-run overlap fraction; a
sub-interval claim (e.g. sibling card `cfcc0946`'s finding that a run stamped `concurrentGatesMax: 2`
while one specific file inside it ran with zero overlapping gates) needs the finer per-file
reconstruction instead — an instrument wider than the claim overstates, narrower understates.

## 6. A third, weaker signal — also not decisive, and it inherits §5's own problem

Grepping `~/.loom/logs/daemon-output.log` for `[pty] spawn` events landing strictly inside each run's
own `[runStart, runEnd]` window (a much cruder instrument than §5 — a spawn is a point event, not a
duration, and this count says nothing about how long the spawned session then ran):

| run | new session spawns inside window | daemon log lines/min inside window |
|---|---|---|
| `17069e7e` | 1 (own project) | 10.9 |
| `63bdd2cc` (REJ) | 1 (own project) | 6.7 |
| `753d9911` | **0** | **5.3** |
| `867e64f1` | **2** (one Codescape, one own-project) | **24.5** |

This tracks the same extremes as §5 (`753d9911` quietest-and-fastest, `867e64f1` busiest-and-slowest)
and offers one partial explanation for what §5's coverage fraction alone could not: `867e64f1` and
`17069e7e` have similar foreign-gate coverage but `867e64f1` additionally had a second concurrent
session spawn (fresh `claude` process startup — MCP handshakes, extension loading, initial tool-list
negotiation — is itself a real, if brief, CPU/IO event) landing in its window, which `17069e7e` did
not — consistent with `867e64f1` running measurably worse than `17069e7e` despite near-equal gate
coverage. **But it does NOT resolve §5's actual problem**: `63bdd2cc` (1 spawn) and `17069e7e` (1
spawn) have the *same* spawn count and still land on the same 1.23×/1.24× collision. Report this as a
secondary, weaker signal that partially explains one asymmetry (§5's `17069e7e` vs `867e64f1` gap) —
not as independent corroboration of the contention story overall, since it doesn't touch the pair that
actually breaks it.

## 7. Host fields (method step 4) — one is unusable, one does not cleanly discriminate

- **`nodeLikeProcessCount` / `nodeLikeWorkingSetMB`: `null` in all four `hostBefore`/`hostAfter`
  snapshots, in every run.** The schema field exists; nothing populates it in this data. This method
  step is **not answerable** from the banked data — an instrumentation gap, not a null result.
- **`freeMemMB` before each run:** 6614 (`17069e7e`) → 7672 (`63bdd2cc`) → 3731 (`753d9911`) → 2653
  (`867e64f1`). `867e64f1` (slowest) does start from the lowest free memory of the four, consistent
  with a memory-pressure story — but `753d9911` (fastest) has the **second-lowest** free memory
  (3731MB, well below `17069e7e`'s 6614MB) and is still the fastest run. **`freeMemMB` alone does not
  cleanly rank-order the four runs and is not treated as a confirmed discriminator on its own** — it
  neither confirms nor excludes the contention story; it is simply not resolving at this sample size.

## What is CONFIRMED

1. The in-gate suite genuinely runs 21–77% more SUM-seconds than the same suite standalone, at the
   same pool size, in every one of the four banked runs — not a scheduling/harness artifact (§1), not
   population growth (§2), not a handful of outlier files (§3), and not the small non-suite portion of
   the gate operation (§4).

## SUGGESTIVE, NOT ESTABLISHED (n=4) — foreign-project gate concurrency

The two extreme runs are consistent with a contention story (`753d9911`: 0% foreign-gate coverage,
quietest, fastest at 1.11×; `867e64f1`: 61.1% coverage, busiest, slowest at 1.60×). **But the middle
pair contradicts it as cleanly as the extremes support it:** `63bdd2cc` (0.0% coverage) and `17069e7e`
(63.6% coverage) land on the *same* 1.23×/1.24× ratio despite opposite contention states (§5) — a
condition present in one run and absent from an equally-slow run, which this project's own doctrine
treats as disqualifying, not merely inconclusive. `63bdd2cc` is additionally the REJECTED (failing)
run, a second reason to discount it as a clean data point (§5) — but excluding it still leaves
`17069e7e` and `867e64f1` at near-identical coverage (63.6% vs 61.1%) for meaningfully different ratios
(1.24× vs 1.60×), so dropping the confound doesn't rescue a clean rank-ordering either.

**Do not carry "foreign-gate contention is a confirmed contributor" forward from this pass.** Carry:
the extremes are consistent with it, the middle pair is not, and n=4 (n=3 without the failing run) is
too small to settle which pattern is representative. **The path to an actual answer:** see §5 for the
two-instrument breakdown (process start 21:03:50Z vs boot-reconcile-finished 21:08:47Z — distinct
events, both real) — `commit 593f5f93` was live from process start, so `concurrentGatesMax` now stamps
every gate going forward, span-matched to a whole-run claim like this one. That is not the only
available path, though, and does not require new runs: exact-window overlap reconstruction (as §5
already did) needs no stamped field and reaches this pass's own n=4 today — the next pass can extend
that reconstruction to a larger corpus rather than wait for `concurrentGatesMax` to accumulate.

**That successor field already shows why the reconstruction above was the right call, not a workaround
to retire without comment.** Verified independently, same readonly `orchestration_events` query used
throughout this pass: task `e082bf4d` (a post-restart Loom merge gate, `durationMs=1514721`) was
admitted SOLO (`concurrentGates: 1`) but reached `concurrentGatesMax: 2` mid-run — a second gate joined
after admission. A bare admission-snapshot reading would have called that run uncontended; it wasn't.
§5's coverage-fraction reconstruction (deriving overlap from every project's own `build_gate` window,
not a single point-in-time read) would not have made that mistake either, which speaks to that method,
not to this section's conclusion — n=4 stands regardless. (One correction to how this was relayed:
`e082bf4d` is not literally the first row with `concurrentGatesMax` populated — `ad2d0a2e`, ts
21:33:26Z, precedes it by ~9 minutes carrying the same signature — verified the same way; doesn't
change the point, but "first" isn't the right word for it.)

⚠️ **This settles nothing about this pass's own n=4.** Confirmed against the DB: `concurrentGatesMax`
is `null` for all four of our runs, the field predates `593f5f93` and is not backfilled, and only 3 of
1174 `build_gate(+retry)` rows across every project carry a non-null value — all logged after the
restart. It cannot be recovered retrospectively. What it gives the next pass is a native,
growing-corpus field to re-ask this question against directly — not a resolution of the n=4 problem
above.

## What is UNATTRIBUTED — state this as plainly as the confirmation

**Even the two runs with zero foreign-gate contention (`63bdd2cc`, `753d9911`) still ran 21–50% more
SUM-seconds, and 11–23% slower per file at the median, than the standalone baseline.** Something makes
the suite run slower **inside any merge-gate worktree, even when nothing else is contending for the
gate semaphore** — and per the section above, it is not yet established that foreign-gate contention
explains the *additional* slowdown in the other two runs either, so treat this floor as covering most
or all of the confirmed delta, not merely a residual on top of an established contention effect. This
pass did not identify the mechanism. Ranked, unexcluded candidates, none confirmed or excluded by
anything in this data: worktree filesystem location/layout differing from the standalone harness's
long-lived checkout; per-worktree `node_modules` (this repo's own CLAUDE.md notes node_modules is
never shared across worktrees) changing cache locality; antivirus/Defender scanning of a freshly
created worktree's files; ordinary background daemon activity (PTY output handling, project-memory
writes, `orchestration_events` writes) that runs regardless of gate-vs-gate contention and was not
separately measured here; or some other structural difference between how
`pnpm --filter @loom/daemon test:daemon` executes inside a gate worktree vs. how the standalone
harness invoked the same tests. **A ranked list of unexcluded causes, not a confident single one.**

## Recommendation on `63bdd2cc` / `a496166a` / `1055f5e3`

The delta is real, so neither card should be shelved outright — but the decomposition above means
**suite-content optimization (`63bdd2cc`) and lane-policy work (`a496166a`) act on SUM, and SUM
reduction pays off proportionally under every condition observed here** (contended or not — see §1's
SUM/poolSize relationship to WALL holding in all four rows). Cutting SUM is not wasted effort even
though it doesn't touch the unattributed floor or settle the still-open contention question.

**What deserves its own follow-up, separate from both:** the unattributed in-gate floor identified
above (§ "What is UNATTRIBUTED") — it is present with zero gate contention and is not addressed by
either `63bdd2cc` or `a496166a`. Recommend a **new, narrowly-scoped card** to test the leading
candidate that's cheapest to check first (per-worktree `node_modules`/disk-cache locality — compare a
worktree-run to a standalone run on the SAME filesystem location) before reaching for AV or daemon
background load, since those are harder to test in isolation. Sequencing this behind the restart
already scoped in the card (for `593f5f93`) is reasonable — this pass needed none of that
instrumentation and answered what it could without it.

## Reproduce

```
node docs/investigations/a591a654-gate-timing-attribution/scripts/compute-sum-wall-slack.mjs
node docs/investigations/a591a654-gate-timing-attribution/scripts/extract-gate-events.mjs
```

Both are read-only (`{ readonly: true, fileMustExist: true }` for the DB script; plain `fs.readFileSync`
for the ndjson script). Neither runs a build, a test, or a gate.
