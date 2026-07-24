import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Recycle-vs-idle-nudge delivery race (task 69a128b0, observed live 2026-07-22).
//
// The bug: `notifyManagerOfIdleWorker` enqueues its `[loom:worker-idle]` nudge the INSTANT a worker parks
// (busy->false) — correct when computed. If the manager is BUSY right then (e.g. still processing the
// worker's own just-delivered report), the nudge only QUEUES in the manager's pending FIFO and drains on
// the manager's NEXT turn boundary. A manager can then RECYCLE that very worker (worker_recycle) — still
// mid-turn, before its queue ever drained. `recycleWorker` hard-stops the predecessor and mints a
// brand-new successor session id, but (before this fix) nothing purged the already-queued nudge naming
// the now-dead predecessor: it drained later telling the manager "worker <predecessor> ... is idle ... it
// IS parked awaiting your reply" for a session that no longer exists — `worker_message <predecessor>` is
// a guaranteed session-dead drop, and worker_list no longer even lists it.
//
// The fix: `recycleWorker` (and the sibling-retirement sweep it shares with `finalizeMerge`) now purges
// any still-queued `[loom:worker-idle]`/`[loom:worker-spawn-broken]` nudge for the retired session id via
// `PtyHost.purgeQueuedWorkerIdleNudges` — the SAME purge finding 2e3a8e6f already wired to a worker's own
// busy(false->true) re-engage edge (`purgeStaleIdleNudgeForReengagedWorker`), now also fired on the "this
// worker will NEVER re-engage" edge (hard-stop-for-recycle).
//
// HERMETIC — a REAL PtyHost (fake pty backend whose kill() synchronously fires the REAL captured onExit
// callback, so recycleWorker's hard-stop-then-wait sees the predecessor actually die, mirroring
// agent-runs-primitive.mjs's SeamHost) driving a REAL Db + SessionService, wired with the SAME onBusy/
// onExit callback shapes index.ts uses, and a REAL (not fabricated) `sessions.recycleWorker()` call.
//
//   (1) STALE nudge purged — the predecessor's queued parked-ack nudge is gone from the manager's FIFO
//       once recycleWorker returns, even though the manager never drained its queue in between.
//   (2) NOT over-suppressed — the fresh successor's OWN later idle-and-unreported park still produces a
//       correctly-addressed [loom:worker-idle] nudge naming the SUCCESSOR's id (the same real
//       notifyManagerOfIdleWorker/classifyIdleWorker path IdleWatcher's periodic tick uses).
//
// Run: 1) build (turbo builds shared first), 2) node test/idle-nudge-recycle-purge.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()) — set BEFORE
// importing host.js, since paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-idle-recycle-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// Fake pty whose kill() synchronously fires the REAL captured onExit callback (mirrors
// agent-runs-primitive.mjs's SeamHost) — so a "hard" stop makes PtyHost's own internal exit handling
// (live.alive=false, events.onExit) run deterministically. Without this, recycleWorker's ~5s
// hard-stop-then-poll wait loop would spin its full bound every run (idle-worker-nudge-race.mjs's fake
// never fires onExit at all, since that test never needs a REAL exit).
const exitCbs = new Map();
function makeFakePty(sessionId) {
  const writes = [];
  return {
    pid: 4242,
    write: (d) => { writes.push(d); },
    onData: () => ({ dispose() {} }),
    onExit(cb) { exitCbs.set(sessionId, cb); return { dispose() {} }; },
    kill() { const cb = exitCbs.get(sessionId); if (cb) cb({ exitCode: 0 }); },
    resize: () => {},
    writes,
  };
}
class TestPtyHost extends PtyHost { createPty(opts) { return makeFakePty(opts.sessionId); } }

// Mirrors index.ts's ACTUAL onBusy/onExit wiring: falling busy edge notifies, rising edge purges (finding
// 2e3a8e6f); onExit retires the row. `sessions` is assigned after `host` is constructed — same
// forward-reference the production module (and idle-worker-nudge-race.mjs) uses.
let sessions;
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  onBusy: (sessionId, busy) => {
    db.setBusy(sessionId, busy);
    if (!busy) sessions.notifyManagerOfIdleWorker(sessionId);
    else sessions.purgeStaleIdleNudgeForReengagedWorker(sessionId);
  },
};

