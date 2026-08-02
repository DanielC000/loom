import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// CodescapeSupervisor's periodic /graph/health liveness probe — closes the gap that
// spawnServe's child.on("exit") detector can't see: a `serve` that's alive, port bound, and simply not
// answering (wedged). REAL-SPAWN, hermetic: the fixture `codescape` CLI (test/fixtures/fake-codescape-cli.mjs)
// stands in for the real binary and answers GET /graph/health for real — normally 200, or (when the env-named
// wedge-flag FILE exists on disk) it silently never responds, simulating an accepted-but-hung connection.
// Claude-free, network-free beyond loopback.
//
// Proves the DoD:
//   (1) an alive-but-unresponsive serve (sustained wedge from boot) is detected and restarted through the
//       EXISTING child-exit -> onDeath -> scheduleRestart path (a real new pid, same port) — no second
//       restart channel.
//   (2) the give-up state stays terminal: once the bounded restartAttempts budget is exhausted by
//       repeated health-driven kills, getPort() stays null and no further serve spawn occurs even while
//       the health-probe timer keeps ticking.
//   (3) a SUB-threshold wedge window (recovers before enough consecutive failures accumulate) does NOT
//       trigger any restart at all.
//   (4) codescape enabled but with ZERO codescape-enabled projects (repoPaths === []) STILL arms the
//       health-probe timer — a sustained wedge is detected and restarted the same as any other boot. (The
//       probe used to be gated off by project count, leaving that boot's serve unwatched for its entire
//       lifetime — since v1 has no runtime project registration, a project enabling codescape later in the
//       same boot could never re-arm it either.)
//
// Run: 1) build (turbo builds shared first), 2) node test/codescape-health-probe.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Card cc43c74d: waits for `cond()` WITHOUT a guessed total-duration budget — a fixed iteration cap
// (e.g. 200*50ms) can expire while the awaited event (here, a drift restart gated on WALL-CLOCK time via
// supervisor.ts's own `driftStabilityMs` check) is still legitimately in progress under full-suite
// contention, turning a real "still working" into a false "failed". Instead this keeps waiting as long as
// `tickCounter()` (the supervisor's own `getCompletedProbeTickCount` — a real, observable unit of
// completed work) keeps advancing, and only gives up if it genuinely STALLS (no tick completes for
// `stallTimeoutMs`, generous above this file's own bounded per-tick subprocess timeouts) — an actual hang,
// not a slow-but-progressing host. See test/codescape-health-probe.mjs scenario (5)'s own history.
//
// Card 44d1dfd8 — LIMIT of `stallTimeoutMs`, stated precisely: it bounds LACK OF PROGRESS ON THE SHARED
// PROBE HEARTBEAT (`tickCounter()`), not on this call's own `cond()`. If the probe keeps ticking —
// meaning the supervisor is alive and health-probing successfully — while `cond()` never becomes true
// (the shape of a genuine regression: a restart that never fires, a spawn that never lands), the stall
// clock keeps resetting on every tick and this does NOT time out. It is bounded only by the test
// runner's per-file timeout in that case. This is deliberate, not an oversight: a slow, loud hang beats a
// fast false FAIL on a healthy-but-contended system, which is the defect this helper replaces. Do not
// read "has a stallTimeoutMs" as "is bounded against its own condition never becoming true" — it isn't.
async function waitForCompletedCondition(cond, tickCounter, { pollMs = 25, stallTimeoutMs = 8000 } = {}) {
  let lastTicks = tickCounter();
  let lastProgressAt = Date.now();
  while (!cond()) {
    await sleep(pollMs);
    if (cond()) break;
    const ticks = tickCounter();
    if (ticks !== lastTicks) { lastTicks = ticks; lastProgressAt = Date.now(); }
    if (Date.now() - lastProgressAt > stallTimeoutMs) return false; // genuinely stalled — no probe-tick progress at all
  }
  return true;
}

// Card 90550a97 review follow-up: an unresolvable installed build must warn LOUDLY but only ONCE per
// distinct reason (never once per ~30s probe tick forever). Intercepts console.warn for the duration of a
// scenario (still forwarding to the real console, so failures stay visible in test output) and counts
// matches against a substring, so a test can assert "warned exactly once" over many probe ticks.
function captureWarnings() {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => { lines.push(args.join(" ")); original(...args); };
  return { lines, restore: () => { console.warn = original; } };
}

// Card 4c7a337d: same technique as captureWarnings, for the give-up path's `console.error` — the loud
// "codescape serve is DOWN … needs a human" diagnostic must be provably REACHABLE for a sustained crash
// loop, not just inferred from getPort() going null.
function captureErrors() {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.join(" ")); original(...args); };
  return { lines, restore: () => { console.error = original; } };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureCli = path.join(__dirname, "fixtures", "fake-codescape-cli.mjs");

// --- Hermetic LOOM_HOME, set BEFORE importing dist (CODESCAPE_HOME_DIR derives from it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-cs-health-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
delete process.env.LOOM_CODESCAPE_ENABLED;
process.env.LOOM_CODESCAPE_BIN = fixtureCli;
process.env.LOOM_DEV = "1"; // gate: isLoomDev() + a resolvable codescape CLI (card 503a30a0)

const { CodescapeSupervisor } = await import("../dist/codescape/supervisor.js");

const readCalls = (callsFile) => fs.existsSync(callsFile)
  ? fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const readServeCalls = (callsFile) => readCalls(callsFile).filter((c) => c.cmd === "serve");

// ===================== (1) sustained wedge (from boot) is detected + restarted =====================
{
  const homeDir = path.join(tmpHome, "sustained-wedge-home");
  const wedgeFile = path.join(tmpHome, "sustained-wedge-flag");
  fs.writeFileSync(wedgeFile, "1"); // wedged from the very first probe onward
  process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE = wedgeFile;

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150], // fast — proves the restart without waiting real minutes
    healthyRunMs: 60_000, // a kill-right-after-spawn (wedge) must never count as "healthy"
    // healthProbeIntervalMs/healthProbeTimeoutMs: card cdbdf742 re-checked whether this pair could be
    // retightened now that spawn counting reads `getSpawnCount()` (immune to the child-self-report race
    // this margin ORIGINALLY guarded against — see the comment below). It should NOT be: that
    // investigation's own load testing found a SEPARATE, still-live reason for this margin — a freshly
    // spawned child genuinely needs real wall-clock time to start listening (Node runtime init + ESM
    // resolution), and a probe that lands before it does gets a connection failure indistinguishable from
    // a real wedge. Under synthetic CPU contention (24 busy-spin processes on a 16-core box, launched at
    // the same instant as this scenario), even THIS pair — already the widest in the file — produced a
    // false restart; a tighter pair would only make that worse. 300/180 is the floor this file has
    // actually run on; not shrinking it further is deliberate, not an oversight.
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
  });
  await sup.start(["/fake/repo/sustained-wedge"]);
  // Card b27f54b0: spawn presence/count is asserted off the SUPERVISOR's own counter
  // (`getSpawnCount()`, incremented in `spawnServe()` on the parent side the instant the OS process
  // exists), never off `readServeCalls(callsFile)` — that file is written by the CHILD about itself, so a
  // child killed before Node finishes initializing (~70-85ms observed, more under host load) never gets
  // there and a spawn that genuinely happened silently vanishes from that count. This block itself never
  // reads the calls file (no `callsFile` const here at all) — it's read further down, by later scenarios
  // in this file, for data the supervisor doesn't have (the fixture's own self-reported fields).
  await waitForCompletedCondition(() => sup.getSpawnCount() >= 1, () => sup.getCompletedProbeTickCount());
  const pidBefore = sup.getPid();
  const portBefore = sup.getPort();
  check("(1) initial serve spawned", sup.getSpawnCount() === 1 && typeof pidBefore === "number");

  // 3 consecutive failed probes @300ms apart (~900ms) should trigger a kill -> real exit -> the EXISTING
  // restart path. Progress-keyed (never a blind sleep or a fixed poll budget) off the supervisor's own
  // spawn counter, which is immune to the child-self-report lag described above.
  await waitForCompletedCondition(() => sup.getSpawnCount() >= 2, () => sup.getCompletedProbeTickCount());
  check("(1) a sustained wedge triggers a restart via the EXISTING death path (a new serve spawn recorded)",
    sup.getSpawnCount() === 2);
  check("(1) restart reused the SAME port", sup.getPort() === portBefore);
  check("(1) restart produced a genuinely NEW pid", sup.getPid() !== pidBefore && sup.getPid() !== null);

  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE;
}

