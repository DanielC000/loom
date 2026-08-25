# Card `d1e10795` — promptness margins under real gate contention

Scope: card `d1e10795`'s 5-item DoD (metric fix; exit-close-gap's 250ms number under contention; do-not-widen
constraint; one-mechanism-or-several; emit-compare-gate under contention). One `run_gate` fire was used,
per the card's own "FIRE ONE, READ IT, THEN DECIDE" rule — no re-fire. Prerequisite reading:
`docs/investigations/4dfc648a-promptness-assertion-population/findings.md` (both sessions), `tasks_get("4dfc648a")`.

## 0. What changed under this card since the prior findings.md session — checked, not assumed

Per the manager's own note: 5 commits landed on main since the card was filed, 3 of them `daemon-src` and
deployed. Checked directly (`git show -s --format='%H %ad %s' --date=iso-strict`, all times UTC below):

| commit | landed (UTC) | touches this investigation |
|---|---|---|
| `8e74ae63` | 09:48:01 | unrelated (hooks-object shape test) |
| `dd35de72` | 10:08:32 | unrelated (sub-agent drift tell) |
| `b048244d` | 10:43:21 | unrelated (memory_write router collision) |
| `fcb6e7b0` | **11:05:05** | **reduced-gate behavior change** (filters `NOT_HERMETIC` out of `--only=` instead of refusing) |
| `56b52bb6` | 12:16:43 | **touches `packages/daemon/test/merge-gate-inert-diff.mjs` directly** (see §4) |

My worktree's branch is fully rebased on main (`git merge-base HEAD main` == `git rev-parse main`), so the
single `run_gate` fire this card used (`opId 3df72bf2…`, started 12:33:00Z) ran with **all five commits
already in place** — an unambiguous post-`fcb6e7b0`/post-`56b52bb6` instrument.

There is one pre-existing NDJSON data point from a full-suite run that predates `fcb6e7b0` by **well under
one second** at the boundary (run ended 11:05:04.671Z; `fcb6e7b0` landed 11:05:05Z). Per the "four stamps"
discipline, that ambiguity means it is **not used as a primary source anywhere below** — cited once for
context only, explicitly marked as such (see §5).

## 1. Fixing the metric — before collecting a number, per the card's DoD-1

