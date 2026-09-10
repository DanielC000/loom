import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// resume() PHANTOM-LIVE row on a pre-pty synchronous throw (card 6ca4155f, following fa1b77c1).
//
// The bug: resume() (sessions/service.ts) flips a session row to processState:"live" (setProcessState)
// BEFORE the pty is started. A synchronous statement — db.restoreSession (auto-archive-model clear) —
// runs between that flip and pty.spawn, with NO surrounding try/catch anywhere in resume(). If it
// throws, the row is stranded "live" with no process behind it — a PHANTOM-LIVE session (mirrors
// spawnWorker's fixed defect and recycleWorker's identical one, worker-recycle-prespawn-throw-marks-
// exited.mjs).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty() seam, mirroring resume-mode-cycles.mjs's proven resume() harness — a fresh manager
// spawn, then a sandboxed engine transcript so resume()'s resumability checks pass). The throw is forced
// by monkeypatching Db.prototype.restoreSession — the exact pre-pty statement named above.
//
// Run: 1) build (turbo builds shared first), 2) node test/session-resume-prespawn-throw-marks-exited.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-srpt-${Date.now()}-${process.pid}`);
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
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

const repo = path.join(os.tmpdir(), `loom-srpt-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# session-resume-prespawn-throw-marks-exited test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=srpt@loom -c user.name=srpt");

const now = new Date().toISOString();
const db = new Db();

// Mirrors resume-mode-cycles.mjs: isAlive() always false so resume()'s already-live short-circuit never
// blocks the resume (this test drives no real OS pty).
class SeamHost extends createSeamHost(PtyHost) {
  isAlive() { return false; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pS", name: "S", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pS", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });

const sMgr = svc.startManager("agentMgr");
const engId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
db.setEngineSessionId(sMgr.id, engId);
const tpath = engineTranscriptPath(repo, engId);
fs.mkdirSync(path.dirname(tpath), { recursive: true });
fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
db.setProcessState(sMgr.id, "exited"); // a genuinely resumable row: exited, with a transcript on disk

// --- force a synchronous throw in the one pre-pty step resume() runs between the live flip and
// pty.spawn: db.restoreSession (the auto-archive-model clear). ---
const INJECTED_MESSAGE = "injected pre-spawn throw (session-resume-prespawn-throw-marks-exited test)";
const originalRestoreSession = Db.prototype.restoreSession;
Db.prototype.restoreSession = function () {
  throw new Error(INJECTED_MESSAGE);
};

try {
  let resumeError;
  try {
    svc.resume(sMgr.id);
  } catch (e) {
    resumeError = e;
  }

  check("(setup precondition) the injected pre-spawn throw actually propagated out of resume()",
    !!resumeError && String(resumeError.message).includes(INJECTED_MESSAGE));

  const row = db.getSession(sMgr.id);
  check("session row ends processState:'exited', NOT stranded 'live', after a pre-spawn throw",
    row?.processState === "exited");
  check("session row's lastError carries the injected throw's own message (the shared helper's second effect)",
    typeof row?.lastError === "string" && row.lastError.includes(INJECTED_MESSAGE));
} finally {
  Db.prototype.restoreSession = originalRestoreSession;
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a synchronous throw in resume()'s pre-pty step (db.restoreSession), after the row goes live, leaves it 'exited', not phantom-live."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
