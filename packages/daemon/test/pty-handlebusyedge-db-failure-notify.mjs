import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f18a2201 (item 1), follow-up to 72c58b1c. index.ts's real `onBusy` wiring used to run
// `db.setBusy(sessionId, busy)` and the manager idle-notification (`notifyManagerOfIdleWorker` /
// `purgeStaleIdleNudgeForReengagedWorker`) as two unguarded, sequential statements. A `db.setBusy` throw
// (e.g. a transient SQLITE_BUSY) propagated straight out of the whole callback — PtyHost.persistBusy's
// own try/catch (card 72c58b1c) absorbs it so the pty itself never sees the throw, but the notify call,
// sitting AFTER the throwing line in the SAME callback body, never ran either. For a TASKLESS worker
// that notify is its ONLY idle coverage — a single transient DB error there could silently strand a
// manager forever.
//
// THE FIX: the callback's body is now `SessionService.handleBusyEdge(sessionId, busy)` (sessions/
// service.ts), which wraps ONLY the `db.setBusy` call in its own try/catch — the notify/purge call
// always runs after it, regardless of whether the write succeeded. index.ts's `onBusy` now just
// delegates: `onBusy: (sessionId, busy) => sessions.handleBusyEdge(sessionId, busy)`.
//
// This test drives the REAL `SessionService.handleBusyEdge` (imported from dist, exactly like
// test/idle-worker-nudge-race.mjs's own `events.onBusy` wiring now does) rather than keeping a
// hand-copied mirror of index.ts's callback — a mirror would stay green even if the real wiring
// regressed back to the unguarded shape.
//
// HERMETIC — a REAL PtyHost (fake pty backend, mirrors idle-worker-nudge-race.mjs) driving a REAL Db
// (with ONE monkey-patched call made to throw) + SessionService. No real claude, no network, no live
// daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-hbe-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

class TestPtyHost extends createSeamHost(PtyHost) {}

// Drives the REAL fixed wiring (see the file header) — never a hand-copied mirror of it.
let sessions;
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onBusy: (sessionId, busy) => sessions.handleBusyEdge(sessionId, busy),
};

const dbFile = path.join(tmpHome, "hbe.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "hbe-proj", agentId = "hbe-agent";
db.insertProject({ id: projId, name: "HBE", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "", position: 0 });

const mgrId = "hbe-mgr", wkrId = "hbe-wkr", taskId = "hbe-tk";
db.insertSession({
  id: mgrId, projectId: projId, agentId, engineSessionId: `eng-${mgrId}`, title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});
db.insertTask({ id: taskId, projectId: projId, title: "T-" + taskId, body: "", columnKey: "in_progress", position: 0, createdAt: now, updatedAt: now });
db.insertSession({
  id: wkrId, projectId: projId, agentId, engineSessionId: `eng-${wkrId}`, title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", parentSessionId: mgrId, taskId,
});

const host = new TestPtyHost(events);
function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" }); // mark ready (startupModeCycles:0 -> synchronous)
}

sessions = new SessionService(db, host, new OrchestrationControl());

try {
  spawnReady(mgrId);
  spawnReady(wkrId);

  // Arm the manager busy (so the worker's falling-edge nudge below QUEUES rather than delivering live —
  // either way proves the point, but queuing makes the nudge directly inspectable via getPendingEntries).
  const reportResult = await sessions.workerReport(wkrId, { status: "progress", summary: "step 1 done, continuing" });
  check("setup: the worker's report delivered live (manager was idle)", reportResult.deliveryStatus === "delivered-live");
  check("setup: the manager is now busy (armed by the just-delivered report)", db.getSession(mgrId).busy === true);

  // Make the WORKER's own falling-edge db.setBusy call throw exactly once (simulates a transient
  // SQLITE_BUSY) — every other db.setBusy call (including the manager's own busy flips) is untouched.
  const realSetBusy = db.setBusy.bind(db);
  let armed = true;
  db.setBusy = (id, busy) => {
    if (armed && id === wkrId && busy === false) {
      armed = false;
      throw new Error("simulated SQLITE_BUSY (handleBusyEdge test)");
    }
    return realSetBusy(id, busy);
  };

  // The worker's turn ends (Stop) -> busy(false) edge -> handleBusyEdge's db.setBusy throws.
  host.deliverHook(wkrId, { hook_event_name: "Stop" });

  check("db.setBusy's throw was actually exercised (armed flag consumed)", armed === false);

  const queued = host.getPendingEntries(mgrId);
  const idleNudge = queued.find((e) => e.text.startsWith(`[loom:worker-idle] worker ${wkrId} `));
  check("the manager idle-notification still fired despite db.setBusy throwing", !!idleNudge);
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — SessionService.handleBusyEdge isolates the db.setBusy write from the manager idle-notification: a DB-write failure on the worker's falling edge never skips notifyManagerOfIdleWorker."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