// ===================== (2) give-up stays terminal under repeated health-driven kills =====================
{
  const homeDir = path.join(tmpHome, "giveup-wedge-home");
  const wedgeFile = path.join(tmpHome, "giveup-wedge-flag");
  fs.writeFileSync(wedgeFile, "1"); // wedged forever — every respawn is wedged too (env inherited by spawn)
  process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE = wedgeFile;

  const backoffMs = [40, 40]; // fast + few — exhausts the schedule quickly
  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: backoffMs,
    healthyRunMs: 60_000,
    // Card b27f54b0 — DELIBERATELY tightened back BELOW real child-startup latency (~70-85ms observed,
    // more under host load): floor time before a kill is eligible is (threshold-1)*intervalMs =
    // (2-1)*60 = 60ms, comfortably under that latency, so a freshly-restarted generation CAN legitimately
    // get killed before it finishes initializing. Before the spawn-counting fix below, that raced the
    // child's own self-report write to `fake-codescape-calls.jsonl` and made this scenario's "exactly N
    // spawns" count read low nondeterministically (the p0 incident, card 7a86df32) — this file used to pad
    // these values instead (300/180) to dodge the race rather than fix the measurement. Now that spawn
    // counting reads the SUPERVISOR's own counter (never the child's self-report — see scenario (1)'s
    // identical comment), these values are back at their original tight setting: a real assertion that the
    // wall-clock dependency is gone, not just re-padded.
    healthProbeIntervalMs: 60,
    healthProbeTimeoutMs: 40,
    healthProbeFailureThreshold: 2,
  });
  await sup.start(["/fake/repo/giveup-wedge"]);

  // Every spawn here is wedged from birth (env persists across the auto-restarts), so the supervisor
  // itself — never a manual kill — should drive exactly 1 (initial) + backoffMs.length (restarts) real
  // serve spawns before its OWN give-up branch refuses a further attempt.
  // Card b27f54b0: spawn count is read off `sup.getSpawnCount()` (the supervisor's own counter,
  // incremented on the parent side the instant each OS process exists), NEVER off
  // `readServeCalls(callsFile)` (the child's own self-report, which a pre-init kill — now routine at the
  // tightened intervals above — can make vanish). Progress-keyed off completed probe ticks, never a fixed
  // poll budget — and the assertion itself, the actual invariant under test, is UNCHANGED.
  const expectedSpawns = 1 + backoffMs.length;
  await waitForCompletedCondition(() => sup.getSpawnCount() >= expectedSpawns, () => sup.getCompletedProbeTickCount());
  check(`(2) exactly ${expectedSpawns} serve spawns recorded (initial + ${backoffMs.length} health-driven restarts), no more`,
    sup.getSpawnCount() === expectedSpawns);

  // The (expectedSpawns)-th spawn must ALSO get detected as wedged and killed before give-up is decided
  // (scheduleRestart's give-up branch runs off THAT kill's exit event) — wait for getPort() to settle null.
  await waitForCompletedCondition(() => sup.getPort() === null, () => sup.getCompletedProbeTickCount());
  check("(2) after the health-probe-driven kills exhaust the bounded restart budget, getPort() is null (gave up, not phantom-alive)",
    sup.getPort() === null);

  const spawnsAtGiveUp = sup.getSpawnCount();
  await sleep(1000); // several more health-probe intervals' worth — a lingering tick must NOT resurrect it
  check("(2) give-up STAYS terminal — no further restart / serve spawn, even with the health-probe timer still ticking",
    sup.getPort() === null && sup.getSpawnCount() === spawnsAtGiveUp);

  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE;
}

// ===================== (3) a sub-threshold wedge window (recovers in time) never restarts =====================
{
  const homeDir = path.join(tmpHome, "blip-wedge-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  const wedgeFile = path.join(tmpHome, "blip-wedge-flag"); // does NOT exist yet — starts healthy
  process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE = wedgeFile;

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    // Card cdbdf742: healthProbeIntervalMs/healthProbeTimeoutMs deliberately match the 300/180 combo this
    // file already uses everywhere ELSE (scenarios (1)/(5)/(6)/(7)/(8)/(8b)/(8c)/(9)/(10)/(11)/(12)) — not
    // an invented number. The 100/50 pair this scenario used to run at gave a failure floor
    // ((threshold-1)*intervalMs) of only 200ms against a 140ms wedge window: a 60ms real-time buffer,
    // measured (this card) to reproduce false restarts under real host load — a batch of 15 runs under
    // synthetic CPU contention (24 busy-spin processes on a 16-core box) restarted 6/15 with the old
    // 100/50 pair, INCLUDING iterations where the test's own sleep(140) drifted by only ~5-12ms — proving
    // the false restarts come from the supervisor's OWN probe-interval timer compressing under load, not
    // solely from this scenario's sleep drifting. At 300/180 the floor becomes 600ms against the same
    // 140ms window (a 460ms buffer, ~7.7x the old one) and the SAME batch of runs, under the SAME
    // synthetic load, restarted 0/15. Residual risk: under an even more extreme burst (this scenario's own
    // process launching 24 fresh CPU-bound children at the exact same instant, not just running alongside
    // already-warm ones), scenario (1) — already at 300/180 in production today — ALSO produced false
    // failures in the same measurement session; that edge is this file's existing, already-accepted
    // contention tolerance (shared by every other scenario here), not something new this change
    // introduces, and it is far beyond this project's actual gate concurrency (maxConcurrentGates=2).
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3, // needs 3 CONSECUTIVE failures — this window can produce at most 1
  });
  await sup.start(["/fake/repo/blip-wedge"]);
  for (let i = 0; i < 50 && readServeCalls(callsFile).length < 1; i++) await sleep(50);
  const pidBefore = sup.getPid();

  // Wedge for a window well under one probe interval (140ms < 300ms), so realistically at most 1 probe
  // lands while it's present — never enough to reach the threshold of 3 — then recover.
  fs.writeFileSync(wedgeFile, "1");
  await sleep(140);
  fs.rmSync(wedgeFile);

  // Wait well past what 3 consecutive failures + kill + fastest restart backoff would have needed (the
  // failure floor alone is now 600ms — see the interval/timeout comment above), to prove no restart ever
  // happened (the recovering success resets the counter to 0 before threshold).
  await sleep(1000);
  // Card b27f54b0's fix (verified in scenarios (1)/(2)): the count half reads `sup.getSpawnCount()` (the
  // supervisor's own parent-side counter, incremented the instant spawn() returns), never
  // `readServeCalls(callsFile)` (the child's own self-report). In a NEGATIVE assertion like this one, a
  // child killed before it finishes writing its record would make the calls-file count read LOW — masking
  // a real restart rather than catching it. `sup.getPid() === pidBefore` stays the load-bearing conjunct
  // either way (parent-sourced, set synchronously by spawn()); this swap just removes the weaker half's
  // last child-self-report dependency.
  check("(3) a sub-threshold wedge window that recovers in time does NOT trigger a restart",
    sup.getSpawnCount() === 1 && sup.getPid() === pidBefore);

  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE;
}

// ===================== (4) codescape enabled but ZERO codescape-enabled projects: the probe is STILL armed ====
// Bugfix: `startHealthMonitor()` used to be gated on a `hasEnabledProjects` flag latched from
// `repoPaths.length` at `start()` time, so a daemon that booted with no codescape-enabled projects never
// armed the probe at all — for that boot's ENTIRE lifetime, since v1 has no runtime project registration
// (a project enabling codescape after boot still needs a daemon restart to ever be ingested, regardless of
// anything this probe does — see gateway/server.ts's config-PATCH log line). `serve` still spawns
// unconditionally either way (see `start()`), so that boot's serve ran fully unwatched — exactly the wedge
// blind spot this probe exists to close. The fix arms the probe unconditionally whenever `start()` spawns
// `serve`, letting `probeHealth`'s own `!alive` guard do the "nothing to watch yet" gating instead. This is
// the SAME proof shape as scenario (1) (a sustained wedge detected + restarted through the existing death
// path) — just started with repoPaths=[] to prove the probe is no longer silently disarmed by an empty
// project list.
{
  const homeDir = path.join(tmpHome, "noproj-wedge-home");
  const wedgeFile = path.join(tmpHome, "noproj-wedge-flag");
  fs.writeFileSync(wedgeFile, "1"); // wedged from the very first probe onward
  process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE = wedgeFile;

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
  });
  await sup.start([]); // NO repoPaths — the health probe must arm anyway
  await waitForCompletedCondition(() => sup.getSpawnCount() >= 1, () => sup.getCompletedProbeTickCount());
  const pidBefore = sup.getPid();
  const portBefore = sup.getPort();
  check("(4) serve still spawns normally with zero repoPaths", sup.getSpawnCount() === 1 && typeof pidBefore === "number");

  await waitForCompletedCondition(() => sup.getSpawnCount() >= 2, () => sup.getCompletedProbeTickCount());
  check("(4) a sustained wedge is detected and restarted even with ZERO codescape-enabled projects (a new serve spawn recorded)",
    sup.getSpawnCount() === 2);
  check("(4) restart reused the SAME port", sup.getPort() === portBefore);
  check("(4) restart produced a genuinely NEW pid", sup.getPid() !== pidBefore && sup.getPid() !== null);

  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE;
}

