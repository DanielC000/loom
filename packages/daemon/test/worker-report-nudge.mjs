import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A worker whose turn ends on an in-progress card with no worker_report is nudged ITSELF (kind "warning")
// after WORKER_REPORT_NUDGE_DELAY_MS; the manager-facing [loom:worker-idle] notice stays the fallback.
// Drives the REAL SessionService.handleBusyEdge -> armWorkerReportNudge -> fireWorkerReportNudge path with a
// stub pty. The timer's wiring is observed through the stub's enqueueStdin (an event), never a fixed wait;
// every negative case inspects the armed-timer map or calls the fire step directly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("worker-report-nudge-");
const { Db } = await import("../dist/db.js");
const { SessionService, WORKER_REPORT_NUDGE_DELAY_MS } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const isNudge = (x) => x.id.startsWith("wkr") && /worker-report-reminder/.test(x.text);

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-wrn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `wn-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `wna-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "WRN", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "x", position: 0 });
  const enqueued = [];
  const purged = [];
  const state = { composerDirty: 0, onNudge: null };
  const pty = {
    isAlive: () => true,
    enqueueStdin: (id, text, source, onDeliver, route, kind, questionId) => {
      enqueued.push({ id, text, kind, questionId });
      if (isNudge({ id, text })) state.onNudge?.();
      return { delivered: true };
    },
    getPendingEntries: () => [],
    hasFirstTurnStarted: () => true,
    getComposerDirtyLen: () => state.composerDirty,
    purgeQueuedByQuestionIds: (id, ids) => { purged.push({ id, ids }); return []; },
  };
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  sessions.workerReportNudgeDelayMs = 5;
  const seed = (id, role, extra = {}) => db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role,
    ctxInputTokens: null, ctxTurns: null, model: null, ...extra,
  });
  seed("mgr", "manager");
  const addWorker = (id, taskId = "tk-" + id) => {
    if (taskId) db.insertTask({ id: taskId, projectId: projId, title: "T", body: "", columnKey: "in_progress", position: 0, createdAt: now, updatedAt: now });
    seed(id, "worker", { parentSessionId: "mgr", taskId });
  };
  return { dbFile, db, enqueued, purged, state, sessions, addWorker, seed };
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
const nudges = (e) => e.enqueued.filter(isNudge);
const timers = (e) => e.sessions.workerReportNudgeTimers.size;
// The service's own timer is unref'd (production must not hold the process open), so this ref'd deadline
// keeps the event loop alive until the nudge arrives; it is a failure bound, never a wait for absence.
const nudgeArrived = (e) => new Promise((resolve, reject) => {
  const bound = setTimeout(() => reject(new Error("nudge never arrived")), 10_000);
  e.state.onNudge = () => { clearTimeout(bound); resolve(); };
});

check("delay constant is ~2 min", WORKER_REPORT_NUDGE_DELAY_MS === 120_000);

// (1) unreported worker: real timer fires, nudge goes to the WORKER, kind warning, tagged for purge.
{
  const e = makeEnv(); e.addWorker("wkr1");
  const arrived = nudgeArrived(e);
  e.sessions.handleBusyEdge("wkr1", true);
  e.sessions.handleBusyEdge("wkr1", false);
  check("(1) a timer is armed at turn end", timers(e) === 1);
  await arrived;
  const n = nudges(e);
  check("(1) unreported worker gets exactly one nudge", n.length === 1);
  check("(1) it is kind warning and tagged for purge", n[0]?.kind === "warning" && /^worker-report-nudge:wkr1$/.test(n[0]?.questionId ?? ""));
  check("(1) the manager did not receive it", !e.enqueued.some((x) => x.id === "mgr" && /worker-report-reminder/.test(x.text)));
  cleanup(e);
}

