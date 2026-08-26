import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Code Review Minor B (task 648ae961, from the review of 8636f761 @ dffd5534).
//
// BACKGROUND: `platformEscalate`'s returned `outcome` used to be derived as
// `created ? "created" : "appended"` — unconditional on `created` alone — while the sibling `appended`
// flag only ever flipped true inside the `if (reusedTask)` branch. If `db.getTask(taskId)` ever returned
// `undefined` for a `reuseTaskId` resolved moments earlier (e.g. the task were deleted concurrently in
// between), the two fields would DISAGREE: `outcome:"appended"` with no `appended` flag, no body write,
// and a taskId pointing at a card that no longer exists — silent detail loss reported as success.
//
// UNREACHABLE IN PRODUCTION: `platformEscalate` takes no `await` anywhere, so nothing can genuinely
// delete the task between the resolution read and the re-read this test forces. This test proves the
// FIX (an explicit error instead of a silent false-success) by monkeypatching `db.getTask` to return
// `undefined` on exactly the SECOND call for the target id — simulating that otherwise-unreachable
// concurrent deletion — the only way to exercise this branch at all.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE — a REAL Db + SessionService driven directly (no MCP
// layer), mirroring platform-escalate-followup.mjs's harness exactly.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-escalate-missing-reused-task.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-escmissing-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// No live Lead in this test — the finding is about `outcome`/`appended` agreement, independent of
// whether a Lead is live to be nudged.
class SeamHost extends createSeamHost(PtyHost) {
  enqueueStdin() { throw new Error("no live Lead in this test — enqueueStdin should never be reached"); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentMgr", projectId: "pOrd", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertSession({
  id: "MGR", projectId: "pOrd", agentId: "agentMgr", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null,
});

const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

try {
  const escA = svc.platformEscalate("MGR", { title: "original finding", detail: "A: first sighting.", severity: "medium" });
  check("(setup) 1st escalation files a fresh task", !!escA.taskId && escA.created === true && escA.outcome === "created");

  // Force the SECOND db.getTask(escA.taskId) call to return undefined — simulating the task being
  // deleted concurrently between the followUpOn resolution read and platformEscalate's own re-read.
  const targetId = escA.taskId;
  const origGetTask = db.getTask.bind(db);
  let callsForTarget = 0;
  db.getTask = (id) => {
    if (id === targetId) {
      callsForTarget++;
      if (callsForTarget === 2) return undefined;
    }
    return origGetTask(id);
  };

  let threw = false;
  let message = "";
  try {
    svc.platformEscalate("MGR", { title: "irrelevant title", detail: "follow-up onto a concurrently-deleted task", followUpOn: targetId });
  } catch (e) {
    threw = true;
    message = e.message;
  } finally {
    db.getTask = origGetTask;
  }

  check("(1) a reused task that vanishes before the re-read is an EXPLICIT ERROR, not a silent 'appended' success", threw);
  check("(1) the error names the task id so a reader can tell which escalation target vanished", message.includes(targetId));

  // Negative control: with the SAME monkeypatch removed (restored above), the identical followUpOn call
  // against the SAME still-existing task succeeds normally — proving callsForTarget===2 is what triggered
  // the forced-undefined branch, not something else about this task/session.
  const escFollowup = svc.platformEscalate("MGR", { title: "irrelevant title", detail: "a normal follow-up", followUpOn: targetId });
  check("(control) the identical followUpOn call succeeds once db.getTask is no longer forced to lie", escFollowup.outcome === "appended" && escFollowup.appended === true);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a followUpOn target that vanishes between resolution and re-read now fails loudly (an explicit error) instead of silently reporting outcome:\"appended\" with no appended flag and no body write."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
