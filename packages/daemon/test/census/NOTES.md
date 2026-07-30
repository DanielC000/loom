Running notes for the suite flake census (card d39db2db). Kept current in the worktree so a recycled
successor can pick up mid-census without re-deriving anything. Rewritten in place, not appended.

## CLOSED (mgr #72 decision) — see FINDINGS.md for the durable write-up
The remaining baseline grind (17 more runs) is RETIRED, accepted by the manager as low-yield: the class
those runs would tighten was never a leading suspect (~0.9%/gate from the previously-carded flakes), and
the classes that could explain the observed ~33% (cross-run collision, real-merge-gate contention) are
structurally untestable by any number of solo runs. The card closes at 7 baseline rows (3 clean / 4
contaminated, 0 failures) plus the Phase 0/0.5/1/1b work, all detailed in `FINDINGS.md`. That file is the
answer for "why did it stop at 7" — read it, not this transcript-oriented notes file, for the full case.

## Current phase
Phase 0.5/1 forced-probe work is DONE (see below) — manager directive #5 (which renumbers phases and
cuts the remaining plan to ~7-9h) arrived describing this same work as still-to-do, because it was
composed before my Phase 1 / Phase 1b reports landed; I flagged that back to the manager and proceeded
straight to what #5 calls "Phase 1" (I'm calling it Phase 2 in filenames to avoid clashing with the
already-committed phase1-*.mjs files) — the N=20 baseline census, C0, concurrency=2.

