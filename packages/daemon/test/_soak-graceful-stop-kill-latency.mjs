// MANUAL-RUN SOAK for card 62fc7320 DoD-1 — NOT part of the gate suite: the leading underscore excludes
// it from test-daemon.mjs's walk (see that script's `isUnderscoreExcluded`).
//
// THE ONE QUESTION THIS ANSWERS: after `live.pty.kill()` is called (the DEFAULT, non-DLL branch — the
// one that walks `_getConsoleProcessList()`, LOOM_PTY_USE_CONPTY_DLL left at its default OFF), how long
// does it take for `live.alive` to actually flip false (the async `onExit` callback)? Card 62fc7320's
// DoD-1 asks whether the 6s(stage-3 kill)→8s(caller's hard-stop fallback) window — a 2000ms margin — is
// reached in practice: it is reached iff `alive` can still read true ~2000ms after kill() was called.
//
// MECHANISM (verified at source, node-pty@1.1.0 windowsPtyAgent.js `kill()`, non-DLL branch): the ACTUAL
// pty-process termination (`this._ptyNative.kill(this._pid, this._innerPid)`) runs SYNCHRONOUSLY and is
// NEVER awaited on `this._getConsoleProcessList()` — that call only feeds an un-awaited `.then(...)` used
// to best-effort-kill straggler console siblings. So even when the forked `conpty_console_list_agent`
// helper is slow or crashes (the documented `AttachConsole failed` — card 03016805), that failure cannot
// delay `onExit`/`live.alive` flipping false, because the two are structurally decoupled.
//
// Run (after `pnpm build`): node test/_soak-graceful-stop-kill-latency.mjs [N] [--concurrent]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== "win32") {
  console.log("SKIP _soak-graceful-stop-kill-latency.mjs — the non-DLL AttachConsole kill path is Windows/ConPTY-specific.");
  process.exit(0);
}

const N = Number(process.argv[2]) || 15;
const CHECKPOINTS_MS = [500, 1000, 1500, 2000, 2500, 3000, 5000, 8000];

