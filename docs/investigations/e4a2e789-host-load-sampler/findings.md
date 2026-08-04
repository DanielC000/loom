# e4a2e789 — Stage 1: an OS-level host-load sampler that samples DURING a run

Card `e4a2e789` ("in-suite-only test failures are blocking merges") DoD-5 makes an instrument a
precondition, not a caveat: **`gate_queue` measures semaphore ADMISSION, not host load, and own-fleet-
busy-count cannot see a peer project's work — neither can tell an idle box from one saturated with
non-gate work.** This is Stage 1 only: build and validate the missing instrument. It does not attempt to
name a mechanism (Stage 2).

**No production code changed.** Everything here lives under `docs/investigations/e4a2e789-host-load-
sampler/`; no suite, gate, or `run_gate` was invoked (per the card's fleet-etiquette note — three sibling
workers plus a live merge gate were on this box at the time).

## What was built

`scripts/sample-host-during-run.mjs` — a standalone process, run **concurrently** with whatever is under
study, that polls at a fixed interval and appends condition-stamped NDJSON rows with real timestamps.
Reuses `packages/daemon/test/census/lib.mjs`'s `appendNdjson` rather than duplicating it. Two row kinds:
`host-sample-during` (one per poll) and `host-sample-run-end` (one per sampler invocation, summarizing
`sampleCount`/`stoppedBy`).

It is a **separate process** from anything it observes — the existing `hostSnapshot()` (same file) is
only ever called immediately before and after a batch, so a spike mid-run is invisible to both endpoints.
This sampler closes exactly that gap: it doesn't measure a run, it measures wall-clock time, and anything
else with a timestamp (e.g. `docs/investigations/6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson`,
once that investigation lands on main) can be joined against it after the fact by finding sampler rows
whose `ts` falls inside a file's `[startTsIso, endTsIso]` window.

`--condition` is a **required** argument (the script refuses to run without it) — per pinned memory
`a-baseline-with-no-recorded-condition-is-not-a-baseline`, an unstamped reading is not data. Per the same
memory's §THE GATE IS THE LOAD, the honest label for a box running real work is never "quiet" — this
project uses **"SOLE GATE, NO DECLARED THIRD-PARTY LOAD"** and expects the caller to name what's actually
running, not assert absence.

Two measurements beyond CPU/memory, motivated directly by instance (5)'s `Error: AttachConsole failed`
(`conpty_console_list_agent.js:13`) — a Windows console-handle failure:
- **CPU%** computed from `os.cpus()` tick deltas between consecutive samples. `os.loadavg()` is always
  `[0,0,0]` on Windows, so this is cross-sample tick-delta arithmetic, not loadavg — confirmed working
  below (values in the 35–84% range were recorded, not a constant zero).
- **Windows OS-handle counts** (`Get-Process HandleCount`), broken out by process class in ONE combined
  PowerShell call per sample (bounded overhead, not one call per class): node-like (`node|esbuild|vite`),
  `conhost.exe` (console-host processes — ConPTY sessions can spin these up, the direct AttachConsole
  lead), claude-like, and system-wide total. A handle table trending toward exhaustion would show here
  well before it shows as CPU or memory pressure.

Usage:
```
node docs/investigations/e4a2e789-host-load-sampler/scripts/sample-host-during-run.mjs \
  --condition "SOLE GATE, NO DECLARED THIRD-PARTY LOAD" --interval-ms 2000 --duration-ms 60000 \
  [--label "free text"] [--out <path>]
```
Omit `--duration-ms` to sample until `Ctrl-C` (SIGINT) — a clean `host-sample-run-end` row is still
written on interrupt.

## Self-footprint — which fields include the sampler's own process

The sampler is itself a `node` process that spawns a `powershell.exe` child once per sample — the
measurement-destroys-the-condition rule (already applied to "the gate is the load") applies to this
instrument too. Named as a field here, not a caveat:
- **`nodeLikeProcessCount` / `nodeLikeWorkingSetMB` / `nodeLikeHandleSum`** carry a **constant +1** for
  the sampler's own `node.exe`, for the sampler's entire lifetime (it matches its own `node|esbuild|vite`
  regex). Its own handle count is small relative to the totals recorded here (order of 100s against sums
  in the 140K+ range).
- **`totalProcessCount` / `totalHandleSum`** carry that same constant `node.exe` contribution, PLUS a
  **transient** contribution from the `powershell.exe` child — alive only for the ~150–400ms of each
  `Get-Process` call, not persistent between samples.
- **`conhostProcessCount` / `conhostHandleSum`** carry **no sampler self-contribution**: the sampler never
  creates a pty/ConPTY session itself, and `child_process.execSync` on Windows does not allocate a new
  `conhost.exe` for a piped child.