**Decision gate (manager directive #5, binding):** after N=20 completes —
- **0/20 failures** → STOP RUNNING. Write up as the answer: census does not reproduce the observed ~33%,
  the CI excludes it, and the tax is hypothesis (3) (gate infrastructure) — card that as separate work,
  do NOT run composition/load axis sweeps.
- **≥1/20 failures** → sweep composition AND concurrency on THAT failing test's neighbourhood only, not
  the full suite.
Either way: report + STOP once N=20 is done. Do not proceed past it without explicit go-ahead.

**Resumption note for a recycled successor:** `test/census/phase2-baseline.mjs --start N --count K` runs
K more baseline reps starting at run index N, appending to `test/census/raw/baseline.ndjson`. Read that
file's `phase:"2-baseline"` records to see how many runs are already done and their tally before deciding
`--start`. Each run takes ~8-18 min per the card's own prior measurement (real timing being collected now).

## Done so far
- Added `export` to `NOT_HERMETIC` in `scripts/test-daemon.mjs` (approved by manager).
- **Found and fixed a real harness bug**: `scripts/test-daemon.mjs`'s run logic was unguarded top-level
  code, so importing the module for its `NOT_HERMETIC` export also executed the entire real 585-test
  suite as a side effect. Added an `isMain` guard (`import.meta.url === pathToFileURL(process.argv[1]).href`)
  around the run block — `node scripts/test-daemon.mjs` (the real gate) is byte-identical; an out-of-band
  import now only evaluates the top-level consts. Verified: discovery now resolves in ~4ms instead of
  triggering a full run. An errant background run was caught and stopped via TaskStop before it did any
  damage (confirmed via `Get-CimInstance Win32_Process` that no orphaned children were left — the host's
  other live processes, i.e. the self-hosting daemon/Codescape/Playwright instances, are unrelated and
  untouched).
- Built `test/census/lib.mjs` (discoverHermetic, hostSnapshot, runCensusBatch, appendNdjson,
  killAllTrackedChildren — own-PID tracking only, never by name/port).
- **Phase 0 — positive control, both directions: PASSED (0 failures).** Known-good pair
  (`pc-pass-1`/`pc-pass-2`) both pass; known-bad assertion failure (`pc-fail`) correctly reports
  `ok:false` with full untruncated TAP failure detail captured in `stdout` (node:test writes failure
  detail to stdout, not stderr — corrected an initial wrong check); known-bad timeout (`pc-timeout`,
  forced via a 2s timeout override) correctly reports `status:"timeout"`.
  **Manager's mandatory synthetic-dir-isolation check: PASSED.** Real-gate discovery count is 585 both
  before and after a probe file exists under `test/census/synthetic/` — confirms `fs.readdirSync(TEST_DIR)`
  being shallow really does make that subdirectory invisible to the real gate, empirically, not just by
  code-reading.
  Raw data: `test/census/raw/phase0.ndjson`.
- **Static shared-external-resource audit (read-only, zero test executions), 3 patterns checked — all
  came back NEGATIVE for a live cross-file collision:**
  1. Duplicate `Date.now()`-only temp-dir prefixes (the `1fb1a3e0` shape, generalized): exactly 1
     duplicate (`E2E-`) across all 585 hermetic files, and both members are in NOT_HERMETIC — never
     reaches the real gate.
  2. Duplicate hardcoded `LOOM_PORT` literals: 77 hermetic files hardcode a port, 20 duplicate groups /
     43 files. Looked like a strong lead — but NONE of the 43 call `.listen()`; all either use Fastify's
     in-memory `.inject()` or never stand up a server. `paths.ts`'s `PORT` export is a bare number with
     no other identity use. Inert, not a live collision surface. (Real code-hygiene smell, worth its own
     small card, but not this mechanism.)
  3. One fully-fixed literal tmpdir name shared by 2 files (`loom-voice-web-`) — safe, both wrap it in
     `fs.mkdtempSync` (collision-safe unique suffix), same pattern the harness itself uses for `LOOM_HOME`.
  **Net: no static smoking-gun cross-file pair found.** Doesn't rule out non-literal/dynamic collisions,
  DB/SQLite-level contention, or memory-pressure timeout cascades — only the 3 greppable literal patterns.

## Phase 1 result (COMPLETE)
- **Probe self-check: PASSED.** `collide-a`/`collide-b` (deliberately share one fixed external path)
  failed 5/5 (100%) when run together, 0/6 (0%) when run solo (3 reps each). `pc-pass-1`/`pc-pass-2`
  (known non-colliding) stayed 0/5 (0%) together. The probe demonstrably CAN catch a real external-
  resource collision and does NOT false-positive on a clean pair — its verdict on real pairs below is
  trustworthy.
- **6 real candidate pairs, all CLEAN under all 3 conditions** (forced-concurrent pool=2 ×2, sequential
  pool=1 ×1, solo ×1 each): `merge-gate-reuse`+`gate-timeout-circuit-breaker`, `merge-gate-reuse`+
  `merge-repo-mutex`, `merge-gate-reuse`+filler(`wake`), `codescape-lifecycle-hooks`+`merge-gate-reuse`,
  `codescape-lifecycle-hooks`+filler(`wake`), `worker-spawn-cap-toctou-race`+`merge-gate-reuse`. Zero
  failures across 26 total runs. Raw data: `test/census/raw/phase1.ndjson`, full console:
  `test/census/raw/phase1-console.log`.
- **Honest scope of this negative result:** it rules out these 6 specific pairs colliding with each
  other (including the peer's exact "sequential at concurrency=1" signature) — it does NOT rule out
  hypothesis 4/shared-external-resource in general. Untested: pairs among the ~580 OTHER hermetic files
  (this was 6 pairs out of C(585,2) ≈ 171k possible pairs — a targeted, not exhaustive, sample); an
  effect that needs MANY prior files' accumulated state rather than one specific neighbour (the harness's
  own tmpRoots cleanup only runs at the very end of a whole invocation, so a genuinely cumulative
  resource-exhaustion effect wouldn't show up in a 2-file probe — Phase 2's full-suite census runs would
  be where that shows up, if it exists).
- `worker-spawn-cap-toctou-race` (the `6c0a6fe5` line item) showed 0 failures across its 5 forced runs
  here — consistent with, but not yet statistically confirming, the `createWorktree` lock fix having
  resolved it. Phase 2's N=20 census is what actually establishes its rate with a real CI.

## Phase 1b (manager directive #4 — retargeted static audit, "go straight to forcing it")
- Manager corrected an earlier premise (gate-semaphore `concurrent=1` ≠ node:test file-level
  parallelism) — doesn't affect anything I'd built, since my own harness's `poolSize` already directly
  controls real child-process concurrency, never the daemon's GateSemaphore. Confirmed and reported back.
- Retargeted static audit per the peer's sharpened pattern: not "any shared name" but "allocate → release
  → a LATER, separate process re-acquires the same external identifier" (a `getFreePort`-shaped TOCTOU).
  **Found a real one**: `src/codescape/supervisor.ts`'s `pickLoopbackPort()` binds ephemeral (`:0`), reads
  the port, `srv.close()`s it, then `spawnServe()` launches a SEPARATE child process that rebinds that
  same port number moments later — the exact close→respawn gap the peer's own specimen had.
  Confirmed via a full-repo scan for `listen(0` + `.close(` co-occurrence: only 4 files match at all;
  the other 3 (`codescape-supervisor.mjs`, `orch-abort-warn.mjs`, `github-binary-download.mjs` — 2 are
  test files that just HOLD their listener until teardown, the safe pattern) don't share this shape.
  `pickLoopbackPort` is the only genuine instance found.
- Of the 7 hermetic test files that reference `CodescapeSupervisor` at all, only 2 actually call
  `.start()` (which unconditionally exercises `pickLoopbackPort()`) for real: `codescape-health-probe.mjs`
  (14 calls) and `codescape-supervisor.mjs` (4 calls). The other 5 only reference the class in
  imports/types.
- **Forced this pair directly: 0/10 failures forced-concurrent (pool=2), 0/6 failures solo.** Another
  clean/negative result — but with an important caveat I'm flagging rather than burying: my deliberate
  `collide-a`/`collide-b` fixture forces a collision at ~100% by sharing one EXACT literal path; a real
  OS ephemeral-port collision between two independent `listen(0)` calls is likely a much LOWER-probability
  event per encounter (the ephemeral range is wide), so 10 reps may simply be underpowered to catch it —
  this is NOT the same strength of negative as the probe-self-check's fixture pair. I have not attempted
  to raise the collision probability artificially (e.g. narrowing the ephemeral port range) — flagging as
  a real limitation, not claiming it as resolved.
  Raw data: `test/census/raw/phase1b.ndjson`.
- Also swept for the peer's second pattern (liveness standing in for readiness — `exitCode === null`,
  bare "still alive" checks): **zero hits** for the literal pattern in `test/`; broader "still running"
  hits were all about in-process async OPERATION state (pending merges/gates), not spawned-child-process
  readiness. Production code at this exact site (`supervisor.ts`) already has an explicit `/graph/health`
  probe specifically because "process-exit detection alone... never sees a serve that's up, port bound,
  but wedged" (comment cites a prior "four-day freeze" this was built to fix) — so this class of bug
  already has a targeted, documented fix at the one site I found it discussed.
