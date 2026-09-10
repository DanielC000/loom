import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// resume() of a REAL gen>=1 recycle successor, on a pre-spawn throw, must KEEP its `recycledFrom` link
// (card 4be56c33, second Code Review pass on commit a11525fe).
//
// The bug this guards against: a FIRST attempt at card 4be56c33 nulled `recycled_from` unconditionally
// inside the SHARED `reconcileFailedSpawn` helper (sessions/service.ts) — reasoning that only the three
// recycle methods ever set `recycledFrom` on a fresh row, so nulling it there would be a no-op for every
// OTHER caller. That reasoning missed that `reconcileFailedSpawn` is ALSO called from resume() (~line
// 3070) on a pre-spawn throw resuming an EXISTING row — and that row is very often a genuine gen>=1
// recycle SUCCESSOR, not a fresh one. Nulling its `recycledFrom` there would flip
// `hasSuccessor(predecessor)` to false and lift every zombie/double-recycle guard for the (still-retired)
// predecessor — see docs/decisions/4be56c33-unlink-failed-recycle-successor.md for the full incident.
//
// The fix moved the unlink OUT of `reconcileFailedSpawn` and into each of the three recycle methods' OWN
// catch block (they alone know the row was JUST insertSession'd this same synchronous call, never live).
// resume()'s own `reconcileFailedSpawn` call is untouched — it never touches `recycled_from` at all.
//
// Proves: resume() of a REAL successor (gen:1, recycledFrom: <predecessor>) that fails pre-spawn —
//   (1) still ends 'exited' with the injected error (reconcileFailedSpawn's own unchanged effect), AND
//   (2) KEEPS recycledFrom === predecessor.id (the fix under test), AND
//   (3) hasSuccessor(predecessor) STAYS true (the predecessor is NOT wrongly un-superseded).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty() seam, mirroring session-resume-prespawn-throw-marks-exited.mjs's proven resume()
// harness). The successor row is inserted directly (not via a real recycle call) — simpler setup for the
// same shape: a resumable gen>=1 row with recycledFrom already set.
//
// RED/GREEN: GREEN against this tranche's fixed service.ts. RED against commit a11525fe (this card's
// FIRST attempt, before the second Code Review pass) — reproduce via `git show a11525fe:packages/daemon/
// src/sessions/service.ts > <scratch>/service.ts.a11525fe` + a temporary `cp` over the real file (or
// `git checkout a11525fe -- packages/daemon/src/sessions/service.ts`, capturing the current diff first
// per worker doctrine's revert-to-prove-RED recipe), rebuild, re-run.
//
// Run: 1) build (turbo builds shared first), 2) node test/session-resume-prespawn-throw-preserves-recycled-from.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-srpr-${Date.now()}-${process.pid}`);
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

const repo = path.join(os.tmpdir(), `loom-srpr-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# session-resume-prespawn-throw-preserves-recycled-from test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=srpr@loom -c user.name=srpr");

const now = new Date().toISOString();
const db = new Db();

// Mirrors session-resume-prespawn-throw-marks-exited.mjs: isAlive() always false so resume()'s
// already-live short-circuit never blocks the resume (this test drives no real OS pty).
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

db.insertProject({ id: "pQ", name: "Q", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pQ", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });

// The PREDECESSOR — already retired (exited, no live pty), exactly as a real recycle leaves it. Needs its
// OWN engine transcript too (resume()'s transcript-exists check runs BEFORE the hasSuccessor/superseded
// check, so assertion (3b) below — proving the superseded refusal specifically — needs it to get there).
const predEngId = "aaaaaaaa-bbbb-cccc-dddd-000000000001";
db.insertSession({ id: "predMgr", projectId: "pQ", agentId: "agentMgr", engineSessionId: predEngId, title: null,
  cwd: repo, processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", gen: 0 });
const predTpath = engineTranscriptPath(repo, predEngId);
fs.mkdirSync(path.dirname(predTpath), { recursive: true });
fs.writeFileSync(predTpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

// The SUCCESSOR — a REAL gen:1 recycle successor (recycledFrom: predMgr.id), resumable (has its own
// engine transcript), but not currently live — exactly the row resume() would be asked to bring back.
const succEngId = "aaaaaaaa-bbbb-cccc-dddd-000000000002";
db.insertSession({ id: "succMgr", projectId: "pQ", agentId: "agentMgr", engineSessionId: succEngId, title: null,
  cwd: repo, processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", gen: 1, recycledFrom: "predMgr" });
const tpath = engineTranscriptPath(repo, succEngId);
fs.mkdirSync(path.dirname(tpath), { recursive: true });
fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

check("(setup precondition) hasSuccessor(predecessor) is TRUE before any resume attempt (real recycle link)",
  db.hasSuccessor("predMgr") === true);

// --- force a synchronous throw in the one pre-pty step resume() runs between the live flip and
// pty.spawn: db.restoreSession (same injection site as session-resume-prespawn-throw-marks-exited.mjs). ---
const INJECTED_MESSAGE = "injected pre-spawn throw (session-resume-prespawn-throw-preserves-recycled-from test)";
const originalRestoreSession = Db.prototype.restoreSession;
Db.prototype.restoreSession = function (...args) {
  if (args[0] === "succMgr") throw new Error(INJECTED_MESSAGE);
  return originalRestoreSession.apply(this, args);
};

try {
  let resumeError;
  try {
    svc.resume("succMgr");
  } catch (e) {
    resumeError = e;
  }

  check("(setup precondition) the injected pre-spawn throw actually propagated out of resume()",
    !!resumeError && String(resumeError.message).includes(INJECTED_MESSAGE));

  const succRow = db.getSession("succMgr");
  check("(1) successor row still ends processState:'exited' (reconcileFailedSpawn's own unchanged effect)",
    succRow?.processState === "exited");
  check("(1) successor row's lastError carries the injected throw's own message",
    typeof succRow?.lastError === "string" && succRow.lastError.includes(INJECTED_MESSAGE));

  check("(2) successor's OWN recycledFrom is UNCHANGED — still points at the real predecessor",
    succRow?.recycledFrom === "predMgr");
  check("(3) hasSuccessor(predecessor) STAYS true — a failed RESUME of a real successor must never un-supersede its predecessor",
    db.hasSuccessor("predMgr") === true);

  // A superseded predecessor stays refused for an AUTOMATIC resume — the exact guard this bug would have
  // silently lifted (resume()'s own line: "session was recycled — a successor exists...").
  let predResumeError;
  try {
    svc.resume("predMgr");
  } catch (e) {
    predResumeError = e;
  }
  check("(3b) an AUTOMATIC resume(predecessor) is STILL refused (superseded) after the successor's own failed resume",
    !!predResumeError && String(predResumeError.message).includes("recycled"));
} finally {
  Db.prototype.restoreSession = originalRestoreSession;
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a pre-spawn throw resuming a REAL gen>=1 recycle successor leaves it 'exited' (unchanged) but keeps its recycledFrom link intact, so its predecessor stays correctly superseded."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
