// MANUAL-RUN SOAK for card bb3d9005 S3 (useConptyDll worker_thread leak) — NOT part of the gate suite: the
// leading underscore excludes it from test-daemon.mjs's walk (see that script's `isUnderscoreExcluded`),
// and the card is explicit this is "a MEASUREMENT, not an argument" / "no run_gate for the soak".
//
// THE CONCERN (source-verified, node-pty@1.1.0):
//   - windowsConoutConnection.js's `ConoutConnection` constructor creates a REAL
//     `worker_threads.Worker` (a full V8 isolate + OS thread) on EVERY conpty spawn, DLL mode or not.
//   - windowsPtyAgent.js's `kill()`:
//       • non-DLL branch: calls `this._conoutSocketWorker.dispose()` IMMEDIATELY, inline.
//       • useConptyDll branch: defers `dispose()` to `this._outSocket.on('data', () => { ...dispose() })`
//         — i.e. it ONLY fires if MORE output arrives on the out socket AFTER kill(). A pty killed with
//         nothing left to flush never gets that 'data' event, so `dispose()` — and therefore
//         `_worker.terminate()`, `ConoutConnection.dispose()`'s ONLY path to it — never runs. The worker
//         thread leaks for the daemon's lifetime.
//
// METHOD: patch `worker_threads.Worker` (a Node core-module singleton) to track live count directly,
// in-process — the same spy technique pty-conpty-dll-kill.mjs already uses for `child_process.fork`
// (windowsConoutConnection.js does `var worker_threads_1 = require("worker_threads"); ... new
// worker_threads_1.Worker(...)` — a property lookup at call time, not a captured reference, so patching
// the export here is visible to node-pty's own call site with no source touch). This is the only way to
// count a THREAD — an OS PID-scoped process check (03016805's own test) cannot see it at all.
//
// CONTRAST: runs BOTH arms — DLL (the concern) and non-DLL (today's default, where dispose() is
// immediate) — for the SAME N, so the DLL arm's worker growth has a same-population baseline that should
// NOT grow, per project doctrine that a measurement without a contrast case proves nothing.
//
// Each trial spawns a real, quiet process (PowerShell `Start-Sleep`), waits for its first real output
// (node-pty's own readiness gate — the same pattern pty-conpty-dll-kill.mjs uses), then hard-kills it
// immediately — Start-Sleep has nothing further to emit, maximizing the chance of landing in the
// no-more-output-ever leak window on the DLL arm.
//
// Run (after `pnpm build`): node --expose-gc test/_soak-conpty-dll-worker-leak.mjs [N]
//   (--expose-gc is optional but reduces GC noise in the RSS trend; N defaults to 50)
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import worker_threads from "node:worker_threads";

const execFileAsync = promisify(execFileCb);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== "win32") {
  console.log("SKIP _soak-conpty-dll-worker-leak.mjs — useConptyDll and the worker_thread leak surface are Windows/ConPTY-specific.");
  process.exit(0);
}

const N = Number(process.argv[2]) || 50;

const tmpHome = path.join(os.tmpdir(), `loom-conptydll-soak-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

// ===== worker_threads.Worker spy — HOST-WIDE-EQUIVALENT for a THREAD: the only vantage point that can
// see one at all is inside the process that owns it (there is no PID-based external view of a thread the
// way psChildPids sees a process — this is the direct, in-process analogue of that same rigor). =====
const RealWorker = worker_threads.Worker;
let liveWorkers = 0;
let totalCreated = 0;
class SpyWorker extends RealWorker {
  constructor(...args) {
    super(...args);
    totalCreated++;
    liveWorkers++;
    this.on("exit", () => { liveWorkers--; });
  }
}
worker_threads.Worker = SpyWorker;

// Self-check the detector BEFORE trusting it (memory `positive-control-your-searches-empty-is-not-evidence`):
// a worker we create and terminate ourselves must be observed both created and reclaimed.
{
  const w = new worker_threads.Worker("", { eval: true });
  console.log(`[self-check] right after construction: created=${totalCreated} liveNow=${liveWorkers} (expect created===1, liveNow===1)`);
  if (totalCreated !== 1 || liveWorkers !== 1) { console.error("SELF-CHECK FAILED — spy detector didn't see the construction, aborting soak."); process.exit(1); }
  await w.terminate();
  await sleep(50); // let the spy's own 'exit' listener run
  console.log(`[self-check] after terminate(): liveNow=${liveWorkers} (expect 0 — a real terminate IS observed)`);
  if (liveWorkers !== 0) { console.error("SELF-CHECK FAILED — spy detector didn't see the exit, aborting soak."); process.exit(1); }
}

const { PtyHost } = await import("../dist/pty/host.js");

async function psAlive(pid) {
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }`],
      { timeout: 5000 });
    return stdout.trim() === "ALIVE";
  } catch { return false; }
}

