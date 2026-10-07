import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2897acc4 (CR round 2, MAJOR finding 2) — covers the WIRING: does every real kill/exit call site
// actually invoke `verifyRootDeadOrForceKill`, with the right pid + trigger? Round 1's hermetic tests
// (pty-root-reap-identity.mjs) prove the DECISION logic in isolation; they say nothing about whether any
// real caller ever reaches it. This file spies on `verifyRootDeadOrForceKill` itself (a thin override
// that records the call then delegates to the real implementation) and drives the REAL claude/codex
// stop()/escalateGracefulStop/stopCodex/onExit code against scripted fake ptys — no real process, no
// real OS enumeration (probeRootSurvival/killRoot are stubbed, same reasoning as every other PtyHost
// subclass in this suite — see test/_seam-host-fixture.mjs's own doc).
//
// NEGATIVE CONTROL (this file's whole reason to exist): reverting the production call-site wiring (any of
// the four `scheduleRootVerify` call sites, or `reapExitedDescendants`'s own verify call) must turn this
// file RED — see the RED/GREEN recipe in the header below, mirroring worker-recycle-retry-after-prespawn-
// failure.mjs's established revert-to-prove-RED convention.
//
// RED/GREEN: `node test/pty-root-reap-call-site-wiring.mjs` is GREEN against the fixed pty/host.ts. To see
// it RED, temporarily strip the four `this.scheduleRootVerify(...)` call sites (stop()'s hard branch,
// escalateGracefulStop's stage 3, stopCodex's hard branch, stopCodex's own stage-3 backstop) and
// `reapExitedDescendants`'s `this.verifyRootDeadOrForceKill(...)` call — `git diff -- packages/daemon/src/
// pty/host.ts > <scratch>.patch` won't isolate just those lines; easiest is a manual revert of each call
// to a no-op, rebuild, rerun, then restore from git and rebuild again.
//
// Shrinks every relevant timing constant via env (set BEFORE importing host.js, like graceful-stop.mjs /
// codex-graceful-stop-diag.mjs already do) so every scenario resolves in low hundreds of ms, observed via
// `waitUntil` (never a blind sleep guarding a negative assertion — see fixed-wait-negative-guard.mjs).
process.env.LOOM_GRACEFUL_GAP_MS = "20";
process.env.LOOM_GRACEFUL_RETRY_MS = "60";
process.env.LOOM_GRACEFUL_KILL_MS = "150";
process.env.LOOM_CODEX_STOP_GAP_MS = "20";
process.env.LOOM_ROOT_REAP_KILL_VERIFY_DELAY_MS = "30";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";
import { createSeamHost } from "./_seam-host-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-reap-wiring-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");

const ETX = "\x03";

// --- fake claude pty — mirrors graceful-stop.mjs's makeFakePty exactly (the proven shape). ---
const claudeFakes = [];
let nextClaudeExitOnCtrlC = Infinity;
function makeFakeClaudePty(exitOnCtrlC) {
  let exitCb = null;
  let ctrlCs = 0;
  let exited = false;
  const fireExit = (code) => { if (exited) return; exited = true; exitCb?.({ exitCode: code, signal: undefined }); };
  const fake = {
    pid: claudeFakes.length + 40000,
    write: (d) => { for (const ch of d) if (ch === ETX) { ctrlCs++; if (ctrlCs >= exitOnCtrlC) fireExit(0); } },
    onData: () => ({ dispose() {} }),
    onExit: (cb) => { exitCb = cb; return { dispose() {} }; },
    kill: () => { fake.killCalled = true; fireExit(0); },
    resize: () => {},
    killCalled: false,
    simulateExit: (code) => fireExit(code),
  };
  claudeFakes.push(fake);
  return fake;
}

