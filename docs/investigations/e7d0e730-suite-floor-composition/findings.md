# e7d0e730 — the suite floor rise: composition, not a platform regression

Card `e7d0e730` ("the suite's duration FLOOR is still climbing ~99% in 11.5 days — diffuse, not test-count, and it will re-eat the 1500s budget") asked whether the rise is a continuous drift, one or more step changes, or a shared multiplier — and explicitly forbade shipping a linear extrapolation before establishing the shape. This document answers it.

**No production code was changed. No `run_gate`, no full suite was run against the CURRENT tree.** Two near-misses at running something unintended in the OLD tree were caught and stopped before they executed anything real — see "Two near-misses," below; both are on the record because they are methodologically relevant, not because anything went wrong in the end.

## Summary of the answer

**The floor rise is dominated by the suite honestly growing: more tests (+31.2%, same-instrument) and heavier ones (NEW-file mean 4546ms vs UNCHANGED-file mean 1731ms), with existing tests contributing only a small residual (bounded by direct measurement at roughly +6-7%). No platform-side shared multiplier was found where one would have been most visible.** The card's own "+3.3%, count is not the mechanism" premise rested on a comparison of two numbers produced by different discovery instruments; same-instrument, the count grew 10x more than that.

## Background — DoD-1, the shape, and why a shared multiplier was the working hypothesis

Before this document's own checks, DoD-1 (establish the shape of the rise) was answered from an independent re-derivation of the historical `orchestration_events` series (read-only DB extraction, matching the card's own cited table exactly, then extended one query further to 2026-08-01: floor 458s→534s→643s→691s→711s→738s→779s→809s→798s→912s, 07-21→08-01). The shape was not a single clean step nor uniform drift: a fast early rise (07-21→07-23), a shallower ~15s/day middle segment (07-24→07-31), and a fresh jump on 08-01.