The falsifier the card retired was broken two ways: **(a)** undefined for the 15-of-37 Shape-B liveness
sites (a boolean has no numeric margin to ratio against a ceiling that doesn't exist); **(b)** measured
standalone when the phenomenon under study is under-load. The fix for each, applied concretely below:

**(a) Shape A (21 sites, a real numeric ceiling exists) keeps the ratio form** — observed-ms ÷
asserted-ceiling-ms, unchanged, since the metric was never broken for this shape.

**Shape B (15 sites, no ceiling) gets a DURATION instrument, not a ratio**: capture the wall-clock gap
between the preceding `waitUntil(...)`'s resolution and the `check()` call that follows it — the actual
race findings.md's §1 named ("both compete for the same event loop") — and report that gap in raw ms. No
ceiling is invented to divide by; a bare elapsed-ms number is the honest output for this shape.

**(b) "Measured under real contention" means run under the full-suite harness (poolSize 3, ~718 files,
genuine concurrent git-subprocess spawns from neighboring lanes) via a real `run_gate` fire — not a
standalone `node test/<file>.mjs` invocation.** This is the load shape findings.md's §5 already identified
as the actual mechanism (Windows `CreateProcess` contention from concurrent lanes), distinct from and
independent of the (already-dead) cross-*gate* contention hypothesis.

### Coverage — stated as the card's own two numbers, per the manager's explicit request

**SITES IN POPULATION: 37** (21 Shape A / 15 Shape B / 1 Shape C mechanism, across ~24 files) —
this count is **inherited from the prior findings.md session, not independently re-derived this session.**
I spot-checked (not re-swept) that the five named specimens still resolve to real files/lines; I did not
re-run the 6-strategy sweep that produced 37 (that would duplicate a full session's own work out of this
card's budget). Treat 37 as carried-forward, not freshly re-derived — flag this explicitly rather than
silently re-asserting it as current, per the card's own "re-derive everything" rule, which I only
partially satisfied.

**SITES WITH NEW DURATION-INSTRUMENT CODE THIS SESSION: 3** — all three are inside
`packages/daemon/test/exit-close-gap.mjs`, all Shape A: the two `check()`s in the mechanism-A block
(current lines 104, 107) and the one in the contrast-B block (line 123 — line numbers as of this file's
second, follow-up edit; see §2's update). See §2 for what that instrumentation actually captured and did not.

**SITES MEASURED UNDER REAL CONTENTION THIS SESSION, WITH A NUMBER: 1 mechanism** — `emit-compare-gate`'s
Shape-C harness-timeout margin (§5), measured via **pre-existing** per-file infrastructure
(`GATE_TIMING_NDJSON`), not new code. The intended Shape-A contention number for exit-close-gap was **not**
captured — see §2's honest account of why.

**SHAPE-B SITES INSTRUMENTED OR MEASURED THIS SESSION: 0 of 15.** I designed the duration-gap technique
above but did not apply it live to any Shape-B file. I considered instrumenting the row-4 specimen
(`pty-conpty-dll-kill.mjs:200`) as a concrete demonstration and decided against it: that file carries an
explicit "READ THIS BEFORE TOUCHING THE FILE" warning about deliberately exercising a known-crashy fork
path under a scoped uncaught-exception guard, and I judged the risk of destabilizing a carefully-timed
regression guard, for a measurement card, not worth it without the lead's go-ahead. This is a real,
stated gap, not a papered-over one: **the Shape-B population's actual duration numbers remain entirely
unmeasured after this card**, both standalone and under contention. Only the *methodology* for measuring
them is fixed.

**Net for DoD-1:** the metric's *definition* is fixed for both shapes. Its *application* this session is
narrow — 3 of 37 sites got new code, 1 of 37 mechanisms got a real contention number, 0 of 15 Shape-B sites
were touched at all. This is exactly the kind of gap DoD-1 was written to prevent papering over: a metric
now correctly defined for the whole population is not the same claim as the whole population being
measured, and this session did the former, not the latter.

## 2. Item 2 — the exit-close-gap 250ms upstream number, under contention: attempted, lost to a bug, reported honestly

### What was instrumented and why (see commit `dd767285`)

`exit-close-gap.mjs`'s own `check()`s test only a boolean ordering (`exitAt <= timeoutFiredAt`) and a
300ms floor on `exitToCloseGapMs`. Neither surfaces the *sharper*, previously-standalone-only number from
the prior findings.md session: `timeoutFiredAt - exitAt`, i.e. how much of the scenario's configured
`timeoutMs:250` the parent fixture had left when it exited (~174-180ms in that session's 5 standalone
probe runs). I added `recordExitCloseMargin()` (lines 45-61 as of this file's current state — shifted twice,
once by the original instrumentation commit and again by the follow-up resolution fix below), wired into both real-spawn blocks,
using the harness's own `appendGateTimingRow`/`gateTimingOpId` (exported from `scripts/test-daemon.mjs`) —
additive, never-throws, LOOM_HOME-relative, matching the codebase's own established telemetry pattern.

**Standalone re-confirmation (before firing the gate, this session):** `mechanismA` upstream margin
206ms, `contrastB` -5ms — both consistent with the prior session's 174-180ms / ~0ms figures (same
mechanism, ordinary run-to-run variance on a quiet host; four stamps: value 206ms, condition standalone/
quiet-host, site exit-close-gap.mjs mechanism-A block, instrument this session's commit `dd767285` on a
post-`fcb6e7b0` tree). This confirms the instrumentation itself works and the underlying number is
real and roughly where the prior session left it.

### The under-contention capture failed — and here is exactly why, not papered over

`exit-close-gap.mjs` ran cleanly inside the real gate (`opId 3df72bf2`, runUid `1787661180313-11120`):
1906ms wall time, `ok:true`, all 13 checks passed (see the data snapshot). But my custom NDJSON file
(`~/.loom/gate-timing/d1e10795-promptness-margins.ndjson`) received **zero rows** for that run — only the
two pre-existing standalone rows from before the gate fired.

**Root cause, verified at source (`packages/daemon/scripts/test-daemon.mjs:1015`):** the harness spawns
every test FILE as its own child process with `env: { ...process.env, LOOM_HOME: home, LOOM_PORT: ...,
LOOM_TEST: "1" }`, where `home` is a fresh `fs.mkdtempSync` temp directory — this is the documented
per-test hermetic isolation (CLAUDE.md: "every test runs in its OWN fresh temp LOOM_HOME"). My
instrumentation computed its own `LOOM_HOME` the same way `test-daemon.mjs`'s *own* module-level constant
does (`process.env.LOOM_HOME || ...`) — correct for the harness's own PARENT process, where that constant
is captured before any test spawns, but wrong for code running *inside* `exit-close-gap.mjs` itself, which
executes in the CHILD, where `LOOM_HOME` has already been overridden to the temp dir. The write did happen
— just to a throwaway directory that isn't `~/.loom`. I confirmed the temp dir is not recoverable:
`fs.mkdtempSync(path.join(os.tmpdir(), 'loom-td-exit-close-gap-'))`-pattern directories are pushed to a
`tmpRoots` cleanup array and no longer exist on disk (checked: zero `loom-td-*exit-close*` directories
remain in `%TEMP%`, against 40 unrelated `loom-td-*` dirs that do — none matching this file).

**Consequence:** item 2's under-contention number for the sharper upstream margin is **not captured this
session.** What IS established: (1) the standalone number, freshly reconfirmed on a post-`fcb6e7b0` tree,
sits at ~200ms against a 250ms budget (~50ms/20% headroom) — not the 3.2x-margin story that applies to the
gap check itself, a genuinely thinner number; (2) the whole FILE ran comfortably under contention (1906ms
of unrelated wall time, all checks green) — indirect evidence there's no gross blow-up, but this says
nothing about the specific ~200ms number's behavior under contention, since the file's total wall time is
dominated by process-spawn overhead unrelated to the timed scenario itself.

**I am not re-firing to recover this** — per the card's own rule and the manager's explicit instruction to
state a real gap rather than manufacture a number.

**Update (same session, follow-up):** the resolution bug is now fixed, but the under-contention number is
**still not captured as of this document** — the fix was verified by direct standalone simulation only, no
gate was re-fired. `scripts/test-daemon.mjs`'s `runOne` now threads a SEPARATE, additive `LOOM_REAL_HOME`
env var through to each spawned test child (mirroring how `LOOM_GATE_OP_ID` is already threaded), carrying
the harness's own real `LOOM_HOME` — `LOOM_HOME` itself stays overridden to the per-test temp dir, unchanged,
load-bearing hermetic isolation. `exit-close-gap.mjs` now reads `process.env.LOOM_REAL_HOME || process.env.LOOM_HOME
|| path.join(os.homedir(), ".loom")`, so it resolves correctly under BOTH a harness-spawned child and a
direct standalone run. Verified without touching the shared gate at all: ran the file directly with
`LOOM_HOME` pointed at a throwaway fake directory and `LOOM_REAL_HOME` pointed at the real one (simulating
exactly what `runOne` now does) — the fake, isolated `LOOM_HOME` received nothing (its `gate-timing/`
subdirectory was never even created), and a fresh row landed in the real `~/.loom`. See memory
`instrument-inside-test-reads-isolated-loom-home` for the full gotcha writeup. **Whether to spend a future
gate fire capturing the actual under-contention number with this fix in place is the lead's call, not mine
to make unilaterally — this session was explicitly told not to re-fire for it.**

**Do not widen `timeoutMs:250`** — nothing here argues for it; the standalone number has genuine headroom,
and no contention data exists to argue otherwise.

## 3. Item 3 — the do-not-widen constraint

No timeout constant was touched. Nothing measured this session argues for widening one. (`GIT_TIMEOUT_MS`
in `deploy-staleness.ts` was outside this session's scope entirely — that was the sibling branch's `4dfc648a`
items 2/3, already shipped as `a60beaa2`.)

## 4. Item 4 — one mechanism, or several? Now THREE, with new direct evidence

The prior findings.md session (its second-session §5-6) already established the git-`ETIMEDOUT` failure
(a hard OS-level subprocess kill, uncaught-exception-shaped, throwing before any `check()` runs) is
structurally distinct from the in-process `check()`-margin races (Shape A/B) — read that report first, it
answers the "two mechanisms" half of this question and I have nothing to add to it.

**This session found direct, reproducible evidence for a THIRD, distinct mechanism: an intermittent
hang/deadlock in the production repo-guard-only handoff (`gate-semaphore.ts`), not a margin race and not a
subprocess timeout — a promise that never settles at all.**

The kickoff flagged this as a single, n=1, unattributed observation in `merge-gate-reuse.mjs`
("two genuinely concurrent `confirmWorkerMerge` calls" — a race test, not this card's original scope).
This session independently reproduced the *same class* of failure in a *different* file
(`merge-gate-inert-diff.mjs`), unprompted, as a side effect of the single `run_gate` fire:

- **In the real gate run** (`opId 3df72bf2`): `merge-gate-inert-diff` hit the harness's blanket 120s
  ceiling and was SIGTERM-killed (`durationMs:120031`, `timeoutDetail:"killed (exited via signal SIGTERM
  after kill)"`) — last visible progress was scenario (J)'s repo-guard-only handoff
  (`site=acquireRepoGuardOnly-release->repoGuardOnlyHandoff t=118830.935`), with nothing after it before
  the kill.
- **Standalone, on a quiet host, no contention at all** (this session, cheap positive control before
  trusting the gate result as anything but noise): ran the file 2 more times.
  - Run 1: **crashed after 36.4s wall-clock** with Node's own `Warning: Detected unsettled top-level await`
    at `merge-gate-inert-diff.mjs:410` (`const confirm2 = await p2;`) — the event loop went idle with
    `p2` (`sessions.confirmWorkerMerge(H.mgrId, worker2Id)`, scenario H) never having settled. Last
    progress: worker2's guard `site=admit t=34911.693`, nothing after.
  - Run 2: all 57 `check()`s passed clean, ~52s of internal scenario time.

**Three attempts, two hangs, at two DIFFERENT scenario letters (H standalone, J under the gate) — not one
deterministically-broken line.** That shape (intermittent, different trigger point each time) is the
signature of a genuine race in shared state, not a fixed logic bug. **Structural link to the kickoff's own
observation, checked, not assumed:** `grep -c "repoGuardOnly\|RepoGuard" packages/daemon/test/merge-gate-reuse.mjs`
returns 3 — `merge-gate-reuse.mjs` touches the same `repoGuardOnly` mechanism
(`gate-semaphore.ts:644`'s `repoGuardOnlyHandoff`) as the hang reproduced here. That makes this two
independently-observed reproductions of the same shared production mechanism failing in two different
test files, not two unrelated flakes.

**I checked whether the file's own most recent change (`56b52bb6`, landed 12:16:43Z, retrofitting
`waitUntilRepoGuardQueued` from a manual poll loop onto the shared `_wait.mjs` helper) could be
responsible.** The retrofit is a single, small, mechanical change (diff: ~15 lines) to the TEST's own
polling helper, used only to confirm worker2 *reached* its queued wait — not to the production
`confirmWorkerMerge`/`gate-semaphore.ts` code path that the hang is actually stuck inside (`await p2` at
line 410 is downstream of the real repo-guard release, not of the retrofitted helper). **I cannot rule out
a causal link from a subtle scheduling-order shift, but I have no positive evidence for one either** — this
is stated as an open question, not a diagnosis.

**I did not attempt to fix, further isolate, or bisect this** — it is a real bug candidate in production
gate-semaphore code, not a promptness-margin question, and is well outside this card's DoD and its
do-not-widen-timeouts constraint. **Escalating this to the manager as a separate, likely more urgent
finding than this card's own measurement task** — see the worker report.

**Answer to "one or several": at least three, and the third is the most concerning — a hang has no
margin to speak of at all; a promise that never settles cannot be waited out by any timeout increase,
correctly or not.**

## 5. Item 5 — emit-compare-gate under contention: confirmed, clean, comfortable margin

Both post-split files ran inside the same `run_gate` fire (`opId 3df72bf2`, poolSize 3, 718 files, real
concurrent git-subprocess contention from neighboring lanes) via the harness's own pre-existing
per-file NDJSON infrastructure — no new instrumentation needed for this item.

| file | standalone (prior session, quiet host) | **under real contention (this session)** |
|---|---|---|
| `emit-compare-gate.mjs` | 34s / 120s ≈ 28% | **40.8s / 120s ≈ 34.0%** |
| `emit-compare-gate-scope.mjs` | 28s / 120s ≈ 23% | **33.0s / 120s ≈ 27.5%** |

Both rise modestly under contention (consistent with the Windows-`CreateProcess`-contention mechanism
findings.md's §5 already identified) but stay well clear of the 120s ceiling — **66% and 72.5% headroom
respectively.** The pre-split single-file 94%-utilization condition this card's sibling branch fixed is
gone and stays gone under the exact condition (real contention) that caused the original failure — this
answers item 5 cleanly: **confirmed, holds under contention, no further action.**

(A pre-existing NDJSON data point from ~11:05Z shows near-identical figures — 36.1s/30.1% and
29.1s/24.2% — but per §0's instrument-change caveat that run is within under-a-second of `fcb6e7b0`
landing, so it is cited here only as corroborating context, not as the basis for this item's answer.)

## 6. What this session did NOT do

- Did not re-derive the 37-site population count from scratch (see §1's explicit flag on this).
- Did not instrument or measure any Shape-B liveness site (0 of 15), including the row-4 specimen
  (`pty-conpty-dll-kill.mjs`) — a deliberate scope decision given that file's own fragility warning, not
  an oversight.
- Did not recover exit-close-gap's under-contention upstream-margin number — lost to a self-diagnosed
  `LOOM_HOME` test-isolation bug in this session's own instrumentation, explained in §2. The bug itself
  IS fixed (same session, follow-up — `LOOM_REAL_HOME` threaded through `runOne`, verified by direct
  standalone simulation) but the number was not re-captured, since that needs a real gate fire and this
  session was explicitly told not to re-fire one.
- Did not widen any timeout constant.
- Did not attempt to fix, isolate, or bisect the `merge-gate-inert-diff` / `merge-gate-reuse` repo-guard
  hang — escalated instead, per §4.
- Fired `run_gate` exactly once, total, across the whole card.
