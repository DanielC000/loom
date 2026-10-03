import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// resume() leaves archived_at UNRESTORED on a synchronous createPty throw (card 819407e4).
//
// The bug: resume() (sessions/service.ts) clears archived_at via db.restoreSession() BEFORE pty.spawn(),
// on the premise that a fast-failing spawn's onExit handler re-archives the row (the auto-archive-on-exit
// model). That premise is false for a throw that happens AFTER restoreSession already cleared archived_at
// but BEFORE a real OS process exists (a synchronous createPty failure, e.g. the real-world Windows
// CreateProcess error class): archiveOnExit is wired to the real pty `onExit` callback (index.ts), which
// never fires when no OS process was ever created. The shared `reconcileFailedSpawn` catch helper only
// flips processState to "exited" — it never touches archived_at. Net result: the row ends
// processState:"exited" + archived_at:NULL — exited but un-archived, which shows up as a dead zombie on
// the live rail (db.listAllSessions/getSessionListItemById filter ONLY on archived_at IS NULL) instead of
// in Archive.
//
// Deliberately injects the throw in createPty (NOT by monkeypatching db.restoreSession itself, which the
// sibling test session-resume-prespawn-throw-marks-exited.mjs does) — restoreSession must actually RUN
// and really clear archived_at first, so this test reproduces the genuine "cleared, then a LATER
// synchronous step throws" window the bug lives in, not a window where the clear never happened.
//
// The fix must restore archived_at ONLY for a row that was actually archived before this resume attempt
// — resume() also runs on non-archived exited rows (a human resuming a dead session straight off the live
// rail, or crash-recovery of a never-archived row), and unconditionally archiving those on failure would
// be a behaviour change, not a restore. This test covers BOTH polarities on two independent sessions:
//   (A) archived before resume() → must be archived again after the throw.
//   (B) NOT archived before resume() → must still NOT be archived after the throw.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty() seam, mirroring createpty-throw-reconciles-live-flip-spawn-sites.mjs's
// throwOnNextSpawn-latch pattern — a fresh manager spawn per scenario, succeeding normally, then a
// sandboxed engine transcript so resume()'s resumability checks pass, then one forced createPty throw on
// the resume() call under test).
//
// Run: 1) build (turbo builds shared first), 2) node test/session-resume-prespawn-throw-restores-archive-state.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-srtras-${Date.now()}-${process.pid}`);
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

const repo = path.join(os.tmpdir(), `loom-srtras-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# session-resume-prespawn-throw-restores-archive-state test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=srtras@loom -c user.name=srtras");

const now = new Date().toISOString();
const db = new Db();

const INJECTED_MESSAGE = "injected createPty throw (session-resume-prespawn-throw-restores-archive-state test)";
// Consumed exactly once per use, mirroring createpty-throw-reconciles-live-flip-spawn-sites.mjs's latch —
// so the manager's OWN initial spawn (via startManager, below) succeeds normally, and only the single
// resume() call under test hits the forced throw.
let throwOnNextSpawn = false;
class SeamHost extends createSeamHost(PtyHost) {
  isAlive() { return false; } // resume()'s already-live short-circuit must never block this test's resume
  createPty(opts) {
    if (throwOnNextSpawn) {
      throwOnNextSpawn = false;
      throw new Error(INJECTED_MESSAGE);
    }
    return super.createPty(opts);
  }
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
db.insertAgent({ id: "agentMgrA", projectId: "pS", name: "MgrA", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentMgrB", projectId: "pS", name: "MgrB", startupPrompt: "MGR", position: 1, profileId: null });

function makeResumableManager(agentId, engIdSuffix) {
  const s = svc.startManager(agentId); // a normal, successful spawn — throwOnNextSpawn is false here
  const engId = `aaaaaaaa-bbbb-cccc-dddd-${engIdSuffix}`;
  db.setEngineSessionId(s.id, engId);
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  db.setProcessState(s.id, "exited"); // a genuinely resumable row: exited, with a transcript on disk
  return s;
}

const sArchived = makeResumableManager("agentMgrA", "111111111111");
const sNotArchived = makeResumableManager("agentMgrB", "222222222222");

// Scenario (A): archived BEFORE resume() is called.
db.archiveSession(sArchived.id);
const archivedAtBefore = db.getSession(sArchived.id)?.archivedAt;
check("(setup precondition, scenario A) session row is archived before resume() is called",
  typeof archivedAtBefore === "string" && archivedAtBefore.length > 0);

// Scenario (B): explicitly NOT archived before resume() is called.
const notArchivedBefore = db.getSession(sNotArchived.id)?.archivedAt;
check("(setup precondition, scenario B) session row is NOT archived before resume() is called",
  notArchivedBefore == null);

try {
  // --- Scenario A: archived before → must be re-archived after the throw. ---
  throwOnNextSpawn = true;
  let errA;
  try { svc.resume(sArchived.id); } catch (e) { errA = e; }
  check("(setup precondition, scenario A) the injected createPty throw actually propagated out of resume()",
    !!errA && String(errA.message).includes(INJECTED_MESSAGE));
  check("(setup precondition, scenario A) the throw latch was actually consumed (proves the forced throw, not a coincidental one, fired)",
    throwOnNextSpawn === false);
  const rowA = db.getSession(sArchived.id);
  check("scenario A: session row ends processState:'exited' after the throw",
    rowA?.processState === "exited");
  check("scenario A: a PREVIOUSLY-ARCHIVED row is RE-ARCHIVED (archived_at restored, non-null) after the throw — this is the bug fix",
    typeof rowA?.archivedAt === "string" && rowA.archivedAt.length > 0);

  // --- Scenario B: not archived before → must NOT become newly archived after the throw. ---
  throwOnNextSpawn = true;
  let errB;
  try { svc.resume(sNotArchived.id); } catch (e) { errB = e; }
  check("(setup precondition, scenario B) the injected createPty throw actually propagated out of resume()",
    !!errB && String(errB.message).includes(INJECTED_MESSAGE));
  check("(setup precondition, scenario B) the throw latch was actually consumed (proves the forced throw, not a coincidental one, fired)",
    throwOnNextSpawn === false);
  const rowB = db.getSession(sNotArchived.id);
  check("scenario B: session row ends processState:'exited' after the throw",
    rowB?.processState === "exited");
  check("scenario B: a row that was NOT archived before resume() stays NOT archived after the throw (no newly-introduced archiving)",
    rowB?.archivedAt == null);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a synchronous createPty throw in resume(), after restoreSession already cleared archived_at, restores archived_at for a row that was archived before, and leaves a never-archived row untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