- **`pickLoopbackPort` is a real, independently-worth-carding production defect** (a genuine TOCTOU on an
  OS-level resource) regardless of whether it explains the observed ~33% gate-rejection rate — it should
  be carded on its own findings, not folded into "fixed" by this census's null result on it.

## fa52f555 check (surfaced via project memory mid-census — the test-daemon.mjs per-lane-port comment)
Project memory surfaced a newly-carded finding (`fa52f555`): `scripts/test-daemon.mjs`'s own comment
— `// fixed per-lane port — safe under concurrency (POOL_SIZE lanes, POOL_SIZE ports)` — is TRUE only
within one invocation; it's FALSE across two CONCURRENT invocations (e.g. two gates admitted at once
under `maxConcurrentGates=2`), since both independently compute `4400 + lane` and would collide on the
literal port number. This is directly relevant to the census's core question (a real, structural,
cross-GATE-RUN mechanism, not a per-test flake), so I checked whether it's actually REACHABLE right now.
**Checked and found NOT reachable in the current hermetic suite**: a comprehensive grep for real
(non-ephemeral) `.listen(...)` calls across all 585 hermetic test files found ZERO genuine binds on the
outer harness's assigned `LOOM_PORT` — every hermetic test either uses Fastify's in-memory `.inject()`
(no real socket) or binds ephemeral `:0` (unrelated to the outer per-lane scheme). The one apparent
match (`boot-listen-not-blocked.mjs`) is a false positive — it's a purely static AST-analysis test that
never boots a real process at all. **So the comment's reasoning flaw is real (worth fixing on its own
card, fa52f555), but nothing in the CURRENT hermetic suite exercises the vulnerable path** — it can't be
contributing to the observed ~33% today. Reporting this as another checked-and-killed lead, same
discipline as the LOOM_PORT-literal-duplicate finding from Phase 0.5.
IMPORTANT CAVEAT: this only covers the HERMETIC test suite as currently composed. If a future test is
added that DOES bind the assigned port for real, or if a differently-configured project's suite does,
the underlying defect would become live. Also does not rule out an analogous fixed-port collision
somewhere I haven't grepped (I checked `.listen(` specifically, matching the exact pattern named).

## Not yet done
- Phase 1 dynamic forcing: pair the 5 `TEST_TIMEOUT_OVERRIDES` git-heavy tests + `codescape-lifecycle-hooks`
  + `worker-spawn-cap-toctou-race` against each other / fillers, at concurrency=2 forced, concurrency=1
  sequential-in-invocation (testing the peer's `concurrent=1`-still-fails signature), and solo control.
- Phase 1 probe positive-control: `collide-a.mjs`/`collide-b.mjs` (fixtures, deliberately share one fixed
  external path) as the known-colliding pair; `pc-pass-1`/`pc-pass-2` as the known-non-colliding pair.
- Bisection for `codescape-lifecycle-hooks` (conditional — only if it actually fails in the forcing step;
  its previously-observed real race was already fixed in `c54d1ea0`).
- Phase 2 baseline census (N=20, C0, concurrency=2).
- Phase 3 composition variation (only if Phase 1 comes back negative).
- Load-axis correlation from Phase 2's host snapshots (observational, not a designed experiment — report
  it as such).
- Final analysis: Clopper-Pearson CIs, remedy-class tags, aggregate rate vs observed ~33%, the `6c0a6fe5`
  named line item, composition-coverage statement.

## Decisions taken
- Pre-registered bar (still stands): a composition-variation result only counts as evidence for
  hypothesis 4 if a test 0/20-clean at baseline shows ≥2 failures in a single 8-run batch — never a
  singleton — and even then triggers a mandatory +15-run targeted resample before being called.
- `6c0a6fe5` stays a named line item, expected 0 — premise retracted, it was a TRUE POSITIVE
  (`createWorktree` race, since fixed), not a flake. Do not re-frame it.
- Census harness lives entirely under `test/census/` (lib + fixtures + synthetic + raw data + this notes
  file) — never touches the real `test/` directory content, so it can never leak into or corrupt anyone
  else's gate run.
