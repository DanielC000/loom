import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Strand backstop regression (incident 22a44352): a worker that reports `done` while its parent manager has
// already EXITED must NOT strand its completed branch. worker_report records a durable
// `worker_report_undelivered` wake trigger, and the CrashRecoveryWatcher bounded-auto-resumes the manager so
// it consumes the report and runs review→gate→merge. Proven HERMETICALLY (no claude, no daemon) — like
// crash-recovery-watcher.mjs: own temp .db, a fake PtyHost, a RECORDING resume stub, tick() driven directly.
//
// Asserts:
//   (1) PARENT EXITED → report orphaned: workerReport(done) returns delivered:false, moves the task → review,
//       records a worker_report event AND a worker_report_undelivered trigger FILED UNDER THE MANAGER; then a
//       single watcher tick AUTO-RESUMES the manager + records the attempt + enqueues a review/merge nudge.
//   (2) PARENT LIVE+IDLE → delivered:true: NO worker_report_undelivered trigger, watcher never resumes.
//   (3) PARENT LIVE+BUSY → delivered:false but QUEUED (processState 'live'): NOT a strand — no trigger.
//   (4) PARENT EXITED but USAGE-LIMIT PARKED: no trigger (the rate-limit watcher owns its resume).
//   (5) CRASH-LOOP SAFETY carries to the new trigger: repeated orphan→re-exit is CAPPED at
//       crashRecoveryMaxAttempts and ESCALATES once (session_recovery_abandoned), never loops past the cap.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { CrashRecoveryWatcher, recordUndeliveredReport } from "../dist/orchestration/crash-recovery-watcher.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Real-time base: the trigger is stamped with new Date() inside workerReport/recordUndeliveredReport, so the
// injected tick clock is anchored at real now+δ — every tick fires AFTER the trigger (correct ordering).
const NOW = new Date();
const STABILITY_MS = 600_000; // large: the exited-at-tick paths never reach the recovery (live) branch anyway
const at = (ms) => new Date(NOW.getTime() + ms);

function makeEnv({ projectConfig = {} } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-orphan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `op-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `oa-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "Orphan", repoPath: projId, vaultPath: projId, config: projectConfig, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  // Fake PtyHost shared by SessionService AND the watcher. enqueueStdin mirrors reality: an idle-LIVE manager
  // takes the turn (delivered:true); an EXITED one delivers to nobody; `forceQueued` simulates a LIVE-but-busy
  // manager whose message is QUEUED (delivered:false WITH a position) — not a strand.
  const enqueued = [];
  let forceQueued = false;
  const pty = {
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      if (!forceQueued && s?.processState === "live") return { delivered: true };
      return { delivered: false, position: 1 };
    },
  };
  // Recording resume stub: marks the session live (mirrors sessions.resume) and records the call.
  const resumes = [];
  const resume = (id) => { resumes.push(id); db.setProcessState(id, "live"); return true; };
  const control = new OrchestrationControl();
  const sessions = new SessionService(db, pty, control);
  const watcher = new CrashRecoveryWatcher({ db, control, pty, resume, stabilityMs: STABILITY_MS });
  return { dbFile, db, projId, agentId, enqueued, resumes, control, sessions, watcher, setForceQueued: (v) => { forceQueued = v; } };
}

function seedSession(e, id, { role = "manager", processState = "exited", engineSessionId = "eng-" + id, resumability = "resumable", parentSessionId = null, taskId = null, branch = null, rateLimitedUntil = null } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId, title: null, cwd: e.projId,
    processState, resumability, busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role,
    parentSessionId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
    worktreePath: null, branch, rateLimitedUntil,
  });
}
function seedTask(e, id) {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey: "in_progress", position: 0, priority: "p2", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
const evKinds = (e, id, kind) => e.db.listEventsForWorker(id).filter((ev) => ev.kind === kind);
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ (1) PARENT EXITED → report orphaned → AUTO-WOKEN ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-1", { role: "manager", processState: "exited" }); // idle-reaped after dispatching its worker
  seedTask(e, "tk-1");
  seedSession(e, "wkr-1", { role: "worker", processState: "live", parentSessionId: "mgr-1", taskId: "tk-1" });

  const res = await e.sessions.workerReport("wkr-1", { status: "done", summary: "WORK-DONE" });
  check("(1) the report reached NOBODY (delivered:false) — the parent had exited", res.reported === true && res.delivered === false);
  check("(1) the task was still moved → review (work is ready, just unconsumed)", e.db.getTask("tk-1").columnKey === "review");
  check("(1) a worker_report event was recorded", evKinds(e, "wkr-1", "worker_report").length === 1);
  const trig = evKinds(e, "mgr-1", "worker_report_undelivered");
  check("(1) a worker_report_undelivered trigger is FILED UNDER THE MANAGER (the resume subject)", trig.length === 1 && trig[0].workerSessionId === "mgr-1");
  check("(1) the trigger carries the reporting worker + task for the audit trail", trig[0].detail?.reportingWorker === "wkr-1" && trig[0].detail?.taskId === "tk-1");

  // The watchdog picks it up: bounded-auto-resume the manager so it runs review→gate→merge.
  e.watcher.tick(at(60_000));
  check("(1) the exited manager is AUTO-RESUMED on the next watcher tick (no human relay)", e.resumes.length === 1 && e.resumes[0] === "mgr-1");
  check("(1) the resume attempt is recorded (shared crash-recovery bound)", evKinds(e, "mgr-1", "session_resume_attempt").length === 1);
  const nudge = e.enqueued.find((x) => x.id === "mgr-1" && /auto-recovered/.test(x.text));
  check("(1) the resumed manager is nudged to review/merge the waiting worker", !!nudge && /worker_list/.test(nudge.text) && /review/.test(nudge.text));
  cleanup(e);
}

