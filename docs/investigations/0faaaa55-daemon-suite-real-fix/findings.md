# 0faaaa55 — daemon suite wall-time: the real fix

Card `0faaaa55` ("perf(daemon): reduce daemon suite wall time — the real fix behind the raised gate
timeout") carries forward `6c1aadf7`'s halted measurement pass, now unblocked by `45274e34` (the
`engine-session-rotation` self-poisoning fix). This document answers the card's 6-point DoD.

## Premises re-verified before starting (per kickoff instruction)

- HEAD at kickoff: `8a6ef5bd`, matching the card's own citation.
- The harness (`docs/investigations/6c1aadf7-daemon-suite-timing/scripts/measure-per-file-timing.mjs`)
  exists on main and does what the card claims: reuses `packages/daemon/test/census/lib.mjs`'s
  `runCensusBatch` (verified its exports match — `discoverHermetic`, `runCensusBatch`, `appendNdjson`,
  `hostSnapshot`, `summarizeExecuted` all present), never touches `run_gate`.
- `45274e34` ("fix(daemon): isolate engine-session-rotation's real-homedir artifacts per run") is a real,
  merged commit ancestral to HEAD — confirmed via `git show --stat`.
- `pnpm build` was run before every standalone test invocation in this pass (dist reflects src).

## DoD-1 — the rising-floor question: **YES, and it is still rising**

Card `99fb882e` already answered this from `orchestration_events` (`build_gate`/`build_gate_retry` rows,
10.5-day window 2026-07-21→2026-07-31): daily **minimum** climbed 458s→~800s+, not explainable by the
~1.5% test-count growth over the same window. Per the card's own instruction ("do NOT answer this by
taking more readings at HEAD — that measures today, not the trend"), this pass did not take a fresh
HEAD reading to answer DoD-1 — instead it **re-ran `99fb882e`'s own read-only DB extraction**
(`extract-gate-events.mjs` + `rising-floor-report.mjs`, both `{readonly:true}` against the live WAL DB) to
extend the SAME historical series through today. This is mining more of the same durable history, not a
fresh sample — consistent with the card's instruction.

**Extended series, `passed` runs only, per UTC day (`durationMs` = admission→settle, excludes queue wait):**

```
date       | n  | min(s) | max(s) | mean(s)
2026-07-21 | 24 |    458 |    719 |    554
2026-07-22 | 42 |    534 |    844 |    647
2026-07-23 | 43 |    643 |   1020 |    745
2026-07-24 | 47 |    691 |    946 |    775
2026-07-25 |  3 |    711 |    741 |    729   (n=3 — thin)
2026-07-28 | 15 |    738 |   1084 |    877
2026-07-29 | 37 |    779 |   1203 |    927
2026-07-30 | 31 |    809 |   1333 |    998
2026-07-31 | 45 |    798 |   1647 |  1019
2026-08-01 | 26 |    912 |   1384 |  1077   ← NEW, this pass
```

**The daily minimum climbed on 9 of 9 day-to-day transitions** (07-31's 798s was the one dip within
noise; 08-01 broke past it to 912s) — from 458s (07-21) to 912s (08-01), a **~99% rise in the observed
floor over 11.5 days.**

