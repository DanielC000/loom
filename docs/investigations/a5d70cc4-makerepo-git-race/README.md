# Card a5d70cc4 — makeRepo git-init race: reproduction attempt, UNREPRODUCED

## THE ANSWER, first line

**Not reproduced.** Several thousand concurrent git subprocess invocations, across 5 distinct
concurrency shapes, under both idle and CPU-saturated host conditions, produced **zero** failures.
This does **not** mean the race does not exist — the real corpus shows it does (see below) — it means
the mechanism is not "concurrent git alone," and CPU contention is not what triggers it. Disk and
process/handle-table pressure remain untested; see §What remains untested.

## What I ran

All 5 fixture-code shapes below are extracted **verbatim** from the real test files (not paraphrased),
and driven as **separate OS processes** — matching how `node --test`'s pool actually runs separate test
*files* concurrently. Driving the same chains as concurrent `Promise`s inside one Node process would
have been a vacuous test: `execSync` is synchronous and blocks the event loop, so "concurrent" execSync
calls in a single process just serialize and would trivially show zero failures regardless of whether a
real race exists. Every trial below spawns genuinely separate processes.

Two fixture-code shapes were exercised:
- `packages/daemon/test/merge-rest-route-tracked.mjs:56-60` — one chained `execSync`: `git init -q &&
  git config user.email ... && git config user.name ... && git add . && git -c ... commit -q -m init`.
- `packages/daemon/test/task-defer-until.mjs:45-51` — two **separate** `execSync` calls: `git init -q`,
  then `git -c user.email=... -c user.name=... commit --allow-empty -q -m init` (no local `git config`
  writes at all in this variant — see §Code-reading exclusion below).
- `packages/daemon/test/merge-repo-mutex.mjs:149-164` — the shape that produced this card's own attested
  `:160` specimen: an init+commit chain, then `git worktree add -q -b <branch> "<wt>" HEAD`, then a file
  write plus an add+commit chain inside the new worktree, x2 branches per repo.

Five trials (scripts in `./scripts/`, raw captured stdout in `./run-output.txt`):

| # | Script | N × rounds | Host condition | Chains | ~git.exe procs | Failures |
|---|--------|-----------|-----------------|--------|-----------------|----------|
| 1 | `repro-makerepo-race.mjs` | 3 × 20 | idle | 60 | ~300 | 0 |
| 2 | `repro-makerepo-race.mjs` | 15 × 10 | idle | 150 | ~750 | 0 |
| 3 | `repro-makerepo-race.mjs` | 20 × 8 | 20 concurrent CPU-hog processes, oversubscribing 16 logical cores | 160 | ~800 | 0 |
| 4 | `repro-lifecycle-race.mjs` | 25 × 6 (full init+2×worktree-add+commit lifecycle) | 24 concurrent CPU-hog processes, 240s | 750 op-groups | ~1650 | 0 |
| 5 | `bash-race.sh` | 60 × 1 (raw bash-backgrounded, no Node spawn overhead) | idle | 60 | ~300 | 0 |

**Totals: 1,180 command chains, ~3,800 individual git.exe process invocations, 0 failures.**
Trial #1's N=3 deliberately matches the suite's real pool size (`pool size 3`, per this card's own
§STALE FACT CORRECTED); the others deliberately exceed it to stress the mechanism harder than the
suite itself does.

**What I deliberately did not run:** the real `node --test` harness driving actual test files
concurrently (heavier, much slower, and manager-directed not to run it after this checkpoint — see the
card's own decision thread). Everything above is the extracted fixture code run standalone, not the
full daemon test suite.

## Host conditions

- git `2.47.0.windows.2`, Node `v22.16.0`, 16 logical cores.
- Locale `de-AT`, active codepage `850` (`chcp` → `Aktive Codepage: 850`) — matches this card's own
  kickoff note that the production host is "Windows, German locale + CP850."
- Windows Defender real-time protection: confirmed **ON** (`Get-MpComputerStatus` →
  `RealTimeProtectionEnabled: True`) for the entire investigation — AV-mediated file-handle contention
  was therefore a live possibility throughout, not a condition I failed to enable.
- CPU saturation: trials 3-4 ran under 20-24 busy-loop Node processes (`scripts/cpu-hog.mjs`),
  oversubscribing the host's 16 logical cores by 1.25-1.5x, for 90-240s spans covering the whole trial.

## Result, against the real corpus

Per the manager's read of the gate-timing corpus (`gate_history`, not independently re-verified by me
in this investigation): failures per file across the whole timing corpus —
`merge-rest-route-tracked` 5/360 (1.4%), `merge-hang-does-not-wedge-queue` 2/382,
`merge-repo-mutex` 1/376, `worktree-provision` 1/373, `task-defer-until` 1/375 — **10 failures / 1,866
file-runs ≈ 0.54%**. The positive control on the same instrument, `kickoff-real-spawn`, is 28/383
(7.3%), so the instrument itself is not blind to failures at that rate; the low counts above are real
lows, not an artifact of a broken counter.