// ===================== (5) genuine build drift: a single STABLE drift restarts once, then does NOT loop; a NEW drift fires again ====
{
  const homeDir = path.join(tmpHome, "drift-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  process.env.FAKE_CODESCAPE_HEALTH_BUILD = "build-old"; // the running serve never actually picks up a new build in this test
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-new";

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    // Same margin rule as scenarios (1)/(2): intervalMs/timeoutMs must stay safely above real child-
    // process startup latency (~70-85ms observed, more under host load), or a restart here can be killed
    // by an unrelated wedge probe failure before it ever gets a fair chance to answer a drift check.
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
    versionProbeTimeoutMs: 2000,
    // Card 9e6f984d: a drift restart now requires the installed build to sit UNCHANGED for
    // driftStabilityMs before it fires — a short test-only window (not the real ~10-15min default) so
    // this scenario settles in well under a second instead of waiting real minutes.
    driftStabilityMs: 500,
  });
  const warnings = captureWarnings();
  // NOTE: drift no longer fires on the very first successful health probe — it must first be observed
  // as UNCHANGED across enough probe ticks to satisfy driftStabilityMs (here: a couple of 300ms ticks).
  // So every assertion below reads pids from the calls-file LOG itself (each record carries the spawning
  // process's own `pid`) rather than sampling live supervisor state, and only bumps env AFTER confirming
  // the previous restart's spawn is already on record — race-free regardless of exactly how many probe
  // ticks the stability window ends up spanning.
  await sup.start(["/fake/repo/drift"]);
  const portAfterStart = sup.getPort(); // the reserved port is fixed for the instance's lifetime — safe to read anytime

  await waitForCompletedCondition(() => readServeCalls(callsFile).length >= 2, () => sup.getCompletedProbeTickCount());
  let calls = readServeCalls(callsFile);
  check("(5) a genuine, STABLE build drift (running != installed, unchanged for the stability window) triggers a restart via the EXISTING death path (initial spawn + one restart on record)",
    calls.length === 2);
  check("(5) restart reused the SAME port", sup.getPort() === portAfterStart);
  check("(5) restart produced a genuinely NEW pid", calls.length === 2 && calls[0].pid !== calls[1].pid);
  check("(5) the deferral was logged distinguishably from the eventual restart (a 'deferring restart' line preceded a 'drift STABLE' line)",
    warnings.lines.some((l) => l.includes("deferring restart")) && warnings.lines.some((l) => l.includes("drift STABLE")));
  // Card 545ef479 (Defect 1): the fifth distinguishable state — a genuine mismatch — reads as "mismatch",
  // never as "match" and never as either "not-checked" bucket.
  check("(5) drift-check state reads mismatch for a genuine, differing build pair",
    sup.getDriftCheckState() === "mismatch");

  // The new (2nd) child inherits the SAME env, so it keeps reporting the SAME stale running build against
  // the SAME installed build — a persisting mismatch. Several more probe intervals must NOT trigger a
  // second kill: one restart per drift event, never an endless cycle.
  await sleep(900);
  check("(5) a persisting mismatch against the SAME installed build does NOT loop (still exactly 2 spawns on record)",
    readServeCalls(callsFile).length === 2);

  // Now the installed build genuinely moves on — a NEW drift event — which must fire its OWN restart,
  // again only once IT has been stable for the full window.
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-newer";
  await waitForCompletedCondition(() => readServeCalls(callsFile).length >= 3, () => sup.getCompletedProbeTickCount());
  calls = readServeCalls(callsFile);
  check("(5) a NEW drift (installed build changes again) fires its own restart, once stable (a 3rd spawn on record)",
    calls.length === 3 && calls[2].pid !== calls[1].pid);

  warnings.restore();
  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
  delete process.env.FAKE_CODESCAPE_INSTALLED_BUILD;
}

// ===================== (6) running build ABSENT from the health response never restarts =====================
{
  const homeDir = path.join(tmpHome, "drift-absent-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  process.env.FAKE_CODESCAPE_HEALTH_BUILD = "__ABSENT__";
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-new";

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    // Same margin rule as scenarios (1)/(2) above: intervalMs/timeoutMs must stay safely above real
    // child-process startup latency (~70-85ms observed, more under host load), or a restart can be killed
    // (by an unrelated wedge probe failure, or miscounted by a test racing its own diagnostic window)
    // before it ever gets a fair chance to run.
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
    versionProbeTimeoutMs: 2000,
  });
  await sup.start(["/fake/repo/drift-absent"]);
  for (let i = 0; i < 50 && readServeCalls(callsFile).length < 1; i++) await sleep(50);
  const pidBefore = sup.getPid();

  await sleep(500); // several probe intervals — an absent `build` field must never be treated as a mismatch
  check("(6) `build` ABSENT from the health response never triggers a restart",
    readServeCalls(callsFile).length === 1 && sup.getPid() === pidBefore);
  // Card 545ef479 (Defect 1): this is one of the two states that used to be a SILENT early return,
  // indistinguishable from a steady-state MATCH. Assert it now reads as its own distinguishable bucket.
  check("(6) drift-check state distinguishes this from MATCH: not-checked:running-absent",
    sup.getDriftCheckState() === "not-checked:running-absent");

  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
  delete process.env.FAKE_CODESCAPE_INSTALLED_BUILD;
}

// ===================== (7) running build:null never restarts =====================
{
  const homeDir = path.join(tmpHome, "drift-null-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  process.env.FAKE_CODESCAPE_HEALTH_BUILD = "__NULL__";
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-new";

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    // Same margin rule as scenarios (1)/(2) above: intervalMs/timeoutMs must stay safely above real
    // child-process startup latency (~70-85ms observed, more under host load), or a restart can be killed
    // (by an unrelated wedge probe failure, or miscounted by a test racing its own diagnostic window)
    // before it ever gets a fair chance to run.
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
    versionProbeTimeoutMs: 2000,
  });
  await sup.start(["/fake/repo/drift-null"]);
  for (let i = 0; i < 50 && readServeCalls(callsFile).length < 1; i++) await sleep(50);
  const pidBefore = sup.getPid();

  await sleep(500);
  check("(7) `build: null` never triggers a restart",
    readServeCalls(callsFile).length === 1 && sup.getPid() === pidBefore);
  check("(7) drift-check state also reads not-checked:running-absent for a running `build:null`",
    sup.getDriftCheckState() === "not-checked:running-absent");

  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
  delete process.env.FAKE_CODESCAPE_INSTALLED_BUILD;
}