const dbFile = path.join(tmpHome, "inr.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "inr-proj", agentId = "inr-agent";
db.insertProject({ id: projId, name: "INR", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
// The recycle successor's own spawn is driven off the PROJECT's resolved permission config (recycleWorker
// doesn't take an inline override like spawnReady below does) — force startupModeCycles:0 so its
// SessionStart also marks it ready SYNCHRONOUSLY, exactly like the direct host.spawn() calls below.
db.setProjectConfig(projId, { permission: { startupModeCycles: 0 } });
db.insertAgent({ id: agentId, projectId: projId, name: "Worker", startupPrompt: "", position: 0 });

function insertManager(id) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: tmpHome,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
}
function insertWorker(id, parentId, taskId) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: tmpHome,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: parentId, taskId,
    worktreePath: tmpHome, branch: "loom/inr-x",
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
  const mgrId = "rec-mgr", wkrId = "rec-wkr", taskId = "rec-tk";
  insertManager(mgrId);
  insertTask(taskId);
  insertWorker(wkrId, mgrId, taskId);
  spawnReady(mgrId);
  spawnReady(wkrId);

  // The worker parks: its own report delivers straight to the IDLE manager as a turn (arms mgr busy=true
  // via the M1 optimistic set) — exactly the real shape (a worker's report is what a manager reads and
  // reacts to, and typically decides what to do next FROM WITHIN that same busy turn).
  const reportResult = await sessions.workerReport(wkrId, { status: "progress", summary: "step 1 done, continuing" });
  check("setup: the worker's report delivered live (manager was idle)", reportResult.deliveryStatus === "delivered-live");
  check("setup: the manager is now busy (armed by the just-delivered report)", db.getSession(mgrId).busy === true);

  // The worker's turn ends (Stop) -> busy(false) edge -> notifyManagerOfIdleWorker classifies parked-ack
  // (no reply yet) and enqueues the nudge. Manager is BUSY, so it only QUEUES — it does not drain yet.
  host.deliverHook(wkrId, { hook_event_name: "Stop" });
  const queuedBefore = host.getPendingEntries(mgrId);
  const staleNudge = queuedBefore.find((e) => e.text.startsWith(`[loom:worker-idle] worker ${wkrId} `));
  check("setup: the parked-ack nudge is QUEUED (held) behind the manager's busy turn, not yet delivered", !!staleNudge);
  check("setup: the queued nudge says 'it IS parked awaiting your reply'", !!staleNudge && /parked awaiting your reply/.test(staleNudge.text));

  // WHILE the manager is STILL busy (mid-turn, exactly as in the observed incident), it recycles this
  // very worker — a REAL recycleWorker() call, not a fabricated recycle_begin/recycle_complete event.
  const successor = await sessions.recycleWorker(mgrId, wkrId, "handoff: continue step 2; decided A; do B next");
  check("recycle: a fresh successor session was minted", !!successor && successor.id !== wkrId);
  check("recycle: the predecessor is retired (exited)", db.getSession(wkrId).processState === "exited");
  check("recycle: the manager is STILL busy (never drained in between — the exact race window)", db.getSession(mgrId).busy === true);

  // (1) THE FIX: the stale nudge naming the now-dead predecessor must be gone from the manager's queue —
  // it must never be able to drain and name a session that's already exited and superseded.
  const queuedAfterRecycle = host.getPendingEntries(mgrId);
  check("(1) the STALE '[loom:worker-idle] worker <predecessor> ...' nudge is purged by the recycle",
    !queuedAfterRecycle.some((e) => e.text.startsWith(`[loom:worker-idle] worker ${wkrId} `)));

  // (2) NOT OVER-SUPPRESSED: the fresh successor later goes idle-and-unreported on its OWN (a genuine
  // strand, unrelated to the recycle) — a FRESH, correctly-addressed nudge naming the SUCCESSOR's id must
  // still fire, via the exact same real notifyManagerOfIdleWorker path IdleWatcher's periodic tick calls
  // (idle-watcher.ts tickIdleWorkers -> notifyIdleWorker -> sessions.notifyManagerOfIdleWorker).
  db.setEngineSessionId(successor.id, `eng-${successor.id}`); // engine attached (else classifyIdleWorker reads broken-spawn)
  sessions.notifyManagerOfIdleWorker(successor.id);
  const queuedAfterSuccessorIdle = host.getPendingEntries(mgrId);
  const successorNudge = queuedAfterSuccessorIdle.find((e) => e.text.startsWith(`[loom:worker-idle] worker ${successor.id} `));
  check("(2) a genuinely idle-and-unreported SUCCESSOR still produces its OWN correctly-addressed nudge", !!successorNudge);
  check("(2) that nudge correctly names the SUCCESSOR (never the retired predecessor)", !!successorNudge && !successorNudge.text.includes(wkrId));
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recycling a worker purges its still-queued [loom:worker-idle] nudge before it can drain naming the now-dead predecessor (task 69a128b0), while a genuinely idle-and-unreported successor still gets its own fresh, correctly-addressed nudge — no over-suppression."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
