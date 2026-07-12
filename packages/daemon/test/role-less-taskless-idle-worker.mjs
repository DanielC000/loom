import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression for card df48366b: a role-less (role:null) and/or taskless (taskId:null) worker-like
// session — e.g. a consultation rig spawned under a manager — used to be INVISIBLE to the entire
// busy/idle reconciliation surface:
//   1. db.listLiveWorkers() filtered `role = 'worker'` only, so BusyWorkerWatcher's long-turn advisory
//      and IdleWatcher's periodic tickIdleWorkers never even iterated a role-less child.
//   2. SessionService.notifyManagerOfIdleWorker (the busy(false)-edge push, called from index.ts's onBusy
//      hook on EVERY session regardless of role) hard-required `role === "worker"`, so even that ONE
//      direct nudge never reached a role-less child's manager — the [loom:worker-idle] nudge promised on
//      a silent finish NEVER fired.
//   3. classifyIdleWorker had the same role gate, and a TASKLESS worker's own notifyManagerOfIdleWorker
//      branch only ever checked for broken-spawn (never started) — a taskless worker that DID engage and
//      then finished a turn silently got NO signal at all, tasked or not.
// This file drives the real SessionService + IdleWatcher + BusyWorkerWatcher + db.listLiveWorkers
// directly against a seeded DB (their own eligibility/decision logic), never wall-clock timing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { IdleWatcher } from "../dist/orchestration/idle-watcher.js";
import { BusyWorkerWatcher } from "../dist/orchestration/busy-worker-watcher.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-07-12T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-rl-idle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `rl-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `rla-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "RoleLess", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  const alive = new Set();
  const enqueued = [];
  const pendingBySession = new Map();
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
    },
    getPendingEntries: (id) => pendingBySession.get(id) ?? [],
    purgeQueuedWorkerIdleNudges: () => 0,
  };
  const control = new OrchestrationControl();
  const sessions = new SessionService(db, pty, control);
  const idleWatcher = new IdleWatcher({
    db, pty, control, recycleRatio: 0,
    notifyIdleWorker: (id) => sessions.notifyManagerOfIdleWorker(id),
    isWorkerStranded: (id) => sessions.isWorkerGenuinelyStranded(id),
  });
  const busyWatcher = new BusyWorkerWatcher({ db, pty, control });
  return { dbFile, db, projId, agentId, alive, enqueued, control, sessions, idleWatcher, busyWatcher, pendingBySession };
}