const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

/** One spawn→wait-for-real-output→hard-kill→settle cycle. Returns nothing; side effect is on `host`'s
 *  live map and (for the DLL arm) node-pty's own deferred worker cleanup. */
async function runCycle(host, id) {
  host.spawnShell({
    id, cwd: tmpHome,
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"],
    geometry: { cols: 120, rows: 40 }, label: id,
  });
  const pid = host.live.get(id)?.pid;
  let sawData = "";
  const unsub = host.subscribe(id, { onData: (chunk) => { sawData += chunk.toString("utf8"); }, onControl: () => {} });
  const dataDeadline = Date.now() + 8000;
  while (sawData.length === 0 && Date.now() < dataDeadline) await sleep(20);
  unsub();
  host.stop(id, "hard"); // TerminateProcess — the DLL arm's kill() defers worker dispose to a 'data' event that (Start-Sleep) should never come
  const deadline = Date.now() + 15000;
  while (await psAlive(pid) && Date.now() < deadline) await sleep(50);
  // FLUSH_DATA_INTERVAL (windowsConoutConnection.js, hardcoded, not env-configurable) is a REAL 1000ms
  // timer even on the non-DLL/baseline arm's OWN (immediate-call, but still async) dispose() path — measuring
  // right after psAlive-gone would misclassify "hasn't drained yet" as "leaked" on the baseline arm too.
  // Wait comfortably past that known constant so only a GENUINE (never-draining) leak still shows live.
  await sleep(1500);
}

async function soakArm(label, useDllFlag) {
  if (useDllFlag) process.env.LOOM_PTY_USE_CONPTY_DLL = "1";
  else delete process.env.LOOM_PTY_USE_CONPTY_DLL;

  const host = new PtyHost(events);
  const startWorkers = liveWorkers;
  const startRss = process.memoryUsage().rss;
  const rows = [];
  for (let i = 0; i < N; i++) {
    await runCycle(host, `soak-${label}-${i}`);
    if (global.gc) global.gc();
    const row = { i, liveWorkers, rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) };
    rows.push(row);
    if (i === 0 || (i + 1) % 10 === 0 || i === N - 1) {
      console.log(`  [${label}] cycle ${i + 1}/${N}: liveWorkers=${row.liveWorkers} rssMb=${row.rssMb}`);
    }
  }
  const endWorkers = liveWorkers;
  const endRss = process.memoryUsage().rss;
  return {
    label, N,
    workerDelta: endWorkers - startWorkers,
    rssDeltaMb: Math.round((endRss - startRss) / 1024 / 1024),
    rows,
  };
}

console.log(`\n===== SOAK: N=${N} spawn/hard-kill cycles per arm (DLL vs non-DLL), card bb3d9005 S3 =====\n`);

console.log(`--- Arm 1: LOOM_PTY_USE_CONPTY_DLL=1 (the concern) ---`);
const dllResult = await soakArm("dll", true);

console.log(`\n--- Arm 2: LOOM_PTY_USE_CONPTY_DLL unset (today's default — contrast/baseline) ---`);
const baselineResult = await soakArm("baseline", false);

delete process.env.LOOM_PTY_USE_CONPTY_DLL;

console.log(`\n===== RESULTS (N=${N}) =====`);
console.log(`DLL arm:      worker_threads leaked = ${dllResult.workerDelta} / ${N} cycles  |  RSS delta = ${dllResult.rssDeltaMb} MB`);
console.log(`Baseline arm: worker_threads leaked = ${baselineResult.workerDelta} / ${N} cycles  |  RSS delta = ${baselineResult.rssDeltaMb} MB`);
if (dllResult.workerDelta > 0) {
  console.log(`\n⚠️  CONFIRMED: DLL mode leaked ${dllResult.workerDelta} worker_threads over ${N} cycles (~${(dllResult.rssDeltaMb / Math.max(1, dllResult.workerDelta)).toFixed(2)} MB/leaked worker, RSS-delta-derived — not an isolated per-thread measurement).`);
} else {
  console.log(`\n✅ No worker_thread leak observed in this run's ${N} cycles (0 net growth) — see file header for why the trigger (no output after kill) is expected but not guaranteed every cycle.`);
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
process.exit(0);
