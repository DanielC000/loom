import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Delivery-vs-watchdog TIMING race (auditor finding 2e3a8e6f — distinct from the progress-vs-blocked
// guard on 5d41fc8a).
//
// The bug: `notifyManagerOfIdleWorker` classifies + enqueues its `[loom:worker-idle]` nudge the INSTANT a
// worker goes idle — correct when computed. But if the manager is BUSY right then (e.g. still processing
// the worker's OWN just-delivered report), the nudge only QUEUES (held) in the manager's pending FIFO and
// drains on the manager's NEXT turn boundary. A manager can reply to that very worker
// (`worker_message`/`worker_redirect`) LATER IN THE SAME still-in-flight turn — re-engaging it — and only
// THEN end its turn, at which point the STALE queued nudge (computed BEFORE the reply) would otherwise
// drain as if fresh, falsely telling an already-responded manager "it IS parked awaiting your reply".
//
// The fix: the worker's OWN busy(false→true) edge (index.ts's onBusy hook) now calls
// `SessionService.purgeStaleIdleNudgeForReengagedWorker` -> `PtyHost.purgeQueuedWorkerIdleNudges`, which
// drops any still-queued `[loom:worker-idle]`/`[loom:worker-spawn-broken]` nudge for that worker from its
// manager's FIFO the instant it re-engages (whether via a manager reply or on its own) — before it can
// ever drain stale into the manager's turn.
//
// HERMETIC — a REAL PtyHost (fake pty backend, mirrors question-answer-nudge-purge.mjs) driving a REAL Db
// + SessionService, wired with the SAME onBusy callback shape as index.ts (falling edge notifies, rising
// edge purges). No real claude, no network, no live daemon.
//
//   (1) STALE nudge suppressed — the manager replies to the worker WHILE the earlier parked-ack nudge is
//       still sitting queued (manager was busy processing the worker's own report): the reply's delivery
//       purges the stale nudge before it can ever reach the manager.
//   (2) GENUINE nudge NOT over-suppressed — a sibling worker parks the same way but gets NO reply: its
//       queued parked-ack nudge survives untouched, so a truly-idle-with-no-reply worker still nudges.
//
// Run: 1) build (turbo builds shared first), 2) node test/idle-worker-nudge-race.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()) — set BEFORE
// importing host.js, since paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-idle-race-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const fakes = [];
function makeFakePty() {
  const writes = [];
  const fake = { pid: 4242, write: (d) => { writes.push(d); }, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }

// Mirrors index.ts's ACTUAL onBusy wiring byte-for-byte (the wiring under test): falling edge notifies,
// rising edge purges. `sessions` is assigned after `host` is constructed — same forward-reference the
// production module uses.
let sessions;
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onBusy: (sessionId, busy) => {
    db.setBusy(sessionId, busy);
    if (!busy) sessions.notifyManagerOfIdleWorker(sessionId);
    else sessions.purgeStaleIdleNudgeForReengagedWorker(sessionId);
  },
};

const dbFile = path.join(tmpHome, "iwr.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "iwr-proj", agentId = "iwr-agent";
db.insertProject({ id: projId, name: "IWR", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "", position: 0 });

function insertManager(id) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
}
function insertWorker(id, parentId, taskId) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: parentId, taskId,
  });
}
function insertTask(id) {
  db.insertTask({ id, projectId: projId, title: "T-" + id, body: "", columnKey: "in_progress", position: 0, createdAt: now, updatedAt: now });
}

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
  // ============ (1) STALE nudge suppressed — a reply mid-turn purges the queued parked-ack nudge ============
  {
    const mgrId = "r1-mgr", wkrId = "r1-wkr", taskId = "r1-tk";
    insertManager(mgrId);
    insertTask(taskId);
    insertWorker(wkrId, mgrId, taskId);
    spawnReady(mgrId);
    spawnReady(wkrId);

    // The worker parks: its own report delivers straight to the IDLE manager as a turn (arms mgr busy=true
    // via the M1 optimistic set) — exactly the real shape (a worker's report is what a manager reads and
    // reacts to).
    const reportResult = await sessions.workerReport(wkrId, { status: "progress", summary: "step 1 done, continuing" });
    check("(1) setup: the worker's report delivered live (manager was idle)", reportResult.deliveryStatus === "delivered-live");
    check("(1) setup: the manager is now busy (armed by the just-delivered report)", db.getSession(mgrId).busy === true);

    // The worker's turn ends (Stop) -> busy(false) edge -> notifyManagerOfIdleWorker classifies parked-ack
    // (no reply yet) and enqueues the nudge. Manager is BUSY, so it only QUEUES — it does not drain yet.
    host.deliverHook(wkrId, { hook_event_name: "Stop" });
    const queuedBefore = host.getPendingEntries(mgrId);
    const staleNudge = queuedBefore.find((e) => e.text.startsWith(`[loom:worker-idle] worker ${wkrId} `));
    check("(1) setup: the parked-ack nudge is QUEUED (held) behind the manager's busy turn, not yet delivered", !!staleNudge);
    check("(1) setup: the queued nudge says 'it IS parked awaiting your reply'", !!staleNudge && /parked awaiting your reply/.test(staleNudge.text));

    // WHILE the manager is still busy (mid-turn processing the report), it replies to the worker.
    const replyResult = sessions.messageWorker(mgrId, wkrId, "keep going, here's the next step");
    check("(1) the manager's reply delivers immediately (the worker was idle)", replyResult.delivered === true);

    // The reply's delivery raced the worker busy(false->true) via the M1-synchronous setBusy -> onBusy(true)
    // -> purgeStaleIdleNudgeForReengagedWorker, which should have removed the now-stale queued nudge BEFORE
    // it could ever drain into the manager's next turn.
    const queuedAfter = host.getPendingEntries(mgrId);
    check("(1) the STALE '[loom:worker-idle] ... it IS parked' nudge is gone from the manager's queue",
      !queuedAfter.some((e) => e.text.startsWith(`[loom:worker-idle] worker ${wkrId} `)));
  }

  // ============ (2) GENUINE nudge NOT over-suppressed — no reply, still idle -> nudge survives ============
  {
    const mgrId = "r2-mgr", wkrId = "r2-wkr", taskId = "r2-tk";
    insertManager(mgrId);
    insertTask(taskId);
    insertWorker(wkrId, mgrId, taskId);
    spawnReady(mgrId);
    spawnReady(wkrId);

    const reportResult = await sessions.workerReport(wkrId, { status: "progress", summary: "step 1 done, continuing" });
    check("(2) setup: the worker's report delivered live (manager was idle)", reportResult.deliveryStatus === "delivered-live");
    check("(2) setup: the manager is now busy (armed by the just-delivered report)", db.getSession(mgrId).busy === true);

    host.deliverHook(wkrId, { hook_event_name: "Stop" }); // worker parks -> parked-ack nudge queues (manager busy)

    // NO reply this time — the worker genuinely stays idle with nobody having responded.
    const queued = host.getPendingEntries(mgrId);
    const nudge = queued.find((e) => e.text.startsWith(`[loom:worker-idle] worker ${wkrId} `));
    check("(2) the genuine parked-ack nudge is present and UNTOUCHED (no reply happened -> nothing purges it)", !!nudge);
    check("(2) it still reads 'it IS parked awaiting your reply' (unmodified)", !!nudge && /parked awaiting your reply/.test(nudge.text));
    check("(2) the worker itself stayed idle throughout (no over-suppression trigger fired)", db.getSession(wkrId).busy === false);
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a manager's reply to a worker mid-turn purges the now-stale queued [loom:worker-idle] parked-ack nudge before it can drain into the manager's next turn (the delivery-vs-watchdog race, finding 2e3a8e6f), while a genuinely-idle worker with no reply still keeps its nudge queued for delivery — no over-suppression."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
