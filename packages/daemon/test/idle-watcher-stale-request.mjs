import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Stale-owner-Request watchdog test (card 99d41588). Structural twin of idle-watcher.mjs's own hermetic
// shape (its own temp .db per env, dist/* + @loom/shared imports, no daemon, no claude) — kept as its OWN
// file rather than folded into idle-watcher.mjs because this is a DELIBERATELY SEPARATE clock/subject (see
// tickStaleRequests's own doc): a pending question_ask Request going stale, independent of any session's
// idle/suppression state.
//
// Covers: fires exactly once past `orchestration.staleRequestMinutes` (event + `escalated_at` stamped;
// a second tick does not re-fire); silent when under the threshold, disabled (0), answered, or already
// escalated; independent of the asking session's busy/suppressed/policy state (the residual gap card
// 99d41588 exists to close: a manager correctly own-Request-suppressed by cb56cf80/8e87f3b5 never accrues
// an idle-nudge strike, so this is its ONLY path to a human-facing alert); per-project threshold
// resolution; and the deliberate first-tick BURST — N stale pendings escalate as N distinct events on one
// tick, never zero and never coalesced.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { IdleWatcher } from "../dist/orchestration/idle-watcher.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-09-04T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function makeEnv({ projectConfig = {} } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-idle-stale-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `ip-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `it-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "Idle", repoPath: projId, vaultPath: projId, config: projectConfig, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
  };
  const control = new OrchestrationControl();
  const watcher = new IdleWatcher({ db, pty, control, recycleRatio: 0, notifyIdleWorker: () => {}, isWorkerStranded: () => true });
  return { dbFile, db, projId, agentId, alive, enqueued, control, watcher };
}

function seedManager(e, id, { idleMin = 60, busy = false, live = true } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  if (live) e.alive.add(id);
}

// A pending (or otherwise-stated) question, with a controllable `createdAt` age — the axis this whole
// file is about, unlike idle-watcher.mjs's own fixed-`NOW` seedQuestion helper.
function seedQuestion(e, sessionId, { state = "pending", ageMinutes = 0, title = "a decision" } = {}) {
  const id = `q-${Math.random().toString(36).slice(2, 8)}`;
  e.db.insertQuestion({
    id, sessionId, projectId: e.projId, type: "decision", title, body: "",
    options: null, recommendation: null, taskId: null,
    permissionAction: null, permissionScope: null, permissionExpiresAt: null, credentialEnvVar: null,
    provisionTarget: null, provisionConnectionId: null, provisionBindingState: "none",
    state, chosenOption: null, note: null, createdAt: minutesAgo(ageMinutes),
    answeredAt: state !== "pending" ? NOW.toISOString() : null, consumedAt: null,
    cancelledReason: null, cancelledBy: null, cancelledAt: null, escalatedAt: null,
  });
  return id;
}

function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ (1) FIRES exactly once past the threshold ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-stale", { busy: false });
  const qid = seedQuestion(e, "mgr-stale", { ageMinutes: 1440 + 1 }); // 1 minute past the 1440 default
  e.watcher.tick(NOW);
  const escalations = () => e.db.listEvents("mgr-stale").filter((ev) => ev.kind === "request_escalated");
  check("(1) a pending Request 1 minute past the threshold escalates on the first tick", escalations().length === 1);
  check("(1) the event carries the questionId/title/ageMinutes", escalations()[0]?.detail?.questionId === qid
    && escalations()[0]?.detail?.title === "a decision" && escalations()[0]?.detail?.ageMinutes === 1441);
  const q = e.db.getQuestion(qid);
  check("(1) escalated_at is stamped on the question row", typeof q?.escalatedAt === "string");
  check("(1) the escalation is NOT delivered as a stdin nudge (event-only signal, mirrors idle_escalated)", e.enqueued.length === 0);
  // Second tick: escalated_at already set → listStalePendingQuestions no longer returns it → no re-fire.
  e.watcher.tick(NOW);
  check("(1) a second tick does NOT re-escalate the SAME request (fires exactly once)", escalations().length === 1);
  cleanup(e);
}

