import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Direct unit coverage of orchestration/wake-impact.ts (card c9e51581) — the pure, `db`-explicit
// classifier extracted from resumeFleetOnBoot's original inline closures (61cc91c6) so Path A
// (resumeFleetOnBoot), Path B (recoverCrashOrphanedWorkers), and Path C (CrashRecoveryWatcher.tick) can
// all reuse the SAME "does this session actually have a stake" logic. The three resume paths already
// prove this end-to-end (restart-wake-classification.mjs, crash-orphaned-workers.mjs §11,
// crash-recovery-watcher.mjs §11) — this file unit-tests the module itself in isolation, no resume path
// involved, NO claude, NO daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import {
  hasPendingBoardWork, hasUnconsumedAnswer, isEscalatedSuppression, isWatcherActiveForSession,
  strandedBoardWork, computeWakeImpact,
} from "../dist/orchestration/wake-impact.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeEnv({ projectConfig = {} } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-wimp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `wip-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `wia-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "WakeImpact", repoPath: projId, vaultPath: projId, config: projectConfig, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  return { dbFile, db, projId, agentId, now };
}
function seedSession(e, id, { role = "manager", processState = "live" } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: `eng-${id}`, title: null, cwd: e.projId,
    processState, resumability: "resumable", busy: false,
    createdAt: e.now, lastActivity: e.now, lastError: null, role, parentSessionId: null, taskId: null,
    worktreePath: null, branch: null,
  });
}
function seedTask(e, id, columnKey = "in_progress", extra = {}) {
  e.db.insertTask({ id, projectId: e.projId, title: id, body: "", columnKey, position: 0, priority: "p2", createdAt: e.now, updatedAt: e.now, ...extra });
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ hasPendingBoardWork ============================
{
  const e = makeEnv();
  seedSession(e, "m1");
  check("(hasPendingBoardWork) no tasks at all → false", hasPendingBoardWork(e.db, "m1") === false);
  seedTask(e, "t1-held", "in_progress", { held: true });
  check("(hasPendingBoardWork) only a HELD card → false", hasPendingBoardWork(e.db, "m1") === false);
  seedTask(e, "t1-deferred", "in_progress", { deferred: true });
  check("(hasPendingBoardWork) held + deferred cards only → false", hasPendingBoardWork(e.db, "m1") === false);
  seedTask(e, "t1-done", "done");
  check("(hasPendingBoardWork) + a terminal-lane card → still false", hasPendingBoardWork(e.db, "m1") === false);
  seedTask(e, "t1-open");
  check("(hasPendingBoardWork) + one ordinary in_progress card → true", hasPendingBoardWork(e.db, "m1") === true);
  cleanup(e);
}

// ==================== hasPendingBoardWork: excludeFromIdleWatchdog column flag (card ab30768a) ====================
{
  const DROPPED_BOARD = { kanbanColumns: [
    { key: "backlog", label: "Backlog", role: "defaultLanding" },
    { key: "in_progress", label: "In Progress", role: "active" },
    { key: "dropped", label: "Dropped", excludeFromIdleWatchdog: true },
    { key: "done", label: "Done", role: "terminal" },
  ] };
  const e = makeEnv({ projectConfig: DROPPED_BOARD });
  seedSession(e, "m1b");
  check("(hasPendingBoardWork) no tasks → false", hasPendingBoardWork(e.db, "m1b") === false);
  seedTask(e, "t1b-dropped", "dropped");
  check("(hasPendingBoardWork) only a card in an excludeFromIdleWatchdog column → false (discounted)",
    hasPendingBoardWork(e.db, "m1b") === false);
  seedTask(e, "t1b-open", "in_progress");
  check("(hasPendingBoardWork) + an ordinary open card in an UNFLAGGED column → true",
    hasPendingBoardWork(e.db, "m1b") === true);

  // Regression pin: the SAME column key WITHOUT the flag → the card IS counted (unchanged behavior).
  const UNFLAGGED_BOARD = { kanbanColumns: DROPPED_BOARD.kanbanColumns.map((c) => {
    const { excludeFromIdleWatchdog, ...rest } = c;
    return rest;
  }) };
  const e2 = makeEnv({ projectConfig: UNFLAGGED_BOARD });
  seedSession(e2, "m1c");
  seedTask(e2, "t1c-dropped", "dropped");
  check("(hasPendingBoardWork) regression: the SAME column WITHOUT the flag → the card IS counted (true)",
    hasPendingBoardWork(e2.db, "m1c") === true);
  cleanup(e); cleanup(e2);
}

// ============================ hasUnconsumedAnswer ============================
{
  const e = makeEnv();
  seedSession(e, "m2");
  check("(hasUnconsumedAnswer) no questions → false", hasUnconsumedAnswer(e.db, "m2") === false);
  e.db.insertQuestion({ id: `q-pending-${randomUUID()}`, sessionId: "m2", projectId: e.projId, type: "decision", title: "t", body: "", state: "pending", createdAt: e.now });
  check("(hasUnconsumedAnswer) a merely PENDING question → false", hasUnconsumedAnswer(e.db, "m2") === false);
  e.db.insertQuestion({ id: `q-answered-${randomUUID()}`, sessionId: "m2", projectId: e.projId, type: "decision", title: "t", body: "", state: "answered", chosenOption: "a", createdAt: e.now, answeredAt: e.now });
  check("(hasUnconsumedAnswer) an ANSWERED, not-yet-pulled question → true", hasUnconsumedAnswer(e.db, "m2") === true);
  cleanup(e);
}

// ============================ isEscalatedSuppression ============================
{
  const e = makeEnv();
  seedSession(e, "m3");
  check("(isEscalatedSuppression) no idle_escalated event at all → false", isEscalatedSuppression(e.db, "m3") === false);
  e.db.appendEvent({ id: randomUUID(), ts: "2026-01-01T00:00:00.000Z", managerSessionId: "m3", kind: "idle_escalated", detail: {} });
  check("(isEscalatedSuppression) idle_escalated with no later idle_report → true", isEscalatedSuppression(e.db, "m3") === true);
  e.db.appendEvent({ id: randomUUID(), ts: "2026-01-02T00:00:00.000Z", managerSessionId: "m3", kind: "idle_report", detail: {} });
  check("(isEscalatedSuppression) a LATER idle_report resets it → false", isEscalatedSuppression(e.db, "m3") === false);
  e.db.appendEvent({ id: randomUUID(), ts: "2026-01-03T00:00:00.000Z", managerSessionId: "m3", kind: "idle_escalated", detail: {} });
  check("(isEscalatedSuppression) a SUBSEQUENT idle_escalated after that report → true again", isEscalatedSuppression(e.db, "m3") === true);
  cleanup(e);
}

// ============================ isWatcherActiveForSession ============================
{
  const e = makeEnv(); // default config → idleNudgeMinutes defaults to 45 (> 0)
  seedSession(e, "m4");
  check("(isWatcherActiveForSession) default project config (idleNudgeMinutes > 0) → true", isWatcherActiveForSession(e.db, "m4") === true);

  const e0 = makeEnv({ projectConfig: { orchestration: { idleNudgeMinutes: 0 } } });
  seedSession(e0, "m4b");
  check("(isWatcherActiveForSession) idleNudgeMinutes:0 (disabled) → false", isWatcherActiveForSession(e0.db, "m4b") === false);
  cleanup(e); cleanup(e0);
}

// ============================ strandedBoardWork ============================
{
  const e = makeEnv();
  seedSession(e, "m5-empty");
  check("(strandedBoardWork) empty board → false regardless of role/policy", strandedBoardWork(e.db, "m5-empty", "manager") === false);

  seedSession(e, "m5-watching");
  seedTask(e, "t5-watching");
  check("(strandedBoardWork) manager, policy 'watching' (default), watcher ACTIVE → false (idle-watcher covers it)",
    strandedBoardWork(e.db, "m5-watching", "manager") === false);

  const e0 = makeEnv({ projectConfig: { orchestration: { idleNudgeMinutes: 0 } } });
  seedSession(e0, "m5-watchingoff");
  seedTask(e0, "t5-watchingoff");
  check("(strandedBoardWork) manager, policy 'watching', watcher DISABLED for the project → true (nothing re-engages it)",
    strandedBoardWork(e0.db, "m5-watchingoff", "manager") === true);

  seedSession(e, "m5-done");
  seedTask(e, "t5-done-board");
  e.db.setIdleNudgePolicy("m5-done", "suppressed");
  check("(strandedBoardWork) manager suppressed via a deliberate idle_report('done')-shaped policy (no idle_escalated) → false",
    strandedBoardWork(e.db, "m5-done", "manager") === false);

  seedSession(e, "m5-escalated");
  seedTask(e, "t5-escalated-board");
  e.db.appendEvent({ id: randomUUID(), ts: e.now, managerSessionId: "m5-escalated", kind: "idle_escalated", detail: {} });
  e.db.setIdleNudgePolicy("m5-escalated", "suppressed");
  check("(strandedBoardWork) manager suppressed via the ESCALATION cap → true (no natural re-arm)",
    strandedBoardWork(e.db, "m5-escalated", "manager") === true);

  // Platform (Lead) parity (card 98b3725c): a platform session now runs through the EXACT SAME per-policy
  // logic as a manager — no more unconditional-true role carve-out. Mirror every manager case above with
  // role:"platform" to prove the two roles classify identically.
  seedSession(e, "m5-plat-watching", { role: "platform" });
  seedTask(e, "t5-plat-watching");
  check("(strandedBoardWork) platform, policy 'watching' (default), watcher ACTIVE → false (idle-watcher covers it, SAME as a manager)",
    strandedBoardWork(e.db, "m5-plat-watching", "platform") === false);

  seedSession(e0, "m5-plat-watchingoff", { role: "platform" });
  seedTask(e0, "t5-plat-watchingoff");
  check("(strandedBoardWork) platform, policy 'watching', watcher DISABLED for the project → true (nothing re-engages it, SAME as a manager)",
    strandedBoardWork(e0.db, "m5-plat-watchingoff", "platform") === true);

  seedSession(e, "m5-plat-done", { role: "platform" });
  seedTask(e, "t5-plat-done-board");
  e.db.setIdleNudgePolicy("m5-plat-done", "suppressed");
  check("(strandedBoardWork) platform suppressed via a deliberate idle_report('done')-shaped policy → false (SAME as a manager)",
    strandedBoardWork(e.db, "m5-plat-done", "platform") === false);

  seedSession(e, "m5-plat-escalated", { role: "platform" });
  seedTask(e, "t5-plat-escalated-board");
  e.db.appendEvent({ id: randomUUID(), ts: e.now, managerSessionId: "m5-plat-escalated", kind: "idle_escalated", detail: {} });
  e.db.setIdleNudgePolicy("m5-plat-escalated", "suppressed");
  check("(strandedBoardWork) platform suppressed via the ESCALATION cap → true (no natural re-arm, SAME as a manager)",
    strandedBoardWork(e.db, "m5-plat-escalated", "platform") === true);

  cleanup(e); cleanup(e0);
}

// ============================ computeWakeImpact ============================
{
  const e = makeEnv();
  seedSession(e, "m6");
  const impactBare = computeWakeImpact(e.db, "m6", "manager", { causal: true, liveWorkersResumed: 3, queuedIoReplayed: 2 });
  check("(computeWakeImpact) perPath fields pass through UNCHANGED",
    impactBare.causal === true && impactBare.liveWorkersResumed === 3 && impactBare.queuedIoReplayed === 2);
  check("(computeWakeImpact) derived fields default false on a stakeless session",
    impactBare.hasUnconsumedAnswer === false && impactBare.strandedBoardWork === false);

  seedTask(e, "t6");
  e.db.appendEvent({ id: randomUUID(), ts: e.now, managerSessionId: "m6", kind: "idle_escalated", detail: {} });
  e.db.setIdleNudgePolicy("m6", "suppressed");
  const impactStranded = computeWakeImpact(e.db, "m6", "manager", { causal: false, liveWorkersResumed: 0, queuedIoReplayed: 0 });
  check("(computeWakeImpact) strandedBoardWork derives true once the manager's board is genuinely stranded",
    impactStranded.strandedBoardWork === true && impactStranded.causal === false);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — orchestration/wake-impact.ts's extracted classifiers (hasPendingBoardWork, hasUnconsumedAnswer, isEscalatedSuppression, isWatcherActiveForSession, strandedBoardWork, computeWakeImpact) behave correctly in isolation, `db`-explicit and reusable across every resume path (Path A/B/C) without divergence."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