**Both facts stand together, not in tension:** the failures are real and rare (~0.5%), and this
investigation's several-thousand-invocation zero says the trigger is not bare concurrent-git contention
at the concurrency levels and CPU-saturation levels tested here. A ~0.5% per-file rate could easily
require tens of thousands of trials to hit even once if concurrent git *were* the whole mechanism at
this saturation level — so a clean zero over ~3,800 process invocations is informative but not
definitive on its own; see §What remains untested for the gap this leaves.

## Code-reading exclusion of the shared-global-config candidate

Independent of reproduction, reading the fixture code itself rules out one of the card's three named
candidates. The card asks whether "`git config` writing a shared global/system file" could be the
mechanism. It cannot, as the code is actually written:
- `task-defer-until.mjs`'s variant never calls `git config` at all — it passes identity via `-c
  user.email=... -c user.name=...` command-line overrides, which never touch any file, shared or not.
- `merge-rest-route-tracked.mjs`'s variant does call `git config user.email`/`git config user.name`,
  but with **no `--global` flag** — a bare `git config` writes only the invoking repo's own
  `.git/config`, never a shared file.

Neither writes to `GIT_CONFIG_GLOBAL` or a system-wide file, so this candidate is dead on the code
itself, not merely unobserved. The remaining two named candidates — a shared git *template* dir, and
plain disk/subprocess contention — were not discriminated between, because no failure ever occurred to
attribute to either.

## What remains untested — the best lead for the next reader

- **Disk and process/handle-table pressure were never generated.** Every trial here saturated CPU
  (busy-loop JS, no I/O) but never stressed disk I/O or the OS process/handle table beyond what the git
  chains themselves produce. If the real mechanism is disk contention (many repos' `.git` directories
  being created/written concurrently on a slow or antivirus-intercepted disk) or process/handle
  exhaustion under sustained *load*, this investigation would not have found it — CPU business does not
  substitute for either.
- **The attested failure signature is unusual for git and is the sharpest remaining lead.** Both
  attested specimens (`merge-repo-mutex.mjs:160`, and the `task-defer-until` specimen referenced by this
  card) show a git subprocess exiting `status:1` with **EMPTY stdout AND EMPTY stderr**. Git almost
  always writes *something* to stderr when it fails — a clean, silent, nonzero exit is more consistent
  with the git.exe **process itself failing to start or being killed/interrupted before it could write
  anything** (e.g. an AV real-time-scan lock on the freshly-written git.exe image or a DLL it loads,
  or the OS refusing `CreateProcess` transiently under load) than with an ordinary git-level error. A
  future attempt should target *this* asymmetry directly — e.g. reproducing under real disk/AV pressure,
  or capturing process-creation-level diagnostics (ETW/Process Monitor) during a failing run — rather
  than repeating the CPU-saturation approach this investigation already covered.
- **The real `node --test` harness was not run** (see §What I ran) — it exercises additional weight
  (large `dist/` ESM imports, `better-sqlite3` native module loads, real daemon service code) alongside
  the git chains that this investigation's extracted-fixture harness does not reproduce. That combined
  load is untested here.

## Files in this directory

- `run-output.txt` — raw, unedited stdout from all 5 trials.
- `scripts/cpu-hog.mjs` — CPU-saturating busy-loop, used as background load in trials 3-4.
- `scripts/repro-child-worker.mjs` / `repro-makerepo-race.mjs` — trials 1-3 (single init+commit chain,
  N processes in parallel).
- `scripts/repro-child-lifecycle.mjs` / `repro-lifecycle-race.mjs` — trial 4 (full init+commit +
  2×worktree-add+commit lifecycle, N processes in parallel).
- `scripts/bash-race.sh` — trial 5 (raw bash-backgrounded, no Node spawn overhead).
