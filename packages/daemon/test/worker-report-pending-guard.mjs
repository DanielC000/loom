import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_report(done) PENDING-DIRECTION guard test (board card dcb25bd9). In-process: drives
// SessionService.workerReport() directly against an isolated LOOM_HOME with a fake pty — NO claude, NO
// live daemon, NO real git on the happy path (sibling of worker-report-precheck.mjs).
//
// THE GAP IT GUARDS (the real incident): a worker raced to `done` on a SUPERSEDED design and committed it
// BEFORE consuming the manager's queued redirects — "finishing" the wrong thing. Nothing stopped a
// done-report while manager direction was still pending. The guard REFUSES `done` at the source while the
// worker holds UNRESOLVED `from-manager` queued direction, keeping the task in_progress so the worker's
// next turn drains the direction and re-reports.
//
// Proves (all gate on the DURABLE `session_message_queued`/`_delivered` event pair — origin-accurate):
//   (P) PENDING from-manager — an unresolved `session_message_queued` whose sender IS the worker's
//       manager: workerReport(done) REFUSES (reported:false, refused:true, error names the pending
//       direction), the task STAYS in_progress (NOT moved to review), a worker_report_rejected
//       (reason:"pending-direction") event is recorded, and NO worker_report(done) event lands.
//   (A) NONE pending — no queued direction at all: ALLOWED (reported:true), task → review.
//   (R) RESOLVED from-manager — a `session_message_queued` WITH its matching `session_message_delivered`
//       marker (already drained): ALLOWED, task → review (a resolved message must not gate).
//   (X) from-PLATFORM (origin accuracy) — an unresolved queued message whose sender is NOT the worker's
//       manager (platform/cross-tree): ALLOWED, task → review (only MANAGER-origin direction gates).
// The ALLOWED cases use a non-git worktree path so the done-precheck's git step fails SAFE to allow,
// isolating the ONLY differentiator under test: the queued from-manager direction.
// Run: 1) build daemon (pnpm build), 2) node test/worker-report-pending-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wrpg-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();

const db = new Db();
// workerReport's manager notification is the only pty touch on this path; a stub returning {delivered}
// keeps it hermetic (delivered-live ⇒ no boarded strand backstop).
const ptyStub = { enqueueStdin() { return { delivered: true }; } };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (tag) => {
  const c = {
    projId: `wrpg-${tag}-proj-${sfx}`, agentId: `wrpg-${tag}-ag-${sfx}`, taskId: `wrpg-${tag}-task-${sfx}`,
    mgrId: `wrpg-${tag}-mgr-${sfx}`, workerId: `wrpg-${tag}-wkr-${sfx}`,
    repo: path.join(os.tmpdir(), `loom-wrpg-${tag}-repo-${sfx}`),
    worktreePath: path.join(os.tmpdir(), `loom-wrpg-${tag}-wt-${sfx}`),
    branch: `loom/${tag}-${sfx}`,
  };
  return c;
};

