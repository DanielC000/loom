import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Exited-without-report guard (board card 84151b99). A fast/first worker can EXIT before its
// worker-report ever fires: a pty exit routes through index.ts's onExit hook, NOT the onBusy callback,
// so notifyManagerOfIdleWorker (which fires only on a busy→false EDGE) is never called on exit — the
// manager is left with a silent idle (or nothing) and has to self-rescue via worker_transcript
// (incident: a session, turns 80-86). Recurrence of the strand family but a DISTINCT mechanism: no
// report fires AT ALL (vs. worker_report_undelivered, where a report fired but reached an exited
// manager). The fix: SessionService.notifyManagerOfExitedWorker — called from onExit with the pty's
// `intended` flag — records a DISTINCT, DURABLE `worker_exited_without_report` event + pushes a
// [loom:worker-exited] nudge to the manager whenever an UNEXPECTEDLY-exited worker left its task still
// in_progress (no report). Proven HERMETICALLY (no claude, no daemon) — like worker-report-orphan-wake.mjs:
// own temp .db, a recording fake PtyHost, the method driven directly.
//
// Asserts:
//   (a) FAST EXIT AFTER A REPORT — a worker that calls worker_report(done) (terminal report delivered to
//       its LIVE manager, task → review) and THEN exits yields NO duplicate worker_exited_without_report:
//       the terminal report is preserved and the exit path does not false-positive on it.
//   (b) GENUINE NO REPORT — an unexpectedly-exited worker (intended:false) whose task is STILL in_progress
//       yields a DISTINCT, DURABLE worker_exited_without_report event AND a [loom:worker-exited] nudge to
//       the manager (NOT a silent idle, NOT a plain worker_report); the task is left untouched (the manager
//       decides). Carries the worker's branch for the audit trail.
//   (c) INTENDED STOP — a manager-issued stop (worker_stop / recycle / merge-stop → intended:true) records
//       NOTHING (the manager stopped it on purpose).
//   (d) RECYCLED/SUPERSEDED — a worker with a successor (hasSuccessor) records NOTHING (its successor owns
//       the task; the recycle stop is intended anyway).
//   (e) NON-WORKER / PARENTLESS — a manager (or a parentless/taskless session) exit records NOTHING.
//   (f) REDIRECTWORKER RACE (card 6101d7f7) — notifyManagerOfIdleWorker, driven directly, skips the
//       [loom:worker-idle] nudge when the worker still has direction queued in its pending FIFO (the
//       redirectWorker-on-a-busy-worker race: enqueue then busy-clear, in one tick, before the drain);
//       a worker with NO pending direction still gets the genuine-strand nudge.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-exitnorep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `ep-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ea-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "ExitNoReport", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  // Recording fake PtyHost: an idle-LIVE manager takes the turn (delivered:true); anything else does not.
  const enqueued = [];
  const pendingBySession = new Map();
  const pty = {
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
    },
    getPendingEntries: (id) => pendingBySession.get(id) ?? [],
  };
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  return { dbFile, db, projId, agentId, enqueued, sessions, pendingBySession };
}

function seedSession(e, id, { role = "worker", processState = "exited", parentSessionId = null, taskId = null, branch = null, recycledFrom = null } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState, resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role,
    parentSessionId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
    worktreePath: null, branch, recycledFrom,
  });
}
function seedTask(e, id, columnKey = "in_progress") {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, priority: "p2", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
const evKinds = (e, id, kind) => e.db.listEventsForWorker(id).filter((ev) => ev.kind === kind);

function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ (a) FAST EXIT AFTER A REPORT → terminal report preserved, no dup ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-a", { role: "manager", processState: "live" });
  seedTask(e, "tk-a");
  seedSession(e, "wkr-a", { role: "worker", processState: "live", parentSessionId: "mgr-a", taskId: "tk-a", branch: "loom/tk-a" });

  // The worker reports done — this IS the terminal report. workerReport records + enqueues synchronously,
  // so even an immediate exit right after cannot lose it.
  const res = await e.sessions.workerReport("wkr-a", { status: "done", summary: "FAST-DONE" });
  check("(a) the terminal worker_report reaches the LIVE manager (delivered-live)", res.reported === true && res.deliveryStatus === "delivered-live");
  check("(a) the task moved → review (the report landed)", e.db.getTask("tk-a").columnKey === "review");
  check("(a) the manager actually received the framed worker-report", e.enqueued.some((x) => x.id === "mgr-a" && /worker-report/.test(x.text) && /FAST-DONE/.test(x.text)));

  // Now the worker's pty exits (unexpectedly — intended:false). The exit path must NOT manufacture a
  // bogus exited-without-report: the worker DID report (task is in review, not in_progress).
  e.sessions.notifyManagerOfExitedWorker("wkr-a", false);
  check("(a) NO worker_exited_without_report event — the terminal report already moved the task off in_progress",
    evKinds(e, "wkr-a", "worker_exited_without_report").length === 0);
  check("(a) NO [loom:worker-exited] nudge after a clean reported done", !e.enqueued.some((x) => /worker-exited/.test(x.text)));
  cleanup(e);
}