- **`cpuPct`** is a whole-box tick-delta measurement; the sampler's own CPU use (largely idle between
  samples, one PowerShell spawn per interval) is a negligible, unnamed fraction of it.

**Empirical isolation attempted, and the result is itself informative.** A direct PowerShell `Get-Process`
reading taken with the sampler NOT running showed `nodeLikeProcessCount:16`; three samples taken
immediately after starting the sampler read `20, 15, 16` — noisier than the deterministic +1 this
analysis predicts, because ambient fleet churn on this shared box (other sessions' processes starting and
exiting) dominates a single-process offset within a ~6-second window. **This is not a failure of the
self-footprint analysis — it is confirmation that a constant ~1-process offset is small relative to real
ambient noise on this host**, which is also why it is harmless for every DELTA-based reading in this
document (Validation run 2's `18 → 20/21 → 18`, Experiment 1's `18 → 35 → 18`): a constant offset present
in both the "before" and "during" samples of a delta cancels out. **It only matters for an ABSOLUTE
reading read in isolation** — e.g. "the box had 18 node processes" is a mixture (ambient fleet + this
sampler + whatever else was running), never a clean population count, and should be read as such.

## Validation run 1 — idle smoke test (instrument sanity)

4 samples, 2s interval, 8s duration, no test files run by this session concurrently (label:
"IDLE-SAMPLER-SMOKE-TEST, INSTRUMENT VALIDATION ONLY, NOT A SUITE RUN" — deliberately not called "quiet").

```
cpuPct: null, 40.1, 55.9, 49.1        (first sample has no prior tick baseline, correctly null)
conhostProcessCount: 42, 42, 43, 43   totalHandleSum: ~4.13M
```
**Condition, corrected against fleet ground truth (manager-supplied, not inferred by this sampler — see
`data/host-samples.ndjson` timestamps against `gate_queue` at read time):** this window sat entirely
inside a Loom merge gate (`dc6b9a53`, card `6c1aadf7`) running continuously since 09:26:02Z —
`elapsedMs` ~729856 (~12.2 min) at the time the manager checked, `idleMs` 1513, `extended:false` — plus
3 live Loom workers (this session included). **Codescape is a live peer on the same daemon whose non-gate
work `gate_queue` cannot see by construction — that gap is the whole reason this instrument exists.**
⇒ **The honest label for this reading is "DURING A LOOM MERGE GATE + 3 LOOM WORKERS; THIRD-PARTY LOAD
UNDECLARED AND UNMEASURED"** — not "consistent with the sibling workers the kickoff names" (too vague,
upgrades "consistent with" toward "caused by" without a contrast case) and never "quiet". The 40–56% CPU
floor measured under this stamped condition is itself a first, genuine data point: the first number this
project has for what the box costs before a suite even starts.

## Validation run 2 — sampler concurrent with a small direct 6-file pty batch

To confirm the instrument actually detects real, self-caused activity (not just ambient fleet noise),
ran the sampler (1.5s interval, 45s duration) while directly spawning 6 pty-heavy hermetic test files
(`pty-busy-drain`, `pty-coalesce-drain`, `pty-giveup-clear`, `pty-giveup-requeue`,
`node-pty-quoting-parity`, `pty-composer-dirty`) via `census/lib.mjs`'s own `runCensusBatch` at
`poolSize:2` — a small DIRECT batch (not `run_gate`, not the full 617-file suite; all 6 files passed,
batch wall-clock 16022ms). Full 30-sample output: `data/host-samples.ndjson`.

```
sampleIndex 0-4  (before/at batch start):  nodeLikeProcessCount 18   cpuPct null,60.8,77.1,66.9,56.1
sampleIndex 5-14 (during the batch):        nodeLikeProcessCount 20-21 (rose from the pty children spawned)
sampleIndex 15+  (after batch finished):    nodeLikeProcessCount back down to 18
```
`nodeLikeProcessCount` tracking the batch's own lifetime (18 → 20/21 → 18) is a clean, self-caused signal
the instrument correctly captured — direct evidence the sampler sees real activity, not just noise.
`cpuPct` fluctuated 35–84% throughout, including well before and after the batch window — consistent with
run 1: this box's CPU baseline is already elevated by non-gate load, so CPU alone does not cleanly
discriminate this batch from ambient activity (expected, and exactly the reason `nodeLikeProcessCount`
and the handle counts were added rather than relying on CPU alone).

