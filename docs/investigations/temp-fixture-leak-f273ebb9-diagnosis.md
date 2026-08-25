# %TEMP% fixture-dir leak — diagnosis (card f273ebb9)

Measured 2026-08-25, ~03:00-03:10Z, on the live self-hosting host (`C:\Users\danie\AppData\Local\Temp`). This is a diagnosis-only pass — no deletions, no code changes. All commands run are read-only enumeration/timing against `%TEMP%` (scoped to `loom-*` names only) plus forensic reads of an existing log file (`~/.loom/gate-timing/daemon-per-file-timing.ndjson`); no `run_gate` or full suite was run.

## 1. Count by prefix family — THE DISTRIBUTION IS EVEN, NOT ONE DOMINANT SITE

`Get-ChildItem $env:TEMP -Directory | Where Name -like 'loom-*'`:

- **4,864** `loom-*` dirs at measurement time (15,504 total entries in the TEMP root — lower than the card's 17,107/5,308 because of routine activity between the two measurements, not a discrepancy in method).
- Grouped by the second hyphen-token (`loom-<family>-...`): **71 distinct families**. Top family (`td`) is only **23.7%** of the total (1,155 dirs). 34 families have ≥50 entries; 41 have ≥20.
- Recency: **433 created in the last 6h**, **36 in the last 1h** — actively regenerating, confirming the card's own "live production" claim.
- Verified 1:1 against source: every family name I checked (`td`, `mgru`, `ecg`, `skills`, `companion`, `mgid`, `sfr`, `wg`, `mgr`, `mslw`, `mcn`, `mst`, `gc`, `lats`, `concstamp`, `mrt`, `opid`, `gh`, `broken`, `platrestart`, `gtb`, `idle`, `credential`, `mcvc`, `prbc`, `wpr`, `setup`, `archive`, `mcl`, `vv`, `rmf`, `pending`, `ngbd`, `mhdwq`) maps to exactly one `packages/daemon/test/*.mjs` file's own `os.tmpdir()` literal.

**⇒ The distribution IS the diagnosis, per the card's own framing: an even spread across ~71 independent test files means the cleanup MECHANISM is unreliable, not that one call site is broken.** Every family I traced back to source (including ones already migrated onto the good shared helper, e.g. `mgru`→`merge-gate-reuse.mjs`, `ecg`→`emit-compare-gate.mjs`) still leaks — so "not yet migrated to the shared helper" cannot be the whole story either (see §3).

## 2. Why they survive — TWO real, distinct, evidenced mechanisms

### 2a. PRIMARY mechanism (explains the bulk + the spread): the gate force-kills its own process tree, bypassing every cleanup hook regardless of how well it's written

`packages/daemon/src/orchestration/gate-runner.ts`'s `killGateProcessTree` (fired from **two** call sites — a genuine step timeout at `onTimeout`, and a **cancellation** at `onCancel`) does, on win32: `spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"])` — a forced (`/F`) kill of the **whole subtree** rooted at the shell running `pnpm --filter @loom/daemon test:daemon`. This is documented in `_tmp-fixture.mjs`'s own header as known non-coverage ("neither `beforeExit` nor `exit` fires on SIGKILL, `taskkill /F`... this helper cannot prevent that and does not claim to") — but that header only names the mechanism; nobody had connected it to gate cancellations/timeouts actually happening on this host until now.

When this fires:
- `scripts/test-daemon.mjs` (the runner) is killed before it ever reaches its own `for (const root of tmpRoots) cleanupPathSync(root);` sweep (line 1379) — **every** `loom-td-<file>-*` home dir created so far in that run (one per test file, tracked in the parent's own `tmpRoots` array) leaks in one shot. This is why `td` is the single largest family.
- Whatever test file(s) happen to be actively executing in the runner's lanes at that instant are ALSO force-killed — their own `beforeExit`/`exit` hooks (installed by `_tmp-fixture.mjs`'s `mkdtempManaged`/`registerForCleanup`) never fire either, **regardless of whether that file uses the good shared helper or a hand-rolled one** — a forced kill bypasses Node's JS-level shutdown entirely, so code quality at the call site is irrelevant here. This explains why even already-migrated files (`merge-gate-reuse.mjs`, `emit-compare-gate.mjs`, `skills-adopt-fastforward.mjs`, `companion-ack-not-recorded.mjs`, all of which correctly import and call `registerForCleanup`/`cleanupPathSync`) still show up in the leak.

**This is not speculation — I found direct, existing evidence for it**, no new gate run needed: `~/.loom/gate-timing/daemon-per-file-timing.ndjson` (a 78MB append-only log `appendGateTimingRow` already writes for every daemon-test run) records a `"kind":"file"` row per test file and exactly one `"kind":"run-summary"` row per run — and the run-summary is written *after* the `tmpRoots` cleanup line, in the same synchronous flow. So a run with `file` rows but **no** `run-summary` row proves the runner was killed before reaching its own cleanup. Scanning the last ~48h (87 distinct run UIDs with activity): **6 runs have file activity but no run-summary**:

| runUid | first file start | last file end | file-rows recorded (≥ dirs leaked from this kill alone) |
|---|---|---|---|
| 1787495585301-15076 | 2026-08-23 14:33:05Z | 2026-08-23 14:37:01Z | 258 |
| 1787502213128-12388 | 2026-08-23 16:23:33Z | 2026-08-23 16:25:18Z | 174 |
| 1787512345028-40140 | 2026-08-23 19:12:25Z | 2026-08-23 19:13:31Z | 81 |
| 1787512353746-43452 | 2026-08-23 19:12:33Z | 2026-08-23 19:13:34Z | 74 |
| 1787577086170-33312 | 2026-08-24 13:11:26Z | 2026-08-24 13:13:17Z | 197 |
| 1787578054900-42672 | 2026-08-24 13:27:35Z | 2026-08-24 13:28:24Z | 59 |

Sum: **843** tracked `loom-td-*` homes present at time of death across just these 6 events — the right order of magnitude for the measured 1,155-strong `td` family. All 6 durations (4-13 minutes) are far below the project's configured hard gate timeout (`gateCommandTimeoutMs` — the 30-minute-class ceiling `my_context` reports), which points at the **cancellation** path (`onCancel`, e.g. a manager cancelling a now-redundant self-check gate, or a daemon restart aborting an in-flight gate) rather than the timeout path — both routes share the identical `killGateProcessTree`, so the leak mechanism is the same either way. I did not attempt to further distinguish which of the two triggered each of the 6 (out of scope for this pass and not needed to make the fix decision — the fix, if any, is at `killGateProcessTree`/graceful-shutdown, not at either trigger).

**This mechanism alone explains both DoD sub-questions:** the dominant `td` family (one kill event leaks dozens-to-hundreds at once) AND the broad 71-family spread (whichever file(s) happened to be mid-flight at each of many kill events over weeks).

### 2b. SECONDARY, compounding mechanism: most test files were never migrated onto the robust cleanup helper, and most of those have zero retry logic at all

The Aug 24 fix (`f0d0ead2` + three follow-ups `72baaab7`/`8519b73e`/`7b3e6458`, all already on `main` — confirmed via `git merge-base --is-ancestor`) migrated **215** files onto `_tmp-fixture.mjs`'s `registerForCleanup`/`cleanupPathSync`/`mkdtempManaged` (bounded retry, a REAL 100ms delay between attempts, `beforeExit`+`exit` dual-hook coverage). I found **635** files across `test/` and `scripts/` that construct an `os.tmpdir()` + `loom-` literal path. That leaves **420 files (≈66%) not on the shared helper**:
- **123** of those 420 have some retry/backoff token of their own (quality not individually audited this pass — may or may not be the same zero-delay-retry defect the original fix eliminated elsewhere).
- **297 (≈71% of the 420)** do a single-attempt `fs.rmSync`/`fs.rm` with no retry at all — vulnerable to a transient Windows EBUSY/EPERM even in a completely normal, non-killed run (the exact defect class `f0d0ead2` fixed, just not yet extended past its original scope).
- **At least 4 files have NO removal call anywhere for their temp path** — an unconditional leak on every single run, independent of §2a entirely: `companion-trust-window-retrofit.mjs`, `resolve-directive-outcome-stream-guard.mjs`, `resume-mode-feedback.mjs`, `skills-dev-only-retirement-coverage.mjs` (verified by reading each file in full — no helper import, no `rmSync`/`rm(` anywhere in the file).

I did not individually audit all 420 files' cleanup correctness (out of scope for a diagnosis pass) — the 123/297/4 breakdown above is a grep-based classification (files containing `attempt`/`retry`/`MAX_ATTEMPTS`/`Atomics.wait` vs. not, and files containing no `rmSync`/`rm(` call at all), not a per-file code review. Treat the 4 "zero coverage" files as confirmed; treat the 297 "no retry token found" figure as a strong signal, not a certified count.

**Neither mechanism is the whole story alone.** §2a explains why even well-written cleanup fails. §2b explains why a large fraction of the suite is still running the exact hand-rolled pattern the Aug 24 card already showed doesn't survive a transient Windows lock, on top of that.

I did not find evidence either way for the card's own third candidate (a WAL/sqlite handle staying open past process end on an otherwise-graceful exit) beyond the one instance already fixed and documented (`skills-adopt-fastforward.mjs`, per project memory `temp-fixture-leak-a1f72ab8-root-cause-and-fix`) — not re-investigated this pass.

## 3. Performance cost — HYGIENE, not performance. Confirmed a second way.

The card already measured enumeration (0.196s for 17,107 entries) and ruled that out. I measured **directory CREATION** specifically, as asked:

- 200 `New-Item -ItemType Directory` calls directly in the crowded `%TEMP%` root (~15.5k entries at the time): **184ms total (0.92ms/op)**.
- The same 200 calls in a freshly-created, empty sibling directory: **185ms total (0.925ms/op)**.
- Repeated across 3 more trials of 300 ops each: crowded 291/306/211ms vs. clean 272/296/279ms — no consistent direction, differences are pure run-to-run noise (NTFS directory indexing is B-tree based, not a linear scan, so this null result is expected, not surprising).

**Verdict, plainly: this is hygiene/toil, not a performance problem.** Directory creation cost in a TEMP root with 15k+ entries is indistinguishable from a clean directory. Combined with the card's own enumeration timing, there is now no measured operation (enumeration OR creation) that this leak measurably slows down. **Do not carry this card as contributing to the `4dfc648a` gate-reliability problem** — if anything the causal arrow may run the OTHER way (a `4dfc648a`-class gate failure/cancellation is a plausible source of new leaked dirs via §2a, not the reverse).

## 4. Reaper proposal (NOT built this pass, per the card's explicit ask to propose only)

Goal: automatic + bounded, so nobody is ever asked a 4th time (per `0260f06b`/`965b815f`/`80aa39db`).

- **Scope strictly to `loom-*`-prefixed entries directly under the TEMP root** — never a blanket sweep, matching the card's hard constraint.
- **Age-gate, not liveness-probe**: only reap entries older than a bound safely beyond any real single test-file run or gate run (e.g. a few hours) — this sidesteps having to positively prove "no live daemon/worker is using this dir" for every candidate, since anything that old cannot belong to a run still in progress. A short-lived false-negative (skip a genuinely-abandoned young dir) is fine — it'll be swept on the next pass; a false-positive (reap something live) is not, so bias conservative on the age threshold.
- **Reuse `_tmp-fixture.mjs`'s `cleanupPathSync` verbatim** for the actual removal — same bounded-retry-with-real-delay, same "log and move on, never throw, never retry a hung `fs.rm`" contract already proven correct (per memory `worktree-gc-threadpool-leak`: a retry LOOP over a hung `fs.rm` previously leaked libuv threadpool threads and wedged the daemon — the existing helper's `MAX_ATTEMPTS=5` bound with a real per-attempt timeout budget already avoids that shape; a reaper must not reimplement its own retry loop).
- **Run it as a step the suite invokes itself** (e.g. at the start of `scripts/test-daemon.mjs`'s full run, before spawning lanes) rather than a human-triggered or scheduled job — this is what actually closes the "ask a human" loop, since it runs on every suite invocation with no approval needed per the card's own framing.
- **Bounded total time per invocation** (e.g. skip the reap and log a count if the candidate set is huge, rather than blocking suite start on removing tens of thousands of entries) — a reaper that itself becomes a multi-minute blocking step defeats its own purpose.
- Does **not** address §2a's root cause (the force-kill itself) — that's a separate, larger question (should a cancelled/timed-out gate's process tree get a grace period / SIGTERM-then-wait before `/T /F`, on platforms where that's meaningful?) that I'm surfacing but not recommending action on this pass — it trades leak-prevention against the existing "never retry a hung kill, never let a wedged child block the gate" invariant, which is a real design tradeoff for the owner/manager to weigh, not a slam-dunk.

## What I did NOT do (explicit, per DoD's own honesty standard)

- No `run_gate`, no full suite run.
- No deletions of any `loom-*` entry in `%TEMP%` (my own scratch test dirs, created and removed during the creation-timing measurement, are confirmed gone — verified by a fresh listing after cleanup).
- No per-file code review of the 297 "no retry token" files or the 123 "has some retry token" files — classified by grep pattern only, named as such above.
- No attempt to determine, for the 6 killed gate runs, whether each was a cancellation or a hard timeout — both share the identical kill mechanism, so it doesn't change the diagnosis, but it is unresolved.
- Did not re-investigate the WAL/sqlite-handle candidate beyond the one instance already documented as fixed.
