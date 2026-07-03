import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Crash-recovery COORDINATION (board card 289586c7). Two gaps in the same subsystem, both proven
// hermetically (no claude, no daemon) over a real Db + a recording fake PtyHost — like
// worker-exited-without-report.mjs / crash-recovery-watcher.mjs:
//
//   (A) isCrashRecoveryEligible (crash-recovery-watcher.ts): the shared eligibility predicate that lets
//       notifyManagerOfExitedWorker (service.ts) know whether the CrashRecoveryWatcher is about to try to
//       save a given exit. True for a resumable role under the project's attempt cap; false when crash
//       recovery is disabled for the project (crashRecoveryMaxAttempts=0), when the session (or its
//       manager) is human-paused, or once the attempt cap for the current episode is already reached.
//
//   (B) notifyManagerOfExitedWorker no longer fires the definitive "will NOT come back, re-dispatch"
//       nudge for a worker the watchdog is ELIGIBLE to auto-resume — it reworks to a provisional
//       heads-up instead. Only once the worker is NOT eligible (recovery disabled/paused/cap already
//       reached) does the original definitive nudge fire. (Reproduces the race in incident worker
//       a1c71a86: the false "won't come back" landed immediately before three auto-recovery
//       re-confirmation worker_reports from that SAME worker.)
//
//   (C) SessionService.workerReport collapses a byte-identical done/blocked/progress re-report into ONE
//       when a session_resume_attempt happened since the prior identical report (the auto-recovery
//       re-confirmation duplicate, observed 3→1 in the same incident) — no duplicate event, no duplicate
//       manager nudge. A DIFFERING report (new summary) is never deduped, and an identical report with NO
//       resume in between (an ordinary duplicate call) is never deduped either — only the
//       resume-in-between shape collapses.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { isCrashRecoveryEligible } from "../dist/orchestration/crash-recovery-watcher.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date();

function makeEnv({ projectConfig = {} } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-crc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `crcp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `crca-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "CrashCoord", repoPath: projId, vaultPath: projId, config: projectConfig, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  const enqueued = [];
  const pty = {
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      return s?.processState === "live" ? { delivered: true } : { delivered: false, position: 1 };
    },
    getPendingEntries: () => [],
    flushPending: () => [],
    interruptForRedirect: () => {},
  };
  const control = new OrchestrationControl();
  const sessions = new SessionService(db, pty, control);
  return { dbFile, db, projId, agentId, enqueued, sessions, control };
}

