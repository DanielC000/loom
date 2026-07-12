import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Restart wake cause/impact classification + completion-escalation de-dup (card 5907b71e parts 1 & 2,
// narrowed by 61cc91c6). NO claude, NO live daemon — drives SessionService.resumeFleetOnBoot +
// platformEscalate directly against an isolated LOOM_HOME with a claude-free PtyStub. Proves:
//
//   PART 1 — SILENT NO-OP WAKE. A non-causal routine deploy (triggered by ANOTHER session) that touched
//     nothing of a bystander manager/platform — no workers resumed, no queued I/O replayed, no unconsumed
//     answer, no STRANDED board work — resumes SILENTLY with ZERO enqueued turns (card b5664b5b Problems
//     A + C1; an enqueue to an idle session is itself a wasted turn). An AFFECTED bystander (live worker /
//     queued I/O / unconsumed answer / stranded board work) still gets the full re-check, and the deploy
//     requester its "code is live" nudge. A standing reviewer (auditor) is gated on busy-at-capture (card
//     b5664b5b Problem B): idle → silent, busy → nudged.
//
//   PART 1b — 61cc91c6's NARROWING of "pending board work" into "STRANDED board work": raw backlog no
//     longer forces the full nudge by itself — only board work NOTHING ELSE will ever re-surface does.
//     A manager with ordinary backlog is silent whether its idle-nudge policy is 'watching' (never
//     idle_report'd — the idle-watcher covers it on its own cadence), 'snoozed' (idle_report('waiting') —
//     self-expires via the SAME ticker), or 'suppressed' via a deliberate idle_report('done') (the
//     manager's own considered judgment — re-litigating it every restart WAS the reported waste). Only
//     'suppressed' reached via the idle-watcher's unanswered-nudge-cap ESCALATION (no natural re-arm — the
//     manager stopped responding, not a deliberate call) still forces the full nudge — better to over-nudge
//     a stuck manager than strand it. A platform/Lead session is NOT covered by IdleWatcher at ALL (it's
//     role='manager'-only, and idle_report itself is a manager-only surface), so a Lead's board work stays
//     a stake UNCONDITIONALLY (today's behavior, unchanged) regardless of any idle-nudge state.
//     REGRESSION GUARD (CR-caught): the 'watching'/'snoozed' silence above is conditioned on the project's
//     idle-watcher ACTUALLY being active (`idleNudgeMinutes > 0`) — a project can set idleNudgeMinutes:0 to
//     disable the watcher entirely, in which case NOTHING re-engages a 'watching'/'snoozed' manager, so
//     board work falls back to the pre-change STRANDED (full re-check) behavior for that project.
//
//   PART 1c — hasUnconsumedAnswer: a session with an ANSWERED, not-yet-question_pull'ed question of its
//     own is a genuinely NEW per-session event distinct from generic board content, so it forces the full
//     nudge even with zero backlog. A merely PENDING (unanswered) question does NOT (nothing to act on yet).
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
  const base = { causal: false, liveWorkersResumed: 0, queuedIoReplayed: 0, hasUnconsumedAnswer: false, strandedBoardWork: false };
  check("(0) isNoOpManagerWake: unaffected bystander → true",
    isNoOpManagerWake(base) === true);
  check("(0) isNoOpManagerWake: causal (requester) → false",
    isNoOpManagerWake({ ...base, causal: true }) === false);
  check("(0) isNoOpManagerWake: live workers resumed → false",
    isNoOpManagerWake({ ...base, liveWorkersResumed: 1 }) === false);
  check("(0) isNoOpManagerWake: queued I/O replayed → false",
    isNoOpManagerWake({ ...base, queuedIoReplayed: 2 }) === false);
  check("(0) isNoOpManagerWake: unconsumed answer → false",
    isNoOpManagerWake({ ...base, hasUnconsumedAnswer: true }) === false);
  check("(0) isNoOpManagerWake: stranded board work → false (would strand the queue)",
    isNoOpManagerWake({ ...base, strandedBoardWork: true }) === false);
  check("(0) extractCommitShas: pulls a SHA, lower-cased + de-duped, ignores non-hex words",
    JSON.stringify(extractCommitShas("deploy fix ABC1234f for issue ABC1234f — daemon merged")) === JSON.stringify(["abc1234f"]));
  check("(0) extractCommitShas: no SHA in plain prose → []", extractCommitShas("routine version sync, no hash here").length === 0);

  // ============================ (1) CHEAP NO-OP WAKE vs FULL RE-CHECK ============================
  // home = the reserved "Loom Platform" project with a LIVE Lead (platform). projX = a normal project with
  // a deployer manager (the requester) + a bystander manager (empty board) + an affected manager (live worker).
  const home = `rwc-home-${sfx}`, homeAg = `rwc-home-ag-${sfx}`;
  const projX = `rwc-X-${sfx}`, xAg = `rwc-X-ag-${sfx}`;
  const projY = `rwc-Y-${sfx}`, yAg = `rwc-Y-ag-${sfx}`; // an affected bystander's project (pending board)
  const projZ = `rwc-Z-${sfx}`, zAg = `rwc-Z-ag-${sfx}`; // an affected platform (Lead) session's project
  const projW = `rwc-W-${sfx}`, wAg = `rwc-W-ag-${sfx}`; // a deferred-only-board manager's project (card 345b1dcc)
  mkProject(home, PLATFORM_PROJECT_NAME, true); mkAgent(homeAg, home);
  mkProject(projX, projX); mkAgent(xAg, projX);
  mkProject(projY, projY); mkAgent(yAg, projY);
  mkProject(projZ, projZ); mkAgent(zAg, projZ);
  mkProject(projW, projW); mkAgent(wAg, projW);
  mkTask(`rwc-Y-pending-${sfx}`, projY, "in_progress"); // projY has a PENDING card → its mgr is affected
  mkTask(`rwc-Z-pending-${sfx}`, projZ, "in_progress"); // projZ has a PENDING card → its Lead is affected
  // projW's ONLY card is `deferred` (the manager's own sequencing marker, card 77d33266) — discounted from
  // the pending-board-work check the SAME as `held`, so its manager must classify unaffected (card 345b1dcc).
  db.insertTask({ id: `rwc-W-deferred-${sfx}`, projectId: projW, title: "sequenced behind other work",
    body: "", columnKey: "in_progress", deferred: true, position: 1, createdAt: now, updatedAt: now });
  // projV resolves idleNudgeMinutes:0 — the watcher is DISABLED for this project entirely
  // (idle-watcher.ts:132 `continue`s before any nudge/snooze-expiry/escalation logic runs), so NOTHING
  // ever re-engages a 'watching'/'snoozed' manager here — the CR-caught regression this test closes.
  const projV = `rwc-V-${sfx}`, vAg = `rwc-V-ag-${sfx}`;
  db.insertProject({ id: projV, name: projV, repoPath: `/tmp/${projV}`, vaultPath: `/tmp/${projV}`,
    config: { orchestration: { idleNudgeMinutes: 0 } }, createdAt: now, archivedAt: null, reserved: false });
  mkAgent(vAg, projV);
  mkTask(`rwc-V-pending-${sfx}`, projV, "in_progress"); // projV has a PENDING card too

  const id = {
    lead: `rwc-lead-${sfx}`, deployer: `rwc-deployer-${sfx}`,
    bystander: `rwc-bystander-${sfx}`, affMgr: `rwc-affMgr-${sfx}`, affWkr: `rwc-affWkr-${sfx}`,
    pendMgr: `rwc-pendMgr-${sfx}`, affLead: `rwc-affLead-${sfx}`, deferredMgr: `rwc-deferredMgr-${sfx}`,
    idleReviewer: `rwc-idleRev-${sfx}`, busyReviewer: `rwc-busyRev-${sfx}`,
    snoozedMgr: `rwc-snoozedMgr-${sfx}`, doneMgr: `rwc-doneMgr-${sfx}`, escalatedMgr: `rwc-escalatedMgr-${sfx}`,
    answerMgr: `rwc-answerMgr-${sfx}`,
    watcherOffMgr: `rwc-watcherOffMgr-${sfx}`, watcherOffSnoozedMgr: `rwc-watcherOffSnoozedMgr-${sfx}`,
  };
  mkSession({ id: id.lead, projId: home, agentId: homeAg, role: "platform" });
  mkSession({ id: id.deployer, projId: projX, agentId: xAg, role: "manager" });   // the requester (causal)
  mkSession({ id: id.bystander, projId: projX, agentId: xAg, role: "manager" });  // 0 workers, empty board
  mkSession({ id: id.affMgr, projId: projX, agentId: xAg, role: "manager" });     // has a live worker
  mkSession({ id: id.affWkr, projId: projX, agentId: xAg, role: "worker", parentSessionId: id.affMgr });
  // 61cc91c6: projY's board has a PENDING card — shared (project-scoped) by every manager below, so each
  // isolates ONE idle-nudge-policy variant against the SAME raw backlog.
  mkSession({ id: id.pendMgr, projId: projY, agentId: yAg, role: "manager" });      // policy 'watching' (never idle_report'd)
  mkSession({ id: id.snoozedMgr, projId: projY, agentId: yAg, role: "manager" });   // policy 'snoozed' (idle_report('waiting'))
  mkSession({ id: id.doneMgr, projId: projY, agentId: yAg, role: "manager" });      // policy 'suppressed' via idle_report('done')
  mkSession({ id: id.escalatedMgr, projId: projY, agentId: yAg, role: "manager" }); // policy 'suppressed' via idle-watcher's cap escalation
  mkSession({ id: id.affLead, projId: projZ, agentId: zAg, role: "platform" });   // 0 workers, PENDING board
  mkSession({ id: id.deferredMgr, projId: projW, agentId: wAg, role: "manager" }); // 0 workers, board is deferred-only
  mkSession({ id: id.answerMgr, projId: projX, agentId: xAg, role: "manager" });  // 0 workers, EMPTY board, unconsumed answer
  // watcherOffMgr / watcherOffSnoozedMgr: same PENDING board as pendMgr/snoozedMgr, but in projV where
  // idleNudgeMinutes=0 (watcher disabled) — NOTHING re-engages either policy here, so BOTH must classify
  // STRANDED (the CR-caught regression: without the idleNudgeMinutes gate these would wrongly go silent).
  mkSession({ id: id.watcherOffMgr, projId: projV, agentId: vAg, role: "manager" });         // policy 'watching', watcher OFF
  mkSession({ id: id.watcherOffSnoozedMgr, projId: projV, agentId: vAg, role: "manager" });   // policy 'snoozed', watcher OFF
  // Two standing reviewers (Platform Auditors) — one IDLE at capture, one BUSY at capture (card b5664b5b
  // Problem B): the idle one must resume SILENTLY (its schedule/wake re-engages it), the busy one is nudged.
  mkSession({ id: id.idleReviewer, projId: home, agentId: homeAg, role: "auditor" });
  mkSession({ id: id.busyReviewer, projId: home, agentId: homeAg, role: "auditor" });

  // snoozedMgr: idle_report('waiting') → policy 'snoozed', self-expires via the idle-watcher's OWN ticker —
  // the restart contributes nothing that ticker wasn't already going to do.
  sessions.recordIdleReport(id.snoozedMgr, "waiting", { minutes: 60 });
  // doneMgr: idle_report('done') → policy 'suppressed', the manager's OWN considered judgment call.
  sessions.recordIdleReport(id.doneMgr, "done");
  // escalatedMgr: mirrors idle-watcher.ts's escalation branch EXACTLY (appendEvent('idle_escalated') THEN
  // setIdleNudgePolicy('suppressed'), WITHOUT resetIdleNudgeState first) — the one policy='suppressed' path
  // with NO natural re-arm, so it must still be classified STRANDED.
  db.appendEvent({ id: `rwc-esc-evt-${sfx}`, ts: now, managerSessionId: id.escalatedMgr, kind: "idle_escalated", detail: { reason: "unanswered_cap", unanswered: 2 } });
  db.setIdleNudgePolicy(id.escalatedMgr, "suppressed");

  // answerMgr: an ANSWERED, not-yet-question_pull'ed question of its own — genuinely new, forces the full
  // nudge even with ZERO backlog (projX has no tasks at all).
  db.insertQuestion({
    id: `rwc-answered-q-${sfx}`, sessionId: id.answerMgr, projectId: projX, type: "decision",
    title: "pick an approach", body: "", state: "answered", chosenOption: "a", createdAt: now, answeredAt: now,
  });

  // watcherOffSnoozedMgr: idle_report('waiting') too, but its project's watcher is disabled — the snooze
  // would self-expire ONLY if idle-watcher.ts's ticker were running for this project, which it never is.
  sessions.recordIdleReport(id.watcherOffSnoozedMgr, "waiting", { minutes: 60 });

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
      { sessionId: id.snoozedMgr, role: "manager", parentSessionId: null },
      { sessionId: id.doneMgr, role: "manager", parentSessionId: null },
      { sessionId: id.escalatedMgr, role: "manager", parentSessionId: null },
      { sessionId: id.affLead, role: "platform", parentSessionId: null },
      { sessionId: id.deferredMgr, role: "manager", parentSessionId: null },
      { sessionId: id.answerMgr, role: "manager", parentSessionId: null },
      { sessionId: id.watcherOffMgr, role: "manager", parentSessionId: null },
      { sessionId: id.watcherOffSnoozedMgr, role: "manager", parentSessionId: null },
      // busy flag mirrors liveFleetResumeSet's capture (omitted ⇒ falsy ⇒ idle).
      { sessionId: id.idleReviewer, role: "auditor", parentSessionId: null, busy: false },
      { sessionId: id.busyReviewer, role: "auditor", parentSessionId: null, busy: true },
    ],
  };
  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true });
  const q = (i) => pty.getPending(i);

  // The Lead: non-causal, 0 workers, no queued I/O, empty home board → SILENT resume, ZERO enqueued turns
  // (card b5664b5b Problems A + C1 — the old "lightweight FYI" enqueue was itself a wasted turn).
  check("(1) the Lead (unaffected bystander platform) resumes SILENTLY — NO enqueued [loom:daemon-restarted] turn",
    q(id.lead).length === 0);
  check("(1) the bystander manager (empty board, 0 workers) also resumes SILENTLY — NO enqueued turn",
    q(id.bystander).length === 0);
  // The affected manager (live worker resumed) → full re-check, with the impact classification.
  check("(1) the affected manager (live worker) gets the FULL re-check nudge with the impact clause",
    q(id.affMgr).length === 1 && /re-check your workers/i.test(q(id.affMgr)[0]) && /live workers were resumed/i.test(q(id.affMgr)[0]) && !/no action is needed/i.test(q(id.affMgr)[0]));
  // 61cc91c6: raw backlog no longer forces the full nudge by itself. A manager whose idle-nudge policy is
  // 'watching' (pendMgr — never idle_report'd) or 'snoozed' (snoozedMgr — idle_report('waiting')) has that
  // SAME backlog independently covered by the idle-watcher's own cadence, restart or not — resumes SILENTLY.
  check("(1) a non-causal manager (policy 'watching') with ordinary backlog now resumes SILENTLY — idle-watcher covers it",
    q(id.pendMgr).length === 0);
  check("(1) a SNOOZED manager (idle_report('waiting')) with the same backlog also resumes SILENTLY — self-expires on its own",
    q(id.snoozedMgr).length === 0);
  // A manager SUPPRESSED via its OWN deliberate idle_report('done') also resumes SILENTLY — re-litigating
  // its own "nothing to do" judgment every restart was exactly the reported waste, not a safety net.
  check("(1) a manager suppressed via idle_report('done') with the same backlog resumes SILENTLY (its own call, not restart's to re-litigate)",
    q(id.doneMgr).length === 0);
  // A manager SUPPRESSED via the idle-watcher's unanswered-cap ESCALATION (it stopped responding, not a
  // deliberate call — no natural re-arm) is the ONE 'suppressed' case that still STRANDS without the
  // restart nudge — it still gets the full re-check. This is the safety carve-out that survives the reframing.
  check("(1) a manager suppressed via the idle-watcher's ESCALATION-CAP still gets the FULL re-check (no stranding)",
    q(id.escalatedMgr).length === 1 && /re-check your workers/i.test(q(id.escalatedMgr)[0]) && /board has pending work/i.test(q(id.escalatedMgr)[0]) && !/no action is needed/i.test(q(id.escalatedMgr)[0]));
  // The manager-shaped "affected" nudge text stays BYTE-IDENTICAL to before the platform split.
  check("(1) the affected manager nudge is the unchanged manager-shaped text (worktrees/orchestrating/workers)",
    q(id.escalatedMgr)[0].includes("your worktrees are intact") &&
    q(id.escalatedMgr)[0].includes("Resume orchestrating from where you left off") &&
    q(id.escalatedMgr)[0].includes("re-check your workers' state; some may have just been resumed too"));
  // A manager with ZERO backlog but a genuinely NEW unconsumed ANSWERED question of its own → full re-check
  // even though its board is empty (distinct from generic board content, so board-work silence doesn't apply).
  check("(1) a non-causal manager with an unconsumed ANSWERED question gets the FULL re-check despite an empty board",
    q(id.answerMgr).length === 1 && /answered question awaiting question_pull/i.test(q(id.answerMgr)[0]) && !/no action is needed/i.test(q(id.answerMgr)[0]));
  // CR-caught regression fix: idleNudgeMinutes:0 (watcher DISABLED for the project) means NOTHING re-engages
  // a 'watching'/'snoozed' manager on its own — the pendMgr/snoozedMgr silence above does NOT hold here, so
  // BOTH policies must fall back to the pre-change STRANDED behavior (the full re-check), same board content.
  check("(1) a 'watching' manager with backlog in an idleNudgeMinutes:0 project gets the FULL re-check (NOT silent — regression guard)",
    q(id.watcherOffMgr).length === 1 && /re-check your workers/i.test(q(id.watcherOffMgr)[0]) && /board has pending work/i.test(q(id.watcherOffMgr)[0]) && !/no action is needed/i.test(q(id.watcherOffMgr)[0]));
  check("(1) a 'snoozed' manager with the same backlog in the same idleNudgeMinutes:0 project ALSO gets the FULL re-check",
    q(id.watcherOffSnoozedMgr).length === 1 && /re-check your workers/i.test(q(id.watcherOffSnoozedMgr)[0]) && /board has pending work/i.test(q(id.watcherOffSnoozedMgr)[0]) && !/no action is needed/i.test(q(id.watcherOffSnoozedMgr)[0]));
  // card 46a961a4: a non-causal PLATFORM (Lead) session with pending board work also gets the FULL re-check,
  // but with LEAD-appropriate text — NO manager/worktree/worker phrasing (a Lead has neither).
  check("(1) an affected platform (Lead) with a PENDING board gets a re-check nudge with the impact clause",
    q(id.affLead).length === 1 && q(id.affLead)[0].includes("[loom:daemon-restarted]") && /board has pending work/i.test(q(id.affLead)[0]) && !/no action is needed/i.test(q(id.affLead)[0]));
  check("(1) the affected Lead nudge re-orients from the board + resume doc, NOT manager/worktree/worker phrasing",
    /re-orient from your home board and your living resume doc/i.test(q(id.affLead)[0]) &&
    !/worktree/i.test(q(id.affLead)[0]) && !/your workers/i.test(q(id.affLead)[0]) && !/orchestrating/i.test(q(id.affLead)[0]));
  // card 345b1dcc: a non-causal manager whose board's ONLY card is `deferred` (manager's own sequencing
  // marker, discounted the same as `held`) resumes SILENTLY — NOT classified affected, same as an empty
  // board. Without the fix this manager would wrongly get the full re-check nudge like pendMgr above.
  check("(1) a non-causal manager with an only-deferred board resumes SILENTLY — NO enqueued turn",
    q(id.deferredMgr).length === 0);
  // The deploy requester is NEVER short-circuited.
  check("(1) the deploy requester gets the full 'code is live' nudge",
    q(id.deployer).length === 1 && q(id.deployer)[0].includes("now LIVE") && !/no action is needed/i.test(q(id.deployer)[0]));
  // Standing-reviewer gate (card b5664b5b Problem B): idle-at-capture → silent; busy-at-capture → nudged.
  check("(1) an IDLE-at-capture standing reviewer resumes SILENTLY — NO enqueued turn",
    q(id.idleReviewer).length === 0);
  check("(1) a BUSY-at-capture standing reviewer still gets the 'continue your work' continuation nudge",
    q(id.busyReviewer).length === 1 && q(id.busyReviewer)[0].includes("[loom:daemon-restarted]") && /continue your/i.test(q(id.busyReviewer)[0]));

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
  ? "\n✅ ALL PASS — a non-causal routine deploy resumes unaffected bystanders SILENTLY (no wasted turn; affected/requester still get the full re-check, an idle standing reviewer is silent while a busy one is nudged), and a completion escalation for a SHA the deploy wake already delivered is suppressed live yet still durably boarded — one completion = one turn."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
