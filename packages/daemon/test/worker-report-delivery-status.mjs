import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Delivery-status ENUM + parked-parent wake (board card fc9a27d5). worker_report and platform_escalate used
// to return a boolean `delivered` that could not tell a DURABLE QUEUE from a real DROP — the `{delivered:false}`
// ambiguity that, in the live repro, READ like a drop and forced the manager to poll. This replaces the boolean
// with a 4-way DeliveryStatus enum (delivered-live | queued | boarded | dropped), and — for worker_report —
// WAKES a parked/snoozed manager (re-arms its idle policy) so the report actually reaches it instead of only
// flipping awaitingReview. Proven HERMETICALLY (no claude, no daemon): own temp .db, a fake PtyHost that
// mirrors host.ts's three return shapes, SessionService called directly.
//
// Asserts, per the DoD case matrix:
//   worker_report:
//     (A) LIVE + idle parent           → 'delivered-live' (took the turn now)
//     (B) PARKED parent, live + idle    → 'delivered-live' AND the snooze is CLEARED (the wake) — the live repro
//     (C) PARKED parent, live + busy    → 'queued' (held FIFO, drains next turn) AND the snooze is CLEARED
//     (D) OFFLINE/exited parent         → 'boarded' (no live taker, but durably recorded + a wake trigger filed)
//     (E) genuine failure (no parent)   → 'dropped' (reached nobody, nothing will surface it)
//   platform_escalate:
//     (F) LIVE Lead                     → 'delivered-live' (board task + a live heads-up)
//     (G) NO live Lead                  → 'boarded' (the durable board task is the floor — never 'dropped')
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { PLATFORM_PROJECT_NAME } from "../dist/platform/seed.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date();