function seedSession(e, id, { role = "worker", processState = "exited", engineSessionId = "eng-" + id, resumability = "resumable", parentSessionId = null, taskId = null, branch = null } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId, title: null, cwd: e.projId,
    processState, resumability, busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role,
    parentSessionId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
    worktreePath: null, branch,
  });
}
function seedTask(e, id, columnKey = "in_progress") {
  e.db.insertTask({ id, projectId: e.projId, title: "T-" + id, body: "", columnKey, position: 0, priority: "p2", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
}
// Record a session_resume_attempt (mirrors what the watcher's tick files) at a controlled ts.
function attempt(e, id, attemptNo, ts = new Date()) {
  const s = e.db.getSession(id);
  e.db.appendEvent({
    id: randomUUID(), ts: ts.toISOString(),
    managerSessionId: s.parentSessionId ?? id, workerSessionId: id, taskId: s.taskId ?? null,
    kind: "session_resume_attempt", detail: { attempt: attemptNo, maxAttempts: 3 },
  });
}
const evKinds = (e, id, kind) => e.db.listEventsForWorker(id).filter((ev) => ev.kind === kind);
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ (A) isCrashRecoveryEligible ============================
{
  const e = makeEnv(); // default crashRecoveryMaxAttempts = 3
  seedSession(e, "mgr-a", { role: "manager", processState: "live" });
  seedSession(e, "wkr-a", { role: "worker", parentSessionId: "mgr-a" });
  check("(A) a fresh resumable worker under the cap IS eligible",
    isCrashRecoveryEligible(e.db, e.control, e.db.getSession("wkr-a")) === true);

  const e0 = makeEnv({ projectConfig: { orchestration: { crashRecoveryMaxAttempts: 0 } } });
  seedSession(e0, "wkr-a0", { role: "worker" });
  check("(A) crashRecoveryMaxAttempts=0 (disabled) is NOT eligible",
    isCrashRecoveryEligible(e0.db, e0.control, e0.db.getSession("wkr-a0")) === false);

  const ePause = makeEnv();
  seedSession(ePause, "wkr-ap", { role: "worker" });
  ePause.control.pause("wkr-ap");
  check("(A) a human-paused session is NOT eligible",
    isCrashRecoveryEligible(ePause.db, ePause.control, ePause.db.getSession("wkr-ap")) === false);

  const eCap = makeEnv();
  seedSession(eCap, "wkr-cap", { role: "worker" });
  attempt(eCap, "wkr-cap", 1); attempt(eCap, "wkr-cap", 2); attempt(eCap, "wkr-cap", 3);
  check("(A) at the attempt cap (3 of 3, no reset since) is NOT eligible — the watchdog has given up",
    isCrashRecoveryEligible(eCap.db, eCap.control, eCap.db.getSession("wkr-cap")) === false);

  const eRole = makeEnv();
  seedSession(eRole, "s-plain", { role: null });
  seedSession(eRole, "s-run", { role: "run" });
  check("(A) out-of-scope roles (plain/run) are NOT eligible",
    isCrashRecoveryEligible(eRole.db, eRole.control, eRole.db.getSession("s-plain")) === false &&
    isCrashRecoveryEligible(eRole.db, eRole.control, eRole.db.getSession("s-run")) === false);

  cleanup(e); cleanup(e0); cleanup(ePause); cleanup(eCap); cleanup(eRole);
}

// ============================ (B) notifyManagerOfExitedWorker — reworded while eligible, definitive once not ============================
{
  // Eligible worker (default cap, no prior attempts) → provisional heads-up, NOT "will NOT come back".
  const e = makeEnv();
  seedSession(e, "mgr-b", { role: "manager", processState: "live" });
  seedTask(e, "tk-b");
  seedSession(e, "wkr-b", { role: "worker", parentSessionId: "mgr-b", taskId: "tk-b", branch: "loom/tk-b" });
  e.sessions.notifyManagerOfExitedWorker("wkr-b", false);
  const nudgeB = e.enqueued.find((x) => x.id === "mgr-b" && /worker-exited/.test(x.text));
  check("(B) a durable worker_exited_without_report event is still recorded either way", evKinds(e, "wkr-b", "worker_exited_without_report").length === 1);
  check("(B) an ELIGIBLE worker gets NO 'will NOT come back' nudge", !!nudgeB && !/will NOT come back/.test(nudgeB.text));
  check("(B) instead it gets a provisional auto-resume heads-up", !!nudgeB && /auto-resume/.test(nudgeB.text));
  cleanup(e);

  // NOT eligible (crash recovery disabled for the project) → the original definitive nudge still fires.
  const e2 = makeEnv({ projectConfig: { orchestration: { crashRecoveryMaxAttempts: 0 } } });
  seedSession(e2, "mgr-b2", { role: "manager", processState: "live" });
  seedTask(e2, "tk-b2");
  seedSession(e2, "wkr-b2", { role: "worker", parentSessionId: "mgr-b2", taskId: "tk-b2", branch: "loom/tk-b2" });
  e2.sessions.notifyManagerOfExitedWorker("wkr-b2", false);
  const nudgeB2 = e2.enqueued.find((x) => x.id === "mgr-b2" && /worker-exited/.test(x.text));
  check("(B) a worker crash recovery will NEVER retry (disabled) gets the DEFINITIVE 'will NOT come back' nudge",
    !!nudgeB2 && /will NOT come back/.test(nudgeB2.text) && /re-dispatch|worker_merge/.test(nudgeB2.text));
  cleanup(e2);

  // NOT eligible (attempt cap already reached — the watchdog has already abandoned this episode).
  const e3 = makeEnv();
  seedSession(e3, "mgr-b3", { role: "manager", processState: "live" });
  seedTask(e3, "tk-b3");
  seedSession(e3, "wkr-b3", { role: "worker", parentSessionId: "mgr-b3", taskId: "tk-b3", branch: "loom/tk-b3" });
  attempt(e3, "wkr-b3", 1); attempt(e3, "wkr-b3", 2); attempt(e3, "wkr-b3", 3);
  e3.sessions.notifyManagerOfExitedWorker("wkr-b3", false);
  const nudgeB3 = e3.enqueued.find((x) => x.id === "mgr-b3" && /worker-exited/.test(x.text));
  check("(B) a worker whose recovery episode already hit the cap gets the DEFINITIVE nudge (won't silently omit it)",
    !!nudgeB3 && /will NOT come back/.test(nudgeB3.text));
  cleanup(e3);
}

// ============================ (C) workerReport auto-recovery re-confirmation dedupe (3→1) ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-c", { role: "manager", processState: "live" });
  seedTask(e, "tk-c");
  seedSession(e, "wkr-c", { role: "worker", processState: "live", parentSessionId: "mgr-c", taskId: "tk-c", branch: "loom/tk-c" });

  const r1 = await e.sessions.workerReport("wkr-c", { status: "done", summary: "SAME-DONE" });
  check("(C) the first done report is recorded + delivered normally", r1.reported === true && r1.deliveryStatus === "delivered-live");
  check("(C) exactly one worker_report event after the first call", evKinds(e, "wkr-c", "worker_report").length === 1);

  // Simulate 3 auto-recovery restarts, each followed by the worker re-confirming the SAME done report.
  for (let i = 1; i <= 3; i++) {
    attempt(e, "wkr-c", i);
    const r = await e.sessions.workerReport("wkr-c", { status: "done", summary: "SAME-DONE" });
    check(`(C) re-confirmation #${i} is still ack'd as reported (worker isn't left thinking it failed)`, r.reported === true);
  }
  check("(C) the 3 identical post-recovery re-confirmations collapse — still exactly ONE worker_report event", evKinds(e, "wkr-c", "worker_report").length === 1);
  check("(C) only ONE [loom:worker-report] nudge reached the manager (3→1, not 3 duplicates)",
    e.enqueued.filter((x) => x.id === "mgr-c" && /worker-report/.test(x.text) && /SAME-DONE/.test(x.text)).length === 1);

  // A DIFFERING report after a resume is never deduped — it's new information.
  attempt(e, "wkr-c", 4);
  const rDiff = await e.sessions.workerReport("wkr-c", { status: "done", summary: "DIFFERENT-DONE" });
  check("(C) a DIFFERING report after a resume is NOT deduped — recorded as new", rDiff.reported === true && evKinds(e, "wkr-c", "worker_report").length === 2);

  cleanup(e);

  // An identical report with NO resume attempt in between is an ordinary duplicate call — NOT deduped
  // (dedupe only fires on the specific auto-recovery re-confirmation shape).
  const e2 = makeEnv();
  seedSession(e2, "mgr-c2", { role: "manager", processState: "live" });
  seedTask(e2, "tk-c2");
  seedSession(e2, "wkr-c2", { role: "worker", processState: "live", parentSessionId: "mgr-c2", taskId: "tk-c2", branch: "loom/tk-c2" });
  await e2.sessions.workerReport("wkr-c2", { status: "progress", summary: "STILL WORKING" });
  await e2.sessions.workerReport("wkr-c2", { status: "progress", summary: "STILL WORKING" });
  check("(C) an identical report with NO resume attempt in between is NOT deduped (ordinary duplicate call)",
    evKinds(e2, "wkr-c2", "worker_report").length === 2);
  cleanup(e2);

  // NEW manager direction (worker_message) landing between the prior report and the identical re-report
  // must NOT be swallowed by the dedupe (task 0b795bf4, the strand this subsystem exists to prevent):
  // report done → manager sends worker_message → worker crashes → auto-resume → worker re-reports the
  // SAME "done" text → the re-report must be delivered, not dropped.
  const e3 = makeEnv();
  seedSession(e3, "mgr-c3", { role: "manager", processState: "live" });
  seedTask(e3, "tk-c3");
  seedSession(e3, "wkr-c3", { role: "worker", processState: "live", parentSessionId: "mgr-c3", taskId: "tk-c3", branch: "loom/tk-c3" });

  const r1c3 = await e3.sessions.workerReport("wkr-c3", { status: "done", summary: "SAME-DONE" });
  check("(C) [new-direction case] the first done report is recorded + delivered normally", r1c3.reported === true && r1c3.deliveryStatus === "delivered-live");

  e3.sessions.messageWorker("mgr-c3", "wkr-c3", "new instructions before you finish");
  attempt(e3, "wkr-c3", 1);
  const r2c3 = await e3.sessions.workerReport("wkr-c3", { status: "done", summary: "SAME-DONE" });
  check("(C) an identical re-report is NOT deduped when a worker_message landed in between — it's delivered",
    r2c3.reported === true && r2c3.deliveryStatus !== "dropped");
  check("(C) the re-report after new direction IS recorded as a second worker_report event",
    evKinds(e3, "wkr-c3", "worker_report").length === 2);
  cleanup(e3);

  // Same shape but with redirectWorker (the "land it NOW" escalation) as the intervening direction.
  const e4 = makeEnv();
  seedSession(e4, "mgr-c4", { role: "manager", processState: "live" });
  seedTask(e4, "tk-c4");
  seedSession(e4, "wkr-c4", { role: "worker", processState: "live", parentSessionId: "mgr-c4", taskId: "tk-c4", branch: "loom/tk-c4" });

  const r1c4 = await e4.sessions.workerReport("wkr-c4", { status: "done", summary: "SAME-DONE" });
  check("(C) [redirect case] the first done report is recorded + delivered normally", r1c4.reported === true && r1c4.deliveryStatus === "delivered-live");

  e4.sessions.redirectWorker("mgr-c4", "wkr-c4", "land this differently now");
  attempt(e4, "wkr-c4", 1);
  const r2c4 = await e4.sessions.workerReport("wkr-c4", { status: "done", summary: "SAME-DONE" });
  check("(C) an identical re-report is NOT deduped when a worker_redirect landed in between — it's delivered",
    r2c4.reported === true && r2c4.deliveryStatus !== "dropped");
  check("(C) the re-report after a redirect IS recorded as a second worker_report event",
    evKinds(e4, "wkr-c4", "worker_report").length === 2);
  cleanup(e4);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — isCrashRecoveryEligible mirrors the watchdog's own gates (role/config/pause/attempt-cap); notifyManagerOfExitedWorker no longer contradicts an in-flight auto-recovery (reworded while eligible, definitive only once the watchdog has genuinely given up); and workerReport collapses the auto-recovery re-confirmation duplicate (3→1) while never deduping genuinely new or ordinary (non-resume-bounded) reports."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
