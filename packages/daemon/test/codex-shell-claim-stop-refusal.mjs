import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 71d08ea3 — `stop()` dispatched to `stopCodex` BEFORE the 710a34fa `{shell:true}` shell-claim guard,
// so `DELETE /api/terminals/<codex-session-id>` (loopback-only, always passes `{shell:true}` — see
// gateway/server.ts's own call site) hard-killed a CODEX AGENT session even though that guard exists
// precisely to refuse a terminal-route stop on a non-shell session. Fixed: the shell-claim check now runs
// BEFORE dispatching to either harness, so a codex session is refused identically to a claude one.
//
// TECHNIQUE: mirrors codex-graceful-stop-diag.mjs's established fake `createCodexPty()` override (a
// scripted fake pty drives the REAL `spawn`/`stop`/`stopCodex` production code, never a real codex
// process) plus shell-terminal-rest-refusal.mjs's `createShellPty()` override, combined in one host so a
// single test can exercise both harnesses' real `stop()` dispatch.
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TMP = mkdtempManaged("loom-codex-shell-claim-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await import("../dist/pty/host.js");

function makeFakeCodexPty() {
  let onExitCb = null;
  const writes = [];
  let kills = 0;
  return {
    pid: 6161,
    write(data) { writes.push(data); },
    onData() { return { dispose() {} }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { kills++; const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    simulateExit(exitCode, signal) { const cb = onExitCb; cb?.({ exitCode, signal }); },
    writes,
    get kills() { return kills; },
  };
}

function makeFakeShellPty() {
  let onExitCb = null;
  const writes = [];
  let kills = 0;
  return {
    pid: 7171,
    write(data) { writes.push(data); },
    onData: () => ({ dispose() {} }),
    onExit: (cb) => { onExitCb = cb; return { dispose() {} }; },
    kill: () => { kills++; onExitCb?.({ exitCode: 0 }); },
    resize() {},
    writes,
    get kills() { return kills; },
  };
}

const fakeCodexPtys = new Map();
const fakeShellPtys = new Map();
class TestHost extends PtyHost {
  reapExitedDescendants(_rootPid) {}
  createCodexPty(opts) {
    const fake = makeFakeCodexPty();
    fakeCodexPtys.set(opts.sessionId, fake);
    return fake;
  }
  createShellPty(opts) {
    const fake = makeFakeShellPty();
    fakeShellPtys.set(opts.id, fake);
    return fake;
  }
}

const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onCodexBootStuck() {}, onExit() {},
};
const host = new TestHost(events);

function spawnReadyCodexSession(sessionId) {
  host.spawn({
    sessionId, cwd: "/fake/codex/worktree", permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: "worker", harness: "codex", startupPrompt: undefined,
  });
  const fakePty = fakeCodexPtys.get(sessionId);
  host.liveCodex.get(sessionId).bootReady = true;
  return fakePty;
}

// --- (1) THE BUG: a shell-claimed stop on a codex agent session — the id DELETE /api/terminals/:id would
// pass — must be refused, and the session must stay fully alive, untouched. RED on main (dispatched to
// stopCodex and hard-killed it before this fix); GREEN with the fix (refused at the top of stop()).
const CODEX_ID = "codex-shell-claim-victim";
const fakeCodex = spawnReadyCodexSession(CODEX_ID);
const result = host.stop(CODEX_ID, "hard", { shell: true });
check("shell-claimed stop() on a codex session returns false (refused)", result === false);
check("the codex session is still alive", host.liveCodex.get(CODEX_ID)?.alive === true);
check("the codex pty was never killed", fakeCodex.kills === 0);
check("the codex pty received no writes", fakeCodex.writes.length === 0);

// --- (2) CONTROL: a genuine shell stop (the real DELETE /api/terminals/:id path) still works — the guard
// must not have turned into a blanket refusal.
const SHELL_ID = "shell-genuine-stop";
host.spawnShell({ id: SHELL_ID, cwd: "/fake/cwd", command: "sh", args: [], geometry: { cols: 120, rows: 40 }, label: "test shell" });
const fakeShell = fakeShellPtys.get(SHELL_ID);
const shellResult = host.stop(SHELL_ID, "hard", { shell: true });
check("control: shell-claimed stop() on a REAL shell is NOT refused (returns undefined, proceeds to kill)", shellResult === undefined);
check("control: the shell pty was killed", fakeShell.kills === 1);
check("control: the shell is no longer alive", host.isAlive(SHELL_ID) === false);

// --- (3) CONTROL: a normal, non-shell-claimed codex stop still works — the fix must not have broken the
// ordinary codex stop path itself, only the shell-claim case.
const CODEX_ID_2 = "codex-normal-stop";
const fakeCodex2 = spawnReadyCodexSession(CODEX_ID_2);
const normalResult = host.stop(CODEX_ID_2, "hard");
check("control: a normal (non-shell-claimed) codex stop proceeds (returns undefined)", normalResult === undefined);
check("control: the codex pty WAS killed by a normal stop", fakeCodex2.kills === 1);
check("control: the codex session is no longer alive", host.liveCodex.get(CODEX_ID_2)?.alive === false);

await finishAndExit(failures === 0 ? 0 : 1);