// ===================== (8) an unresolvable INSTALLED build (spawn failure / non-JSON) never restarts, but IS loud (once) ====
for (const installedFailureMode of ["__FAIL__", "__NONJSON__"]) {
  const homeDir = path.join(tmpHome, `drift-installed-unresolved-${installedFailureMode.replace(/\W/g, "")}-home`);
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  process.env.FAKE_CODESCAPE_HEALTH_BUILD = "build-old"; // a real, resolvable running build
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = installedFailureMode;

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    // Same margin rule as every other scenario in this file (see (1)/(2)/(5) etc.'s identical comment):
    // intervalMs/timeoutMs must stay safely above real subprocess round-trip latency, or the WEDGE
    // detector (an unrelated mechanism from the build-drift-latch behavior this scenario actually tests)
    // can false-positive under host load and kill+restart the serve — which scenario (8) explicitly
    // asserts never happens. An earlier, more aggressive 60/200 combo here (chosen to pack "many ticks"
    // into a fixed sleep window) was exactly that false-positive under load; a deterministic wait on
    // completed probe ticks (below) replaces the need for a fast interval to get enough ticks in.
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
    versionProbeTimeoutMs: 2000,
  });
  const warnings = captureWarnings();
  await sup.start([`/fake/repo/drift-installed-unresolved-${installedFailureMode}`]);
  for (let i = 0; i < 50 && readServeCalls(callsFile).length < 1; i++) await sleep(50);
  const pidBefore = sup.getPid();

  // Drive a deterministic number of COMPLETED probe ticks instead of sleeping through a wall-clock window
  // and hoping enough landed — each successful health probe now spawns a REAL subprocess
  // (checkBuildDrift -> readInstalledBuild), so the number that complete in a fixed sleep is not
  // deterministic under host load. Wait for several completed ticks (each one re-exercises the
  // diagnostic-latch check), then settle briefly to catch a would-be flood before asserting.
  const MIN_TICKS = 5;
  // Card 44d1dfd8: each completed tick here re-exercises a REAL subprocess round-trip (checkBuildDrift ->
  // readInstalledBuild), so waiting for 5 of them to land is the SAME repeated-spawn-under-contention
  // shape as scenario (5)'s driftStabilityMs defect — a fixed elapsed cap over that is still a timing
  // guess (this site's own guessed margin was tighter than the ~10x that already proved insufficient
  // there). waitForCompletedCondition has no such cap; cond and tickCounter share the same underlying
  // counter here, so "progress" and "satisfied" are the same signal.
  await waitForCompletedCondition(() => sup.getCompletedProbeTickCount() >= MIN_TICKS, () => sup.getCompletedProbeTickCount());
  check(`(8) at least ${MIN_TICKS} probe ticks completed (${installedFailureMode})`,
    sup.getCompletedProbeTickCount() >= MIN_TICKS);
  await sleep(200); // settle window — let a would-be flood happen before checking the counts below

  check(`(8) an unresolvable installed build (${installedFailureMode}) never triggers a restart`,
    readServeCalls(callsFile).length === 1 && sup.getPid() === pidBefore);

  const diagnosticLines = warnings.lines.filter((l) => l.includes("cannot read the INSTALLED build id"));
  check(`(8) an unresolvable installed build (${installedFailureMode}) is reported LOUDLY, but exactly ONCE across ${MIN_TICKS}+ completed probe ticks (not once per tick)`,
    diagnosticLines.length === 1);
  // Card 545ef479 (Defect 1): a genuine couldn't-read is its OWN distinguishable bucket too — never left
  // reading as a stale prior state (e.g. a leftover "match" from before the failure started).
  check(`(8) drift-check state reads not-checked:installed-read-failed (${installedFailureMode})`,
    sup.getDriftCheckState() === "not-checked:installed-read-failed");

  warnings.restore();
  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
  delete process.env.FAKE_CODESCAPE_INSTALLED_BUILD;
}

// ===================== (8b) the diagnostic re-fires if the failure REASON changes, and stops once it recovers ====
{
  const homeDir = path.join(tmpHome, "drift-installed-unresolved-reason-change-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  process.env.FAKE_CODESCAPE_HEALTH_BUILD = "build-old";
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "__FAIL__";

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    // Same margin rule as scenarios (1)/(2) above: intervalMs/timeoutMs must stay safely above real
    // child-process startup latency (~70-85ms observed, more under host load), or a restart can be killed
    // (by an unrelated wedge probe failure, or miscounted by a test racing its own diagnostic window)
    // before it ever gets a fair chance to run.
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
    versionProbeTimeoutMs: 2000,
  });
  const warnings = captureWarnings();
  const diagCount = () => warnings.lines.filter((l) => l.includes("cannot read the INSTALLED build id")).length;
  // Poll until the expected count first APPEARS (never a blind sleep-then-snapshot — a straggler
  // diagnostic can land after its own probe's subprocess round-trip, arbitrarily close to a fixed
  // sleep's boundary), THEN settle an extra window and re-check — catches a FLOOD (more than expected)
  // that a bare "count >= expected" poll would otherwise miss by returning the instant it's satisfied.
  // Card 44d1dfd8: each diagnostic is gated behind its own completed probe tick (a real subprocess
  // round-trip) — the same repeated-spawn-under-contention shape as scenario (5)'s driftStabilityMs
  // defect — so this is progress-keyed off getCompletedProbeTickCount(), not a guessed elapsed budget.
  // The 400ms settle sleep AFTER satisfaction is a deliberate flood-catch window, not a timing guess.
  const waitForDiagCount = async (atLeast) => {
    await waitForCompletedCondition(() => diagCount() >= atLeast, () => sup.getCompletedProbeTickCount());
    await sleep(400); // deliberate flood-catch window, not a completion guess — diagCount() is already satisfied by the line above
  };

  await sup.start(["/fake/repo/drift-installed-unresolved-reason-change"]);
  for (let i = 0; i < 50 && readServeCalls(callsFile).length < 1; i++) await sleep(50);

  await waitForDiagCount(1);
  check("(8b) exactly one diagnostic for the FIRST failure reason", diagCount() === 1);

  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "__NONJSON__"; // a DIFFERENT reason — must warn again once
  await waitForDiagCount(2);
  check("(8b) a CHANGED failure reason produces exactly one MORE diagnostic (not zero, not a flood)",
    diagCount() === 2);

  const recoveryCount = () => warnings.lines.filter((l) => l.includes("drift detection recovered")).length;
  // Card 44d1dfd8: same reasoning as waitForDiagCount above — progress-keyed, not elapsed-keyed.
  const waitForRecoveryCount = async (atLeast) => {
    await waitForCompletedCondition(() => recoveryCount() >= atLeast, () => sup.getCompletedProbeTickCount());
    await sleep(400); // deliberate flood-catch window, not a completion guess — recoveryCount() is already satisfied by the line above
  };

  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-old"; // recovers: now matches the running build exactly
  await waitForRecoveryCount(1);
  check("(8b) card ebd755ab (Gap 2): the inert -> recovered transition is announced, exactly ONCE",
    recoveryCount() === 1);
  check("(8b) recovery adds no further 'cannot read' diagnostics (still exactly 2, unchanged)",
    diagCount() === 2);
  check("(8b) recovery with a MATCHING build does not restart either", readServeCalls(callsFile).length === 1);

  warnings.restore();
  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
  delete process.env.FAKE_CODESCAPE_INSTALLED_BUILD;
}

// ===================== (8c) an HONEST installed build:null (exit 0) is a real answer, not a failure — SILENT, no restart ====
{
  const homeDir = path.join(tmpHome, "drift-installed-honest-null-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  process.env.FAKE_CODESCAPE_HEALTH_BUILD = "build-old"; // a real, resolvable running build
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "__NULL__"; // exit 0, {"version":"fake","build":null} — an honest answer

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    // Same margin rule as scenarios (1)/(2) above: intervalMs/timeoutMs must stay safely above real
    // child-process startup latency (~70-85ms observed, more under host load), or a restart can be killed
    // (by an unrelated wedge probe failure, or miscounted by a test racing its own diagnostic window)
    // before it ever gets a fair chance to run.
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
    versionProbeTimeoutMs: 2000,
  });
  const warnings = captureWarnings();
  await sup.start(["/fake/repo/drift-installed-honest-null"]);
  for (let i = 0; i < 50 && readServeCalls(callsFile).length < 1; i++) await sleep(50);
  const pidBefore = sup.getPid();

  await sleep(500); // several probe ticks — an honest exit-0 build:null must never be mistaken for a read failure
  check("(8c) an HONEST installed build:null never triggers a restart",
    readServeCalls(callsFile).length === 1 && sup.getPid() === pidBefore);
  const diagnosticLines = warnings.lines.filter((l) => l.includes("cannot read the INSTALLED build id"));
  check("(8c) an HONEST installed build:null is SILENT — it is a real answer, not a couldn't-read failure",
    diagnosticLines.length === 0);
  // Card 545ef479 (Defect 1): the OTHER silent collapse — an honest installed `build:null` used to be
  // byte-identical downstream to a steady-state MATCH (both were pure early returns, no signal at all).
  check("(8c) drift-check state distinguishes this from MATCH: not-checked:installed-null",
    sup.getDriftCheckState() === "not-checked:installed-null");

  warnings.restore();
  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
  delete process.env.FAKE_CODESCAPE_INSTALLED_BUILD;
}