function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-delivstatus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `dp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `da-${Math.random().toString(36).slice(2, 8)}`;
  const now = NOW.toISOString();
  db.insertProject({ id: projId, name: "Deliv", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  // Fake PtyHost mirroring host.ts's enqueueStdin EXACTLY (the enum mapping depends on these three shapes):
  //   • live-but-busy (`forceQueued`) → HELD FIFO: {delivered:false, position:1}  → 'queued'
  //   • idle-LIVE                    → submitted now: {delivered:true}            → 'delivered-live'
  //   • NOT live (exited / pty gone)  → unreachable, NO position: {delivered:false} → 'boarded'
  const enqueued = [];
  let forceQueued = false;
  const pty = {
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      if (forceQueued) return { delivered: false, position: 1 };
      if (s?.processState === "live") return { delivered: true };
      return { delivered: false };
    },
  };
  const control = new OrchestrationControl();
  const sessions = new SessionService(db, pty, control);
  return { dbFile, db, projId, agentId, enqueued, sessions, setForceQueued: (v) => { forceQueued = v; } };
}

function seedSession(e, id, { role = "manager", processState = "live", parentSessionId = null, taskId = null } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState, resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role,
    parentSessionId, taskId, ctxInputTokens: null, ctxTurns: null, model: null,
    worktreePath: null, branch: null, rateLimitedUntil: null,
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

// ============================ (A) LIVE + idle parent → delivered-live ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-A", { role: "manager", processState: "live" });
  seedTask(e, "tk-A");
  seedSession(e, "wkr-A", { role: "worker", processState: "live", parentSessionId: "mgr-A", taskId: "tk-A" });

  const res = await e.sessions.workerReport("wkr-A", { status: "done", summary: "DONE-A" });
  check("(A) live idle parent → deliveryStatus 'delivered-live'", res.reported === true && res.deliveryStatus === "delivered-live");
  check("(A) the framed report reached the manager", e.enqueued.some((x) => x.id === "mgr-A" && /DONE-A/.test(x.text)));
  check("(A) no boolean `delivered` field leaks (contract replaced)", !("delivered" in res));
  cleanup(e);
}

// ============================ (B) PARKED (snoozed) + live + idle → delivered-live + WAKE ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-B", { role: "manager", processState: "live" });
  seedTask(e, "tk-B");
  seedSession(e, "wkr-B", { role: "worker", processState: "live", parentSessionId: "mgr-B", taskId: "tk-B" });
  // The manager idle_reported `waiting` → snoozed for 1h (the live-repro park).
  const snoozeUntil = new Date(NOW.getTime() + 3_600_000).toISOString();
  e.db.setIdleNudgePolicy("mgr-B", "snoozed", snoozeUntil);
  check("(B) precondition: the parent is snoozed (parked)", e.db.getIdleNudgeState("mgr-B").policy === "snoozed");

  const res = await e.sessions.workerReport("wkr-B", { status: "done", summary: "DONE-B" });
  check("(B) parked live-idle parent still RECEIVES it → 'delivered-live'", res.deliveryStatus === "delivered-live");
  check("(B) the parked parent is WOKEN — idle policy re-armed to 'watching', snooze cleared",
    e.db.getIdleNudgeState("mgr-B").policy === "watching" && e.db.getIdleNudgeState("mgr-B").snoozeUntil === null);
  cleanup(e);
}

// ============================ (C) PARKED (snoozed) + live + BUSY → queued + WAKE ============================
{
  const e = makeEnv();
  e.setForceQueued(true); // simulate the manager mid-turn: the report QUEUES (delivered:false WITH position)
  seedSession(e, "mgr-C", { role: "manager", processState: "live" });
  seedTask(e, "tk-C");
  seedSession(e, "wkr-C", { role: "worker", processState: "live", parentSessionId: "mgr-C", taskId: "tk-C" });
  e.db.setIdleNudgePolicy("mgr-C", "snoozed", new Date(NOW.getTime() + 3_600_000).toISOString());

  const res = await e.sessions.workerReport("wkr-C", { status: "done", summary: "DONE-C" });
  check("(C) parked live-but-busy parent → 'queued' (held FIFO, drains next turn)", res.deliveryStatus === "queued");
  check("(C) the report is in the manager's FIFO (it WILL reach it)", e.enqueued.some((x) => x.id === "mgr-C" && /DONE-C/.test(x.text)));
  check("(C) the parked parent is still WOKEN (snooze cleared) so the idle path re-engages it",
    e.db.getIdleNudgeState("mgr-C").policy === "watching");
  check("(C) NO worker_report_undelivered trigger for a queued (live) parent — its FIFO drains",
    evKinds(e, "mgr-C", "worker_report_undelivered").length === 0);
  cleanup(e);
}

// ============================ (D) OFFLINE/exited parent → boarded + durable wake trigger ============================
{
  const e = makeEnv();
  seedSession(e, "mgr-D", { role: "manager", processState: "exited" }); // idle-reaped after dispatching its worker
  seedTask(e, "tk-D");
  seedSession(e, "wkr-D", { role: "worker", processState: "live", parentSessionId: "mgr-D", taskId: "tk-D" });

  const res = await e.sessions.workerReport("wkr-D", { status: "done", summary: "DONE-D" });
  check("(D) offline/exited parent → 'boarded' (no live taker, durably recorded)", res.deliveryStatus === "boarded");
  check("(D) the task still moved → review (work is ready, just unconsumed)", e.db.getTask("tk-D").columnKey === "review");
  check("(D) a worker_report event is recorded (the durable report)", evKinds(e, "wkr-D", "worker_report").length === 1);
  const trig = evKinds(e, "mgr-D", "worker_report_undelivered");
  check("(D) a worker_report_undelivered wake trigger is filed under the manager (crash-recovery auto-resumes it)",
    trig.length === 1 && trig[0].workerSessionId === "mgr-D");
  cleanup(e);
}

// ============================ (E) genuine failure (parentless worker) → dropped ============================
{
  const e = makeEnv();
  seedTask(e, "tk-E");
  seedSession(e, "wkr-E", { role: "worker", processState: "live", parentSessionId: null, taskId: "tk-E" });

  const res = await e.sessions.workerReport("wkr-E", { status: "done", summary: "DONE-E" });
  check("(E) a parentless worker report → 'dropped' (reached nobody, nothing will surface it)", res.deliveryStatus === "dropped");
  check("(E) nothing was enqueued (no manager to route to)", !e.enqueued.length);
  cleanup(e);
}

// ============================ (F)/(G) platform_escalate enum ============================
{
  const e = makeEnv();
  // The reserved Platform home (the escalation target, resolved by name server-side).
  e.db.insertProject({ id: "pHome", name: PLATFORM_PROJECT_NAME, repoPath: e.projId, vaultPath: e.projId, config: {}, createdAt: NOW.toISOString(), archivedAt: null, reserved: true });
  seedSession(e, "MGR-F", { role: "manager", processState: "live" });

  // (G) first: NO live Lead → the board task is the durable floor → 'boarded'.
  const escNoLead = e.sessions.platformEscalate("MGR-F", { title: "issue-1", detail: "evidence", severity: "low" });
  check("(G) no live Lead → 'boarded' (durable board task, never 'dropped')", escNoLead.deliveryStatus === "boarded");
  check("(G) the escalation task was filed on the reserved Platform home", e.db.getTask(escNoLead.taskId)?.projectId === "pHome");
  check("(G) no boolean `delivered` field leaks (contract replaced)", !("delivered" in escNoLead));

  // (F) now a LIVE Lead session exists → 'delivered-live' (board task + a live heads-up).
  seedSession(e, "PL", { role: "platform", processState: "live" });
  const escLead = e.sessions.platformEscalate("MGR-F", { title: "issue-2", detail: "evidence", severity: "high" });
  check("(F) live Lead → 'delivered-live'", escLead.deliveryStatus === "delivered-live");
  check("(F) the Lead got a [loom:escalation] heads-up", e.enqueued.some((x) => x.id === "PL" && /\[loom:escalation\]/.test(x.text)));
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_report / platform_escalate return the DeliveryStatus enum (delivered-live | queued | boarded | dropped) with the correct value per case; a worker reporting to a PARKED/snoozed manager reaches it AND wakes it (idle snooze cleared); an offline parent is 'boarded' with a durable wake trigger; only a truly unroutable report is 'dropped' — no stale boolean `delivered` remains."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