function seed(p) {
  // worktreePath EXISTS but is NOT a git repo ⇒ the done-precheck's git step throws and fails SAFE to allow,
  // so the pending-direction guard is the sole gate exercised here.
  fs.mkdirSync(p.repo, { recursive: true });
  fs.mkdirSync(p.worktreePath, { recursive: true });
  db.insertProject({ id: p.projId, name: "WRPG", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "WRPG-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

// Mirror enqueueDurableMessage's persisted shape: a HELD message is a `session_message_queued` event with
// detail {msgId, text, sender}. Optionally append the matching delivered marker to RESOLVE it.
function queueFromManager(p, { sender, resolved = false, text = "[loom:from-manager]\nSTOP — the design changed, redo it" } = {}) {
  const msgId = randomUUID();
  db.appendEvent({
    id: randomUUID(), ts: now,
    managerSessionId: sender, workerSessionId: p.workerId, taskId: p.taskId,
    kind: "session_message_queued", detail: { msgId, text, sender },
  });
  if (resolved) {
    db.appendEvent({
      id: randomUUID(), ts: now,
      managerSessionId: "", workerSessionId: p.workerId, taskId: null,
      kind: "session_message_delivered", detail: { msgId },
    });
  }
  return msgId;
}

const P = mk("p"); // PENDING from-manager → REFUSED
const A = mk("a"); // NONE pending → ALLOWED
const R = mk("r"); // RESOLVED from-manager → ALLOWED
const X = mk("x"); // from-PLATFORM (origin accuracy) → ALLOWED
const RPT = mk("rpt"); // SAME unresolved set refused twice → 2nd refusal is a softer "reconcile" repeat
const FRESH = mk("fresh"); // a NEW instruction lands between two refusals → NOT treated as a repeat
const all = [P, A, R, X, RPT, FRESH];

try {
  // ── (P) PENDING from-manager → REFUSED ────────────────────────────────────────────────────────────
  seed(P);
  queueFromManager(P, { sender: P.mgrId });
  const rP = await sessions.workerReport(P.workerId, { status: "done", summary: "I think I'm done" });
  check("(pending) workerReport → reported:false, refused:true", rP.reported === false && rP.refused === true);
  check("(pending) error mentions the unconsumed manager direction",
    typeof rP.error === "string" && /unresolved|queued|manager/i.test(rP.error) && rP.error.includes("REFUSED"));
  check("(pending) error names the queued instruction TEXT, not just a count (board card 50162e6b)",
    rP.error.includes("STOP — the design changed, redo it"));
  check("(pending) deliveryStatus is 'dropped' (nothing routed)", rP.deliveryStatus === "dropped");
  check("(pending) task STAYS in_progress (NOT moved to review)", db.getTask(P.taskId).columnKey === "in_progress");
  check("(pending) a worker_report_rejected(reason:pending-direction) event recorded",
    db.listEvents(P.mgrId).some((e) => e.kind === "worker_report_rejected" && e.detail && e.detail.reason === "pending-direction"));
  check("(pending) NO worker_report(done) event recorded (the done never landed)",
    !db.listEvents(P.mgrId).some((e) => e.kind === "worker_report" && e.detail && e.detail.status === "done"));

  // ── (A) NONE pending → ALLOWED ─────────────────────────────────────────────────────────────────────
  seed(A);
  const rA = await sessions.workerReport(A.workerId, { status: "done", summary: "done, nothing queued" });
  check("(none) workerReport → reported:true, NOT refused", rA.reported === true && !rA.refused);
  check("(none) task moved to review", db.getTask(A.taskId).columnKey === "review");

  // ── (R) RESOLVED from-manager → ALLOWED ──────────────────────────────────────────────────────────
  seed(R);
  queueFromManager(R, { sender: R.mgrId, resolved: true }); // queued AND delivered ⇒ already drained
  const rR = await sessions.workerReport(R.workerId, { status: "done", summary: "drained the redirect, now done" });
  check("(resolved) workerReport → reported:true, NOT refused (a delivered message must not gate)", rR.reported === true && !rR.refused);
  check("(resolved) task moved to review", db.getTask(R.taskId).columnKey === "review");

  // ── (X) from-PLATFORM (origin accuracy) → ALLOWED ──────────────────────────────────────────────────
  seed(X);
  queueFromManager(X, { sender: "platform", text: "[loom:from-platform]\nFYI cross-tree note" }); // sender ≠ manager
  const rX = await sessions.workerReport(X.workerId, { status: "done", summary: "only a platform note is queued" });
  check("(platform) workerReport → reported:true, NOT refused (only MANAGER-origin direction gates)", rX.reported === true && !rX.refused);
  check("(platform) task moved to review", db.getTask(X.taskId).columnKey === "review");

  // ── (RPT) SAME unresolved set refused twice → 2nd refusal softens to "reconcile", still refused ───
  seed(RPT);
  queueFromManager(RPT, { sender: RPT.mgrId, text: "[loom:from-manager]\nSTOP — reconsider the approach" });
  const rRPT1 = await sessions.workerReport(RPT.workerId, { status: "done", summary: "attempt 1" });
  check("(repeat) 1st refusal names the instruction text", rRPT1.error.includes("STOP — reconsider the approach"));
  check("(repeat) 1st refusal is the standard (non-repeat) wording", !/REFUSED \(again\)/.test(rRPT1.error));
  const rRPT2 = await sessions.workerReport(RPT.workerId, { status: "done", summary: "attempt 2, nothing new arrived" });
  check("(repeat) 2nd refusal on the UNCHANGED set softens to a 'reconcile' repeat",
    /REFUSED \(again\)/.test(rRPT2.error) && /RECONCILE/.test(rRPT2.error));
  check("(repeat) task still stays in_progress (hard guard unchanged)", db.getTask(RPT.taskId).columnKey === "in_progress");
  check("(repeat) the 2nd rejection event records repeat:true",
    db.listEvents(RPT.mgrId).filter((e) => e.kind === "worker_report_rejected" && e.taskId === RPT.taskId).at(-1)?.detail?.repeat === true);

  // ── (FRESH) a NEW instruction lands between two refusals → NOT treated as a repeat ─────────────────
  seed(FRESH);
  queueFromManager(FRESH, { sender: FRESH.mgrId, text: "[loom:from-manager]\nfirst nudge" });
  const rFRESH1 = await sessions.workerReport(FRESH.workerId, { status: "done", summary: "attempt 1" });
  check("(fresh) 1st refusal is standard wording", !/REFUSED \(again\)/.test(rFRESH1.error));
  queueFromManager(FRESH, { sender: FRESH.mgrId, text: "[loom:from-manager]\nSTOP, redo it entirely" }); // a genuinely new redirect lands
  const rFRESH2 = await sessions.workerReport(FRESH.workerId, { status: "done", summary: "attempt 2" });
  check("(fresh) 2nd refusal, with a NEW instruction added, is NOT a repeat",
    !/REFUSED \(again\)/.test(rFRESH2.error) && rFRESH2.error.includes("STOP, redo it entirely"));
  check("(fresh) the 2nd rejection event records repeat:false",
    db.listEvents(FRESH.mgrId).filter((e) => e.kind === "worker_report_rejected" && e.taskId === FRESH.taskId).at(-1)?.detail?.repeat === false);
} finally {
  db.close();
  for (const p of all) {
    try { fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_report(done) pending-direction guard: an unresolved from-manager queued message REFUSES done (task stays in_progress) and names the instruction TEXT; a repeat refusal on the SAME unresolved set softens to a 'reconcile' tone (still refused) while a genuinely NEW instruction keeps the standard wording; none / already-resolved / platform-origin all allow the done through."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