// ===================== (9) `version` is NEVER the drift signal — a version mismatch with build MATCHING must not restart ====
{
  const homeDir = path.join(tmpHome, "drift-version-unused-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  process.env.FAKE_CODESCAPE_HEALTH_BUILD = "same-build";
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "same-build";
  process.env.FAKE_CODESCAPE_HEALTH_VERSION = "totally-different-version"; // if drift ever read `version`, this alone would look like a mismatch

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    // Same margin rule as scenarios (1)/(2) above: intervalMs/timeoutMs must stay safely above real
    // child-process startup latency (~70-85ms observed, more under host load), or a restart can be killed
    // (by an unrelated wedge probe failure, or miscounted by a test racing its own diagnostic window)
    // before it ever gets a fair chance to run.
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
    versionProbeTimeoutMs: 2000,
  });
  await sup.start(["/fake/repo/drift-version-unused"]);
  for (let i = 0; i < 50 && readServeCalls(callsFile).length < 1; i++) await sleep(50);
  const pidBefore = sup.getPid();

  await sleep(500);
  check("(9) `build` matching never restarts even when `version` differs — `version` is not the drift signal",
    readServeCalls(callsFile).length === 1 && sup.getPid() === pidBefore);
  // Card 545ef479 (Defect 1): the fourth distinguishable state — a genuine, comparable MATCH — completing
  // the RED case from today's code: (a)/(b)/(c) were all silent and indistinguishable; this proves they
  // are now separable.
  check("(9) drift-check state reads match for a genuine, comparable MATCH",
    sup.getDriftCheckState() === "match");

  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
  delete process.env.FAKE_CODESCAPE_INSTALLED_BUILD;
  delete process.env.FAKE_CODESCAPE_HEALTH_VERSION;
}

// ===================== (10) drift detection cannot resurrect a serve past an exhausted restartAttempts budget ====
{
  const homeDir = path.join(tmpHome, "drift-giveup-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  process.env.FAKE_CODESCAPE_HEALTH_BUILD = "build-stuck"; // the running serve never actually comes up on the new build
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-1"; // a fresh drift target for the initial spawn

  const backoffMs = [40, 40]; // fast + few — exhausts the schedule quickly
  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: backoffMs,
    healthyRunMs: 60_000, // a kill-right-after-spawn (drift) must never count as "healthy"
    // Same margin rule as scenarios (1)/(2) above: intervalMs/timeoutMs must stay safely above real
    // child-process startup latency (~70-85ms observed, more under host load), or a restart can be killed
    // (by an unrelated wedge probe failure, or miscounted by a test racing its own diagnostic window)
    // before it ever gets a fair chance to run.
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
    versionProbeTimeoutMs: 2000,
    // Card 9e6f984d: short test-only stability window (see scenario (5)'s identical seam) — each drift
    // below must still sit stable before it fires, just not for the real ~10-15min default.
    driftStabilityMs: 500,
  });
  await sup.start(["/fake/repo/drift-giveup"]);

  // Same shape as test (2)'s give-up proof, but EVERY kill here is drift-driven, not a health-probe
  // timeout. Staged (not a generic loop) and race-free like test (5): each env bump happens only AFTER
  // the previous restart's spawn is already on record, so `lastDriftRestartInstalledBuild` can never be
  // raced past — this proves the give-up ceiling binds drift restarts too, not just death/wedge restarts.
  // backoffMs=[40,40] (length 2): kill#1 (vs "build-1", once stable) schedules restart #1 (call #2,
  // restartAttempts->1); kill#2 (vs "build-2", once stable) schedules restart #2 (call #3,
  // restartAttempts->2); kill#3 (vs "build-3", once stable) finds restartAttempts(2) >=
  // backoffMs.length(2) and gives up — no call #4. Each stage now waits out its own stability window
  // (not instant), so the polling loops below are generous (up to 200 x 50ms).
  await waitForCompletedCondition(() => readServeCalls(callsFile).length >= 2, () => sup.getCompletedProbeTickCount());
  check("(10) restart #1 (drift vs the initial installed build, once stable) recorded", readServeCalls(callsFile).length === 2);

  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-2"; // arm the SECOND drift event
  await waitForCompletedCondition(() => readServeCalls(callsFile).length >= 3, () => sup.getCompletedProbeTickCount());
  check("(10) restart #2 (a NEW drift, once stable) recorded", readServeCalls(callsFile).length === 3);

  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-3"; // arm the THIRD drift event — this one exhausts the budget
  await waitForCompletedCondition(() => sup.getPort() === null, () => sup.getCompletedProbeTickCount());
  check("(10) after drift-driven kills exhaust the bounded restart budget, getPort() is null (gave up, not phantom-alive)",
    sup.getPort() === null);
  check("(10) give-up happened WITHOUT a 4th spawn (drift cannot resurrect past the exhausted budget)",
    readServeCalls(callsFile).length === 3);

  // Belt-and-suspenders: even a BRAND NEW drift event (installed build moves on yet again) must NOT
  // resurrect a serve past the exhausted budget — probeHealth itself no-ops once `!alive`.
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-final-after-giveup";
  const callsAtGiveUp = readServeCalls(callsFile).length;
  await sleep(400);
  check("(10) give-up STAYS terminal under drift — no further restart / serve spawn, even with a fresh drift event and the health-probe timer still ticking",
    sup.getPort() === null && readServeCalls(callsFile).length === callsAtGiveUp);

  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
  delete process.env.FAKE_CODESCAPE_INSTALLED_BUILD;
}

// ===================== (11) card 9e6f984d: a burst of N distinct installed builds collapses into ONE restart, after settling ====
{
  const homeDir = path.join(tmpHome, "drift-burst-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  process.env.FAKE_CODESCAPE_HEALTH_BUILD = "build-old"; // the running serve never actually picks up a new build in this test
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-burst-1"; // the FIRST build in the burst

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    // Same margin rule as scenarios (1)/(2)/(5): intervalMs/timeoutMs must stay safely above real
    // child-process startup latency, or an unrelated wedge false-positive could confound this scenario.
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
    versionProbeTimeoutMs: 2000,
    driftStabilityMs: 700, // short test window; must span more than one 300ms probe tick to prove the reset-on-new-candidate behavior
  });
  const warnings = captureWarnings();
  await sup.start(["/fake/repo/drift-burst"]);
  for (let i = 0; i < 50 && readServeCalls(callsFile).length < 1; i++) await sleep(50);

  // Drive THREE distinct installed builds, one per COMPLETED probe tick (never a blind sleep — see this
  // file's own header on why margin and counting are separate axes) — each new distinct build seen
  // resets the stability window, so the burst must not fire a restart until the LAST build in it has sat
  // unchanged for the full driftStabilityMs. Coordinating off completedProbeTicks makes each env change
  // land on its own tick deterministically, regardless of host scheduling jitter.
  let tick = sup.getCompletedProbeTickCount();
  for (let i = 0; i < 100 && sup.getCompletedProbeTickCount() < tick + 1; i++) await sleep(20); // tick sees build-burst-1
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-burst-2";
  tick = sup.getCompletedProbeTickCount();
  for (let i = 0; i < 100 && sup.getCompletedProbeTickCount() < tick + 1; i++) await sleep(20); // tick sees build-burst-2 (new candidate, window resets)
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-burst-final";

  check("(11) mid-burst: no restart has fired yet (each distinct build reset the still-open stability window)",
    readServeCalls(callsFile).length === 1);

  // Now let the FINAL build sit unchanged for the full stability window — exactly one restart follows.
  await waitForCompletedCondition(() => readServeCalls(callsFile).length >= 2, () => sup.getCompletedProbeTickCount());
  let calls = readServeCalls(callsFile);
  check("(11) a burst of 3 distinct installed builds collapses into exactly ONE restart, once the LAST one settles",
    calls.length === 2 && calls[0].pid !== calls[1].pid);

  // The settled build now equals lastDriftRestartInstalledBuild, so no further restart should follow even
  // across several more stability-window-length intervals.
  await sleep(900);
  check("(11) after the single settled restart, no further restart follows (still exactly 2 spawns on record)",
    readServeCalls(callsFile).length === 2);

  const deferredLines = warnings.lines.filter((l) => l.includes("deferring restart"));
  check("(11) each distinct build seen during the burst logged a DEFERRED-drift line (visible — never indistinguishable from 'no drift detected')",
    deferredLines.length >= 3);
  const stableLines = warnings.lines.filter((l) => l.includes("drift STABLE"));
  check("(11) exactly one STABLE/restart line fired, and it names the final settled build",
    stableLines.length === 1 && stableLines[0].includes("build-burst-final"));

  warnings.restore();
  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
  delete process.env.FAKE_CODESCAPE_INSTALLED_BUILD;
}

