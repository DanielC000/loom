import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a84e5d67 part 2 — `worker_report(done)`'s pending-direction guard keys on whether each unresolved
// manager-direction row is DELIVERABLE, never on whether its sending manager is still live:
//   (I) IN-LIVE-PENDING — the row is held in the worker's live queue (it will drain): REFUSE, nothing re-driven.
//   (S) STRANDED — the row is durable but NOT in the worker's live queue (the cd390610 shape): it is RE-DRIVEN
//       onto the worker (redriveQueuedMessage) and the done is still REFUSED, the error saying it was
//       re-delivered.
//   (U) UNDELIVERABLE — the re-drive cannot deliver it (worker not live in this process): the done is ACCEPTED
//       with a `[loom:undeliverable-direction]` warning and an `undeliverableDirection` field on the
//       worker_report event; no refusal event.
//   (U2) the same with a LIVE manager — sender liveness is irrelevant to the outcome.
// Each case runs with the sending manager EXITED (I, S, U) so a manager's exit is shown not to change the
// verdict; (U2) flips it to live.
// Run: 1) pnpm build, 2) node test/worker-done-dead-sender-direction.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wddsd-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();
const db = new Db();

// Controllable fake pty: `inLive` is the set of logical ids "held in the worker's live queue"; every
// enqueueStdin is recorded so a test can assert whether a re-drive hit the worker.
const inLive = new Set();
const calls = [];
// Per-worker re-drive result shape: "position" (claude-style held), "codex" (held: {queued:true,
// deliveryState:"queued"} with NO position — PtyHost.enqueueStdinCodex), "silent" (enqueued but the result
// reports nothing — the live queue must be re-checked as the truth). "codex"/"silent" also put the entry in
// the live queue, as the real host does.
const mode = new Map();
const ptyStub = {
  hasPendingLogicalId(_id, logicalId) { return inLive.has(logicalId); },
  enqueueStdin(id, text, _s, _o, _r, _k, _q, _ow, _p, _sn, opts) {
    calls.push({ id, text });
    const m = mode.get(id) ?? "position";
    if (m === "codex") { if (opts?.logicalId) inLive.add(opts.logicalId); return { delivered: false, queued: true, deliveryState: "queued" }; }
    if (m === "silent") { if (opts?.logicalId) inLive.add(opts.logicalId); return { delivered: false, deliveryState: "dropped" }; }
    return { delivered: false, position: 1 }; // held, not delivered
  },
};
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (tag, { mgrState = "exited", workerState = "live" } = {}) => ({
  tag, mgrState, workerState, projId: `wddsd-${tag}-proj-${sfx}`, agentId: `wddsd-${tag}-ag-${sfx}`, taskId: `wddsd-${tag}-task-${sfx}`,
  mgrId: `wddsd-${tag}-mgr-${sfx}`, workerId: `wddsd-${tag}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-wddsd-${tag}-repo-${sfx}`), worktreePath: path.join(os.tmpdir(), `loom-wddsd-${tag}-wt-${sfx}`),
  branch: `loom/${tag}-${sfx}`,
});
function seed(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.mkdirSync(p.worktreePath, { recursive: true }); // exists but not a git repo ⇒ done-precheck fails SAFE to allow
  db.insertProject({ id: p.projId, name: "WDDSD", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "WDDSD-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: p.mgrState, resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: p.workerState, resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}
function queueFromManager(p, text = "[loom:from-manager]\nSTOP — the design changed, redo it", rootMsgId) {
  const msgId = randomUUID();
  db.appendEvent({
    id: randomUUID(), ts: now, managerSessionId: p.mgrId, workerSessionId: p.workerId, taskId: p.taskId,
    kind: "session_message_queued", detail: { msgId, rootMsgId: rootMsgId ?? msgId, text, sender: p.mgrId },
  });
  return msgId;
}
const laterReport = (p, status) => db.appendEvent({
  id: randomUUID(), ts: now, managerSessionId: p.mgrId, workerSessionId: p.workerId, taskId: p.taskId,
  kind: "worker_report", detail: { status, summary: `${status} checkpoint` },
});
const workerCalls = (p) => calls.filter((c) => c.id === p.workerId);
const unresolved = (p) => db.listUnresolvedQueuedMessagesForWorker(p.workerId);

const I = mk("i"), S = mk("s"), U = mk("u", { workerState: "exited" }), U2 = mk("u2", { mgrState: "live", workerState: "exited" });
const C = mk("c"), C2 = mk("c2"), R = mk("r"), P = mk("p"), D = mk("d");
try {
  // ── (C) codex-shaped held re-drive ({queued:true}, no position) → REFUSED, never "stuck"/accepted ─────
  seed(C);
  mode.set(C.workerId, "codex");
  queueFromManager(C);
  const rC = await sessions.workerReport(C.workerId, { status: "done", summary: "done, codex worker with a stranded row" });
  check("(C) a codex-shaped queued re-drive is REFUSED (reEnqueued), not accepted as undeliverable",
    rC.reported === false && rC.refused === true && /RE-DELIVERED/.test(rC.error) && workerCalls(C).length === 1);
  // ── (C2) re-drive result reports nothing but the entry IS in the live queue → the live queue wins ────
  seed(C2);
  mode.set(C2.workerId, "silent");
  queueFromManager(C2);
  const rC2 = await sessions.workerReport(C2.workerId, { status: "done", summary: "done, silent enqueue" });
  check("(C2) a re-drive that reads 'stuck' but lands in the live queue is REFUSED (live queue is the truth)",
    rC2.reported === false && rC2.refused === true);
  // ── (R) rootMsgId ≠ msgId (re-mint/carry shape): matched through the ROOT id held in the live queue ──
  seed(R);
  const rootR = randomUUID();
  queueFromManager(R, undefined, rootR);
  inLive.add(rootR);
  const rR = await sessions.workerReport(R.workerId, { status: "done", summary: "done, remint-shaped row" });
  check("(R) a row whose rootMsgId (not msgId) is in the live queue is REFUSED with no re-drive",
    rR.refused === true && workerCalls(R).length === 0);
  // ── (P) a later PROGRESS report must not retire a stranded direction ─────────────────────────────────
  seed(P);
  queueFromManager(P);
  laterReport(P, "progress");
  const rP = await sessions.workerReport(P.workerId, { status: "done", summary: "done after a progress checkpoint" });
  check("(P) stranded row + a later progress report is still RE-DRIVEN and refused",
    rP.refused === true && /RE-DELIVERED/.test(rP.error) && workerCalls(P).length === 1);
  // ── (D) contrast: a later DONE report DOES retire it → nothing to deliver → accepted ─────────────────
  seed(D);
  queueFromManager(D);
  laterReport(D, "done");
  const rD = await sessions.workerReport(D.workerId, { status: "done", summary: "done again" });
  check("(D) a row already superseded by a later done report is retired, not re-driven (done accepted)",
    rD.reported === true && workerCalls(D).length === 0);

  // ── (I) in the live queue → refuse, no re-drive ────────────────────────────────────────────────────────
  seed(I);
  const msgI = queueFromManager(I);
  inLive.add(msgI);
  const rI = await sessions.workerReport(I.workerId, { status: "done", summary: "done, direction still queued" });
  check("(I) refused (reported:false, refused:true)", rI.reported === false && rI.refused === true);
  check("(I) NOT re-driven (the row is already in the live queue)", workerCalls(I).length === 0);
  check("(I) no RE-DELIVERED claim", !/RE-DELIVERED/.test(rI.error));
  check("(I) task stays in_progress", db.getTask(I.taskId).columnKey === "in_progress");

  // ── (S) stranded → re-driven + refused ─────────────────────────────────────────────────────────────────
  seed(S);
  const msgS = queueFromManager(S);
  const rS = await sessions.workerReport(S.workerId, { status: "done", summary: "done, direction stranded" });
  check("(S) refused (reported:false, refused:true)", rS.reported === false && rS.refused === true);
  check("(S) the stranded row was RE-DRIVEN onto the worker (one enqueue naming the instruction)",
    workerCalls(S).length === 1 && workerCalls(S)[0].text.includes("STOP — the design changed, redo it"));
  check("(S) the error says it was RE-DELIVERED and to end the turn", /RE-DELIVERED/.test(rS.error) && /end this turn/i.test(rS.error));
  check("(S) the row stays unresolved until it actually drains", unresolved(S).some((e) => e.detail?.msgId === msgS));
  check("(S) task stays in_progress", db.getTask(S.taskId).columnKey === "in_progress");
  // Once the re-driven copy is IN the live queue, a retry is a plain in-live-pending refusal (no second re-drive).
  inLive.add(msgS);
  const rS2 = await sessions.workerReport(S.workerId, { status: "done", summary: "done, retry" });
  check("(S) a retry with the copy now in the live queue is refused WITHOUT a second re-drive", rS2.refused === true && workerCalls(S).length === 1);

  // ── (U) undeliverable → accepted with warning + event field ───────────────────────────────────────────
  seed(U);
  const msgU = queueFromManager(U);
  const rU = await sessions.workerReport(U.workerId, { status: "done", summary: "done; the re-drive cannot deliver" });
  check("(U) done ACCEPTED when the re-drive cannot deliver", rU.reported === true && !rU.refused);
  check("(U) task moved to review", db.getTask(U.taskId).columnKey === "review");
  check("(U) no worker_report_rejected event", !db.listEvents(U.mgrId).some((e) => e.kind === "worker_report_rejected"));
  const rptU = db.listEvents(U.mgrId).find((e) => e.kind === "worker_report" && e.detail?.status === "done");
  check("(U) the worker_report event carries undeliverableDirection {count:1, msgIds:[the row]}",
    rptU?.detail?.undeliverableDirection?.count === 1 && rptU.detail.undeliverableDirection.msgIds?.[0] === msgU);
  check("(U) the event warning carries the [loom:undeliverable-direction] note", /\[loom:undeliverable-direction\]/.test(String(rptU?.detail?.warning ?? "")));
  check("(U) nothing was enqueued onto the (not-live) worker", workerCalls(U).length === 0);

  // ── (U2) same verdict with a LIVE manager — sender liveness is not the predicate ──────────────────────
  seed(U2);
  queueFromManager(U2);
  const rU2 = await sessions.workerReport(U2.workerId, { status: "done", summary: "done; live manager, undeliverable row" });
  check("(U2) a LIVE manager does not change the verdict: accepted", rU2.reported === true && !rU2.refused);
} finally {
  db.close();
  for (const p of [I, S, U, U2, C, C2, R, P, D]) {
    try { fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