// --- fake codex pty — mirrors codex-graceful-stop-diag.mjs's makeFakePty exactly. ---
function makeFakeCodexPty() {
  let onExitCb = null;
  const writes = [];
  return {
    pid: 50000 + Math.floor(Math.random() * 10000),
    write(data) { writes.push(data); },
    onData() { return { dispose() {} }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    simulateExit(exitCode, signal) { const cb = onExitCb; cb?.({ exitCode, signal }); },
    writes,
  };
}

class SpyHost extends createSeamHost(PtyHost) {
  verifyCalls = [];
  codexFakes = new Map();
  // Round 4 (item 4): recorded sweep calls, and a per-sessionId queue that lets ONE scenario (the new
  // confirmed-force-kill wiring test below) drive `probeRootSurvival` through the alive->kill->dead path
  // without disturbing every OTHER scenario's existing "already gone" default (they never populate this
  // map, so they keep getting that same stubbed response as before this round).
  sweepCalls = [];
  probeOverrides = new Map();
  createPty(_opts) { return makeFakeClaudePty(nextClaudeExitOnCtrlC); }
  createCodexPty(opts) {
    const fake = makeFakeCodexPty();
    this.codexFakes.set(opts.sessionId, fake);
    return fake;
  }
  // Card 2897acc4: `createSeamHost`'s own `reapExitedDescendants` is a no-op (see its doc) — bypass THAT
  // and call the REAL (grandparent) `PtyHost.prototype.reapExitedDescendants` directly, so this file
  // actually tests PRODUCTION wiring rather than a stand-in that would stay green even if the real
  // method's own verify call were removed.
  //
  // CR round 3 (B1, FIXED — a prior version of this file ran the real OS-wide descendant sweep against
  // these fake pids, measured to SIGKILL real host processes, incl. the self-hosting daemon itself, when
  // a real process happened to share a parent pid with one of these fictional roots): `sweepOrphanedDescendants`
  // — the free-function sweep `reapExitedDescendants` calls, split into its own seam for exactly this
  // reason — is overridden to a no-op below, so the real `reapExitedDescendants` body still runs (proving
  // call-site wiring) but its OS-wide SIGKILL sweep never does. No test here may ever call a real reaper
  // or killer on a fabricated pid — that is this file's own standing rule, not just this one fix.
  sweepOrphanedDescendants(rootPid) { this.sweepCalls.push(rootPid); }
  reapExitedDescendants(rootPid, sessionId, liveRef) {
    PtyHost.prototype.reapExitedDescendants.call(this, rootPid, sessionId, liveRef);
  }
  async probeRootSurvival(rootPid, sessionId) {
    const queue = this.probeOverrides.get(sessionId);
    if (queue && queue.length > 0) return queue.shift();
    return { foundAlive: false, identityConfirmed: false, enumerationFailed: false, creationTime: null };
  }
  killRoot(_pid) {}
  async verifyRootDeadOrForceKill(sessionId, rootPid, trigger, expectedOwner) {
    this.verifyCalls.push({ sessionId, rootPid, trigger });
    return super.verifyRootDeadOrForceKill(sessionId, rootPid, trigger, expectedOwner);
  }
}

const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onCodexBootStuck() {},
  onExit() {},
};
const host = new SpyHost(events);
const PERM = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };
const GEO = { cols: 120, rows: 40 };

function callsFor(sessionId, trigger) {
  return host.verifyCalls.filter((c) => c.sessionId === sessionId && c.trigger === trigger);
}

function spawnClaude(sid, exitOnCtrlC) {
  nextClaudeExitOnCtrlC = exitOnCtrlC;
  host.spawn({ sessionId: sid, cwd: tmpHome, permission: PERM, geometry: GEO, sessionEnv: {} });
  const fake = claudeFakes[claudeFakes.length - 1];
  host.deliverHook(sid, { hook_event_name: "SessionStart" });
  return fake;
}

function spawnCodex(sid) {
  host.spawn({
    sessionId: sid, cwd: tmpHome, permission: PERM, geometry: GEO, sessionEnv: {},
    role: "worker", harness: "codex", startupPrompt: undefined,
  });
  const fake = host.codexFakes.get(sid);
  host.liveCodex.get(sid).bootReady = true;
  return fake;
}

// =========================================================================================================
// (1) claude stop(hard) on a LIVE session — expects BOTH "exit-reap" (the fake's synchronous kill->onExit)
//     and "hard-stop" (stop()'s own scheduled verify) for the SAME pid.
// =========================================================================================================
{
  const SID = "claude-hard-stop";
  const fake = spawnClaude(SID, Infinity);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
  host.stop(SID, "hard");
  check("(1) kill() was actually called", fake.killCalled === true);
  check("(1) 'exit-reap' trigger fired synchronously, right pid", callsFor(SID, "exit-reap").some((c) => c.rootPid === fake.pid));
  await waitUntil(() => callsFor(SID, "hard-stop").length > 0, { label: "(1) 'hard-stop' trigger to fire" });
  check("(1) 'hard-stop' trigger fired with the right pid", callsFor(SID, "hard-stop").some((c) => c.rootPid === fake.pid));
}