// ===================== (12) card ebd755ab: drift UNRESOLVED after its one restart is spent is now LOUD (once), and RESOLVING it announces recovery (once) ====
{
  const homeDir = path.join(tmpHome, "drift-unresolved-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  process.env.FAKE_CODESCAPE_HEALTH_BUILD = "build-stale"; // the running serve never actually picks up the new installed build in this test
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-target";

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    // Same margin rule as every other scenario in this file: intervalMs/timeoutMs must stay safely above
    // real child-process startup latency (~70-85ms observed, more under host load).
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
    versionProbeTimeoutMs: 2000,
    driftStabilityMs: 500,
  });
  const warnings = captureWarnings();
  const unresolvedCount = () => warnings.lines.filter((l) => l.includes("drift UNRESOLVED")).length;
  const resolvedCount = () => warnings.lines.filter((l) => l.includes("drift RESOLVED")).length;

  await sup.start(["/fake/repo/drift-unresolved"]);

  // Wait for the ONE deliberate restart the one-restart-per-build guard allows (same shape as scenario (5)).
  await waitForCompletedCondition(() => readServeCalls(callsFile).length >= 2, () => sup.getCompletedProbeTickCount());
  check("(12) the drift's one allowed restart fired (initial spawn + one restart on record)",
    readServeCalls(callsFile).length === 2);

  // The respawned child inherits the SAME stale FAKE_CODESCAPE_HEALTH_BUILD, so the mismatch persists —
  // every later probe tick now hits the exhausted-restart guard. Drive several COMPLETED probe ticks
  // (never a blind sleep-then-count — probeInFlight legitimately skips ticks, see this file's own header
  // on why margin and counting are separate axes) and confirm the new diagnostic fires exactly ONCE, not
  // once per tick and not silently forever (the pre-fix defect this card exists to close).
  const MIN_TICKS = 5;
  const ticksAtRestart = sup.getCompletedProbeTickCount();
  for (let i = 0; i < 160 && sup.getCompletedProbeTickCount() < ticksAtRestart + MIN_TICKS; i++) await sleep(50);
  check(`(12) at least ${MIN_TICKS} more probe ticks completed after the one allowed restart`,
    sup.getCompletedProbeTickCount() >= ticksAtRestart + MIN_TICKS);
  await sleep(200); // settle window — catch a would-be flood before asserting
  check("(12) drift persisting after its one restart is spent logs the UNRESOLVED diagnostic exactly ONCE (not once per tick, and not silently forever)",
    unresolvedCount() === 1);
  check("(12) the exhausted-restart guard itself is UNCHANGED — still no second restart while the SAME installed build persists",
    readServeCalls(callsFile).length === 2);
  check("(12) no RESOLVED diagnostic yet — the drift genuinely has not resolved", resolvedCount() === 0);

  // Now the installed side reverts to the value the ALREADY-RUNNING child reports (simulating an operator
  // fix, or the bad deploy being rolled back) — a genuine recovery, never a restart (the running side
  // already matches). Assert the recovery transition is announced, exactly once.
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-stale";
  const ticksAtRecoveryArm = sup.getCompletedProbeTickCount();
  for (let i = 0; i < 160 && resolvedCount() < 1 && sup.getCompletedProbeTickCount() < ticksAtRecoveryArm + MIN_TICKS; i++) await sleep(50);
  await sleep(200); // settle window
  check("(12) the drift RESOLVING (installed build now matches the running build) announces recovery, exactly ONCE",
    resolvedCount() === 1);
  check("(12) recovery did not trigger a restart (still exactly 2 spawns on record)",
    readServeCalls(callsFile).length === 2);
  check("(12) the UNRESOLVED diagnostic did not re-fire during/after recovery (still exactly ONE)",
    unresolvedCount() === 1);

  warnings.restore();
  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
  delete process.env.FAKE_CODESCAPE_INSTALLED_BUILD;
}

// ===================== (13) card f0718488: a TIMED-OUT version probe is retried — a transient timeout rescued by a retry never even reaches the loud diagnostic ====
{
  const homeDir = path.join(tmpHome, "version-retry-success-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  process.env.FAKE_CODESCAPE_HEALTH_BUILD = "build-running";
  process.env.FAKE_CODESCAPE_INSTALLED_BUILD = "build-installed"; // resolvable once the hang clears
  process.env.FAKE_CODESCAPE_VERSION_HANG_ATTEMPTS = "1"; // the FIRST `--version` invocation hangs; the 2nd succeeds

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    // Same margin rule as every other scenario in this file (see (1)/(8) etc.) — kept consistent even
    // though this scenario's own subprocess timing (below) now dominates the tick's wall time.
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
    // Card 8bc899ce: raised from 300 to 2000 — 300 made attempt 2 (a REAL `node <fixture-cli> --version`
    // spawn, not a fixture-forced hang) race actual host spawn latency, so under contention it could ALSO
    // time out and push the attempt count to 3, flaking this scenario's exact-2 assertion. MEASURED on this
    // host (same {command,args} pair resolveCodescapeBin produces — `process.execPath <fixtureCli>
    // --version`): idle n=30 mean 94ms (min 81/max 118); under synthetic 24-busy-spin-process CPU
    // contention on this 16-core box (same methodology scenario (3)'s comment already cites) n=30 mean
    // 552ms (min 143/p90 895/max 948); under REAL ambient contention from this host's own live fleet at
    // measurement time (a concurrent `test:daemon` run plus several other worker worktree test/dev
    // processes — not synthetic) n=20 mean 379ms (min 168/p90 553/max 689) — already past the OLD 300ms
    // budget at the median. 2000ms clears every measured worst case here (synthetic and real) with
    // >=2x margin, and matches what every OTHER scenario in this file already uses for
    // versionProbeTimeoutMs (see (5)-(11)) — not a new number, the rest of the file's existing choice,
    // now backed by a measurement.
    // Attempt 1 stays fixture-forced regardless of this value (FAKE_CODESCAPE_VERSION_HANG_ATTEMPTS=1
    // below never responds), so raising it removes the attempt-2 race without weakening what this
    // scenario actually tests — the cost is this scenario's own wall time growing by roughly the delta
    // (attempt 1 now pays the full budget before timing out, ~1.7s slower than before).
    versionProbeTimeoutMs: 2000,
    // Card 8bc899ce: versionProbeRetryDelayMs is unaffected by the above — it only paces the gap BETWEEN
    // attempts, never raced against a real spawn.
    versionProbeRetryDelayMs: 50, // this card's new retry-backoff test seam
  });
  const warnings = captureWarnings();
  await sup.start(["/fake/repo/version-retry-success"]);
  for (let i = 0; i < 50 && readServeCalls(callsFile).length < 1; i++) await sleep(50);

  await waitForCompletedCondition(() => sup.getCompletedProbeTickCount() >= 1, () => sup.getCompletedProbeTickCount());
  check("(13) the first probe tick completed", sup.getCompletedProbeTickCount() >= 1);

  // ⭐ Observed ATTEMPT COUNT, never wall-clock (card f0718488's own DoD) — getVersionProbeAttemptCount()
  // is incremented once per real subprocess spawn inside readInstalledBuild's retry loop.
  check("(13) exactly 2 version-probe attempts were made (1 timeout + 1 retry that succeeded)",
    sup.getVersionProbeAttemptCount() === 2);
  const diagnosticLines = warnings.lines.filter((l) => l.includes("cannot read the INSTALLED build id"));
  check("(13) a transient timeout rescued by a retry never reaches the loud 'cannot read' diagnostic at all",
    diagnosticLines.length === 0);
  check("(13) the tick that retried into success did not restart serve",
    readServeCalls(callsFile).length === 1);

  warnings.restore();
  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
  delete process.env.FAKE_CODESCAPE_INSTALLED_BUILD;
  delete process.env.FAKE_CODESCAPE_VERSION_HANG_ATTEMPTS;
}