Two confounds were checked and ruled out before treating that jump as real:
- **Order-statistic / sample-size effect** (a daily minimum's expected value depends on how many draws produced it): a sample-size-matched bootstrap (with-replacement resampling to a common `k` per day, 10,000 resamples/day, seed 12345) reproduced the same rising shape at both `k=3` (the window's global minimum `n`) and `k=15` (excluding one thin day) — the rise is not manufactured by `n` varying.
- **Gate-admission-invisible host load**: `concurrentGates` (the existing historical field) only captures contention AT ADMISSION, not mid-run joins. A worker-session-existence proxy (the `sessions` table's own `created_at`/`last_activity`, filtered to drop 6 stale/leaked >24h-span rows) showed the 08-01 jump *survives and slightly strengthens* when restricted to low-worker-concurrency runs (803s→944s vs the raw 798s→912s) — the opposite of what a contention artifact would predict. This instrument is coarse (session *existence*, not CPU proof) and its low-concurrency samples thin out late in the window (n=2-3), so it was reported as suggestive, not decisive.

With a genuine, non-artifactual rise established, the working hypothesis became a "shared multiplier" — something common to most tests getting more expensive (shared setup, module load, a platform regression). The rest of this document tests that hypothesis directly and finds a different mechanism.

## 1. The reconciliation — the magnitude a shared multiplier would need

Floor: 458s (07-21) → 912s (08-01) = **+454s**, over the card's own cited test count (607→627). At gate concurrency `C`, total per-file CPU ≈ wall × `C`:

| | 07-21 (implied) | 08-01 (implied) | per-file Δ needed |
|---|---|---|---|
| C=1 | 0.76s/file | 1.46s/file | **+0.70s** |
| C=2 (this project's configured parallelism) | 1.51s/file | 2.91s/file | **+1.40s** |

A **proportional** (percentage) model gives the friendlier comparison: on the ~500-650ms files tested below, a proportional doubling implies **+250-325ms** per file.

## 2. The A/B — a controlled retrospective re-execution

DoD-3 asked to measure a fixed, unchanged test file across the historical window to separate "tests got heavier" from "the platform under them did." That can't be done with historical data — no per-file timing was ever captured before 2026-08-01 (the only per-file dataset, `docs/investigations/6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson`, is entirely stamped today). Instead: a controlled **retrospective re-execution** — same host, same hour, same measurement method, only the tree differs. This is strictly better than the historical data would have been, since it eliminates the condition-variation problem a real historical series would have carried anyway.

**Setup:** a second worktree checked out at `0387f95a` (2026-07-21T06:44:42Z, the tree just before the duration-instrumentation window began), installed (`pnpm install --frozen-lockfile`) and built (`pnpm build`) independently, outside `.loom-worktrees` (so it wasn't reachable by worktree GC) and outside the worker's own worktree (so it survives past this task).

**Dependency equivalence, verified three ways** (so any measured difference is attributable to Loom's own source, not deps): (1) `pnpm-lock.yaml` is byte-identical between `0387f95a` and HEAD (`git diff --quiet`, clean). (2) `node_modules/.pnpm` package-set listings are identical between the two trees (401/401, zero diff). (3) `better-sqlite3` and `node-pty` both load and run correctly in both trees on the same Node (v22.16.0) — no native-module ABI mismatch.

**File selection, by variance not mean** (from today's 3-run per-file data): `companion-messages` (533/544/521ms, ~4% spread — primary) and `config-bounds` (510/550/443ms, ~20% spread — secondary). A third candidate, `tasks-get-taskid-alias` (~36% spread), was dropped as too noisy to resolve anything at 6 pairs.

**Design:** 1 warmup run per tree per file, **discarded** (the first run pays cold OS/page-cache cost; in a naive old-first order that bias lands entirely on the OLD arm, working *against* the "new is slower" hypothesis, so it's conservative to discard rather than merely tidy). **ABBA counterbalanced order**: alternate old→new / new→old across the 6 pairs, so a systematic within-pair position effect cancels in the aggregate instead of loading onto one arm. **Pairs adjacent in time** (never all-A-then-all-B), so a load step *between* pairs shifts both arms of every later pair equally and cancels in the per-pair difference. Timed by a single Node orchestrator (`execFileSync` + `Date.now()`), so both arms of every pair use the identical measurement method. Script: `scripts/ab-interleave.mjs`; raw result: `data/ab-result.json`.

**Sibling-lane state, recorded at both ends of the interleave:** `gate_queue` empty (cap=2, activeCount=0, queuedCount=0) at the start; identical at the end. No step change on the gate dimension during the ~15-20s the interleave took to run. All 28 runs (incl. warmups) exited `ok=true` — zero test failures confounding the timing.

**Results (order | old ms | new ms | diff = new−old):**

`companion-messages`:
```
1 [old->new]  471 / 474    +3
2 [new->old]  542 / 502   -40
3 [old->new]  486 / 507   +21
4 [new->old]  554 / 721  +167
5 [old->new]  586 / 586     0
6 [new->old]  464 / 496   +32
```
mean diff **+30.5ms** (+5.9% of the old-arm mean, 517.2ms). Sign test (excluding the one tie, n=5): 4 positive / 1 negative, one-sided p=0.1875 — **not significant**.

`config-bounds`:
```
1 [old->new]  644 / 639    -5
2 [new->old]  718 / 781   +63
3 [old->new]  681 / 573  -108
4 [new->old]  513 / 690  +177
5 [old->new]  550 / 559    +9
6 [new->old]  487 / 600  +113
```
mean diff **+41.5ms** (+6.9% of the old-arm mean, 598.8ms). Sign test (n=6): 4 positive / 2 negative, one-sided p=0.34375 — **not significant**.

**The non-significant result is the evidence, not a failure of the design.** Checking it against the reconciliation in §1: the measured effect (+30.5ms, +41.5ms) is **20-40× smaller** than the +0.70s to +1.40s per file a shared multiplier would need to produce, and still ~8× smaller than the friendlier proportional-doubling model's +250-325ms prediction. This holds at either concurrency assumption and under either model — **that robustness is the result**. The initial working diagnosis ("startup-cost dilution makes the effect look underpowered") is retracted: an additive ~35ms difference is not hidden by noise when the true effect would need to be an order of magnitude larger; the effect on these files is genuinely small, not merely hard to see. More pairs would sharpen a ~35ms measurement, not surface a multi-second one — the wrong instrument to sharpen further.

## 3. Composition — where the CPU actually went

Splitting today's 627 hermetic files by their relationship to `0387f95a`'s test directory (git-verified, see §5 for the rename check):

| bucket | n | mean | median | sum |
|---|---|---|---|---|
| UNCHANGED (byte-identical since `0387f95a`) | 237 | 1731.7ms | 814.0ms | 410.4s |
| MODIFIED (existed then, content changed) | 241 | 3336.0ms | 1308.3ms | 804.0s |
| NEW (did not exist at `0387f95a`) | 149 | 4546.0ms | 1549.0ms | 677.4s |
| **all 627** | | | | **1891.7s** |

NEW files alone are **35.8% of today's entire suite CPU** from files that didn't exist at the start of the window. Script: `scripts/composition-breakdown.mjs`.

## 4. Check 2 — does per-file execution account for wall time at all?

Sum of all 627 per-file means = 1891.7s. At `poolSize=2` (the harness's own configured concurrency), predicted wall = 945.9s. Observed wall, today's 3 clean runs: 950.1s / 1003.3s / 894.6s, mean 949.3s. **Predicted vs observed: 945.9s vs 949.3s — within 0.4%.**

This kills the **static** form of the "harness/scheduler overhead" hypothesis: there is no room for a fixed, additive tax living outside the per-file numbers today. It does **not** rule out the **dynamic** sub-form (effective parallelism degrading across the 11.5-day window, inflating wall while per-file CPU stays flat) — there is no historical per-file sum to compute the same ratio for 07-21, so that comparison point doesn't exist. Note the statistic mismatch this comparison makes deliberately: the per-file sum is checked against runs 6/7/8's **mean** wall time (949.3s), not the floor **series' minima** — those are different statistics answering different questions, and 949.3s must never be differenced against 912s.

## 5. The `607` baseline — a fourth outcome: two different instruments, not one wrong number

The card's DoD-3 treated `607→627` (~3.3%) as settled proof that count isn't the mechanism. Checking it:

**Rename detection first** (a renamed file looks identical to a delete+add without `-M`):
```
git diff --name-status -M --find-renames 0387f95a HEAD -- packages/daemon/test
→ 190 Added, 257 Modified, 0 Renamed, 0 Deleted
```
Zero renames, and — critically — **zero deletions** from the whole test directory in the entire window. (This is over the full test dir, a broader population than the 627 hermetic files; it's consistent with the hermetic-only 149 NEW / 241 MODIFIED split below it.)

**Baseline count, by static read** (zero execution — `--count` did not exist at `0387f95a`; confirmed by `grep -n "count" scripts/test-daemon.mjs` in that tree returning no match, and by the near-miss below, which showed what actually happens when that flag is passed to the old script). Instead: `discoverHermeticTests` was imported — never run as a CLI, the same safe pattern `test/census/*` already uses — from the CURRENT `test-daemon.mjs` and applied to the OLD tree's actual on-disk `test/` directory. Script: `scripts/static-read-old-tree-count.mjs`.

```
OLD TREE hermetic count, TODAY'S discovery rules applied retroactively: 478 (0 violations)
NEW TREE (HEAD) hermetic count, same rules: 627 (0 violations)
```

**478 exactly equals the git-derived 237 UNCHANGED + 241 MODIFIED — two independent derivations (a static rule-application walk, and a `git diff` classification) agreeing exactly.** That parity, plus zero deletions found above, means there is no unexplained gap to attribute to reclassified files: 478 is solid.

**But 478 ≠ 607.** Checking why, rather than picking a side: `git log 0387f95a..HEAD -- packages/daemon/scripts/test-daemon.mjs` shows the discovery **algorithm itself** changed materially within the window — not cosmetic tweaks: `9c4d797d` "make test discovery an allowlist that refuses non-test files", `e09e460d` "make the discovered-test set self-reporting and refuse a test-shaped file in an excluded dir", `0e630c15` "audit test discovery against an independent enumeration — the walk cannot check itself".

`607` traces back through the card's own citation chain to `99fb882e`'s findings ("the card's own build-log notes put suite size at ~607 files on 07-21ish") — an eyeballed build-log observation from a still-earlier card, never an instrumented `--count` run (the flag didn't exist yet at any point in that chain). **`607` and `627` are not "one of them is wrong" — they are numbers produced by two different, non-comparable instruments**, on top of an already-uncertain provenance for `607` itself. This is the four-stamp rule (NUMBER · CONDITION · POPULATION · INSTRUMENT) applied to the card's own headline comparison.

**The comparison that survives, same-instrument:** `478` (today's rules, OLD tree) → `627` (today's rules, CURRENT tree) is a valid, same-instrument comparison: **+149 files = +31.2%** — not the card's +3.3%. Off by roughly 10×.

## The decomposition — it closes

| | 07-21 (implied) | today | factor |
|---|---|---|---|
| hermetic files | 478 | 627 | **1.312×** (+31.2%) |
| implied mean/file (sum ÷ files, sum = wall × C=2) | 916s/478 = 1916ms | 1891.7s/627 = 3017ms | **1.575×** (+57%) |
| **product** | | | **2.066×** |

`1.312 × 1.575 = 2.066×` — matching the observed ~99-106% rise (the exact percentage depends on which two floor readings anchor the comparison; 458s→912s is a 99.1% rise, i.e. a 1.991× factor, close to 2.066×). **~31% of the rise is simply more files. Most of the remaining ~57% mean increase is because the added files are heavy (NEW mean 4546ms vs UNCHANGED 1731ms, 2.6×) — not because existing files got slower.** The A/B in §2 independently bounds the "existing files got slower" contribution at roughly +6-7% on the two files it measured directly.

## 6. The (i)/(ii) sample — do existing tests exercise slower product code, or just do more?

Sampling the top 20 of 241 MODIFIED files by today's mean duration (446.3s of the bucket's 804.0s = 55.5% of its weight, from 8% of its files — where a "same test, slower product code" story would be most visible if it existed):

```
merge-confirm-completion-nudge(89.3s) gate-timeout-circuit-breaker(48.1s)
worker-run-gate-completion-nudge(46.4s) worker-kickoff-guarantee(28.5s) worktrees(24.1s)
pty-mode-convergence(23.9s) merge-spawn-tracked(22.0s) worker-run-gate(21.8s)
gate-timeout-extend(16.8s) pty-giveup-clear(15.8s) codescape-lifecycle-hooks(15.5s)
worker-spawn-cap-queue(12.7s) worktree-process-reap(11.0s) gate-semaphore-concurrency(10.9s)
worker-prompt(10.5s) spawn-recut-stale-branch(10.4s) git-identity-warning(9.9s)
manager-context-block(9.9s) merge-gate-diagnostic(9.8s) no-commit-reviewer(9.3s)
```

Classification: **(i)** the test does more (added scenarios/setup/`beforeEach`/fixtures) — mundane, expected; **(ii)** the test body is materially unchanged but exercises changed product code — the shared-multiplier story, if it exists anywhere, would live here.

19 of 20 show heavy net insertions in `git diff --stat` (e.g. `worker-run-gate` +284/−44, `pty-giveup-clear` +151/−76, `gate-semaphore-concurrency` +260/−35). Content-checked a sample of these: `worker-run-gate`, `worker-kickoff-guarantee`, `pty-giveup-clear`, and `gate-timeout-extend` all **add new helper functions** (`waitUntilGatePhase`, `waitUntil`, `raceReport`, `spawnControlDelivery`, `waitForBusyFalse`) — polling/robustness scaffolding, not slower assertions bolted onto old logic. `pty-mode-convergence` converts fixed `sleep(750)` calls to `waitUntil(...,2500)` polling *and* adds a new `_seam-host-fixture.mjs` that routes the fake pty through more of the real `PtyHost.createPty` path — more realistic testing, not a silently slower one.

The one exception, `git-identity-warning` (+6/−6), is a pure plumbing refactor — swapping inline tmpdir cleanup for a shared `mkdtempManaged`/`finishAndExit` fixture (card `995be21f`) — classified as **neither** (i) nor (ii), a neutral rewrite, rather than forced into a bucket it doesn't fit.

**Split: 19/20 clearly (i), 0/20 clearly (ii), 1/20 neutral.** Looking for (ii) in the slice where it would be most visible found not one clean example.

## Two near-misses (both self-caught, both stopped before executing anything real)

1. **An accidental `run_gate` call.** Intending to check the read-only `gate_queue`, `run_gate` was called instead — this fired a real worker self-check gate in this worker's own worktree, exactly the action this card forbids for measurement. Caught immediately via the response's live `opId`, reported before the manager could discover it independently. The op was cancelled by the manager (`outcome:"cancelled"`) — it never completed a suite pass and its row (if any survives) is not a valid duration reading for any population, by outcome rather than by timestamp guessing.
2. **The old tree's `--count` silently starting real execution.** Attempting to verify the `607` baseline by running `node scripts/test-daemon.mjs --count` against the OLD tree ran 120s+ with zero output — not the near-instant result the same command gives on HEAD. Stopped via `TaskStop` rather than waiting it out or assuming it was benign; verified via a `Win32_Process` check, scoped to the old tree's own worktree path (never by image name or port), that no process was left running. Root cause confirmed by reading git history, not by re-running anything: `grep -n "count"` in the old tree's script returns zero matches — the flag didn't exist yet — and commit `14dbc93a` ("fix(daemon): test-daemon.mjs silently runs the FULL SUITE on an unrecognized flag instead of erroring") names exactly this defect. Stopping it was the correct call, established from evidence after the fact, not merely an overcautious guess in the moment.

## What was retracted, and why

- **This investigation's own "process-startup dilution" diagnosis** for the A/B's non-significant result — retracted once the reconciliation in §1 showed the true effect (not just its detectability) is 20-40× too small to be the mechanism; more pairs would not have changed that conclusion.
- **A "~129 files existed then and are gone now" inference**, drawn from `607 − 478 = 129` — retracted; `git diff --name-status -M` shows zero deletions from the test directory in the whole window. The gap is explained by the discovery algorithm changing mid-window (§5), not by real file removal.
- **The `607`-vs-`627` comparison itself** — not "607 is wrong," but discarded as cross-instrument and not comparable. The same-instrument `478→627 = +31.2%` figure survives completely and is the number that retires the card's "count is not the mechanism, settled" premise.

## Condition stamps carried through this document

Every reading above is stated with what it does and does not cover: the A/B's dependency verdict, host state, and design are given in full in §2 rather than asserted; the DoD-1 background section states which population and instrument each figure came from; §4 explicitly separates the mean statistic from the minima statistic to prevent differencing them; §5 states plainly that the static read applies *today's* rules to the old tree, not a reconstruction of what the old script itself counted. No rounded nudge value is differenced against a raw millisecond row anywhere in this document.

## Addendum — a two-instruments-disagree specimen found along the way (`concurrentGatesMax`)

Not part of the card's own DoD, but worth recording alongside everything else here: investigating whether `concurrentGates` (used in the Background section's confound check above) understates gate contention led to checking its companion field, `concurrentGatesMax` (added by card `c6750500` to record true max-concurrency-over-run rather than a snapshot at admission). Widening from one row to the whole corpus before calling anything a defect: **zero of 1876 gate-kind rows** (`build_gate`/`build_gate_retry`/`worker_gate`, every project, all time) in the database carry `concurrentGatesMax` — not a historical-row gap, a total absence, including rows written minutes before this check. The code is genuinely present: `grep -c concurrentGatesMax packages/daemon/dist/sessions/service.js`, run against this worker's own worktree build of current HEAD, returns 16.

`tasks_get(c6750500)` shows it merged with `merged.date: "2026-08-01T09:30:24+02:00"`, which converts to **`2026-08-01T07:30:24Z`** (verified directly — `new Date("2026-08-01T09:30:24+02:00").toISOString()` — not `05:30:24Z` as an earlier report of this figure stated; using the verified value here). The daemon serving this investigation reportedly (per the manager, from a deploy-stale banner not exposed to this worker's own tool surface, so stated as their reading rather than independently confirmed) has a running build dated `10:05:14Z` — after the merge. If both hold, "the process hasn't restarted since before the merge" isn't available as the explanation for a *total* field absence, and the two instruments — merged, built, present-in-dist code, versus zero live rows ever — genuinely disagree. The leading inference (not established here): the banner likely reports the dist artifact's build/mtime, while a running Node process's loaded modules are fixed at startup, so a rebuild without a restart can advance the banner while the executing code stays on the older module graph — meaning the banner can *understate* real staleness. Carded separately as `8ff7ccde` (p2); not investigated further in this document. This has no bearing on the composition finding above — the `concurrentGatesMax` gap only ever mattered for calibrating gate-admission contention, and the Background section's confound check used an entirely independent instrument (the `sessions` table), untouched by this gap.

## What this means for remediation (not scoped here)

If the cost is real, earned test coverage rather than a regression, then "find and remove the shared multiplier" has no target to aim at. **The lever is capacity** — sharding the gate test step, raising lane concurrency, or an explicitly raised budget — not a code fix. Card `6185fbfc` ("shard the gate test step by CLASS — isolate real-spawn tests into their own low-concurrency lane") is where this line of work continues. This investigation does not scope or start that card; it is a separate piece of work and a separate decision.

## Reproduce this

```sh
# §2 — the A/B (needs a separate OLD-commit checkout, built independently; see the card for the exact
# commit, 0387f95a):
AB_OLD_TREE=/path/to/old-checkout/packages/daemon \
  node docs/investigations/e7d0e730-suite-floor-composition/scripts/ab-interleave.mjs result.json

# §3 — composition breakdown (needs an OLD-commit checkout on disk to diff against; no execution):
git ls-tree -r --name-only 0387f95a -- packages/daemon/test | grep '\.mjs$' > /tmp/old-test-files.txt
git diff --name-only 0387f95a HEAD -- packages/daemon/test > /tmp/changed-test-files.txt
node docs/investigations/e7d0e730-suite-floor-composition/scripts/composition-breakdown.mjs \
  /tmp/old-test-files.txt /tmp/changed-test-files.txt \
  docs/investigations/6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson

# §5 — rename/deletion check (pure git, no execution):
git diff --name-status -M --find-renames 0387f95a HEAD -- packages/daemon/test

# §5 — static baseline read (needs the OLD-commit checkout on disk; imports, never executes, the
# CURRENT test-daemon.mjs's discoverHermeticTests):
node docs/investigations/e7d0e730-suite-floor-composition/scripts/static-read-old-tree-count.mjs \
  packages/daemon/scripts/test-daemon.mjs \
  /path/to/old-checkout/packages/daemon/test \
  packages/daemon/test
```

`data/ab-result.json` holds the raw per-pair A/B timing data behind §2's table.
