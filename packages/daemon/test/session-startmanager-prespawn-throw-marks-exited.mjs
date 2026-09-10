import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// startManager PHANTOM-LIVE row on a pre-pty synchronous throw (card 6ca4155f, following fa1b77c1).
//
// The bug (and the fix): startManager (sessions/service.ts) inserts a session row and flips it to
// processState:"live" (setProcessState) BEFORE the pty is started. A synchronous statement —
// resolveCodescapeInjectionStatus — runs between that flip and pty.spawn. Before card 6ca4155f's shared
// `reconcileFailedSpawn` helper, nothing wrapped this window, so a throw there stranded the row
// phantom-live — the exact defect worker-recycle-prespawn-throw-marks-exited.mjs and
// session-resume-prespawn-throw-marks-exited.mjs already prove for recycleWorker/resume(). This test
// proves the SAME shared helper on a THIRD, non-worker role (a manager) — the helper is the claim under
// test here, not a third independent implementation.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty() seam). The throw is forced by monkeypatching
// SessionService.prototype.resolveCodescapeInjectionStatus — the exact pre-pty statement startManager
// runs in this window — the same prototype-patch technique the sibling tests already use.
//
// Run: 1) build (turbo builds shared first), 2) node test/session-startmanager-prespawn-throw-marks-exited.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-smpt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const repo = path.join(os.tmpdir(), `loom-smpt-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# session-startmanager-prespawn-throw-marks-exited test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=sm@loom -c user.name=sm");

const now = new Date().toISOString();
const db = new Db();
const host = new (createSeamHost(PtyHost))({
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
});
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pM", name: "M", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pM", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });

// --- force a synchronous throw in the pre-pty step startManager runs between the live flip and
// pty.spawn: resolveCodescapeInjectionStatus. TS `private` is erased at runtime — the same
// prototype-patch technique the sibling tests already use. ---
const INJECTED_MESSAGE = "injected pre-spawn throw (session-startmanager-prespawn-throw-marks-exited test)";
const original = SessionService.prototype.resolveCodescapeInjectionStatus;
SessionService.prototype.resolveCodescapeInjectionStatus = function () {
  throw new Error(INJECTED_MESSAGE);
};

try {
  let spawnError;
  try {
    svc.startManager("agentMgr");
  } catch (e) {
    spawnError = e;
  }

  check("(setup precondition) the injected pre-spawn throw actually propagated out of startManager",
    !!spawnError && String(spawnError.message).includes(INJECTED_MESSAGE));

  const rows = db.listSessions("agentMgr");
  check("(setup precondition) exactly one session row was created despite the throw", rows.length === 1);
  const row = rows[0];

  check("session row ends processState:'exited', NOT stranded 'live', after a pre-spawn throw",
    row?.processState === "exited");
  check("session row's lastError carries the injected throw's own message (the shared helper's second effect)",
    typeof row?.lastError === "string" && row.lastError.includes(INJECTED_MESSAGE));
} finally {
  SessionService.prototype.resolveCodescapeInjectionStatus = original;
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a synchronous throw in startManager's pre-pty step (resolveCodescapeInjectionStatus), after the row goes live, leaves it 'exited', not phantom-live — proving the shared reconcileFailedSpawn helper on a THIRD, non-worker role."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