// =========================================================================================================
// (2) claude escalateGracefulStop stage 3 — a BUSY session that swallows Ctrl-C never exits gracefully;
//     the stage-3 hard-kill backstop must fire scheduleRootVerify too.
// =========================================================================================================
{
  const SID = "claude-graceful-escalation";
  const fake = spawnClaude(SID, Infinity);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
  host.stop(SID, "graceful");
  await waitUntil(() => fake.killCalled === true, { timeoutMs: 3000, label: "(2) stage-3 hard-kill backstop to fire" });
  check("(2) 'exit-reap' trigger fired (the stage-3 kill's synchronous onExit)", callsFor(SID, "exit-reap").some((c) => c.rootPid === fake.pid));
  await waitUntil(() => callsFor(SID, "hard-stop").length > 0, { label: "(2) stage-3's own 'hard-stop' trigger to fire" });
  check("(2) stage-3's 'hard-stop' trigger fired with the right pid", callsFor(SID, "hard-stop").some((c) => c.rootPid === fake.pid));
}

// =========================================================================================================
// (3) claude's early-return backstop (finding 7): a SECOND hard stop on an ALREADY-exited session must
//     still schedule a verify using the last-known pid, not silently no-op.
// =========================================================================================================
{
  const SID = "claude-early-return-backstop";
  const fake = spawnClaude(SID, Infinity);
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
  host.stop(SID, "hard"); // first hard stop: exits it (live.alive -> false), schedules its own verify
  await waitUntil(() => callsFor(SID, "hard-stop").length >= 1, { label: "(3) the FIRST hard-stop's own verify" });
  const callsBefore = callsFor(SID, "hard-stop").length;
  host.stop(SID, "hard"); // SECOND hard stop: live.alive is now false — exercises the early-return path
  await waitUntil(() => callsFor(SID, "hard-stop").length > callsBefore, { label: "(3) the early-return backstop's OWN verify" });
  check("(3) the early-return backstop scheduled its own additional verify, same pid", callsFor(SID, "hard-stop").some((c) => c.rootPid === fake.pid));
}

// =========================================================================================================
// (4) codex stop(hard) — mirrors (1) for stopCodex's hard branch.
// =========================================================================================================
{
  const SID = "codex-hard-stop";
  const fake = spawnCodex(SID);
  host.stop(SID, "hard");
  check("(4) hard stop never writes a Ctrl-C (it kills directly)", fake.writes.length === 0);
  check("(4) 'exit-reap' trigger fired synchronously, right pid", callsFor(SID, "exit-reap").some((c) => c.rootPid === fake.pid));
  await waitUntil(() => callsFor(SID, "hard-stop").length > 0, { label: "(4) codex 'hard-stop' trigger to fire" });
  check("(4) codex 'hard-stop' trigger fired with the right pid", callsFor(SID, "hard-stop").some((c) => c.rootPid === fake.pid));
}

// =========================================================================================================
// (5) codex's own stage-3 hard-kill backstop (inside stopCodex's graceful branch) — a codex session that
//     never exits on either \x03 must still reach the bounded hard-kill + its scheduleRootVerify call.
// =========================================================================================================
{
  const SID = "codex-graceful-escalation";
  const fake = spawnCodex(SID);
  host.stop(SID, "graceful");
  await waitUntil(() => fake.writes.length === 2, { label: "(5) both \\x03 writes" });
  await waitUntil(() => callsFor(SID, "exit-reap").length > 0, { timeoutMs: 3000, label: "(5) stage-3 backstop's kill to fire (exit-reap)" });
  check("(5) 'exit-reap' trigger fired with the right pid", callsFor(SID, "exit-reap").some((c) => c.rootPid === fake.pid));
  await waitUntil(() => callsFor(SID, "hard-stop").length > 0, { label: "(5) stage-3 backstop's own 'hard-stop' trigger" });
  check("(5) stage-3's 'hard-stop' trigger fired with the right pid", callsFor(SID, "hard-stop").some((c) => c.rootPid === fake.pid));
}