// ===================== (14) card f0718488: a version probe that ALWAYS times out exhausts the bounded retry budget, still fails the tick loudly (once), and NEVER restarts ====
{
  const homeDir = path.join(tmpHome, "version-retry-exhausted-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  process.env.FAKE_CODESCAPE_HEALTH_BUILD = "build-running";
  process.env.FAKE_CODESCAPE_VERSION_HANG_ATTEMPTS = "999"; // every `--version` invocation hangs — persistent, never resolves

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
    // Card 8bc899ce: DELIBERATELY left at 300 — NOT raised to 2000 like scenario (13)'s identical-looking
    // field. HANG_ATTEMPTS="999" above means every attempt here is fixture-forced to hang, at every
    // attempt, regardless of this value — there is no real subprocess completing quickly for it to race,
    // so a short timeout costs nothing in correctness (unlike (13), where a real spawn had to beat it).
    // Raising it here would only slow the test: this scenario already spends
    // versionProbeMaxAttempts(3) x versionProbeTimeoutMs(this value) x 2 completed ticks purely waiting
    // out timeouts, so matching (13)'s 2000 would add roughly (2000-300) x 3 x 2 = ~10.2s of pure wall
    // time for zero coverage gained. This is the decoupling the card asked for, not an oversight.
    versionProbeTimeoutMs: 300,
    versionProbeMaxAttempts: 3,
    versionProbeRetryDelayMs: 50,
  });
  const warnings = captureWarnings();
  await sup.start(["/fake/repo/version-retry-exhausted"]);
  for (let i = 0; i < 50 && readServeCalls(callsFile).length < 1; i++) await sleep(50);
  const pidBefore = sup.getPid();

  await waitForCompletedCondition(() => sup.getCompletedProbeTickCount() >= 1, () => sup.getCompletedProbeTickCount());
  check("(14) the first probe tick completed", sup.getCompletedProbeTickCount() >= 1);
  // ⭐ Observed ATTEMPT COUNT, never wall-clock — EXACTLY the configured max, not fewer (budget genuinely
  // exhausted) and not more (bounded, no runaway retry).
  check("(14) EXACTLY the max (3) version-probe attempts were made for the first tick",
    sup.getVersionProbeAttemptCount() === 3);

  const diagnosticLines = () => warnings.lines.filter((l) => l.includes("cannot read the INSTALLED build id"));
  check("(14) a persistent timeout IS reported loudly, exactly once (latched, same discipline as scenario (8))",
    diagnosticLines().length === 1);
  check("(14) the timeout diagnostic names the actual attempt count made (3 attempts)",
    diagnosticLines().some((l) => l.includes("3 attempts")));

  // ⭐ Assert BOTH halves of the fail-safe (the property most likely to be quietly broken by a refactor of
  // this retry loop): the tick classifies failed (asserted above via the diagnostic) AND this never
  // restarts — a probe that ultimately fails must only ever decline to act, never trigger a restart.
  check("(14) a persistently-timing-out version probe NEVER triggers a restart (fail-safe half 1: no spawn)",
    readServeCalls(callsFile).length === 1);
  check("(14) serve's pid is unchanged (fail-safe half 2: nothing was killed)",
    sup.getPid() === pidBefore);

  // Drive a second completed tick — the retry budget re-exhausts EVERY tick (never cached: checkBuildDrift
  // calls readInstalledBuild fresh on every probe), but the loud diagnostic must stay latched at exactly
  // one (same reason, unchanged) rather than re-firing per tick, and the fail-safe must hold across ticks.
  const ticksAtCheckpoint = sup.getCompletedProbeTickCount();
  await waitForCompletedCondition(() => sup.getCompletedProbeTickCount() >= ticksAtCheckpoint + 1, () => sup.getCompletedProbeTickCount());
  check("(14) a second completed tick re-spends the full attempt budget too (cumulative: 6 across 2 ticks) — the retry budget is per-tick, never cached",
    sup.getVersionProbeAttemptCount() === 6);
  check("(14) the diagnostic still did not re-fire on the second tick (still exactly ONE, same reason)",
    diagnosticLines().length === 1);
  check("(14) still no restart after a second exhausted tick (fail-safe holds across ticks too)",
    readServeCalls(callsFile).length === 1 && sup.getPid() === pidBefore);

  warnings.restore();
  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
  delete process.env.FAKE_CODESCAPE_VERSION_HANG_ATTEMPTS;
}

// ===================== (15) card 545ef479 (Defect 2): a sustained /graph/health 500 is NOT wedge evidence — no kill, no unbounded respawn cycle ====
// `scheduleRestart`'s give-up ceiling is only skipped when `ranHealthy` (spawnServe's
// `Date.now() - spawnedAt >= healthyRunMs`) is TRUE at kill time. A large `healthyRunMs` (e.g. the 60_000
// default, or this file's other scenarios' typical value) makes `ranHealthy` FALSE for any fast kill —
// which on PRE-fix code makes the bug look BOUNDED (it exhausts `restartBackoffMs` and gives up loudly)
// rather than UNBOUNDED (the card's actual claim: the give-up ceiling is never reached, only a quiet
// `warn`, never the loud "needs a human" `console.error`). `healthyRunMs:10` is kept DELIBERATELY tiny so a
// regression that reintroduces "500 counts as wedge" still shows up as genuinely unbounded growth, not a
// merely-bounded failure that DoD-8 already warns can pass on pre-fix code too (a single early kill is
// always bounded until it isn't).
//
// 🔴 CARD 09e56fd5 — CORRECTED: intervalMs/timeoutMs used to be 60/40 (threshold 2), reused from scenario
// (2)'s "already-proven-safe tight combo". That reuse was a SCOPE ERROR: scenario (2) proved 60/40 safe
// for RELIABLY PRODUCING a wanted wedge-kill fast — the opposite of what THIS scenario needs, which is
// margin against an UNWANTED false kill under real host load (the same margin every other "never
// restarts" scenario in this file already carries at 300/180 — see (3)'s own measured history: 100/50
// false-restarted 6/15 runs under synthetic contention, 300/180 false-restarted 0/15). At 60/40 this
// scenario is genuinely unsafe: a forced-delay rig (card 09e56fd5) proved that ANY response latency at or
// above ~30ms — a loopback HTTP round-trip easily stretched by ordinary host contention (concurrent gate
// lanes, other live sessions) — makes the client-side `AbortController` fire before the 500 ever arrives,
// which `probeHealth` cannot distinguish from a genuine no-answer wedge; two such timeouts in a row (the
// threshold) trigger a REAL kill, and since the fixture keeps answering (slowly), this repeats until the
// restart budget exhausts and the supervisor gives up entirely. The SAME rig confirmed 300/180 survives
// an injected 150ms delay (2.5x what broke 60/40) without a single restart. This is why the original
// merge-gate failure (specimen 7, card 09e56fd5) was IN-SUITE-ONLY and never reproduced standalone on an
// idle box: it needed exactly this kind of transient host-load latency spike, and 60/40 had essentially
// no margin to absorb one. Production's real defaults (30_000/5_000, threshold 3) are
// ~28x more generous than even the FIXED 300/180 here, so this was a TEST-ONLY timing artifact, never a
// production defect — nothing about the fix touches `src/codescape/supervisor.ts`.
{
  const homeDir = path.join(tmpHome, "health-500-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  const errorFile = path.join(tmpHome, "health-500-flag");
  fs.writeFileSync(errorFile, "1"); // 500 from the very first probe onward, sustained
  process.env.FAKE_CODESCAPE_HEALTH_500_FILE = errorFile;

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [40, 40], // small — if the fix regressed and this genuinely restarted, give-up would land fast and loudly
    // Card 545ef479 follow-up: deliberately tiny — see this scenario's own header comment for why a large
    // healthyRunMs (this file's usual choice) would make `ranHealthy` false and mask the true UNBOUNDED
    // defect behind a merely-bounded one.
    healthyRunMs: 10,
    // Card 09e56fd5: widened from 60/40 (threshold 2) to this file's OTHER established-safe combo — see
    // this scenario's own corrected header comment for why the tight pair was unsafe here specifically.
    healthProbeIntervalMs: 300,
    healthProbeTimeoutMs: 180,
    healthProbeFailureThreshold: 3,
  });
  const warnings = captureWarnings();
  await sup.start(["/fake/repo/health-500"]);
  await waitForCompletedCondition(() => sup.getSpawnCount() >= 1, () => sup.getCompletedProbeTickCount());
  const pidBefore = sup.getPid();
  const portBefore = sup.getPort();

  // Card 09e56fd5: at the widened 300/180 combo (see header), a regression to pre-fix code would need
  // several seconds rather than ~500ms to show its unbounded climb — the old ~9-12-spawns-in-500ms figure
  // was measured at the since-replaced 60/40 combo and no longer applies; not re-measured at 300/180.
  // Waiting for many completed ticks here still gives pre-fix code ample room to show unbounded growth.
  const MIN_TICKS = 15;
  await waitForCompletedCondition(() => sup.getCompletedProbeTickCount() >= MIN_TICKS, () => sup.getCompletedProbeTickCount());
  check(`(15) at least ${MIN_TICKS} probe ticks completed against a sustained 500`,
    sup.getCompletedProbeTickCount() >= MIN_TICKS);

  check("(15) a sustained /graph/health 500 does NOT kill the child (fail-safe half 1: no spawn beyond the initial one) — under timing where pre-fix code demonstrably loops UNBOUNDED (see header), not merely timing where pre-fix code would give up",
    sup.getSpawnCount() === 1);
  check("(15) serve's pid is unchanged throughout (fail-safe half 2: nothing was killed)",
    sup.getPid() === pidBefore);
  check("(15) getPort() stays the SAME live port — never gave up, never phantom-alive",
    sup.getPort() === portBefore && sup.getPort() !== null);

  const errorLines = warnings.lines.filter((l) => l.includes("/graph/health answered HTTP 500"));
  check("(15) the arrived-but-error response IS reported, but exactly ONCE across many ticks (latched, not once per tick)",
    errorLines.length === 1);
  const wedgeKillLines = warnings.lines.filter((l) => l.includes("health probe failed") && l.includes("killing for restart"));
  check("(15) the wedge-kill diagnostic never fires for an arrived 500 (it is not wedge evidence)",
    wedgeKillLines.length === 0);

  // Recovery: clear the 500 condition — the NEXT successful probe must announce recovery once, and drift
  // checking (previously skipped on every 500 tick) resumes normally.
  fs.rmSync(errorFile);
  await waitForCompletedCondition(
    () => warnings.lines.some((l) => l.includes("/graph/health recovered")),
    () => sup.getCompletedProbeTickCount(),
  );
  const recoveryLines = warnings.lines.filter((l) => l.includes("/graph/health recovered"));
  check("(15) recovery (back to 200) is announced exactly ONCE",
    recoveryLines.length === 1);
  check("(15) still exactly one spawn after recovery — the whole episode never restarted serve",
    readServeCalls(callsFile).length === 1 && sup.getSpawnCount() === 1);

  warnings.restore();
  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_500_FILE;
}