// ============================ (b) GENUINE NO REPORT → DISTINCT durable event + manager nudge ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-b", { role: "manager", processState: "live" });
  seedTask(e, "tk-b");
  // The worker exited (intended:false) while its task is STILL in_progress — it never called worker_report.
  seedSession(e, "wkr-b", { role: "worker", processState: "exited", parentSessionId: "mgr-b", taskId: "tk-b", branch: "loom/tk-b" });

  e.sessions.notifyManagerOfExitedWorker("wkr-b", false);

  const ev = evKinds(e, "wkr-b", "worker_exited_without_report");
  check("(b) exactly one DISTINCT worker_exited_without_report event is recorded", ev.length === 1);
  check("(b) the event is filed under the manager (managerSessionId) for the audit trail", ev[0]?.managerSessionId === "mgr-b" && ev[0]?.taskId === "tk-b");
  check("(b) the event carries the worker's branch", ev[0]?.detail?.branch === "loom/tk-b");
  check("(b) it is NOT mis-recorded as a plain worker_report", evKinds(e, "wkr-b", "worker_report").length === 0);
  const nudge = e.enqueued.find((x) => x.id === "mgr-b" && /worker-exited/.test(x.text));
  check("(b) a DISTINCT [loom:worker-exited] nudge is pushed to the manager (not a silent idle)", !!nudge);
  check("(b) the nudge says EXITED-without-report and points at transcript/merge/re-dispatch",
    !!nudge && /EXITED/.test(nudge.text) && /worker_transcript/.test(nudge.text) && /worker_merge/.test(nudge.text));
  check("(b) the nudge is NOT the [loom:worker-idle] copy (this is a definitive exit, not a maybe-stalled idle)",
    !!nudge && !/worker-idle/.test(nudge.text));
  check("(b) the task is left untouched (still in_progress) — the manager decides what to do", e.db.getTask("tk-b").columnKey === "in_progress");
  cleanup(e);
}

// ============================ (c) INTENDED STOP → nothing recorded ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-c", { role: "manager", processState: "live" });
  seedTask(e, "tk-c");
  seedSession(e, "wkr-c", { role: "worker", processState: "exited", parentSessionId: "mgr-c", taskId: "tk-c", branch: "loom/tk-c" });

  e.sessions.notifyManagerOfExitedWorker("wkr-c", true); // intended:true = a manager-issued worker_stop/recycle/merge-stop
  check("(c) an INTENDED stop records NO worker_exited_without_report event", evKinds(e, "wkr-c", "worker_exited_without_report").length === 0);
  check("(c) an INTENDED stop pushes NO [loom:worker-exited] nudge", !e.enqueued.some((x) => /worker-exited/.test(x.text)));
  cleanup(e);
}