const tmpHome = path.join(os.tmpdir(), `loom-graceful-kill-latency-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Deliberately do NOT set LOOM_PTY_USE_CONPTY_DLL — this measures the PRODUCTION DEFAULT (off) branch,
// which is the one card 62fc7320 is about (upgradeCompanionCapabilities's hard-stop fallback runs against
// whatever a real daemon boots with, and the default is off).
delete process.env.LOOM_PTY_USE_CONPTY_DLL;

const { PtyHost } = await import("../dist/pty/host.js");

const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

/** One spawn→wait-for-real-output→hard-kill→multi-checkpoint-sample cycle against `host.isAlive`.
 *  Returns { aliveBeforeKill (positive control), samples: [{atMs, alive}], clearedAtMs }. */
async function runCycle(host, id) {
  // Spawns a genuine CHILD process (not just a same-process Start-Sleep) so the console process list
  // _getConsoleProcessList() has to walk at kill time has >1 entry — closer to a real claude session's
  // shape (the CLI process plus any live tool-call subprocess) than a single bare shell.
  host.spawnShell({
    id, cwd: tmpHome,
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command",
      "Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 60' -WindowStyle Hidden; Start-Sleep -Seconds 30"],
    geometry: { cols: 120, rows: 40 }, label: id,
  });
  let sawData = "";
  const unsub = host.subscribe(id, { onData: (chunk) => { sawData += chunk.toString("utf8"); }, onControl: () => {} });
  const dataDeadline = Date.now() + 8000;
  while (sawData.length === 0 && Date.now() < dataDeadline) await sleep(20);
  unsub();
  // Positive control (memory `positive-control-your-searches-empty-is-not-evidence`): confirm the session
  // reads alive BEFORE kill, so a later `false` is a real transition, not a broken `isAlive` query.
  const aliveBeforeKill = host.isAlive(id);
  const killedAt = Date.now();
  host.stop(id, "hard"); // sets killed=true, then live.pty.kill() — same call this card is about
  const samples = [];
  let clearedAtMs = null;
  for (const checkpointMs of CHECKPOINTS_MS) {
    const targetTime = killedAt + checkpointMs;
    const waitMs = targetTime - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    const alive = host.isAlive(id);
    samples.push({ atMs: checkpointMs, alive });
    if (!alive) { clearedAtMs = checkpointMs; break; } // dead does not come back — stop sampling early
  }
  return { aliveBeforeKill, samples, clearedAtMs };
}

// --concurrent runs all N cycles IN PARALLEL instead of sequentially — approximates the host-contention
// scenario the card names as the plausible trigger for a slow AttachConsole fork (many kills competing
// for the host at once), rather than one clean spawn/kill at a time.
const CONCURRENT = process.argv.includes("--concurrent");

console.log(`\n===== GRACEFUL-STOP KILL-LATENCY SOAK: N=${N} default(non-DLL)-branch cycles${CONCURRENT ? " (CONCURRENT)" : ""}, card 62fc7320 DoD-1 =====`);
console.log(`Checkpoints sampled (ms since live.pty.kill()): ${CHECKPOINTS_MS.join(", ")}\n`);

const host = new PtyHost(events);
let cycles;
if (CONCURRENT) {
  cycles = await Promise.all(Array.from({ length: N }, (_, i) => runCycle(host, `latency-${i}`)));
  cycles.forEach((result, i) => {
    const clearedStr = result.clearedAtMs === null
      ? `STILL ALIVE at last checkpoint (${CHECKPOINTS_MS[CHECKPOINTS_MS.length - 1]}ms)`
      : `alive flipped false at ${result.clearedAtMs}ms`;
    console.log(`  [cycle ${i + 1}/${N}] aliveBeforeKill=${result.aliveBeforeKill} ${clearedStr} (samples: ${result.samples.map(s => `${s.atMs}ms=${s.alive}`).join(" ")})`);
  });
} else {
  cycles = [];
  for (let i = 0; i < N; i++) {
    const result = await runCycle(host, `latency-${i}`);
    cycles.push(result);
    const clearedStr = result.clearedAtMs === null
      ? `STILL ALIVE at last checkpoint (${CHECKPOINTS_MS[CHECKPOINTS_MS.length - 1]}ms)`
      : `alive flipped false at ${result.clearedAtMs}ms`;
    console.log(`  [cycle ${i + 1}/${N}] aliveBeforeKill=${result.aliveBeforeKill} ${clearedStr} (samples: ${result.samples.map(s => `${s.atMs}ms=${s.alive}`).join(" ")})`);
  }
}
let seenAliveCycles = cycles.filter(c => c.aliveBeforeKill).length;

console.log(`\n===== POSITIVE CONTROL =====`);
console.log(`isAlive observed true (pre-kill) in ${seenAliveCycles}/${N} cycles.`);
if (seenAliveCycles === 0) {
  console.log(`⚠️  UNVERIFIED: isAlive never read true before kill in any cycle — the positive control did not fire, so nothing below is trustworthy. Do not read the curve as evidence.`);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(1);
}

console.log(`\n===== THE CURVE — cycles STILL ALIVE at each checkpoint (out of ${N}) =====`);
for (const checkpointMs of CHECKPOINTS_MS) {
  const stillAliveCount = cycles.filter(c => {
    const sampled = c.samples.find(s => s.atMs === checkpointMs);
    return sampled ? sampled.alive : false;
  }).length;
  console.log(`  ${String(checkpointMs).padStart(6)}ms after kill(): ${stillAliveCount}/${N} still alive`);
}

const stillAliveAt2000 = cycles.filter(c => {
  const sampled = c.samples.find(s => s.atMs === 2000);
  return sampled ? sampled.alive : (c.clearedAtMs === null || c.clearedAtMs > 2000);
}).length;

console.log(`\n===== VERDICT (card 62fc7320 DoD-1: is the 2000ms stage-3→hard-stop-fallback margin reached?) =====`);
if (stillAliveAt2000 > 0) {
  console.log(`🔴 REACHED: ${stillAliveAt2000}/${N} cycles were STILL ALIVE 2000ms after kill() — the exact margin between stage 3's kill (t=6000ms) and upgradeCompanionCapabilities's hard-stop fallback (t=8000ms). The window is real and this card's coordination fix is warranted.`);
} else {
  const clearTimes = cycles.map(c => c.clearedAtMs).filter(t => t !== null).sort((a, b) => a - b);
  const max = clearTimes[clearTimes.length - 1];
  console.log(`✅ NOT REACHED in this run: all ${N}/${N} cycles had already flipped to not-alive by 2000ms after kill() (max observed clear time: ${max}ms). This does not prove the window can never be hit (host load, a slower AttachConsole fork under contention), but it is evidence against it being routinely reached.`);
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
process.exit(0);