// ===================== (16) card 4c7a337d: a kill cadence LONGER than healthyRunMs — which used to reset
// restartAttempts to 0 on EVERY death and make the give-up ceiling structurally unreachable — is still
// eventually caught by an independent, ranHealthy-proof restart-rate ceiling. ============================
// ⭐ TIMING IS LOAD-BEARING, same principle as scenario (15)'s own header: `healthyRunMs:10` is
// deliberately far below the real per-cycle kill time (~100-160ms at these intervals — a cycle needs >=2
// real HTTP round trips, `healthProbeFailureThreshold`(2) apart by `healthProbeIntervalMs`(60ms) each),
// so on the PRE-FIX mechanism `ranHealthy` reads true on essentially every single kill and
// `restartAttempts` never survives long enough to reach any backoff ceiling — this is what actually
// reproduces the card's measured defect (12 -> 30 spawns over 3s, zero give-ups; 92 cycles over 30s, zero
// give-ups), not merely "didn't die once" (which the card explicitly warns passes on pre-fix code too).
// `restartBackoffMs` here has 100 entries — structurally impossible to exhaust within this test's
// timeframe — so if a give-up DOES fire, it can only be the NEW, independent rate ceiling, never a
// coincidence of the original backoff-exhaustion mechanism.
{
  const homeDir = path.join(tmpHome, "unbounded-cadence-home");
  const wedgeFile = path.join(tmpHome, "unbounded-cadence-flag");
  fs.writeFileSync(wedgeFile, "1"); // wedged forever — every respawn is wedged too (env inherited by spawn)
  process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE = wedgeFile;

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: Array(100).fill(40), // effectively "never exhausts" within this test's timeframe
    healthyRunMs: 10, // deliberately far below the real per-cycle kill time — see header
    healthProbeIntervalMs: 60,
    healthProbeTimeoutMs: 40,
    healthProbeFailureThreshold: 2,
    restartWindowMs: 1500, // test-only seam: short window so the ceiling trips in ~seconds, not a real hour
    maxRestartsPerWindow: 5, // test-only seam: small ceiling
  });
  const warnings = captureWarnings();
  const errors = captureErrors();
  await sup.start(["/fake/repo/unbounded-cadence"]);

  // Card 5dd77ba5's own lesson (codescape-supervisor.mjs (bad-bin)): getPort()===null is AMBIGUOUS — it
  // reads identically whether the supervisor has genuinely given up (permanent) or is merely transiently
  // down BETWEEN a kill and its already-scheduled restart (temporary, resolves within one backoff delay).
  // So this waits on the UNAMBIGUOUS signal instead — the give-up diagnostic line itself, which is only
  // ever printed once, exactly at the moment of a genuine give-up — never on getPort() polling.
  const giveUpLines = () => errors.lines.filter((l) => l.includes("codescape serve is DOWN") && l.includes("needs a human"));
  await waitForCompletedCondition(() => giveUpLines().length >= 1, () => sup.getCompletedProbeTickCount());
  check("(16) the loud give-up diagnostic actually FIRED — reachable for a sustained crash loop, not merely bounded-but-silent",
    giveUpLines().length === 1);
  check("(16) the give-up reason names the rate ceiling, not backoff exhaustion (restartAttempts never got anywhere near the 100-entry backoff array)",
    giveUpLines().some((l) => l.includes("restarts within") && l.includes("rate ceiling")));
  check("(16) a kill cadence LONGER than healthyRunMs — which used to reset restartAttempts to 0 forever — still eventually gives up (getPort() null, not phantom-alive)",
    sup.getPort() === null);

  const spawnsAtGiveUp = sup.getSpawnCount();
  await sleep(500); // several more health-probe intervals' worth — give-up must stay terminal
  check("(16) give-up STAYS terminal — no further restart / serve spawn, even with the health-probe timer still ticking",
    sup.getPort() === null && sup.getSpawnCount() === spawnsAtGiveUp);

  warnings.restore();
  errors.restore();
  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE;
}

// ===================== cleanup =====================
delete process.env.LOOM_CODESCAPE_BIN;
delete process.env.LOOM_CODESCAPE_ENABLED;
delete process.env.LOOM_DEV;
delete process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE;
delete process.env.FAKE_CODESCAPE_HEALTH_BUILD;
delete process.env.FAKE_CODESCAPE_INSTALLED_BUILD;
delete process.env.FAKE_CODESCAPE_HEALTH_VERSION;
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — Codescape supervisor health probe: a sustained wedge (alive, port bound, unresponsive) is detected via GET /graph/health and restarted through the EXISTING child-exit restart path (same port, new pid, no second restart channel); the give-up state stays terminal under repeated health-driven kills (no probe can resurrect an exhausted budget); a sub-threshold wedge window that recovers before enough CONSECUTIVE failures accumulate never restarts; and the health-probe timer now arms regardless of codescape-enabled project count, so a sustained wedge with ZERO codescape-enabled projects is detected and restarted the same as any other boot. Build-id drift detection (card 90550a97) + the stability window on top of it (card 9e6f984d): a genuine running-vs-installed build mismatch restarts exactly ONCE through that same existing path — but only once the installed build has sat UNCHANGED for the stability window, not on the first probe tick that observes it — and does not loop even under a persisting mismatch, while a NEW drift (installed build changes again) restarts again once IT stabilizes; a BURST of several distinct installed builds inside the window collapses into exactly ONE restart, fired only once the LAST build in the burst settles, with the deferral logged distinguishably from both 'no drift detected' and the eventual restart; `build` absent or `build:null` on the RUNNING side, and on the INSTALLED side a genuine couldn't-read (non-zero exit OR malformed stdout at exit 0 — two INDEPENDENT failure paths, both proven) all correctly never restart; an HONEST installed `build:null` at exit 0 is a real answer, not a failure — also never restarts, and stays SILENT (no diagnostic); a `version` mismatch alone never restarts (version is not the drift signal); the drift path (including the stability window) is bound by the SAME restartAttempts give-up ceiling; a genuine installed-side read failure is reported LOUDLY exactly once per distinct reason (never once per probe tick, never silent) — a changed reason warns again, and (card ebd755ab, Gap 2) a successful read after a latched failure now ALSO announces the recovery transition exactly once (inert -> recovered is no longer indistinguishable from still-inert); and (card ebd755ab, Gap 1) a drift that persists after its ONE allowed restart is already spent is now LOUD exactly once (never silent forever, never once per tick), with its own resolution — the installed side matching the running build again — likewise announced exactly once, and the restart guard itself unchanged throughout; and (card f0718488) a version probe that TIMES OUT specifically is retried (a genuine timeout rescued by a retry never even reaches the loud diagnostic, asserted on the observed attempt COUNT, never wall-clock), while a persistently-timing-out probe still exhausts EXACTLY its bounded attempt budget, still fails the tick loudly (latched, once, same discipline as (8)), and — the property most likely to break under a refactor of this retry loop — STILL never triggers a restart, across repeated ticks. Card 545ef479: the drift-check outcome (match / mismatch / not-checked:running-absent / not-checked:installed-null / not-checked:installed-read-failed) is now a DISTINGUISHABLE, latched signal (getDriftCheckState()) rather than three silent, byte-identical early returns; and a sustained /graph/health 500 (a response that ARRIVES, just can't determine something) is proven — over many multiples of the old kill threshold — to never count as wedge evidence, never kill the child, and never produce an unbounded respawn cycle, while still being reported once (latched) and its recovery announced once — claude-free, network-free beyond loopback."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