// ============================ (2) SILENT — under the threshold ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-fresh-request");
  seedQuestion(e, "mgr-fresh-request", { ageMinutes: 60 }); // well under the 1440 default
  e.watcher.tick(NOW);
  check("(2) a pending Request under the threshold does NOT escalate",
    e.db.listEvents("mgr-fresh-request").filter((ev) => ev.kind === "request_escalated").length === 0);
  cleanup(e);
}

// ============================ (3) SILENT — staleRequestMinutes=0 disables the watcher ============================
{
  const e = makeEnv({ projectConfig: { orchestration: { staleRequestMinutes: 0 } } });
  seedManager(e, "mgr-disabled-stale");
  seedQuestion(e, "mgr-disabled-stale", { ageMinutes: 60 * 24 * 30 }); // 30 days — would fire at ANY nonzero threshold
  e.watcher.tick(NOW);
  check("(3) staleRequestMinutes=0 disables the watchdog for that project even for a 30-day-old Request",
    e.db.listEvents("mgr-disabled-stale").filter((ev) => ev.kind === "request_escalated").length === 0);
  cleanup(e);
}

// ============================ (4) SILENT — answered/consumed/cancelled Requests are never scanned ============================
{
  const e = makeEnv();
  seedManager(e, "mgr-answered-old");
  seedQuestion(e, "mgr-answered-old", { state: "answered", ageMinutes: 60 * 24 * 30 });
  seedManager(e, "mgr-cancelled-old");
  seedQuestion(e, "mgr-cancelled-old", { state: "cancelled", ageMinutes: 60 * 24 * 30 });
  e.watcher.tick(NOW);
  check("(4) an ANSWERED Request, however old, never escalates (dropped out of state='pending')",
    e.db.listEvents("mgr-answered-old").filter((ev) => ev.kind === "request_escalated").length === 0);
  check("(4) a CANCELLED Request, however old, never escalates",
    e.db.listEvents("mgr-cancelled-old").filter((ev) => ev.kind === "request_escalated").length === 0);
  cleanup(e);
}

// ==== (5) INDEPENDENT of the asking session's idle/suppression state — the card's own central point ====
// A manager that is BUSY (mid-turn) still has its stale Request escalated: this clock never reads m.busy,
// unlike the idle-nudge loop's own full trigger predicate.
{
  const e = makeEnv();
  seedManager(e, "mgr-busy-with-stale", { busy: true });
  seedQuestion(e, "mgr-busy-with-stale", { ageMinutes: 1440 + 1 });
  e.watcher.tick(NOW);
  check("(5a) a BUSY manager's own stale Request STILL escalates (idle-state-independent)",
    e.db.listEvents("mgr-busy-with-stale").filter((ev) => ev.kind === "request_escalated").length === 1);
  cleanup(e);
}
// A manager already 'suppressed' by the idle-nudge policy (cb56cf80/8e87f3b5's own-Request carve-out —
// the EXACT residual gap this card exists to close: its `unanswered` counter never increments because
// it's never nudged, so it can never reach `idle_escalated` on its own) still has its stale Request
// escalated by this SEPARATE clock.
{
  const e = makeEnv();
  seedManager(e, "mgr-suppressed-with-stale");
  e.db.setIdleNudgePolicy("mgr-suppressed-with-stale", "suppressed");
  const qid = seedQuestion(e, "mgr-suppressed-with-stale", { ageMinutes: 1440 + 1 });
  e.watcher.tick(NOW);
  check("(5b) an idle-nudge-SUPPRESSED manager's own stale Request STILL escalates — the residual gap this card closes",
    e.db.listEvents("mgr-suppressed-with-stale").filter((ev) => ev.kind === "request_escalated").length === 1);
  check("(5b) NO idle_escalated is ALSO fired for it (this is a separate clock, not a fold-in)",
    e.db.listEvents("mgr-suppressed-with-stale").filter((ev) => ev.kind === "idle_escalated").length === 0);
  check("(5b) escalated_at stamped regardless of the session's own idle-nudge policy", typeof e.db.getQuestion(qid)?.escalatedAt === "string");
  cleanup(e);
}
// A manager that's human-PAUSED — the idle-nudge loop's own pause check never runs in tickStaleRequests —
// still has its stale Request escalated (a human decision inbox item is not the same gate as a pause).
{
  const e = makeEnv();
  seedManager(e, "mgr-paused-with-stale");
  seedQuestion(e, "mgr-paused-with-stale", { ageMinutes: 1440 + 1 });
  e.control.pause("mgr-paused-with-stale");
  e.watcher.tick(NOW);
  check("(5c) a human-paused manager's own stale Request STILL escalates (a different gate than idle-nudge pause)",
    e.db.listEvents("mgr-paused-with-stale").filter((ev) => ev.kind === "request_escalated").length === 1);
  cleanup(e);
}

