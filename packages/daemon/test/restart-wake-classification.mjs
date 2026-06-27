import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Restart wake cause/impact classification + completion-escalation de-dup (card 5907b71e parts 1 & 2).
// NO claude, NO live daemon — drives SessionService.resumeFleetOnBoot + platformEscalate directly against
// an isolated LOOM_HOME with a claude-free PtyStub. Proves:
//
//   PART 1 — CHEAP NO-OP WAKE. A non-causal routine deploy (triggered by ANOTHER session) that touched
//     nothing of a bystander manager/platform — no workers resumed, no queued I/O replayed, empty board —
//     gets the lightweight "no action needed" FYI, NOT the full "re-check your workers" re-orient. An
//     AFFECTED bystander (live worker / queued I/O / pending board) still gets the full re-check.
//
//   PART 2 — ONE COMPLETION = ONE TURN. When a deploy restart already delivered a SHA to the Lead (in the
//     restart reason), a SEPARATE "X COMPLETE + DEPLOYED" platform_escalate for the SAME SHA suppresses its
//     LIVE [loom:escalation] nudge (the durable board task is STILL filed). An escalation for a SHA the Lead
//     has NOT seen is delivered live (no regression).
//
//   Plus the two PURE helpers (isNoOpManagerWake, extractCommitShas) in isolation.
//
// Run: 1) build daemon, 2) node test/restart-wake-classification.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rwc-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PLATFORM_PROJECT_NAME } = await import("../dist/platform/seed.js");
const { isNoOpManagerWake, extractCommitShas } = await import("../dist/orchestration/restart.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Claude-free pty stub: a resumed pty is not-ready, so every enqueueStdin QUEUES and getPending returns
// the FIFO — exactly what resumeFleetOnBoot's nudges + the escalation nudge land in.
class PtyStub {
  constructor() { this.q = new Map(); }
  enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
  getPending(id) { return [...(this.q.get(id) ?? [])]; }
}

const mkProject = (id, name, reserved = false) => db.insertProject({ id, name, repoPath: `/tmp/${id}`, vaultPath: `/tmp/${id}`, config: {}, createdAt: now, archivedAt: null, reserved });
const mkAgent = (id, projId) => db.insertAgent({ id, projectId: projId, name: "t", startupPrompt: "", position: 0 });
function mkSession(o) {
  db.insertSession({
    id: o.id, projectId: o.projId, agentId: o.agentId, engineSessionId: `eng-${o.id}`,
    title: null, cwd: o.cwd ?? os.tmpdir(), processState: "live", resumability: "unknown",
    busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: o.role ?? null, parentSessionId: o.parentSessionId ?? null,
    taskId: null, worktreePath: null, branch: null,
  });
}
const mkTask = (id, projId, col) => db.insertTask({ id, projectId: projId, title: id, body: "", columnKey: col, position: 1, createdAt: now, updatedAt: now });

const db = new Db();
const pty = new PtyStub();
const sessions = new SessionService(db, pty, new OrchestrationControl());

try {
  // ============================ (0) PURE HELPERS ============================
  check("(0) isNoOpManagerWake: unaffected bystander → true",
    isNoOpManagerWake({ causal: false, liveWorkersResumed: 0, queuedIoReplayed: 0, pendingBoardWork: false }) === true);
  check("(0) isNoOpManagerWake: causal (requester) → false",
    isNoOpManagerWake({ causal: true, liveWorkersResumed: 0, queuedIoReplayed: 0, pendingBoardWork: false }) === false);
  check("(0) isNoOpManagerWake: live workers resumed → false",
    isNoOpManagerWake({ causal: false, liveWorkersResumed: 1, queuedIoReplayed: 0, pendingBoardWork: false }) === false);
  check("(0) isNoOpManagerWake: queued I/O replayed → false",
    isNoOpManagerWake({ causal: false, liveWorkersResumed: 0, queuedIoReplayed: 2, pendingBoardWork: false }) === false);
  check("(0) isNoOpManagerWake: pending board work → false (would strand the queue)",
    isNoOpManagerWake({ causal: false, liveWorkersResumed: 0, queuedIoReplayed: 0, pendingBoardWork: true }) === false);
  check("(0) extractCommitShas: pulls a SHA, lower-cased + de-duped, ignores non-hex words",
    JSON.stringify(extractCommitShas("deploy fix ABC1234f for issue ABC1234f — daemon merged")) === JSON.stringify(["abc1234f"]));
  check("(0) extractCommitShas: no SHA in plain prose → []", extractCommitShas("routine version sync, no hash here").length === 0);

  // ============================ (1) CHEAP NO-OP WAKE vs FULL RE-CHECK ============================
  // home = the reserved "Loom Platform" project with a LIVE Lead (platform). projX = a normal project with
  // a deployer manager (the requester) + a bystander manager (empty board) + an affected manager (live worker).
  const home = `rwc-home-${sfx}`, homeAg = `rwc-home-ag-${sfx}`;
  const projX = `rwc-X-${sfx}`, xAg = `rwc-X-ag-${sfx}`;
  const projY = `rwc-Y-${sfx}`, yAg = `rwc-Y-ag-${sfx}`; // an affected bystander's project (pending board)
  mkProject(home, PLATFORM_PROJECT_NAME, true); mkAgent(homeAg, home);
  mkProject(projX, projX); mkAgent(xAg, projX);
  mkProject(projY, projY); mkAgent(yAg, projY);
  mkTask(`rwc-Y-pending-${sfx}`, projY, "in_progress"); // projY has a PENDING card → its mgr is affected

  const id = {
    lead: `rwc-lead-${sfx}`, deployer: `rwc-deployer-${sfx}`,
    bystander: `rwc-bystander-${sfx}`, affMgr: `rwc-affMgr-${sfx}`, affWkr: `rwc-affWkr-${sfx}`,
    pendMgr: `rwc-pendMgr-${sfx}`,
  };
  mkSession({ id: id.lead, projId: home, agentId: homeAg, role: "platform" });
  mkSession({ id: id.deployer, projId: projX, agentId: xAg, role: "manager" });   // the requester (causal)
  mkSession({ id: id.bystander, projId: projX, agentId: xAg, role: "manager" });  // 0 workers, empty board
  mkSession({ id: id.affMgr, projId: projX, agentId: xAg, role: "manager" });     // has a live worker
  mkSession({ id: id.affWkr, projId: projX, agentId: xAg, role: "worker", parentSessionId: id.affMgr });
  mkSession({ id: id.pendMgr, projId: projY, agentId: yAg, role: "manager" });    // 0 workers, PENDING board

  const SHA = "abc1234f";
  const intent = {
    reason: `deploy fix for escalated issue ${SHA}`, managerSessionId: id.deployer, requestedAt: now,
    resume: [
      { sessionId: id.lead, role: "platform", parentSessionId: null },
      { sessionId: id.deployer, role: "manager", parentSessionId: null },
      { sessionId: id.bystander, role: "manager", parentSessionId: null },
      { sessionId: id.affMgr, role: "manager", parentSessionId: null },
      { sessionId: id.affWkr, role: "worker", parentSessionId: id.affMgr },
      { sessionId: id.pendMgr, role: "manager", parentSessionId: null },
    ],
  };
  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true });
  const q = (i) => pty.getPending(i);

  // The Lead: non-causal, 0 workers, no queued I/O, empty home board → cheap no-op FYI (PART 1).
  check("(1) the Lead (unaffected bystander platform) gets ONE [loom:daemon-restarted] no-op FYI, not a re-check",
    q(id.lead).length === 1 && q(id.lead)[0].includes("[loom:daemon-restarted]") && /no action is needed/i.test(q(id.lead)[0]) && !/re-check your workers/i.test(q(id.lead)[0]));
  check("(1) the bystander manager (empty board, 0 workers) also gets the cheap no-op FYI",
    q(id.bystander).length === 1 && /no action is needed/i.test(q(id.bystander)[0]) && !/re-check your workers/i.test(q(id.bystander)[0]));
  // The affected manager (live worker resumed) → full re-check, with the impact classification.
  check("(1) the affected manager (live worker) gets the FULL re-check nudge with the impact clause",
    q(id.affMgr).length === 1 && /re-check your workers/i.test(q(id.affMgr)[0]) && /live workers were resumed/i.test(q(id.affMgr)[0]) && !/no action is needed/i.test(q(id.affMgr)[0]));
  // A non-causal manager with PENDING board work → full re-check (a no-op would strand it; idle-watcher
  // skips a snoozed/suppressed manager). This is the safety carve-out that survives the reframing.
  check("(1) a non-causal manager with a PENDING board still gets the FULL re-check (no stranding)",
    q(id.pendMgr).length === 1 && /re-check your workers/i.test(q(id.pendMgr)[0]) && /board has pending work/i.test(q(id.pendMgr)[0]) && !/no action is needed/i.test(q(id.pendMgr)[0]));
  // The deploy requester is NEVER short-circuited.
  check("(1) the deploy requester gets the full 'code is live' nudge",
    q(id.deployer).length === 1 && q(id.deployer)[0].includes("now LIVE") && !/no action is needed/i.test(q(id.deployer)[0]));

  // ============================ (2) COMPLETION-ESCALATION DE-DUP ============================
  // The deploy wake already delivered SHA to the Lead. A "COMPLETE + DEPLOYED" escalation for that SAME
  // SHA suppresses its live nudge (one completion = one turn) but STILL files the durable board task.
  const leadTurnsBefore = q(id.lead).length; // 1 (the no-op FYI)
  const dup = sessions.platformEscalate(id.deployer, { title: `Bugfix COMPLETE + DEPLOYED (${SHA})`, detail: `Shipped at ${SHA}.`, severity: "info" });
  check("(2) the duplicate-SHA completion escalation enqueues NO new live turn to the Lead (suppressed)",
    q(id.lead).length === leadTurnsBefore && !q(id.lead).some((m) => m.includes("[loom:escalation]")));
  check("(2) but the durable board task IS still filed on the Platform home",
    db.listTasks(home).some((t) => t.id === dup.taskId && /COMPLETE \+ DEPLOYED/.test(t.title)));
  check("(2) its deliveryStatus is 'boarded' (durably routed, no live turn burned)", dup.deliveryStatus === "boarded");

  // Control: an escalation for a SHA the Lead has NOT seen is delivered LIVE (no regression).
  const fresh = sessions.platformEscalate(id.deployer, { title: "New unrelated regression ff00ee11", detail: "Different issue at ff00ee11.", severity: "high" });
  check("(2) a NEW-SHA escalation IS delivered live to the Lead (legitimate, un-suppressed)",
    q(id.lead).some((m) => m.includes("[loom:escalation]") && m.includes(fresh.taskId)) && fresh.deliveryStatus !== "boarded");
} finally {
  db.close();
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a non-causal routine deploy gives unaffected bystanders a cheap no-op wake (affected/requester still get the full re-check), and a completion escalation for a SHA the deploy wake already delivered is suppressed live yet still durably boarded — one completion = one turn."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
