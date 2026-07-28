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
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  const wedgeFile = path.join(tmpHome, "sustained-wedge-flag");
  fs.writeFileSync(wedgeFile, "1"); // wedged from the very first probe onward
  process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE = wedgeFile;

  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: [50, 100, 150], // fast — proves the restart without waiting real minutes
    healthyRunMs: 60_000, // a kill-right-after-spawn (wedge) must never count as "healthy"
    healthProbeIntervalMs: 100,
    healthProbeTimeoutMs: 50,
    healthProbeFailureThreshold: 3,
  });
  await sup.start(["/fake/repo/sustained-wedge"]);
  for (let i = 0; i < 50 && readServeCalls(callsFile).length < 1; i++) await sleep(50);
  const pidBefore = sup.getPid();
  const portBefore = sup.getPort();
  check("(1) initial serve spawned", readServeCalls(callsFile).length === 1 && typeof pidBefore === "number");

  // 3 consecutive failed probes @100ms apart (~300ms) should trigger a kill -> real exit -> the EXISTING
  // restart path. Poll the calls file (never a blind sleep) for the second 'serve' record.
  for (let i = 0; i < 100 && readServeCalls(callsFile).length < 2; i++) await sleep(50);
  check("(1) a sustained wedge triggers a restart via the EXISTING death path (a new serve call recorded)",
    readServeCalls(callsFile).length === 2);
  check("(1) restart reused the SAME port", sup.getPort() === portBefore);
  check("(1) restart produced a genuinely NEW pid", sup.getPid() !== pidBefore && sup.getPid() !== null);

  sup.stop();
  delete process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE;
}

// ===================== (2) give-up stays terminal under repeated health-driven kills =====================
{
  const homeDir = path.join(tmpHome, "giveup-wedge-home");
  const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
  const wedgeFile = path.join(tmpHome, "giveup-wedge-flag");
  fs.writeFileSync(wedgeFile, "1"); // wedged forever — every respawn is wedged too (env inherited by spawn)
  process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE = wedgeFile;

  const backoffMs = [40, 40]; // fast + few — exhausts the schedule quickly
  const sup = new CodescapeSupervisor({
    homeDir,
    restartBackoffMs: backoffMs,
    healthyRunMs: 60_000,
    healthProbeIntervalMs: 60,
    healthProbeTimeoutMs: 40,
    healthProbeFailureThreshold: 2,
  });
  await sup.start(["/fake/repo/giveup-wedge"]);

  // Every spawn here is wedged from birth (env persists across the auto-restarts), so the supervisor
  // itself — never a manual kill — should drive exactly 1 (initial) + backoffMs.length (restarts) real
  // serve spawns before its OWN give-up branch refuses a further attempt.
  const expectedSpawns = 1 + backoffMs.length;
  for (let expected = 1; expected <= expectedSpawns; expected++) {
    for (let i = 0; i < 100 && readServeCalls(callsFile).length < expected; i++) await sleep(50);
  }
  check(`(2) exactly ${expectedSpawns} serve spawns recorded (initial + ${backoffMs.length} health-driven restarts), no more`,
    readServeCalls(callsFile).length === expectedSpawns);

  // The (expectedSpawns)-th spawn must ALSO get detected as wedged and killed before give-up is decided
  // (scheduleRestart's give-up branch runs off THAT kill's exit event) — wait for getPort() to settle null.
  for (let i = 0; i < 100 && sup.getPort() !== null; i++) await sleep(50);
  check("(2) after the health-probe-driven kills exhaust the bounded restart budget, getPort() is null (gave up, not phantom-alive)",
    sup.getPort() === null);

  const callsAtGiveUp = readServeCalls(callsFile).length;
  await sleep(400); // several more health-probe intervals' worth — a lingering tick must NOT resurrect it
  check("(2) give-up STAYS terminal — no further restart / serve spawn, even with the health-probe timer still ticking",
    sup.getPort() === null && readServeCalls(callsFile).length === callsAtGiveUp);

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
    healthProbeIntervalMs: 100,
    healthProbeTimeoutMs: 50,
    healthProbeFailureThreshold: 3, // needs 3 CONSECUTIVE failures — this window can produce at most 2
  });
  await sup.start(["/fake/repo/blip-wedge"]);
  for (let i = 0; i < 50 && readServeCalls(callsFile).length < 1; i++) await sleep(50);
  const pidBefore = sup.getPid();

  // Wedge for a window shorter than 2 full probe intervals (140ms < 2x100ms), so AT MOST 2 consecutive
  // probes can land while it's present — never enough to reach the threshold of 3 — then recover.
  fs.writeFileSync(wedgeFile, "1");
  await sleep(140);
  fs.rmSync(wedgeFile);

  // Wait well past what 3 consecutive failures + kill + fastest restart backoff would have needed, to
  // prove no restart ever happened (the recovering success resets the counter to 0 before threshold).
  await sleep(600);
  check("(3) a sub-threshold wedge window that recovers in time does NOT trigger a restart",
    readServeCalls(callsFile).length === 1 && sup.getPid() === pidBefore);

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

// ===================== cleanup =====================
delete process.env.LOOM_CODESCAPE_BIN;
delete process.env.LOOM_CODESCAPE_ENABLED;
delete process.env.LOOM_DEV;
delete process.env.FAKE_CODESCAPE_HEALTH_WEDGE_FILE;
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — Codescape supervisor health probe: a sustained wedge (alive, port bound, unresponsive) is detected via GET /graph/health and restarted through the EXISTING child-exit restart path (same port, new pid, no second restart channel); the give-up state stays terminal under repeated health-driven kills (no probe can resurrect an exhausted budget); a sub-threshold wedge window that recovers before enough CONSECUTIVE failures accumulate never restarts; and with zero codescape-enabled projects the health-probe timer never starts at all, so a sustained wedge there produces no restart either — claude-free, network-free beyond loopback."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