**Restricted to SOLO-at-admission runs only** (ruling out "more contention happened later" as the
explanation): 691s (07-24, n=17) → 912s (08-01, n=18, IDENTICAL to the all-runs minimum for that day —
today's floor-setting run was itself solo at admission). The same climbing-minimum shape survives.

**Verdict: the floor is still climbing, past `99fb882e`'s own window.** If the trend holds, 1800s is not
a comfortable multi-week margin.

## DoD-2 — where does the time go: dominant files or diffuse? **BOTH — a real heavy top, but the majority is genuinely diffuse**

A clean 3-run pass (runs 6-8, `--start-index 6`, against the FINAL landed code — the DI seam plus the 5
fixed test files) produced per-file timing across all 627 hermetic files. Runs 7 and 8 were fully clean
(0 failures each); run 6 carries one now-fully-explained spurious failure (see "A regression caught and
reverted" below — it ran against a since-reverted broken edit mid-pass) and one known pre-existing flake
(`kickoff-real-spawn`, a real-`claude`-spawn-timing test also flagged flaky in `6c1aadf7`'s own findings) —
neither affects the per-file DURATION numbers below, which are computed from all 3 runs' `durationMs`.

**⚠️ CONDITION (supplied by the manager's op ledger, cross-referenced against these runs' own UTC
timestamps — see DoD-5 below for the full table): runs 7 and 8 ran 100% under a concurrent Loom merge
gate (`3c712d4e`); run 6 was ~93% under one of two concurrent merge gates, ~7% gate-free.** This dataset
carries real, mostly-continuous host contention throughout — not a quiet-box reading, and (per DoD-5's own
discriminating-cause check) the fastest and slowest of the three whole-suite totals were BOTH taken under
the identical gate-concurrent condition, so contention cannot explain the spread between them. The
dominant/diffuse SHAPE below (which files are relatively heavy vs. light) is a within-run, cross-file
comparison and is far less sensitive to overall host load than an absolute duration is — but treat the
absolute per-file `mean` figures as "under real contention," not as isolated per-file costs.

**The heavy top exists and is real:**

```
rank | file                              | mean(ms) | min–max(ms)
1     merge-confirm-completion-nudge       89276     84360–98026   ← found, attempted, REVERTED (see below)
2     merge-gate-reuse                     64181     61150–68185
3     kickoff-real-spawn                   60576     42036–89795   ← known flaky, real spawn timing
4     merge-repo-mutex                     54408     51729–56819
5     gate-timeout-circuit-breaker         48109     39608–63124
6     worker-run-gate-completion-nudge     46382     45674–47030   ← found, NOT attempted (same risk class)
7     gate-status                          40108     38786–42387   ← found, NOT attempted (structurally safer, but out of time)
8     codescape-health-probe               40008     39130–40713
9     worker-kickoff-guarantee             28457     28153–28718
10    worktrees                            24063     22576–25695
```

**Top 10 of 627 files = 26.2% of total per-file time. Top 30 = 43.7%.** Three of the top 10 are the
"found, not fixed" files from the DoD-4/5 table above — together with `merge-gate-reuse`/`merge-repo-mutex`/
`gate-timeout-circuit-breaker`/`codescape-health-probe`/`worker-kickoff-guarantee`, most of the heavy top
is real-subprocess or real-timeout tests (spawning actual child processes, real git operations, or genuine
timeout windows), not blind sleeps — a structurally different, harder-to-shrink class than the
`SYNC_ATTACH_BUDGET_MS` sleeps this card fixed.

**But the majority of total time is genuinely diffuse, not concentrated:**
- Median per-file duration: **1086ms**. 296 of 627 files (47%) run in under 1 second each.
- The bottom 597 files (everything EXCEPT the top 30) still sum to **56.3%** of total per-file time.
- Only 38 files (6%) take ≥10s; only 84 (13%) take ≥5s.

**⭐ THE DIFFUSE ANSWER IS THE OPERATIVE ONE, per the card's own framing.** Even a full, careful fix of
every file in the "heavy top" table (~176s of serial time across the 3 found-but-unfixed files alone)
would leave the MAJORITY of total suite cost — the diffuse tail across ~600 ordinary files at ~1s median —
completely untouched. This is not a "few surgical fixes" problem; the suite's cost is structurally spread
across the whole file population, with a real but secondary concentration in real-subprocess/real-timeout
scenarios. (Sanity check: sum of all 627 per-file means ≈ 1891.7s; at `poolSize:2` concurrency that
predicts ≈946s wall-clock, matching the observed 895–1003s almost exactly — confirming the per-file data
and the wall-clock totals are mutually consistent.)

## DoD-3 — test count is NOT the mechanism (confirmed)

`node scripts/test-daemon.mjs --count`, run twice this pass (never cached): **627** hermetic tests as of
this pass (HEAD `8a6ef5bd`). Trajectory across the investigation's own history: ~607 (`99fb882e`'s 07-21
citation) → 616 (07-31) → 617 (`6c1aadf7`'s measurement, pre-`45274e34`) → **627** (this pass, post-`45274e34`).
Growth of ~20 files (~3.3%) over the 11.5-day window that saw the daily-minimum floor rise ~99%. Per the
card's own instruction, **test count cannot explain the duration rise** — this matches `99fb882e`'s own
"607→616 (+9 files) cannot explain +600s" observation, now extended and still holding.

## DoD-4/5 — safe reductions landed, with before/after measurement

### DoD-5 answer, up front: resulting test-step duration, and does it clear 1500s?

**Yes, comfortably, on the FINAL landed code.** The 3-run clean pass (runs 7-8 fully clean; run 6 carries
one explained spurious failure from a mid-pass edit that's since been reverted — see below) gave whole-suite
test-step wall-clock totals of **895s (run 8), 950s (run 6), 1003s (run 7)**. All three sit comfortably
under the original 1500s budget, with 33–40% headroom remaining even under real contention.

**Condition, precisely stamped — supplied by the manager's own op ledger, cross-referenced against this
harness's own per-run UTC timestamps (not a re-run, a labelling pass over data already collected):**

```
run  | window (UTC)                          | duration | condition
6    | 12:57:13.400 → 13:13:03.662            | 950s     | 31.2% under merge gate 079f3a6a, 61.9% under merge gate 3c712d4e, ~6.9% (66s) gate-free
7    | 13:13:04.853 → 13:29:48.267            | 1003s    | 100% under merge gate 3c712d4e
8    | 13:29:49.057 → 13:44:43.845            | 895s     | 100% under merge gate 3c712d4e
```

**⚠️ The concurrent-gate condition CANNOT explain the 895–1003s spread across these three runs — it fails
the discriminating-cause test.** Run 8 (the FASTEST, 895s) and run 7 (the SLOWEST, 1003s) were BOTH 100%
under the exact same condition (merge gate `3c712d4e` running the whole time). A condition present
identically in both the fastest and slowest reading cannot be the cause of the difference between them.
**The honest write-up for what drives that ~108s spread is: unattributed pending a contrast case** — not
"gate contention," even though contention was genuinely present throughout. Run 6's ~66s gate-free sliver
is too small a fraction of its own 950s total (7%) to serve as a standalone gate-free data point.

**None of this changes the headline finding: all three readings, taken under real (mostly continuous)
contention, still clear 1500s with comfortable margin.** But it means the margin should be read as "clears
1500s even WITH a concurrent merge gate running almost the entire time," not "clears 1500s when quiet" —
this pass never obtained (and per this project's own "the gate is the load" finding, cannot in principle
obtain) a genuinely gate-free reading to compare against. Given DoD-1's finding that the floor is still
climbing (912s minimum as of today, up from 458s 11.5 days ago), this headroom is not guaranteed to hold —
restate this number against a fresh DoD-1 reading before treating it as a durable margin.

### The mechanism: `SYNC_ATTACH_BUDGET_MS` was a non-injectable production constant

`pending-ops.ts`'s `PendingOpRegistry.attach()` already took its sync-wait budget as a plain parameter
(`waitMs`) — but `SessionService`'s three call sites (`spawnWorkerTracked`, `confirmWorkerMergeTracked`,
`runWorkerGate`) all passed the imported module constant `SYNC_ATTACH_BUDGET_MS` (12s) directly, with no
test-only override — unlike two sibling constants in the same class (`GATE_OP_RETAIN_MS`,
`DEFAULT_GATE_CANCEL_VERIFY_MS`) which already had exactly this seam. Several hermetic tests need a
gate that genuinely outlives this budget to exercise the pending-degrade / async-settle-nudge code paths,
and — lacking any way to shrink the budget — paid the full ~12-16s in REAL wall-clock sleep, sometimes
multiple times per file.

### The fix (production, additive, default-preserving)

`packages/daemon/src/sessions/service.ts`: added `syncAttachBudgetMs` as a constructor option, mirroring
the existing `gateOpRetainMs`/`gateCancelVerifyMs` pattern exactly — `this.syncAttachBudgetMs =
opts?.syncAttachBudgetMs ?? SYNC_ATTACH_BUDGET_MS`, and the three call sites now pass
`this.syncAttachBudgetMs` instead of the bare module constant. **Every existing caller that doesn't pass
the option is byte-identical to before** (default unchanged). `tsc` clean; `pnpm build` clean.

### Files fixed, each with a real gate/budget that shrinks proportionally (sleep still safely > budget)

| file | scenario(s) touched | budget/sleep before → after | before (single run) | after (stable, n≥3) |
|---|---|---|---|---|
| `run-gate-cancelled-retention.mjs` | (D) cancel/re-call | 12s/16s → 500ms/2s | 21839ms | 8167–8600ms |
| `run-gate-result-consumption.mjs` | (B) mid-flight re-call | 12s/16s → 100ms/400ms | 22359ms | 6042–7753ms |
| `pending-op-settle-lineage.mjs` | (A)(B)(C), ×3 sequential | 12s/15s → 100ms/400ms | 53284ms | 8643–15118ms (5 runs; 9202–9608ms in 4 of 5) |
| `wake-auto-cancel-on-settle.mjs` | single scenario | 12s/15s → 100ms/400ms | 17224ms | 2755–3927ms |
| `worker-run-gate.mjs` | (G) retention, (K) async nudge | `GATE_OP_RETAIN_MS` 5s/5.2s→100ms/250ms; budget 12s/12.3s→150ms/350ms | 46767ms | 23493–36614ms |

**Total, this seat, SOLE reading each (before) vs. average of stable-run measurements (after):**
before ≈ 161.5s, after ≈ 57.0s — **≈104s removed**, all measured under real, named contention (see
"conditions" below), never a quiet box.

**The removed-sleep-time prediction matches the observed reduction almost exactly**, file by file — the
strongest evidence this is the mechanism, not incidental host noise:

| file | theoretical sleep removed | observed reduction (range) |
|---|---|---|
| `pending-op-settle-lineage.mjs` | 3×(15000−400) = 43.8s | 38.2–43.8s |
| `wake-auto-cancel-on-settle.mjs` | 1×(15000−400) = 14.6s | 13.3–14.4s |
| `run-gate-result-consumption.mjs` | 16000−400 = 15.6s | 14.6–16.4s |
| `run-gate-cancelled-retention.mjs` | ≈14s (multiple sites) | 13.2–13.6s |

### Conditions stamped on every reading

**LOOM SIBLING MERGE GATE ACTIVE throughout nearly this entire pass** — corroborated two ways: this
worker's own `gate_queue` reads (a Loom-project merge gate running continuously, `elapsedMs` >700s at one
check; a Codescape merge gate co-tenanting the same 2-slot cap earlier in the session), and the manager's
own op ledger (two Loom merge gates, `079f3a6a` then `3c712d4e`, covering essentially the whole pass — see
DoD-5's precise per-run overlap table). Never a sole/quiet box — consistent with this project's "the gate
is the load" finding: no quiet-box reading is obtainable in principle.

**⚠️ Honest limitation on the before/after table above:** the "before" and "after" figures were captured
via ad-hoc individual `node test/<file>.mjs` invocations timed with relative (`date +%s%3N`) deltas, not
the harness's own UTC-stamped per-run mechanism — so, unlike the DoD-2/5 background pass, these specific
readings cannot be precisely cross-referenced against the manager's gate-window ledger after the fact. The
"before" batch (the single-run baseline column) ran earlier in the session, plausibly closer to (or
partly within) a genuinely gate-free window per the manager's data; the "after" stability batches ran
later, overlapping the `079f3a6a`/`3c712d4e` gate windows more. **This means the before→after comparison in
that table is not proven to be an apples-to-apples contrast on contention alone** — some of the apparent
improvement could in principle be confounded by a condition change rather than purely the fix. The
strongest evidence the reduction is real and mechanism-driven, not a contention artifact, is the
theoretical-vs-observed match immediately above: each file's predicted sleep-time removal (computed purely
from the code change, independent of any host condition) tracks its observed reduction within a few
seconds — a contention-driven explanation would have no reason to land that close to a specific,
code-derived number.

### A regression caught and reverted, not shipped (correctness over speed)

`merge-confirm-completion-nudge.mjs` (6 scenarios, ~88.7s unmodified, 5 of them spawning REAL child
`node -e "setTimeout(...)"` processes past the old 12s budget) was attempted with the same recipe
(budget→500ms, gate sleep→2000ms). **Scenario (3) — the "fast path, no gateCommand, resolves
synchronously" case — started failing**: `r.settled` came back `false` (queued, `state:"running"`)
instead of `true`. Diagnosis: this file shares **ONE `SessionService` instance across all 6 scenarios**,
so they share one `GateSemaphore` (`maxConcurrentGates` defaults to 1 in this fixture). The original 13s
gate durations left enough natural slack between scenarios for the semaphore to fully clear before the
next one started; shrinking the sleep to 2s removed that slack, and scenario 3's own call now genuinely
queues behind scenario 1/2's still-draining gate. **This is a real, pre-existing inter-scenario
dependency the old margins were masking, not a bug in the fix's arithmetic.** A correct fix needs an
explicit settle-wait between scenarios (the pattern scenario (5) in the same file already uses for its
own bookkeeping — waiting for the task to reach `done` and the worktree to be removed, not just the
nudge) — applied to scenarios 1/2/4 too. That's real, careful per-scenario work, not a constant tweak, so
it was **reverted rather than shipped partially-understood** (`git checkout --` the one file; the
production DI seam and the 5 other files are unaffected).

**By contrast, `pending-op-settle-lineage.mjs` ALSO shares one `SessionService` across its 3 sequential
scenarios (A)/(B)/(C) — but is safe**, because none of its scenarios assert synchronous/fast settlement;
all three already expect the pending/async path throughout, so a residual semaphore hold from a prior
scenario can only add to an already-expected wait, never flip a "settles fast" assertion to false. Re-run
5 times total (2 before this note, 3 more after diagnosing the `merge-confirm-completion-nudge.mjs`
regression, specifically to stress-test this exact risk): 5/5 PASS, 0 failures, ~8.6–9.6s each.

### Known-deliberate cost the card named, and its actual siblings

The card named `run-gate-cancelled-retention.mjs`'s ~16s sleep as a known deliberate cost and asked to
look for siblings (cross-referencing `c976f009`). **`c976f009` is a different, non-overlapping concern**
— it catalogs small (50–500ms) blind sleeps for FLAKE-RISK/correctness reasons (poll-vs-sleep hygiene),
not wall-time. The actual siblings for THIS card's wall-time question were the other four files in the
table above, all traced to the same root cause (`SYNC_ATTACH_BUDGET_MS` non-injectability) and fixed by
the one shared DI seam.

**A larger sibling class exists beyond what this pass fixed, found but NOT attempted**, given the
regression above demonstrated this class needs individual care, not a batch constant-swap:

| file | current (unmodified) wall time | why not attempted |
|---|---|---|
| `merge-confirm-completion-nudge.mjs` | 88.7s | attempted, reverted (see above) — needs per-scenario settle-waits |
| `worker-run-gate-completion-nudge.mjs` | 47.5s | mirrors `merge-confirm-completion-nudge.mjs`'s single-shared-`svc`-across-scenarios structure (one `svc` at module scope, line 106) — same risk class, not attempted for lack of remaining time to diagnose safely |
| `gate-status.mjs` | 41.9s | **structurally safer** — 8 independent `SessionService` instances (fresh per scenario, injected fake `runGate` functions, not real spawns) — plausibly fixable with the same low-risk recipe as the 5 landed files, but not attempted this pass for lack of time; a good first candidate for a follow-up |

Combined, ~178s of further-reachable wall time exists in these three files, at varying risk. Recommend a
dedicated follow-up card rather than folding into this one under time pressure.

## DoD-6 — the deliberate-cost sibling search (see table above)

Answered as part of DoD-4/5: a full-suite scan for blind `sleep`/`setTimeout`/`delay` calls ≥2000ms (both
literal and `_`-separated numeric literals) across all 627 hermetic files found 12 call sites in 8 files.
A broader identifier-based scan (constants like `HOLD_WAIT`, `pollMs`, `OVERLAP_TIMEOUT_MS`) found 51 more
call sites, nearly all either already-tiny injected test constants (e.g. `pty-giveup-*`'s
`LOOM_GIVE_UP_HOLD_MS`-driven `HOLD_MS=10`), pure polling intervals, or Promise.race safety-net ceilings
that cost nothing on the pass path. One exception, `pty-mode-convergence.mjs`'s `sleep(6000)`, tests a
real, deliberately-tuned production timing window (`MODE_LOG_POLL_MS`/`MODE_CYCLE_SETTLE_MS`) that this
repo's own CLAUDE.md explicitly documents as "a deliberate trade... not to be re-optimized here" — left
untouched by design, not oversight.

## Note on the shared `6c1aadf7` data file's `runIndex` 3

`docs/investigations/6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson`'s `runIndex` 3 is
CONTAMINATED and excluded from every analysis in this document. This pass's first attempt at a clean
triplet (intended as `runIndex` 3-5) was itself disturbed by concurrent `pnpm build` invocations while
still executing (a mistake, recorded as project memory `per-file-timing-harness-mid-run-rebuild-contaminates`
so it isn't repeated); `runIndex` 3 completed with a spurious `run-gate-cancelled-retention` failure
directly attributable to that contamination, and the pass was killed before `runIndex` 4/5 could run. Left
in the NDJSON rather than deleted, per this investigation's own data-retention convention (mirrors
`6c1aadf7`'s own handling of its aborted run 3) — every DoD-2 number above filters to `runIndex >= 6`, the
genuinely clean re-run this card actually used.

## Reproduce this

```sh
# DoD-1 (read-only DB mining, safe against the live WAL DB):
cd docs/investigations/99fb882e-gate-suite-timing
node scripts/extract-gate-events.mjs --project c36e8691-44d8-44ae-91ed-1bae3c632b33 --out data/loom-build-gate-series.json
node scripts/rising-floor-report.mjs

# DoD-2/3 (per-file timing, reuses 6c1aadf7's harness):
cd packages/daemon
node ../../docs/investigations/6c1aadf7-daemon-suite-timing/scripts/measure-per-file-timing.mjs --runs 3 --start-index N
node scripts/test-daemon.mjs --count

# DoD-4/5 before/after (build clean between each):
pnpm build
node packages/daemon/test/<file>.mjs
```
