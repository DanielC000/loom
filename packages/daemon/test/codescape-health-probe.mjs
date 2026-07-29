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
//   (4) codescape enabled but with ZERO codescape-enabled projects (repoPaths === []) never starts the
//       health-probe timer at all — no restart even under a sustained wedge with a low threshold and a
//       fast interval that would otherwise trip quickly.
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

// ===================== (4) codescape enabled but ZERO codescape-enabled projects: no probe traffic at all ====
{
  const homeDir = path.join(tmpHome, "noproj-wedge-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  const wedgeFile = path.join(tmpHome, "noproj-wedge-flag");
  fs.writeFileSync(wedgeFile, "1"); // wedged from the start — if probing ran at all, this trips immediately
  process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE = wedgeFile;

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150],
    healthyRunMs: 60_000,
    healthProbeIntervalMs: 60, // fast + low threshold — a real prober would trip well within the wait below
    healthProbeTimeoutMs: 40,
    healthProbeFailureThreshold: 2,
  });
  await sup.start([]); // NO repoPaths ⇒ hasEnabledProjects=false ⇒ the health-probe timer never starts
  for (let i = 0; i < 50 && readServeCalls(callsFile).length < 1; i++) await sleep(50);
  const pidBefore = sup.getPid();
  check("(4) serve still spawns normally with zero repoPaths", typeof pidBefore === "number" && pidBefore > 0);

  await sleep(500); // far more than enough for the fast interval/threshold above to have tripped if it ran
  check("(4) with zero codescape-enabled projects, the health-probe timer never started — sustained wedge, still no restart",
    readServeCalls(callsFile).length === 1 && sup.getPid() === pidBefore);

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
  ? "\n✅ ALL PASS — Codescape supervisor health probe: a sustained wedge (alive, port bound, unresponsive) is detected via GET /graph/health and restarted through the EXISTING child-exit restart path (same port, new pid, no second restart channel); the give-up state stays terminal under repeated health-driven kills (no probe can resurrect an exhausted budget); a sub-threshold wedge window that recovers before enough CONSECUTIVE failures accumulate never restarts; and with zero codescape-enabled projects the health-probe timer never starts at all, so a sustained wedge there produces no restart either. Build-id drift detection (card 90550a97) + the stability window on top of it (card 9e6f984d): a genuine running-vs-installed build mismatch restarts exactly ONCE through that same existing path — but only once the installed build has sat UNCHANGED for the stability window, not on the first probe tick that observes it — and does not loop even under a persisting mismatch, while a NEW drift (installed build changes again) restarts again once IT stabilizes; a BURST of several distinct installed builds inside the window collapses into exactly ONE restart, fired only once the LAST build in the burst settles, with the deferral logged distinguishably from both 'no drift detected' and the eventual restart; `build` absent or `build:null` on the RUNNING side, and on the INSTALLED side a genuine couldn't-read (non-zero exit OR malformed stdout at exit 0 — two INDEPENDENT failure paths, both proven) all correctly never restart; an HONEST installed `build:null` at exit 0 is a real answer, not a failure — also never restarts, and stays SILENT (no diagnostic); a `version` mismatch alone never restarts (version is not the drift signal); the drift path (including the stability window) is bound by the SAME restartAttempts give-up ceiling; a genuine installed-side read failure is reported LOUDLY exactly once per distinct reason (never once per probe tick, never silent) — a changed reason warns again, and (card ebd755ab, Gap 2) a successful read after a latched failure now ALSO announces the recovery transition exactly once (inert -> recovered is no longer indistinguishable from still-inert); and (card ebd755ab, Gap 1) a drift that persists after its ONE allowed restart is already spent is now LOUD exactly once (never silent forever, never once per tick), with its own resolution — the installed side matching the running build again — likewise announced exactly once, and the restart guard itself unchanged throughout — claude-free, network-free beyond loopback."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
