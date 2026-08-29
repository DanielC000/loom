// MANUAL-RUN SOAK for card 579c88a9 (OpenConsole.exe teardown latency) — NOT part of the gate suite: the
// leading underscore excludes it from test-daemon.mjs's walk (see that script's `isUnderscoreExcluded`).
//
// THE ONE QUESTION THIS ANSWERS (card 579c88a9 DoD-1): does the OpenConsole.exe straggler count observed
// by `_soak-conpty-dll-worker-leak.mjs` (S5: 30/30 DLL-arm cycles still present at a FIXED 1500ms
// post-kill settle window) return to 0 given more time, or does it stay stuck?
//
// That prior soak only ever sampled ONE fixed point (1500ms after TerminateProcess). It could not tell
// "bounded teardown latency, just slower than 1500ms" from "never exits" — both look identical at a
// single timestamp. This script samples MULTIPLE checkpoints after kill, per cycle, and reports the
// CURVE: how many cycles still have a live OpenConsole.exe at each checkpoint. Once a cycle's count
// reaches 0 it is not re-sampled (no reason to expect a dead process to come back), so the reported curve
// is a proper "cleared by time T" distribution, not repeated noise.
//
// Scope fence (card 579c88a9): pty/ only, no other pty/ card runs concurrently with this one.
//
// Run (after `pnpm build`): node test/_soak-conpty-dll-teardown-curve.mjs [N]
//   N defaults to 10 (each straggling cycle can cost up to CHECKPOINTS_MS[last] ~= 25s of real wait, so
//   keep N modest — this is a targeted latency measurement, not a leak-count soak).
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== "win32") {
  console.log("SKIP _soak-conpty-dll-teardown-curve.mjs — useConptyDll and OpenConsole.exe are Windows/ConPTY-specific.");
  process.exit(0);
}

const N = Number(process.argv[2]) || 10;
// Cumulative milliseconds elapsed SINCE kill at each sample point. Chosen to bracket the already-known
// "still present at 1500ms" data point with enough headroom to see genuine convergence to 0, while
// staying bounded (no infinite wait) — a cycle that never clears is reported as such, not chased forever.
const CHECKPOINTS_MS = [1500, 2000, 2500, 3000, 5000, 8000, 12000, 18000, 25000];

const tmpHome = path.join(os.tmpdir(), `loom-conptydll-curve-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PTY_USE_CONPTY_DLL = "1";

const { PtyHost } = await import("../dist/pty/host.js");

async function psAlive(pid) {
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }`],
      { timeout: 5000 });
    return stdout.trim() === "ALIVE";
  } catch { return false; }
}

