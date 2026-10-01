// Card 40738f24 MINOR-1 (Code Review 5d6b0561) — onRunSessionExit must not re-process a run that
// startRun's own catch already marked 'failed'.
//
// THE BUG: startRun's catch calls reconcileFailedSpawn(session.id, e) BEFORE its own
// db.failRun(runId, "run spawn failed before it could start: ..."). Since 40738f24, reconcileFailedSpawn
// can hard-kill a genuinely-live pty (the orphan-kill fix) — and on a REAL pty, that kill()'s onExit
// fires ASYNCHRONOUSLY, on a LATER tick, after startRun's catch has already returned (and already called
// its own db.failRun). When that deferred onExit eventually drives onRunSessionExit, the OLD code's guard
// (`run.status !== "completed" && ... !== "cancelled" && ... !== "timed_out"`) did not exclude "failed" —
// so it would overwrite startRun's precise error with the generic "run session exited before
// submit_result" message, reset endedAt, and re-run the whole teardown (usage capture + webhook fire) for
// a run that never had a real engine session at all.
//
// WHY THE SYNC SEAM FAKE CAN'T SEE IT: the shared _seam-host-fixture.mjs pty's kill() invokes its onExit
// callback SYNCHRONOUSLY, so with that fixture, reconcileFailedSpawn's kill() would drive onRunSessionExit
// to completion BEFORE startRun's own catch ever reaches its db.failRun call — the exact opposite
// ordering from a real (async) pty, and the one ordering that could never expose this bug. This test uses
// a LOCAL fake pty (mirroring agent-runs-primitive.mjs's own technique) whose kill() is a deliberate
// no-op: the test fires the deferred exit itself, via fireExit(), only AFTER asserting startRun's own
// catch has already run to completion — reproducing the real ordering a genuine async pty would exhibit.
//
// THE FIX: onRunSessionExit now early-returns when `run.status === "failed"`, before touching anything.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService against a local fake
// pty; a real temp git repo (startRun's createRunSnapshot needs a real HEAD to snapshot).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rsesaf-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const repo = path.join(os.tmpdir(), `loom-rsesaf-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# run-session-exit-skips-already-failed test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rsesaf@loom -c user.name=rsesaf");

const INJECTED_MESSAGE = "injected post-spawn throw (run-session-exit-skips-already-failed test)";

// LOCAL OVERRIDE (mirrors agent-runs-primitive.mjs's own technique, not the shared _seam-host-fixture.mjs
// SeamHost): kill() is a deliberate no-op — the real exit callback is stored and fired ONLY via the
// test's own explicit fireExit(), so the test controls exactly when the deferred exit lands relative to
// startRun's own catch, rather than the shared fixture's synchronous (and here, misleading) kill().
class SeamHost extends PtyHost {
  reapExitedDescendants(_rootPid) {}
  constructor(events) { super(events); this.exitCbs = new Map(); }
  createPty(opts) {
    const self = this;
    return {
      pid: 4242,
      write() {},
      onData() { return { dispose() {} }; },
      onExit(cb) { self.exitCbs.set(opts.sessionId, cb); return { dispose() {} }; },
      kill() { /* deliberately deferred — see fireExit() */ },
      resize() {},
    };
  }
  fireExit(sessionId, code = 0) { const cb = this.exitCbs.get(sessionId); if (cb) cb({ exitCode: code }); }
  // super.spawn(opts) runs the REAL PtyHost logic first (this.live genuinely registers the pty alive,
  // onExit is wired) — THEN this throws, reproducing "spawn throws after createPty already handed back a
  // live process" for startRun specifically (same shape as reconcile-failed-spawn-kills-live-orphan.mjs).
  spawn(opts) {
    super.spawn(opts);
    throw new Error(INJECTED_MESSAGE);
  }
}

const now = new Date().toISOString();
const db = new Db();
let onRunSessionExitCalls = 0;
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  // Wired like index.ts: onExit owns live->exited AND finalizes a run session's teardown.
  onExit(id) {
    db.setProcessState(id, "exited"); db.setBusy(id, false);
    const s = db.getSession(id);
    if (s?.role === "run") { onRunSessionExitCalls++; svc.onRunSessionExit(id); }
  },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pR2", name: "R2", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentRun2", projectId: "pR2", name: "Run2", startupPrompt: "AGENT_DOCTRINE", position: 0, profileId: null, endpoint: true, ioSchema: null });

try {
  let startErr;
  try {
    await svc.startRun({ agentId: "agentRun2", input: { q: "ping" }, schema: null });
  } catch (e) {
    startErr = e;
  }
  check("(setup precondition) the injected post-spawn throw actually propagated out of startRun",
    !!startErr && String(startErr.message).includes(INJECTED_MESSAGE));

  const runRows = db.listRuns("pR2");
  check("(setup precondition) exactly one run row was created despite the throw", runRows.length === 1);
  const runId = runRows[0]?.id;
  const sessionId = runRows[0]?.sessionId;

  check("(setup precondition) the pty is STILL alive right now — kill() was issued but its deferred exit hasn't landed yet (this IS the orphan case, mid-flight)",
    host.isAlive(sessionId) === true);
  check("(setup precondition) onRunSessionExit has NOT run yet — the deferred exit hasn't fired", onRunSessionExitCalls === 0);

  const beforeDeferred = db.getRun(runId);
  check("run is 'failed' with startRun's OWN precise error, BEFORE the deferred exit ever fires",
    beforeDeferred?.status === "failed" && beforeDeferred?.error?.includes("run spawn failed before it could start"));
  check("(setup precondition) startRun's own error does NOT already contain the generic onRunSessionExit message (proves the two messages are genuinely distinguishable)",
    !beforeDeferred?.error?.includes("run session exited before submit_result"));
  const endedAtBeforeDeferred = beforeDeferred?.endedAt;
  check("(setup precondition) endedAt was stamped by startRun's own failRun call", typeof endedAtBeforeDeferred === "string");

  // Now fire the deferred exit — reproducing the real (async) ordering: PtyHost's own internal onExit
  // handler runs (flips live.alive=false, calls events.onExit), which drives onRunSessionExit for a run
  // that is ALREADY 'failed'.
  host.fireExit(sessionId);
  check("the deferred exit actually reached onRunSessionExit (not a vacuous pass — it genuinely ran, just early-returned)", onRunSessionExitCalls === 1);

  const afterDeferred = db.getRun(runId);
  check("run.error is STILL startRun's own precise message — NOT overwritten by the generic one",
    afterDeferred?.error === beforeDeferred?.error);
  check("run.status is still 'failed' (not re-processed into some other terminal state)",
    afterDeferred?.status === "failed");
  check("run.endedAt was NOT re-stamped — proves onRunSessionExit's failRun call never ran a second time",
    afterDeferred?.endedAt === endedAtBeforeDeferred);
  check("the teardown usage/transcript capture never ran either (early return skips the whole method body)",
    afterDeferred?.usage == null && afterDeferred?.transcriptRef == null);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — onRunSessionExit early-returns on an already-'failed' run: a deferred (async-shaped) pty exit after startRun's own catch never overwrites its precise error or re-runs teardown."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