// =========================================================================================================
// (6) codex's early-return backstop — symmetric to (3).
// =========================================================================================================
{
  const SID = "codex-early-return-backstop";
  const fake = spawnCodex(SID);
  host.stop(SID, "hard");
  await waitUntil(() => callsFor(SID, "hard-stop").length >= 1, { label: "(6) the FIRST hard-stop's own verify" });
  const callsBefore = callsFor(SID, "hard-stop").length;
  host.stop(SID, "hard");
  await waitUntil(() => callsFor(SID, "hard-stop").length > callsBefore, { label: "(6) codex's early-return backstop OWN verify" });
  check("(6) codex's early-return backstop scheduled its own additional verify, same pid", callsFor(SID, "hard-stop").some((c) => c.rootPid === fake.pid));
}

// =========================================================================================================
// (7) Round 4, item 4 — a CONFIRMED force-kill of the root must ALSO sweep orphaned descendants
//     afterward (a descendant spawned in the TOCTOU window between identity confirmation and the kill
//     itself — codex's own codex.exe under its shim, a shell, an MCP child). Drives
//     `verifyRootDeadOrForceKill` DIRECTLY (not via reapExitedDescendants, which already unconditionally
//     sweeps once of its own accord and is covered by scenarios (1)-(6) above) so this isolates and proves
//     JUST the new post-confirmed-kill sweep this round added. `sweepOrphanedDescendants` stays the
//     no-op'd seam the whole file already uses — this test NEVER lets the real OS-wide sweep run.
// =========================================================================================================
{
  const SID = "claude-confirmed-force-kill-sweep";
  const fake = spawnClaude(SID, Infinity); // Infinity: never exits on its own via Ctrl-C
  host.probeOverrides.set(SID, [
    // creationTime:0 (not null) — win32's own guard 2 (M3) refuses on a NULL creationTime as an
    // enumeration anomaly; 0 is a real (if ancient) value that trivially clears the slack check against
    // this session's own just-now startedAt, so this scenario actually reaches the force-kill branch.
    { foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: 0 }, // first probe: alive + confirmed
    { foundAlive: false, identityConfirmed: false, enumerationFailed: false, creationTime: null }, // recheck after killRoot: confirmed dead
  ]);
  const sweepCallsBefore = host.sweepCalls.length;
  const result = await host.verifyRootDeadOrForceKill(SID, fake.pid, "hard-stop");
  check("(7) verifyRootDeadOrForceKill reports a confirmed, dead, force-killed root", result.dead === true && result.identity === "confirmed" && result.forceKilled === true);
  check("(7) sweepOrphanedDescendants was called exactly once more, with the confirmed root's pid", host.sweepCalls.length === sweepCallsBefore + 1 && host.sweepCalls[host.sweepCalls.length - 1] === fake.pid);
}
{
  // (7, negative control) the SAME shape, but the recheck after killRoot still finds it alive (force-kill
  // UNCONFIRMED) — the sweep must NOT fire, since nothing was confirmed dead to sweep descendants of.
  const SID = "claude-unconfirmed-force-kill-no-sweep";
  const fake = spawnClaude(SID, Infinity);
  host.probeOverrides.set(SID, [
    { foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: 0 }, // first probe: alive + confirmed
    { foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: null }, // recheck after killRoot: STILL alive
  ]);
  const sweepCallsBefore = host.sweepCalls.length;
  const result = await host.verifyRootDeadOrForceKill(SID, fake.pid, "hard-stop");
  check("(7, negative control) verifyRootDeadOrForceKill reports forceKilled but NOT dead", result.dead === false && result.forceKilled === true);
  check("(7, negative control) sweepOrphanedDescendants was NOT called for this unconfirmed outcome", host.sweepCalls.length === sweepCallsBefore);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every real kill/exit call site (claude stop(hard)/escalateGracefulStop stage 3/early-return backstop, codex's three mirrors) actually invokes verifyRootDeadOrForceKill with the right pid + trigger, and a confirmed force-kill sweeps orphaned descendants afterward."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