// ============================ (d) RECYCLED/SUPERSEDED worker → nothing recorded ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-d", { role: "manager", processState: "live" });
  seedTask(e, "tk-d");
  seedSession(e, "wkr-d", { role: "worker", processState: "exited", parentSessionId: "mgr-d", taskId: "tk-d", branch: "loom/tk-d" });
  // A fresh successor recycled FROM wkr-d → hasSuccessor(wkr-d) is true; the successor owns the task.
  seedSession(e, "wkr-d2", { role: "worker", processState: "live", parentSessionId: "mgr-d", taskId: "tk-d", branch: "loom/tk-d", recycledFrom: "wkr-d" });

  e.sessions.notifyManagerOfExitedWorker("wkr-d", false);
  check("(d) a recycled/superseded worker records NOTHING (its successor owns the task)", evKinds(e, "wkr-d", "worker_exited_without_report").length === 0);
  check("(d) a recycled/superseded worker pushes NO nudge", !e.enqueued.some((x) => /worker-exited/.test(x.text)));
  cleanup(e);
}

// ============================ (e) NON-WORKER / PARENTLESS → nothing recorded ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-e", { role: "manager", processState: "exited" }); // a manager exit is not our concern
  seedSession(e, "wkr-orphan", { role: "worker", processState: "exited", parentSessionId: null, taskId: null }); // parentless/taskless

  e.sessions.notifyManagerOfExitedWorker("mgr-e", false);
  e.sessions.notifyManagerOfExitedWorker("wkr-orphan", false);
  check("(e) a manager exit records no worker_exited_without_report", evKinds(e, "mgr-e", "worker_exited_without_report").length === 0);
  check("(e) a parentless/taskless worker records no worker_exited_without_report", evKinds(e, "wkr-orphan", "worker_exited_without_report").length === 0);
  check("(e) no nudges enqueued for either", e.enqueued.length === 0);
  cleanup(e);
}

// ============================ (f) notifyManagerOfIdleWorker: redirectWorker race guard (card 6101d7f7) ============================
// redirectWorker on a BUSY worker enqueues its redirect into live.pending FIRST, then — in the same tick —
// clears busy and drains it. The busy->false clear fires notifyManagerOfIdleWorker SYNCHRONOUSLY, BEFORE
// the drain hands the redirect over, so at that instant the worker looks stranded even though it has
// authoritative direction about to land as its very next turn. Guard: a worker with a non-empty pending
// FIFO is not stranded — skip the [loom:worker-idle] nudge. A genuinely stranded worker (no pending) must
// still nudge.
{
  const e = makeEnv();
  seedSession(e, "mgr-f1", { role: "manager", processState: "live" });
  seedTask(e, "tk-f1");
  seedSession(e, "wkr-f1", { role: "worker", processState: "live", parentSessionId: "mgr-f1", taskId: "tk-f1", branch: "loom/tk-f1" });
  // Simulate the redirectWorker race: a redirect is sitting in the worker's pending FIFO when busy clears.
  e.pendingBySession.set("wkr-f1", [{ id: "m1", text: "[loom:from-manager:redirect]\ndo X instead", source: "system" }]);

  e.sessions.notifyManagerOfIdleWorker("wkr-f1");
  check("(f) NO [loom:worker-idle] nudge when the worker has queued direction about to drain",
    !e.enqueued.some((x) => x.id === "mgr-f1" && /worker-idle/.test(x.text)));

  seedSession(e, "mgr-f2", { role: "manager", processState: "live" });
  seedTask(e, "tk-f2");
  seedSession(e, "wkr-f2", { role: "worker", processState: "live", parentSessionId: "mgr-f2", taskId: "tk-f2", branch: "loom/tk-f2" });
  // No pending direction queued — this IS a genuine strand (ended a turn, did not report, nothing incoming).

  e.sessions.notifyManagerOfIdleWorker("wkr-f2");
  const idleNudge = e.enqueued.find((x) => x.id === "mgr-f2" && /worker-idle/.test(x.text));
  check("(f) a genuinely stranded worker (no pending direction) STILL nudges its manager", !!idleNudge);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a worker that exits without ever calling worker_report (task still in_progress) yields a DISTINCT, durable worker_exited_without_report event + a [loom:worker-exited] manager nudge; a worker that DID report (task moved) yields no duplicate; an intended stop, a recycled/superseded worker, and a non-worker/parentless exit all record nothing; notifyManagerOfIdleWorker skips the nudge when direction is genuinely queued (the redirectWorker race) but still nudges a genuine strand."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