// (2) a worker that already reported this turn gets none (fire step, and timer cancelled by the report).
{
  const e = makeEnv(); e.addWorker("wkr2");
  e.sessions.handleBusyEdge("wkr2", true);
  await e.sessions.workerReport("wkr2", { status: "progress", summary: "midway" });
  e.sessions.handleBusyEdge("wkr2", false);
  e.sessions.fireWorkerReportNudge("wkr2");
  check("(2) reported-this-turn worker gets no nudge", nudges(e).length === 0);
  e.sessions.handleBusyEdge("wkr2", true);
  e.sessions.handleBusyEdge("wkr2", false);
  check("(2) timer armed after a later unreported turn end", timers(e) === 1);
  await e.sessions.workerReport("wkr2", { status: "done", summary: "x" });
  check("(2) a worker_report cancels the pending timer", timers(e) === 0);
  check("(2) and purges any queued copy by its tag", e.purged.some((p) => p.id === "wkr2" && p.ids[0] === "worker-report-nudge:wkr2"));
  cleanup(e);
}

// (3) exemptions single-sourced through classifyIdleWorker: parked-ack (reported progress, no manager reply).
{
  const e = makeEnv(); e.addWorker("wkr3");
  await e.sessions.workerReport("wkr3", { status: "blocked", summary: "need decision", needs: "x" });
  // The blocked report predates this turn (turn start pinned in the future), so ONLY the classifyIdleWorker
  // exemption (parked-ack) can suppress the nudge here, not the report-since-turn-start check.
  e.sessions.workerTurnStartedAtMs.set("wkr3", Date.now() + 60_000);
  e.sessions.fireWorkerReportNudge("wkr3");
  check("(3) a worker parked after a blocked report (no manager reply) gets no nudge", nudges(e).length === 0);
  cleanup(e);
}

// (4) exactly once per episode; manager direction re-opens it.
{
  const e = makeEnv(); e.addWorker("wkr4");
  e.sessions.fireWorkerReportNudge("wkr4");
  e.sessions.fireWorkerReportNudge("wkr4");
  check("(4) a second turn end without a report does not nudge again", nudges(e).length === 1);
  e.db.appendEvent({ id: "ev-dir", ts: new Date(Date.now() + 1000).toISOString(), managerSessionId: "mgr", workerSessionId: "wkr4", taskId: "tk-wkr4", kind: "message_worker", detail: {} });
  e.sessions.fireWorkerReportNudge("wkr4");
  check("(4) fresh manager direction re-opens the episode (one more nudge)", nudges(e).length === 2);
  cleanup(e);
}

// (5) composer dirty: never write; nothing recorded as nudged, so a later clean turn end still nudges.
{
  const e = makeEnv(); e.addWorker("wkr5");
  e.state.composerDirty = 12;
  e.sessions.fireWorkerReportNudge("wkr5");
  check("(5) dirty composer => no nudge", nudges(e).length === 0);
  e.state.composerDirty = 0;
  e.sessions.fireWorkerReportNudge("wkr5");
  check("(5) clean composer afterwards => nudged (dirty attempt did not burn the episode)", nudges(e).length === 1);
  cleanup(e);
}

// (6) a new turn cancels the timer; a busy worker and taskless / non-worker rows are never nudged.
{
  const e = makeEnv(); e.addWorker("wkr6");
  e.sessions.handleBusyEdge("wkr6", false);
  check("(6) armed", timers(e) === 1);
  e.sessions.handleBusyEdge("wkr6", true);
  check("(6) the worker's next turn cancels it", timers(e) === 0);
  e.addWorker("wkr6b", null);
  e.sessions.handleBusyEdge("wkr6b", false);
  check("(6) a taskless worker arms nothing", timers(e) === 0);
  e.sessions.handleBusyEdge("mgr", false);
  check("(6) a manager arms nothing", timers(e) === 0);
  cleanup(e);
}