// Same technique as _soak-conpty-dll-worker-leak.mjs: OpenConsole.exe is parented to THIS (daemon/soak)
// process, not to the pty's own shell root, so scope by (name, parent pid) rather than truly host-wide —
// avoids false positives from an unrelated Windows Terminal/VS Code OpenConsole.exe on a shared machine.
async function psChildProcessCountByName(parentPid, exeName) {
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter "Name='${exeName}' AND ParentProcessId=${parentPid}" | Measure-Object).Count`],
      { timeout: 5000 });
    return Number(stdout.trim()) || 0;
  } catch { return 0; }
}

const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

/** One spawn→wait-for-real-output→hard-kill→multi-checkpoint-sample cycle.
 *  Returns { openConsoleWhileAlive (positive control), samples: [{atMs, count}], clearedAtMs (first
 *  checkpoint where count reached 0, or null if still >0 at the last checkpoint) }. */
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
  // Positive control (memory `positive-control-your-searches-empty-is-not-evidence`): prove the query CAN
  // see OpenConsole.exe before trusting any post-kill sample of it.
  const openConsoleWhileAlive = await psChildProcessCountByName(process.pid, "OpenConsole.exe");
  const killedAt = Date.now();
  host.stop(id, "hard"); // TerminateProcess
  const deadline = killedAt + 15000;
  while (await psAlive(pid) && Date.now() < deadline) await sleep(50);

  const samples = [];
  let clearedAtMs = null;
  for (const checkpointMs of CHECKPOINTS_MS) {
    const targetTime = killedAt + checkpointMs;
    const waitMs = targetTime - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    const count = await psChildProcessCountByName(process.pid, "OpenConsole.exe");
    samples.push({ atMs: checkpointMs, count });
    if (count === 0) { clearedAtMs = checkpointMs; break; } // a dead process does not come back — stop sampling early
  }
  return { openConsoleWhileAlive, samples, clearedAtMs };
}

console.log(`\n===== TEARDOWN-CURVE SOAK: N=${N} DLL-arm cycles, card 579c88a9 DoD-1 =====`);
console.log(`Checkpoints sampled (ms since TerminateProcess): ${CHECKPOINTS_MS.join(", ")}\n`);

const host = new PtyHost(events);
const cycles = [];
let seenAliveCycles = 0;
for (let i = 0; i < N; i++) {
  const result = await runCycle(host, `curve-${i}`);
  cycles.push(result);
  if (result.openConsoleWhileAlive > 0) seenAliveCycles++;
  const clearedStr = result.clearedAtMs === null
    ? `NEVER CLEARED within ${CHECKPOINTS_MS[CHECKPOINTS_MS.length - 1]}ms`
    : `cleared at ${result.clearedAtMs}ms`;
  console.log(`  [cycle ${i + 1}/${N}] whileAlive=${result.openConsoleWhileAlive} ${clearedStr} (samples: ${result.samples.map(s => `${s.atMs}ms=${s.count}`).join(" ")})`);
}

console.log(`\n===== POSITIVE CONTROL =====`);
console.log(`OpenConsole.exe observed alive (pre-kill) in ${seenAliveCycles}/${N} cycles.`);
if (seenAliveCycles === 0) {
  console.log(`⚠️  UNVERIFIED: the query never saw OpenConsole.exe alive in any cycle — the positive control did not fire, so nothing below is trustworthy. Do not read the curve as evidence.`);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(1);
}

console.log(`\n===== THE CURVE — cycles still straggling AT EACH CHECKPOINT (out of ${N}) =====`);
for (const checkpointMs of CHECKPOINTS_MS) {
  // Sampling stops the first time a cycle's count hits 0 (a dead process does not come back), so a
  // cycle with NO recorded sample at this checkpoint cleared at an earlier one and is correctly 0 here.
  const stillStragglingCount = cycles.filter(c => {
    const sampled = c.samples.find(s => s.atMs === checkpointMs);
    return sampled ? sampled.count > 0 : false;
  }).length;
  console.log(`  ${String(checkpointMs).padStart(6)}ms after kill: ${stillStragglingCount}/${N} still present`);
}

const neverCleared = cycles.filter(c => c.clearedAtMs === null);
console.log(`\n===== VERDICT =====`);
if (neverCleared.length === 0) {
  const clearTimes = cycles.map(c => c.clearedAtMs).sort((a, b) => a - b);
  const median = clearTimes[Math.floor(clearTimes.length / 2)];
  console.log(`✅ CLEARS: all ${N}/${N} cycles reached 0 within ${CHECKPOINTS_MS[CHECKPOINTS_MS.length - 1]}ms of kill. clear-time range: ${clearTimes[0]}ms – ${clearTimes[clearTimes.length - 1]}ms, median ${median}ms. This is BOUNDED per-process teardown latency, not a leak — the straggler count at the previous soak's fixed 1500ms checkpoint was measuring too early, not measuring a defect.`);
} else {
  console.log(`🔴 DOES NOT CLEAR: ${neverCleared.length}/${N} cycles still had a live OpenConsole.exe at the last checkpoint (${CHECKPOINTS_MS[CHECKPOINTS_MS.length - 1]}ms after kill). This is NOT explained by teardown latency alone and needs the retained-handle investigation (DoD-3).`);
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
process.exit(0);