`conhostHandleSum` moved in a 4800–5290 band across both runs with no dramatic excursion tied to this
small batch specifically. **This is not evidence against the AttachConsole/handle-exhaustion lead** — a
6-file, non-`kickoff-real-spawn` batch is a light load relative to the concurrent REAL-`claude`-spawning
work that produced instance (5); Stage 2's mechanism hunt needs a load shaped like the actual failure
(concurrent real-pty spawns at suite scale), not this validation batch. What run 2 establishes is only
that the instrument itself works and is sensitive enough to catch a real, self-caused process-count
change at 1.5s resolution — the class of measurement Stage 2 will need.

## Status — Stage 1

Instrument built, validated twice (idle + self-caused-load), reused the existing census harness rather
than duplicating it, condition-stamped per the pinned-memory discipline. Reported as a `progress`
checkpoint, then continued straight to Stage 2 per kickoff instructions.

# Stage 2 — DoD-1/2/3: force a deterministic repro, name the mechanism, decide one-or-two

**No production code changed. No `run_gate` used. No full-suite run.** Every experiment below is a direct
`node census/lib.mjs runCensusBatch(...)` call, driven from a scratch driver script (not committed —
throwaway, lived under the session scratchpad). Neither test file this investigation touches spawns a
real Anthropic `claude` — both substitute a fixture/real-node-binary via `LOOM_CLAUDE_BIN` (see each
file's own header) — so this is a real node-pty/ConPTY stress test with zero API cost, safe to run
repeatedly.

**Manager correction applied here (Stage 1 was accepted; this redirect landed before Stage 2 was seen):**
don't hand-run the full suite to shape the load — a hand-run suite doesn't queue through the
GateSemaphore, so it competes with everything already admitted AND contaminates the very measurement
under study by being the largest thing on the box. Instead: isolate the REAL-PTY class (files that invoke
a real, unmocked `PtyHost.createPty()`) and run only that, at suite-like concurrency. Experiments 1-2
below predate that redirect and used repeated copies of one file to FORCE the mechanism as fast as
possible — a valid technique for naming it, kept here rather than discarded. Experiment 3 is the
class-based, suite-representative follow-up the redirect asked for, and derives the class list itself as
a shared deliverable for card `6185fbfc` ("shard the gate test step by class").

### The real-spawn class, derived (deliverable for card `6185fbfc`)

Searched `packages/daemon/test/*.mjs` for every file that instantiates `new PtyHost(` (5 hits), then
excluded the ones that never call `.spawn()`/`createPty()` on it (`companion-persona-reinject.mjs` and
`companion-refresh-persona.mjs` — both comment "never spawns anything below"; `seed-endpoint.mjs` — "no
real claude/shell spawn ever happens"), and cross-checked against every file matching
`LOOM_CLAUDE_BIN`/`node-pty` for anything missed by the `new PtyHost(` grep specifically (e.g.
`node-pty-quoting-parity.mjs` calls node-pty's internal `argsToCommandLine` directly — a pure string
function, never a pty session; `document-conversion-spawn.mjs` explicitly drives a FAKE pty seam;
`claude-version-prewarm.mjs` uses plain `execFile`, not a pty at all).

**Result — exactly two files in the entire ~617-file hermetic suite invoke a real, unmocked
`PtyHost.createPty()`:**
- `kickoff-real-spawn.mjs` — 9 real ConPTY spawn/stop cycles per run (6 roles + 2 large-payload + 1
  late-ready scenario).
- `spawn-command-line-preflight.mjs` — 1 real ConPTY spawn (its "Part B", Windows-only), the rest of the
  file is pure string-length/quoting logic with no pty involved.

**This is smaller than a ballpark "a dozen real-spawn files" guess — worth flagging explicitly rather than
padding the list to match an assumption.** It is scoped precisely to what this card's own mechanism needs
(a real, unmocked `PtyHost.createPty()` invocation) — card `6185fbfc`'s own "real-spawn class" for gate
SHARDING purposes may reasonably want a broader definition (e.g. real non-pty `child_process` spawns in
`dev-server*.mjs`/`codescape-lifecycle-hooks.mjs`), which this search did not attempt to enumerate; this
two-file list is a verified SUBSET, not a claim that it's `6185fbfc`'s complete answer.

## Experiment 1 — force high concurrency (N=8, direct spawn, poolSize=8)

8 concurrent copies of `kickoff-real-spawn`, each internally performing 9 sequential real ConPTY
spawn/stop cycles (6 roles + 2 large-payload + 1 late-ready scenario). **Result: 2 of 8 copies (25%)
crashed with the EXACT signature of card instance (5):**
```
C:\...\node_modules\.pnpm\node-pty@1.1.0\node_modules\node-pty\lib\conpty_console_list_agent.js:13
var consoleProcessList = getConsoleProcessList(shellPid);
Error: AttachConsole failed
```
Both failing copies crashed on their **9th (final, late-ready) spawn** — they completed all 8 earlier
real-pty spawns cleanly first. **This ordinal pattern turned out to be load-bearing, not incidental — see
Experiment 4 below, which shows the conjunction of high cross-process concurrency AND this per-copy
depth together reliably triggers the failure, at a rate concurrency alone does not (see also the
counter-evidence subsection further down: the conjunction is a demonstrated sufficient trigger, not shown
to be a necessary one).** Both crashes are `exit 1` (not a timeout) at ~45.7s/45.8s — the
same SHAPE as instance (5)'s run 2 (`real exit 1 at 24938ms`, well under `TEST_TIMEOUT_MS`), not run 1's
shape (a 120061ms hard timeout). One crashed copy's stderr shows the AttachConsole error firing (at
minimum) twice in the same process, followed by an unrelated-looking `Error: write EAGAIN` on a Socket
(`errno: -4088`) — consistent with a cascading failure: the crashed console-list-agent helper subprocess
(which node-pty spawns internally to enumerate a shell's attached console processes) takes down
output-stream handling with it, not merely failing its own narrow call.

**Mechanism, named (refined by Experiment 4 — read that section for the depth-vs-concurrency deciding
evidence; and see "Counter-evidence: the conjunction is sufficient, not necessary" below, which narrows
this from a necessity claim to a sufficiency claim):** node-pty's `conpty_console_list_agent.js` helper —
a small Node subprocess node-pty spawns per real pty session to call the Win32 `AttachConsole()` API —
reliably fails under the CONJUNCTION of high cross-process concurrency AND high per-copy sequential spawn
depth demonstrated here; concurrency alone (Experiment 4) was shown insufficient to trigger it at this
rate. **This conjunction is a demonstrated SUFFICIENT condition that substantially raises the failure
rate — it is NOT a necessary one.** Four separately-observed sub-threshold crashes (depth 1, concurrency
~0-2, far below this experiment's depth≥9/concurrency~7-8) carry the identical `AttachConsole failed`
signature; see the counter-evidence subsection below for the specimens. Both can be true at once: the
conjunction substantially raising the rate, and a cheaper depth-1 path also triggering the same failure —
read as complementary findings, not alternatives. The failure is an **uncaught exception in that helper
subprocess**, not a graceful assertion failure. **Observed parent-process exit shapes vary and are not a
single universal** — the two Experiment 1 crashes below both exited `1`, but other observed specimens
exited `0` (parent survived) and `3221225477` (`0xC0000005`, ACCESS_VIOLATION); see the counter-evidence
subsection for the full range and do not assume `exit 1` when characterizing a future occurrence. This
reaches a separate-process, hermetic test exactly as DoD-2 asks (confirmed via a real, forced, repeatable
crash — not inferred).

**Measured correlate (sampler, 1s interval, `data/stage2-samples.ndjson`, condition "SOLE GATE, NO
DECLARED THIRD-PARTY LOAD (Stage 2 forced experiment: 8 concurrent copies...)"):**
```
baseline (pre-batch, samples 0-4):   nodeLikeProcessCount 18   conhostProcessCount ~43-45   conhostHandleSum ~5000-5180
during batch (samples 5-49, ~44s):   nodeLikeProcessCount 35   conhostProcessCount ~50-55   conhostHandleSum ~5900-6200 (sustained plateau, not a brief spike)
after batch (samples 57+):           back to baseline (18 / ~43 / ~4900-5000)
```
`conhostHandleSum` rose ~20% and **stayed elevated for the entire batch duration**, while
`totalHandleSum` (system-wide, ~4.95M) moved by under 0.3% across the whole run. ⭐ The rise is
**concentrated specifically in the conhost/console subsystem**, not a generic system-wide handle
shortage — that specificity is exactly what points at `AttachConsole` (a console API) rather than at
memory or a generic OS resource ceiling. `cpuPct` fluctuated 17-99% throughout with no clean
before/during/after separation (consistent with Stage 1's finding that CPU alone doesn't discriminate on
this box) — the discriminating signal here is the process/handle counts, not CPU.

## Experiment 2 — does it need HIGH concurrency, or just cumulative churn at poolSize:2?

The real gate runs at `LOOM_GATE_TEST_CONCURRENCY=2` (`maxConcurrentGates`/pool default), never 8. Ran 6
total copies of `kickoff-real-spawn` at **`poolSize:2`** (3 sequential waves, same peak concurrency as the
real gate, MORE cumulative real-pty churn than experiment 1 — 54 real ConPTY sessions total over 152.8s
vs. 72 sessions over 52.6s at N=8). **Result: 6/6 PASS, 0 failures, no AttachConsole error.**

**This is a genuine discriminator, not just an absence of evidence** (per the card's own DoD-1 caution,
n=6 is a small sample and this is an upper bound, not proof pool-2 can never fail this way): the mechanism
did not reproduce at the real gate's own peak concurrency even with more cumulative real-pty churn than
the run that DID crash it. ⇒ **This looks like a PEAK-INSTANTANEOUS-concurrency effect (many real ConPTY
sessions attaching at once), not a cumulative-churn-over-time effect.**

## Experiment 3 — the actual real-spawn class, at suite-representative concurrency, plus a bisection

Per the manager's redirect: isolate the class, don't hand-run the suite. Ran the derived two-file class
itself (not repeated copies of one file) at the concurrencies a real gate could plausibly schedule them
at, then bisected the N=4-safe / N=8-crashes gap from experiments 1-2 with intermediate points — every run
still a direct, targeted spawn (2-6 files, ~50s each), never the full suite.

```
poolSize=2, [kickoff-real-spawn, spawn-command-line-preflight]              (the full real class, together, once)   0/2 crash
poolSize=4, [kickoff-real-spawn ×2, spawn-command-line-preflight ×2]        (the real class, doubled)               0/4 crash
poolSize=6, [kickoff-real-spawn ×6]                                         (bisection point)                       0/6 crash
poolSize=8, [kickoff-real-spawn ×8]                                         (experiment 1, repeated here for the table) 2/8 crash
```
`spawn-command-line-preflight`'s real-spawn section finishes in ~360-390ms (a single spawn, not
`kickoff-real-spawn`'s sustained ~50s of 9 sequential spawns) — it contributes to peak concurrency but not
to SUSTAINED concurrent pressure, so the pool=6/8 bisection points use `kickoff-real-spawn` copies only,
where the effect actually shows up.

**The threshold sits between 6 and 8 concurrent, sustained real-pty-spawning processes on this box** (16
logical cores) — not a smooth probability curve rising gradually from N=2, but a comparatively sharp
transition: 0 failures across 18 total runs at N≤6 (2+4+6+6 from experiments 1-2-3 combined), 2 failures
in 8 runs at N=8. That shape is more consistent with crossing a fixed OS/process-level ceiling (a
concurrent-console-attach limit, a helper-subprocess spawn-rate ceiling) than with a gradually-worsening
resource squeeze. **And directly answering the manager's redirect: the real class's actual membership (2
files, peak concurrency 2 even run together) sits FAR below this threshold** — the real gate's own two
lanes, even scheduling both real-spawn files into concurrent lanes at once, cannot reach N=8 by
themselves. Whatever pushes a real gate run into the failure range has to come from OUTSIDE the gate's
own two lanes.

Sampler data for all three sub-experiments in this section (run back-to-back inside one 180s sampler
invocation): `data/stage2-realclass-samples.ndjson` — note its `condition`/`label` fields describe only
the first (pool=2) sub-experiment; the file's own timestamps (09:48:30Z–09:51:31Z) span all three, so
read by `ts` against the batch durations quoted above, not by the stamped label alone.

## Experiment 4 — the deciding experiment: is it PEAK CONCURRENCY alone, or a CONJUNCTION with per-copy DEPTH?

Manager catch on this investigation's own data: both experiment-1 failures crashed on their **9th (final)**
real-pty spawn, having completed the 8 before it cleanly. "Peak-instantaneous concurrency" (many copies
attaching consoles at the same moment) predicts nothing about *which* spawn fails — but a competing,
un-ruled-out hypothesis does: **within-process accumulation** (consoles/handles not fully released across
9 *sequential* spawn/stop cycles inside one copy, so the 9th spawn is simply when that copy carries the
most residue). Experiment 2's 6/6 pass at poolSize:2 does NOT rule this out — those copies also ran 9
sequential spawns each and passed, which shows depth ALONE is insufficient, not that it's irrelevant.

**Deciding test: hold concurrency at the crashing N=8, cut per-copy depth.** `kickoff-real-spawn.mjs`
exposes exactly one depth knob, `KICKOFF_TEST_ROLES` (env-overridable; the large-payload and late-ready
sections are unconditional) — the achievable minimum is 1 role + 2 large-payload + 1 late-ready = **4
spawns/copy**, not exactly the suggested ~2-3, but the closest reachable without editing the test file
itself (out of scope for an investigation). Ran `KICKOFF_TEST_ROLES=worker`, 8 concurrent copies,
poolSize=8 (identical concurrency to experiment 1, less than half the spawn depth).

**Result: 8/8 PASS, 0 AttachConsole hits, batch wall-clock 26.3s** (vs. experiment 1's 52.6s at full
depth — consistent with roughly proportional-to-depth wall time, a sanity check that the reduction
actually took effect).

**This decides it: depth reduction alone, AT THE SAME concurrency that crashed 2/8 at full depth,
eliminated the failure.** ⇒ **The mechanism is a CONJUNCTION — peak cross-process concurrency AND
per-copy spawn depth both have to be high together — not peak concurrency alone.** (Caveat: this is one
run of 8 against a probabilistic ~25%-at-depth-9 baseline, so it does not prove depth-4 can NEVER crash at
N=8 — but combined with the ordinal pattern that motivated the test, it is real evidence for the
conjunction, not merely an absence.)

**Condition stamp for THIS run, corrected — not directly measured at the time, established after the
fact from commit timestamps.** Commit `34ef3dc2` (Experiment 3, the last work committed before this one)
landed at 09:53:47Z; commit `33f12aa7` (this experiment's writeup) landed at 09:57:17Z. The manager
separately reported, live from `gate_queue` at 09:58Z, that a SECOND full-suite merge gate (Codescape's
`888784fc`) started at 09:56:21Z, joining the already-running Loom merge gate `7f37c0b5` — the first time
both daemon-global gate slots were occupied all session. **This experiment's actual ~26s run window falls
somewhere inside the 09:53:47Z–09:57:17Z bracket, straddling that 09:56:21Z boundary — and unlike every
other experiment in this document, no sampler ran concurrently with it, so there is no direct measurement
to pin it down further.** That gap is itself a finding: this is the one experiment in the investigation
that skipped condition-stamping-in-real-time, and it is exactly the one case where it would have mattered.

**Why the result stands regardless of which side of the boundary it fell on.** Experiments 1-3 (depth 9,
including the crashing N=8 run) ran solidly before 09:53:47Z, under lighter, single-gate conditions. If
this depth-4 run fell BEFORE 09:56:21Z, it is condition-matched to them and the comparison is clean as
reported above. If it fell AFTER — i.e. under the heaviest load this box saw all session, two concurrent
full-suite gates — then per the manager's own asymmetry ("a crash here is weak evidence; a clean run here
is strong evidence"): a CLEAN run under MORE load than the crashing experiment 1 run is, if anything,
STRONGER evidence that cutting depth closed the failure mode, not weaker — it rules out "it only passed
because the box happened to be quieter this time," since the box can only have been quieter or the same,
never heavier, relative to a scenario that would undermine the conclusion. **The conjunction finding is
therefore robust to which side of the boundary this run actually fell on; only the WALL-CLOCK comparison
against experiment 1 (26.3s vs 52.6s, cited above as a sanity check that the depth reduction took effect)
loses precision if the two ran under different load** — the pass/fail result itself does not.

**Why this matters for the remedy (not proposed here, per DoD-4, but the finding is a direct input to
whoever picks one up):** if peak concurrency alone dominated, capping concurrent real-pty tests and
sharding by FILE (card `6185fbfc`'s proposal) would fix it. **Since depth is load-bearing, sharding by
file alone would NOT fix it** — the depth lives *inside* `kickoff-real-spawn.mjs` itself (9 sequential
spawns in one file), so even a lane running that ONE file alone, with no cross-file concurrency at all,
still carries the depth half of the conjunction; only the peak-concurrency half would be addressed by
per-file sharding.

## Counter-evidence: the conjunction is SUFFICIENT, not NECESSARY (four sub-threshold crashes)

**Added after this document's original write-up, from card `6a016f9d` / escalation `ed61e277` (three
specimens) plus a fourth observed live in the merge gate on 2026-08-04.** Four separately-observed crashes
carry the exact same `AttachConsole failed` signature at depth 1 and minimal-to-zero concurrency — far
below this document's depth≥9/concurrency~7-8 threshold:

| specimen | shape | concurrency | exit |
|---|---|---|---|
| Stage 1 (escalation `ed61e277`) | `host.stop(…,"hard")` → next `host.spawn()` | 1 kill + 1 spawn, ambient 2 gates | `exit 0`, parent survived, printed a summary |
| Stage 1, 2nd run (escalation `ed61e277`) | same shape | same | `exit 0`, parent survived, printed a summary |
| Stage 2 (escalation `ed61e277`) | 1 spawn + 1 stop | `gate_queue` `activeCount=0` at launch | `exit 0`, parent survived, printed a summary |
| `kickoff-real-spawn` (live merge gate, 2026-08-04) | stop()/spawn()-adjacent | `concurrentGates:1` on both failing runs, one at `concurrentGatesMax:1`; the one run that PASSED was the MORE-contended condition (`concurrentGates:2`) | `exit 3221225477` (`0xC0000005`, ACCESS_VIOLATION), `timedOut:false`; stack tail `conpty_console_list_agent.js:13` › `getConsoleProcessList` › `AttachConsole failed` ×3 |

All four sit at depth 1 — a single kill→spawn or spawn→stop cycle, not `kickoff-real-spawn`'s full
9-sequential-spawn sequence — against the depth≥9 Experiment 4 needed to cross the threshold at N=8. The
fourth specimen additionally excludes host/gate contention as the explanation three separate ways: both
its failing runs were the LESS-contended condition, and the one run that passed was the MORE-contended
one — the opposite of what a load-explanation would predict. **This should not be recorded as host load.**

**What this does and does not change.** The conjunction (high peak concurrency + high per-copy depth) is a
real, demonstrated SUFFICIENT condition that substantially raises the failure rate — Experiment 4's 2/8 at
depth 9 vs. 0/8 at depth 4, same N=8, stands unchanged and is not being re-litigated here (no additional
campaign was run to "re-confirm" it; a single sub-threshold crash already establishes non-necessity, and
there are four). What is corrected is the earlier claim, above, that the conjunction is REQUIRED: it
evidently is not, since all four specimens above crash the same helper at depth 1 with negligible
concurrency. Whatever the depth-1 trigger is — plausibly the `stop()`-adjacent kill/spawn transition
itself, since all four specimens share that shape — remains unnamed (see "What remains open" below); a
single controlled test isolating the kill path specifically (not a campaign) would be the cheapest next
probe, and was not run as part of this correction.

**Observed parent-process exit shapes are a range, not a single value.** This document originally asserted
the crash "kills the parent test process outright (`exit 1`)," generalized from Experiment 1's two
`exit 1` observations. The full observed range across all known specimens is: `exit 1` (Experiment 1
above, N=8/depth=9), `exit 0` with the parent surviving (the first three counter-evidence specimens
above), and `exit 3221225477` / ACCESS_VIOLATION (the fourth). Do not assume any one of these when
characterizing a future occurrence — check the actual exit code.

**A caution this raises, not acted on here.** If the crashed process sometimes does not exit promptly (see
the "does not self-terminate at all" observation reported alongside this investigation on card `6a016f9d`),
a suite-level timeout can be masking this same uncaught-throw-blocks-exit path rather than a genuinely slow
test — which bears directly on `TEST_TIMEOUT_OVERRIDES`. A prior attempt to raise an override ceiling on
exactly this reasoning had to be retracted: raising a ceiling converts a loud crash into a rare silent one,
which is worse than the loud crash it was meant to fix. This is recorded here as a caution only — no
override is touched by this edit.

## DoD-3 — one mechanism or two? **At least two, and they are not the same shape.**

Instance (5)'s two gate rejections were already flagged in the card as having **different shapes**:
- **Run 1: a 120061ms HANG**, hitting the blanket `TEST_TIMEOUT_MS`, tail showing `GIVE-UP RECOVERY
  after 4 Enter attempts — no engine output observed since the final Enter write` — a
  confirmation/give-up-shaped failure, the same family as pinned memory
  `engine-confirmation-can-lag-minutes-timeouts-assume-seconds`.
- **Run 2: a 24938ms `exit 1` CRASH**, well under the timeout — the shape this investigation just
  reproduced and named (AttachConsole).

**This investigation reproduced and named run 2's shape** (the crash) with a real, forced, repeatable
trigger: the CONJUNCTION of peak concurrent real-pty session count AND per-copy sequential spawn depth
(Experiment 4) reliably raising the failure rate — not peak concurrency alone. (This conjunction is a
demonstrated SUFFICIENT trigger, not a necessary one — see "Counter-evidence" above for four sub-threshold
crashes with the same signature at depth 1.) **It did NOT reproduce run 1's shape** (the hang/give-up/
timeout) — that remains a distinct, unnamed mechanism. Forcing it would need a genuinely different
experiment (CPU starvation stretching the submit-confirmation loop specifically, not just concurrent pty
creation) that this investigation did not attempt. Per DoD-3's instruction to "report the split honestly
rather than forcing one story": **two mechanisms, one named with forced evidence (AttachConsole /
console-attach contention — the peak-concurrency+depth conjunction is a demonstrated sufficient trigger
that substantially raises the rate, not a shown-necessary one), one still unnamed (the give-up/
confirmation-lag hang).**

## Why this reaches a real gate running at poolSize:2

Experiments 1-4 show the AttachConsole mechanism is reliably, and at a substantially elevated rate,
triggered by the CONJUNCTION of roughly **7-8 concurrent, sustained real-pty sessions** AND **high
per-copy sequential spawn depth** (≥9 in the one file tested; depth 4 at the same N=8 concurrency did not
crash) — not concurrency in isolation. **This conjunction is not shown to be required** — see
"Counter-evidence: the conjunction is SUFFICIENT, not NECESSARY" above for four depth-1, low-concurrency
crashes with the identical signature — so the argument below (that the real gate's own two lanes cannot
reach the conjunction threshold by themselves) explains why the conjunction path is unlikely to be the
gate's exposure, not why the gate is safe from this failure altogether: a depth-1 trigger, still unnamed,
remains possible at the gate's own concurrency. `kickoff-real-spawn.mjs`
itself already supplies the depth half (9 sequential spawns, unconditionally, inside one file) every time
it runs. The real class's own membership (2 files) cannot supply the CONCURRENCY half by itself even
scheduled together in the gate's own two lanes. The gate's own two lanes are not the only real-pty
activity on the host at gate time, though — per this card's own kickoff, **three sibling workers plus a
live merge gate were on this box at once** during earlier instances, and per Stage 1's instrument, ambient
`nodeLikeProcessCount`/`conhostProcessCount` were already elevated with zero test files run by this
session. `gate_queue` and own-fleet-busy-count are structurally blind to a peer project's real-pty
sessions (the card's own retraction). ⇒ **The gate's own poolSize:2 does not need to be the thing that
pushes concurrent real-pty session count to 7-8 — the REST of the fleet (sibling Loom workers, a peer
project's own real-pty-spawning tests, another concurrent gate) can supply the remaining concurrency,
invisibly to every instrument except the one built in Stage 1, landing on top of the depth
`kickoff-real-spawn.mjs` already supplies on its own.** This is consistent with, not proof of, the load
hypothesis — Stage 1's instrument would need to be run DURING a real gate rejection (not this
investigation's own forced local experiments) to close that last link with direct evidence rather than a
plausibility argument.

## What remains open (explicitly, not glossed over)

1. The give-up/timeout shape (run 1) is unreproduced and unnamed.
2. The N≤6-safe / N=8-crashes bracket (at depth 9) is drawn from 18 clean runs vs. 8 runs with 2
   failures — enough to see a sharp transition, not enough to pin the exact boundary (7? a probabilistic
   ramp between 6 and 8 under different host conditions?) or to prove N≤6 is safe at depth 9 on a
   differently-loaded box. The depth side of the conjunction is even less resolved: only two depths were
   tested (4 and 9) at N=8 — the actual minimum crashing depth (5? 7?) is unknown.
3. This investigation never ran concurrently with a REAL gate or REAL sibling-worker load at the moment of
   measurement (per the card's fleet-etiquette instruction not to use `run_gate` or hand-run the full
   suite) — the fleet-contention link in the section above is argued from Stage 1's ambient readings and
   the derived threshold, not measured at the instant of an actual gate rejection.
4. The two-file real-spawn class list is scoped to this card's own mechanism (real `PtyHost.createPty()`
   only); card `6185fbfc`'s sharding use case may want a broader class (real non-pty `child_process`
   spawns) that this investigation did not enumerate.
5. Experiment 4 (the depth-vs-concurrency deciding run) is the one experiment in this document that ran
   without a concurrent sampler — its exact position relative to the 09:56:21Z two-gate escalation
   (Codescape `888784fc` joining Loom's `7f37c0b5`) is bracketed by commit timestamps, not directly
   measured. The pass/fail conclusion is argued to survive either way (see that section); a tighter
   wall-clock comparison against experiment 1 does not.
6. Per DoD-4, no remedy is proposed here — a node-pty version bump, retry-wrapping the console-list-agent
   call, or reducing real-pty test concurrency are all plausible directions but are OUT OF SCOPE for this
   investigation and were not evaluated.
7. The depth-1, low-concurrency trigger behind the four sub-threshold crashes (see "Counter-evidence"
   above) is unnamed. All four specimens share a `stop()`-adjacent shape (a kill→spawn or spawn→stop
   transition), which is a plausible lead — the kill path specifically, rather than spawn depth, may be
   what's firing it — but this is unverified. A single controlled test isolating the kill path (not a
   campaign) would be the cheapest next probe; it was not run as part of this correction, since a
   docs-only card is not the place to run test code.