// (7) fire-time refusals: each row state is NOT nudged, and the same worker IS nudged once the state is
// lifted (the positive control proves the refusal is the state's doing, not a broken harness).
{
  const cases = [
    ["archived", (e, id) => e.db.archiveSession(id), null],
    ["exited", (e, id) => e.db.setProcessState(id, "exited"), (e, id) => e.db.setProcessState(id, "live")],
    ["busy", (e, id) => e.db.setBusy(id, true), (e, id) => e.db.setBusy(id, false)],
    ["rate-limited", (e, id) => e.db.setRateLimitedUntil(id, new Date(Date.now() + 3_600_000).toISOString(), "rl"), (e, id) => e.db.setRateLimitedUntil(id, null, null)],
    ["context-exhausted", (e, id) => e.db.setContextExhausted(id, new Date().toISOString(), "exhausted"), (e, id) => e.db.setContextExhausted(id, null, null)],
  ];
  for (const [name, apply, lift] of cases) {
    const e = makeEnv(); const id = "wkr7" + name.replace(/\W/g, "");
    e.addWorker(id);
    apply(e, id);
    const applied = name === "archived" ? !!e.db.getSession(id).archivedAt
      : name === "exited" ? e.db.getSession(id).processState === "exited"
      : name === "busy" ? !!e.db.getSession(id).busy
      : name === "rate-limited" ? e.db.getSession(id).rateLimitedUntil != null
      : e.db.getSession(id).contextExhaustedAt != null;
    check(`(7) ${name}: the state was really applied to the row`, applied);
    e.sessions.fireWorkerReportNudge(id);
    check(`(7) ${name} worker is NOT nudged`, nudges(e).length === 0);
    if (lift) {
      lift(e, id);
      e.sessions.fireWorkerReportNudge(id);
      check(`(7) ${name}: control — same worker IS nudged once the state is lifted`, nudges(e).length === 1);
    }
    cleanup(e);
  }
}

// (8) the retire/recycle/exit sites clear the nudge timer through its OWN clear, and re-arming or clearing
// a kickoff recheck neither cancels nor is cancelled by it (decoupled).
{
  const e = makeEnv(); e.addWorker("wkr8");
  e.sessions.handleBusyEdge("wkr8", false);
  e.sessions.clearKickoffConfirmRecheckTimer("wkr8");
  check("(8) clearing a kickoff recheck does NOT cancel the report nudge", timers(e) === 1);
  e.sessions.clearWorkerReportNudgeTimer("wkr8");
  check("(8) the explicit clear cancels it", timers(e) === 0);
  e.sessions.handleBusyEdge("wkr8", false);
  e.sessions.archiveOnExit(e.db.getSession("wkr8"));
  check("(8) the exit path (archiveOnExit) cancels it", timers(e) === 0);
  cleanup(e);
}

// (9) a held reminder is NOT carried onto a recycle successor (its tag names the OLD id, so the successor's
// workerReport purge could never match it); an ordinary held entry is still carried (positive control).
{
  const e = makeEnv(); e.addWorker("wkr9"); e.addWorker("wkr9b");
  const mk = (id, text, questionId) => ({ id, text, source: "system", kind: "warning", questionId, mintedAtWallClock: 1 });
  e.sessions.carryPendingToSuccessor("wkr9", "wkr9b", [
    mk("m1", "[loom:worker-report-reminder] held", "worker-report-nudge:wkr9"),
    mk("m2", "ordinary held nudge", undefined),
  ], []);
  check("(9) the held report reminder is dropped, not forwarded", !e.enqueued.some((x) => x.id === "wkr9b" && /worker-report-reminder/.test(x.text)));
  check("(9) control: an ordinary held entry IS forwarded", e.enqueued.some((x) => x.id === "wkr9b" && x.text === "ordinary held nudge"));
  // the revive direction (dead successor's queue carried back onto the predecessor) uses the same function
  e.sessions.carryPendingToSuccessor("wkr9b", "wkr9", [mk("m3", "[loom:worker-report-reminder] held", "worker-report-nudge:wkr9b")], []);
  check("(9) revive direction: not forwarded either", !e.enqueued.some((x) => x.id === "wkr9" && /worker-report-reminder/.test(x.text)));
  cleanup(e);
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log("\nALL PASS");