// ============================ (6) per-project threshold resolution ============================
{
  // A project overriding staleRequestMinutes to 60 escalates a 90-minute-old Request; a SIBLING project at
  // the 1440 default does NOT (90 minutes is well under 1440) — proving the threshold resolves per-project.
  const e = makeEnv({ projectConfig: { orchestration: { staleRequestMinutes: 60 } } });
  seedManager(e, "mgr-low-threshold-project");
  seedQuestion(e, "mgr-low-threshold-project", { ageMinutes: 90 });

  const e2 = makeEnv(); // default 1440
  seedManager(e2, "mgr-default-threshold-project");
  seedQuestion(e2, "mgr-default-threshold-project", { ageMinutes: 90 });

  e.watcher.tick(NOW);
  e2.watcher.tick(NOW);
  check("(6) a project with staleRequestMinutes:60 escalates a 90-minute-old Request",
    e.db.listEvents("mgr-low-threshold-project").filter((ev) => ev.kind === "request_escalated").length === 1);
  check("(6) a SIBLING project at the 1440 default does NOT escalate the same 90-minute age",
    e2.db.listEvents("mgr-default-threshold-project").filter((ev) => ev.kind === "request_escalated").length === 0);
  cleanup(e); cleanup(e2);
}

// ==== (7) FIRST-TICK BURST — N stale pendings on one board escalate as N distinct events, not zero, ====
// ==== not coalesced, and a second tick re-fires for none of them (deliberate, per Correction 3) ====
{
  const e = makeEnv();
  seedManager(e, "mgr-burst-a");
  seedManager(e, "mgr-burst-b");
  const qa = seedQuestion(e, "mgr-burst-a", { ageMinutes: 60 * 24 * 11, title: "Linux CI red/green" }); // ~11 days
  const qb = seedQuestion(e, "mgr-burst-a", { ageMinutes: 60 * 24 * 5, title: "the push gap" }); // ~5 days, same session
  const qc = seedQuestion(e, "mgr-burst-b", { ageMinutes: 60 * 24 * 6, title: "memory budget ceiling" }); // different session
  e.watcher.tick(NOW);
  const allEscalations = () => [...e.db.listEvents("mgr-burst-a"), ...e.db.listEvents("mgr-burst-b")]
    .filter((ev) => ev.kind === "request_escalated");
  check("(7) three stale pendings on one tick escalate as exactly THREE distinct events", allEscalations().length === 3);
  const escalatedIds = new Set(allEscalations().map((ev) => ev.detail?.questionId));
  check("(7) all three ORIGINAL request ids are present (one event per request, not coalesced)",
    escalatedIds.has(qa) && escalatedIds.has(qb) && escalatedIds.has(qc));
  e.watcher.tick(NOW);
  check("(7) a second tick re-fires for NONE of them", allEscalations().length === 3);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the stale-owner-Request watchdog (card 99d41588) escalates a pending question_ask " +
    "Request EXACTLY ONCE (one request_escalated event + escalated_at stamped; a second tick never " +
    "re-fires) once it crosses the project's staleRequestMinutes threshold; stays silent under the " +
    "threshold, when disabled (0), or once the Request is answered/consumed/cancelled; fires " +
    "INDEPENDENTLY of the asking session's busy/idle-nudge-suppressed/human-paused state (the residual " +
    "gap left by cb56cf80/8e87f3b5's own-Request idle-nudge suppression); resolves its threshold " +
    "PER-PROJECT; and correctly fires ONE distinct event per stale Request on a first-tick BURST, never " +
    "zero and never coalesced."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
