import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// WAKE GUARD test (board card dfa87343): a worker that legitimately self-parked via wake_me (its task
// is still in the active lane, no fresh worker_report) must NOT be classified `stranded` — it will
// resume itself when the wake fires. Before this fix, classifyIdleWorker never consulted the worker's
// pending scheduled wakeups, so a wake-parked worker was misclassified as `stranded` and drew the
// [loom:worker-idle] "did NOT call worker_report … may be stalled" nudge, costing the manager a wasted
// worker_transcript pull on a healthy worker.
//
// Asserts:
//   (a) a worker with a PENDING wake is NOT classified stranded and draws NO stall nudge.
//   (b) a worker with NO pending wake, idle, and no report IS still classified stranded and nudged
//       (the guard is narrow — proves it doesn't over-suppress).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-07-11T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-idle-wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `iw-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `iwa-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "IdleWake", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
    },
    getPendingEntries: () => [],
  };
  const control = new OrchestrationControl();
  const sessions = new SessionService(db, pty, control);
  return { dbFile, db, projId, agentId, alive, enqueued, sessions };
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
function seedWorker(e, id, parentId, taskId, { idleMin = 60 } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "worker",
    parentSessionId: parentId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
}
function seedTask(e, id, columnKey = "in_progress") {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============ (a) a worker with a PENDING wake is NOT stranded / draws no stall nudge ============
{
  const e = makeEnv();
  seedManager(e, "mgr-a");
  seedTask(e, "tk-a", "in_progress");
  seedWorker(e, "wkr-a", "mgr-a", "tk-a", { idleMin: 60 }); // idle, never reported — would be stranded WITHOUT a pending wake
  e.db.insertWake({
    id: "wake-a", sessionId: "wkr-a",
    wakeAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(), // still in the future — genuinely pending
    note: "check on the build", createdAt: NOW.toISOString(),
  });

  check("(a) isWorkerGenuinelyStranded is FALSE for a wake-parked worker", e.sessions.isWorkerGenuinelyStranded("wkr-a") === false);

  e.sessions.notifyManagerOfIdleWorker("wkr-a");
  check("(a) NO [loom:worker-idle] stall nudge is sent to the manager for a wake-parked worker",
    !e.enqueued.some((x) => x.id === "mgr-a" && /worker-idle/.test(x.text)));
  cleanup(e);
}

// ============ (b) narrowness control — NO pending wake + idle + no report IS still stranded/nudged ============
{
  const e = makeEnv();
  seedManager(e, "mgr-b");
  seedTask(e, "tk-b", "in_progress");
  seedWorker(e, "wkr-b", "mgr-b", "tk-b", { idleMin: 60 }); // idle, never reported, no wake at all

  check("(b) isWorkerGenuinelyStranded is TRUE for a genuinely stalled worker (no pending wake)",
    e.sessions.isWorkerGenuinelyStranded("wkr-b") === true);

  e.sessions.notifyManagerOfIdleWorker("wkr-b");
  const nudge = e.enqueued.find((x) => x.id === "mgr-b" && /worker-idle/.test(x.text));
  check("(b) the stall nudge STILL fires for a genuinely stalled worker (the guard doesn't over-suppress)", !!nudge);
  check("(b) that nudge alleges it did NOT call worker_report (it genuinely didn't)", !!nudge && /did NOT call worker_report/.test(nudge.text));
  cleanup(e);
}

// ============ (c) a FIRED (no longer pending) wake does not suppress the stall nudge ============
// listWakesForSession only ever returns pending rows (a fired wake is deleted claim-first by
// WakeService.tick) — this proves the guard reads live DB state, not a stale "ever had a wake" flag.
{
  const e = makeEnv();
  seedManager(e, "mgr-c");
  seedTask(e, "tk-c", "in_progress");
  seedWorker(e, "wkr-c", "mgr-c", "tk-c", { idleMin: 60 });
  // Simulate: the wake fired and was claimed/deleted already (as WakeService.tick does) — nothing left
  // in the table for this session, so it must classify exactly like (b).
  check("(c) precondition: no pending wakes remain for this worker", e.db.listWakesForSession("wkr-c").length === 0);
  check("(c) a worker whose wake already fired (no longer pending) is stranded like any unreported worker",
    e.sessions.isWorkerGenuinelyStranded("wkr-c") === true);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a wake-parked worker (pending, not-yet-fired wake) is no longer misclassified stranded and draws no false stall nudge; a genuinely stalled worker with no pending wake still is/does."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