// ============================ (2) PARENT LIVE+IDLE → delivered → NO trigger ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-2", { role: "manager", processState: "live" });
  seedTask(e, "tk-2");
  seedSession(e, "wkr-2", { role: "worker", processState: "live", parentSessionId: "mgr-2", taskId: "tk-2" });

  const res = await e.sessions.workerReport("wkr-2", { status: "done", summary: "WORK-DONE" });
  check("(2) a live idle manager RECEIVES the report (delivered:true)", res.delivered === true);
  check("(2) NO worker_report_undelivered trigger when the report was delivered", evKinds(e, "mgr-2", "worker_report_undelivered").length === 0);
  e.watcher.tick(at(60_000));
  check("(2) the watchdog does NOT resume a live, delivered-to manager", e.resumes.length === 0);
  cleanup(e);
}

// ============================ (3) PARENT LIVE+BUSY → queued (not orphaned) → NO trigger ============================
{
  const e = makeEnv();
  e.setForceQueued(true); // simulate the manager mid-turn: the report QUEUES (delivered:false WITH position)
  seedSession(e, "mgr-3", { role: "manager", processState: "live" });
  seedTask(e, "tk-3");
  seedSession(e, "wkr-3", { role: "worker", processState: "live", parentSessionId: "mgr-3", taskId: "tk-3" });

  const res = await e.sessions.workerReport("wkr-3", { status: "done", summary: "WORK-DONE" });
  check("(3) a live-but-busy manager's report is delivered:false BUT queued (drains next turn)", res.delivered === false);
  check("(3) NO trigger for a LIVE manager — its FIFO drains; the gate requires an EXITED manager", evKinds(e, "mgr-3", "worker_report_undelivered").length === 0);
  e.watcher.tick(at(60_000));
  check("(3) the watchdog does NOT resume a still-live manager", e.resumes.length === 0);
  cleanup(e);
}

// ============================ (4) PARENT EXITED but USAGE-LIMIT PARKED → NO trigger ============================
{
  const e = makeEnv();
  const parkUntil = new Date(NOW.getTime() + 3_600_000).toISOString(); // parked 1h out
  seedSession(e, "mgr-4", { role: "manager", processState: "exited", rateLimitedUntil: parkUntil });
  seedTask(e, "tk-4");
  seedSession(e, "wkr-4", { role: "worker", processState: "live", parentSessionId: "mgr-4", taskId: "tk-4" });

  const res = await e.sessions.workerReport("wkr-4", { status: "done", summary: "WORK-DONE" });
  check("(4) report still recorded + task moved (work is ready)", res.delivered === false && e.db.getTask("tk-4").columnKey === "review");
  check("(4) NO trigger for a PARKED manager — the rate-limit watcher owns its resume (don't fight the usage hold)", evKinds(e, "mgr-4", "worker_report_undelivered").length === 0);
  e.watcher.tick(at(60_000));
  check("(4) the watchdog does not early-wake a usage-limit-parked manager", e.resumes.length === 0);
  cleanup(e);
}

// ============================ (5) CRASH-LOOP SAFETY carries to the new trigger ============================
{
  const e = makeEnv(); // default crashRecoveryMaxAttempts = 3
  seedSession(e, "mgr-5", { role: "manager", processState: "exited" });
  // Simulate a manager that re-exits after each resume while reports keep orphaning: 5 rounds, cap is 3.
  for (let i = 1; i <= 5; i++) {
    e.db.setProcessState("mgr-5", "exited");                          // re-exit before the round
    recordUndeliveredReport(e.db, e.db.getSession("mgr-5"), { reportingWorkerId: "wkr-5", taskId: null });
    e.watcher.tick(at(i * 60_000));                                  // resume stub flips it back to live
  }
  check("(5) auto-resume is CAPPED at 3 attempts on the orphan trigger too (never a 4th)", e.resumes.length === 3);
  check("(5) exactly 3 attempt events", evKinds(e, "mgr-5", "session_resume_attempt").length === 3);
  check("(5) after the cap it ESCALATES once (one session_recovery_abandoned), not loops", evKinds(e, "mgr-5", "session_recovery_abandoned").length === 1);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a worker reporting done to a since-EXITED manager records a worker_report_undelivered wake trigger (not when the manager is live-idle, live-busy/queued, or usage-parked); the CrashRecoveryWatcher bounded-auto-resumes the manager to run review→gate→merge — no strand, no human relay — and the crash-loop cap holds on the new trigger."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