function seedManager(e, id, { idleMin = 60 } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
}
// A role-less (role:null) worker-like child. engineSessionId non-null by default (it DID start a turn).
function seedRoleLessWorker(e, id, parentId, { taskId = null, busy = false, idleMin = 60, engineSessionId = "eng-" + id } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: null,
    parentSessionId: parentId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
}
function seedTask(e, id, columnKey = "in_progress") {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
const stuckEvents = (e, workerId) => e.db.listEventsForWorker(workerId).filter((ev) => ev.kind === "worker_stuck");
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============ (1) db.listLiveWorkers() now includes a role-less PARENTED child, excludes a PARENTLESS one ============
{
  const e = makeEnv();
  seedManager(e, "mgr-1");
  seedRoleLessWorker(e, "rl-1", "mgr-1"); // parented role-less child
  // A standalone role-less session with NO parent (e.g. a platform 'plain' spawn) must stay excluded.
  e.db.insertSession({
    id: "standalone-1", projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-s1", title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role: null,
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  const ids = e.db.listLiveWorkers().map((w) => w.id);
  check("(1) a role-less child WITH a manager parent is now returned by listLiveWorkers", ids.includes("rl-1"));
  check("(1) a role-less, PARENTLESS standalone session is still excluded", !ids.includes("standalone-1"));
  cleanup(e);
}

// ============ (2) BusyWorkerWatcher's long-turn advisory now covers a role-less busy child ============
{
  const e = makeEnv();
  seedManager(e, "mgr-2");
  seedRoleLessWorker(e, "rl-2", "mgr-2", { busy: true, idleMin: 65, taskId: null }); // busy 65m in one turn
  e.busyWatcher.tick(NOW);
  check("(2) a role-less child busy 65m in one turn now fires the SAME worker_stuck advisory a role='worker' child gets", stuckEvents(e, "rl-2").length === 1);
  check("(2) the advisory nudge lands on the owning manager", e.enqueued.some((x) => x.id === "mgr-2" && /worker-busy-long/.test(x.text)));
  cleanup(e);
}

// ============ (3) notifyManagerOfIdleWorker — role-less + taskless, DID start a turn, NEVER reported ============
// This is the exact scenario in the bug report: a role-less, taskless consultation session that finished
// its turn but never called worker_report used to get NO nudge at all (blocked by the top-level role
// gate before ever reaching the taskless branch's broken-spawn-only check).
{
  const e = makeEnv();
  seedManager(e, "mgr-3");
  seedRoleLessWorker(e, "rl-3", "mgr-3", { taskId: null, busy: false, engineSessionId: "eng-rl-3" });
  e.sessions.notifyManagerOfIdleWorker("rl-3");
  const nudge = e.enqueued.find((x) => x.id === "mgr-3" && /worker-idle/.test(x.text));
  check("(3) a role-less, taskless, engaged-but-unreported session now DOES get a [loom:worker-idle] nudge", !!nudge);
  check("(3) the nudge says it never called worker_report", !!nudge && /never called worker_report/.test(nudge.text));
  cleanup(e);
}

// ============ (4) notifyManagerOfIdleWorker — role-less + taskless BROKEN-SPAWN still covered ============
{
  const e = makeEnv();
  seedManager(e, "mgr-4");
  seedRoleLessWorker(e, "rl-4", "mgr-4", { taskId: null, busy: false, engineSessionId: null }); // never started a turn
  e.sessions.notifyManagerOfIdleWorker("rl-4");
  const nudge = e.enqueued.find((x) => x.id === "mgr-4" && /worker-spawn-broken/.test(x.text));
  check("(4) a role-less taskless session that never started a turn still gets the broken-spawn nudge", !!nudge);
  cleanup(e);
}

// ============ (5) notifyManagerOfIdleWorker — role-less + TASKED, finished a turn, never reported ============
{
  const e = makeEnv();
  seedManager(e, "mgr-5");
  seedTask(e, "tk-5", "in_progress");
  seedRoleLessWorker(e, "rl-5", "mgr-5", { taskId: "tk-5" });
  e.sessions.notifyManagerOfIdleWorker("rl-5");
  const nudge = e.enqueued.find((x) => x.id === "mgr-5" && /worker-idle/.test(x.text));
  check("(5) a role-less TASKED session is now evaluable by classifyIdleWorker (no longer 'not-evaluable')", !!nudge);
  check("(5) the nudge correctly alleges it did NOT call worker_report", !!nudge && /did NOT call worker_report/.test(nudge.text));
  cleanup(e);
}

// ============ (6) notifyManagerOfIdleWorker — role-less + TASKED + ALREADY reported → no false alarm ============
{
  const e = makeEnv();
  seedManager(e, "mgr-6");
  seedTask(e, "tk-6", "in_progress");
  seedRoleLessWorker(e, "rl-6", "mgr-6", { taskId: "tk-6" });
  await e.sessions.workerReport("rl-6", { status: "progress", summary: "still consulting" });
  e.enqueued.length = 0; // isolate to the notify call below
  e.sessions.notifyManagerOfIdleWorker("rl-6");
  const parkedNudge = e.enqueued.find((x) => x.id === "mgr-6" && /parked awaiting your reply/.test(x.text));
  check("(6) a role-less worker that already reported gets the parked-ack wording, not a false stall alarm", !!parkedNudge);
  cleanup(e);
}

// ============ (7) end-to-end via IdleWatcher.tick — role-less TASKED session, periodic re-nudge path ============
{
  const e = makeEnv();
  seedManager(e, "mgr-7", { idleMin: 60 });
  seedTask(e, "tk-7", "in_progress");
  seedRoleLessWorker(e, "rl-7", "mgr-7", { taskId: "tk-7", idleMin: 60 }); // idle 60m > default idleWorkerMinutes (45)
  e.idleWatcher.tick(NOW);
  const nudge = e.enqueued.find((x) => x.id === "mgr-7" && /worker-idle/.test(x.text));
  check("(7) IdleWatcher's periodic tickIdleWorkers now reaches a role-less TASKED child via the widened listLiveWorkers", !!nudge);
  cleanup(e);
}

// ============ (8) busy/lastActivity tracking is role-agnostic at the db layer ============
// Sanity check that db.setBusy (the mechanism deliverHook's Stop-hook handler drives) treats a role-less
// session identically to any other — no role branch exists there, so a real busy(false) edge always
// updates BOTH fields, regardless of role. This is the piece of the bug's two-fault hypothesis that
// turned out NOT to be independently broken (see the worker_report write-up) — asserted here so a future
// regression that DID special-case role would be caught.
{
  const e = makeEnv();
  seedRoleLessWorker(e, "rl-8", null, { busy: true, idleMin: 30 });
  const before = e.db.getSession("rl-8");
  check("(8) precondition: seeded role-less session starts busy:true", before.busy === true);
  e.db.setBusy("rl-8", false);
  const after = e.db.getSession("rl-8");
  check("(8) db.setBusy(false) flips busy regardless of role", after.busy === false);
  check("(8) db.setBusy also advances lastActivity regardless of role", after.lastActivity !== before.lastActivity);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a role-less (role:null) and/or taskless worker-like session is no longer invisible to busy/idle reconciliation: db.listLiveWorkers() includes a manager-parented role-less child (still excluding a parentless standalone one), BusyWorkerWatcher's long-turn advisory and IdleWatcher's periodic re-nudge both reach it, notifyManagerOfIdleWorker's role gate no longer blocks it (broken-spawn, silent-finish, and parked-ack all correctly classified for both taskless and tasked role-less workers), and db.setBusy/lastActivity were confirmed already role-agnostic at the tracking layer."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
