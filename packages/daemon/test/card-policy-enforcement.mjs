import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9623e943 — card-policy ENFORCEMENT through the real SessionService (real git on a temp repo, stub/fake
// ptys, no claude, no daemon). The pure evaluator is card-policy-evaluator.mjs; the batch drop is
// card-policy-merge-batch.mjs; recycle/revive exemption is card-policy-recovery-exempt.mjs.
//   (S) worker_spawn: byte-identical with no policy (zero policy-only evidence reads); approved-request
//       refused for no / pending / denied / decision-type Requests, met by answered|consumed permission+authorize,
//       waived; refusal creates NO worker row and NO pty; unreadable config refuses; a REVIEW spawn is never blocked;
//       the kickoff carries the policy verdict + the fixed investigate paragraph (not when waived / no policy).
//   (M) solo merge (confirmWorkerMergeTracked): code-review-report met only by a done review of THIS card at the
//       CURRENT tip (a review of an older tip is unmet), investigate-checkpoint met only by an earlier blocked|progress
//       report (also via the recycle lineage); unreadable evidence refuses; waived lands; the refusal mints NO op and is
//       not cached (satisfy ⇒ the same call lands); the backstop in confirmWorkerMerge refuses on its own; a shipped card
//       is never refused.
//   (T) tasks_get: `policy` appears only when a stored policy matches (no-policy response is key-for-key unchanged).
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
useOwnLoomHome("cpe2-");
requireHermeticEnv();

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
const { makeEnv, policy, GIT_ID, closeAll } = await import("./_card-policy-fixture.mjs");
const { getProjectTask } = await import("../dist/mcp/tasks.js");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return String(e?.message ?? e); } };
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

const REQ_APPROVED = { kind: "approved-request" }, REQ_REVIEW = { kind: "code-review-report" }, REQ_CHECK = { kind: "investigate-checkpoint" };

// ════════════════════════════════════ (S) worker_spawn ════════════════════════════════════
{
  const e = await makeEnv();
  // Policy-only evidence readers, spied: with NO policy they must never run (the evaluator returns first).
  let policyReads = 0;
  for (const m of ["listCardPolicyWaivers", "listReviewSessionsOfTask"]) { const o = e.db[m].bind(e.db); e.db[m] = (...a) => { policyReads++; return o(...a); }; }
  const spawn = (taskId) => e.sessionsSpawn.spawnWorker(e.mgrId, { taskId, agentId: e.agentId, kickoffPrompt: "KICK_OFF" });

  const t0 = e.addTask("s0");
  const w0 = await spawn(t0);
  check("(S1) no cardPolicies key: tasked spawn succeeds", !!w0?.id);
  check("(S1) no cardPolicies key: ZERO policy-only evidence reads", policyReads === 0);
  check("(S1) no cardPolicies key: kickoff carries no CARD POLICY block (byte-identical)", !(e.optsFor(w0.id)?.startupPrompt ?? "").includes("CARD POLICY"));
  e.setPolicies([]);
  const t0b = e.addTask("s0b");
  const w0b = await spawn(t0b);
  check("(S1) empty list: spawn succeeds, still ZERO policy-only reads, no CARD POLICY block", !!w0b?.id && policyReads === 0 && !(e.optsFor(w0b.id)?.startupPrompt ?? "").includes("CARD POLICY"));

  e.setPolicies([policy({ require: [REQ_APPROVED] })]);
  const refuseCase = async (label, taskId) => {
    const before = e.db.listWorkers(e.mgrId).length;
    const msg = await throws(() => spawn(taskId));
    check(`(S2) ${label}: refused naming policy, the permission-Request remedy and the waiver`, !!msg && msg.includes("Feat policy") && /permission Request/.test(msg) && /waiver/.test(msg));
    check(`(S2) ${label}: refusal created NO worker row (no side effect before the check)`, e.db.listWorkers(e.mgrId).length === before);
    return msg;
  };
  const tNone = e.addTask("none");
  await refuseCase("no Request at all", tNone);
  const tPend = e.addTask("pend"); e.fileRequest({ taskId: tPend, state: "pending" });
  await refuseCase("permission Request still pending", tPend);
  const tDeny = e.addTask("deny"); e.fileRequest({ taskId: tDeny, chosenOption: "deny" });
  await refuseCase("permission Request answered DENY", tDeny);
  const tDec = e.addTask("dec"); e.fileRequest({ taskId: tDec, type: "decision", chosenOption: "approve" });
  await refuseCase("DECISION Request answered 'approve' (no structured affirmative ⇒ never counts)", tDec);
  const tDecRej = e.addTask("decrej"); e.fileRequest({ taskId: tDecRej, type: "decision", chosenOption: "reject" });
  await refuseCase("DECISION Request answered 'reject'", tDecRej);
  const tOk = e.addTask("ok"); e.fileRequest({ taskId: tOk });
  const wOk = await spawn(tOk);
  check("(S3) answered permission + authorize: spawn succeeds", !!wOk?.id);
  check("(S3) the kickoff carries the read-only policy verdict (policy, requirement, status met)", /CARD POLICY/.test(e.optsFor(wOk.id)?.startupPrompt ?? "") && /Feat policy \(p1\): approved-request — met/.test(e.optsFor(wOk.id)?.startupPrompt ?? ""));
  const tCons = e.addTask("cons"); e.fileRequest({ taskId: tCons, state: "consumed" });
  check("(S3) consumed permission + authorize: spawn succeeds", !!(await spawn(tCons))?.id);
  const tWv = e.addTask("wv");
  e.db.upsertCardPolicyWaiver({ taskId: tWv, projectId: e.projId, policyId: "p1", requirementKind: "approved-request", reason: "owner said ok", waivedBy: "human", createdAt: e.now });
  check("(S4) waived (card, policy, approved-request): spawn succeeds with no Request", !!(await spawn(tWv))?.id);
  const tWvOther = e.addTask("wvother");
  e.db.upsertCardPolicyWaiver({ taskId: tWvOther, projectId: e.projId, policyId: "p1", requirementKind: "code-review-report", reason: "wrong kind", waivedBy: "human", createdAt: e.now });
  await refuseCase("a waiver for a DIFFERENT requirement kind does not waive approved-request", tWvOther);

  // a permission grant whose DECIDED expiry has lapsed does not count; a live one does
  const tExpL = e.addTask("expl"); e.fileRequest({ taskId: tExpL, decidedExpiresAt: iso(-60_000) });
  await refuseCase("permission grant whose decided expiry LAPSED", tExpL);
  const tExpF = e.addTask("expf"); e.fileRequest({ taskId: tExpF, decidedExpiresAt: iso(+3_600_000) });
  check("(S3) permission grant with a still-live decided expiry: spawn succeeds", !!(await spawn(tExpF))?.id);

  // (S7) card 9623e943 F1: an approval an AGENT wrote does not count. question_resolve, question_amend and the companion
  // decision_resolve all call db.answerQuestion WITHOUT `answeredVia` (only the human REST answer routes stamp "human");
  // the fixture writes through that same db.answerQuestion, so `answeredVia:null` here IS the agent-path row shape.
  // A pre-field row (answered_via NULL) is the same shape and also fails closed.
  const tAgent = e.addTask("agentans"); e.fileRequest({ taskId: tAgent, answeredVia: null });
  await refuseCase("(S7) permission Request answered via the AGENT path (question_resolve; answeredVia null)", tAgent);
  const tComp = e.addTask("compans"); e.fileRequest({ taskId: tComp, state: "consumed", answeredVia: null });
  await refuseCase("(S7) permission Request answered by the COMPANION decision_resolve path (answeredVia null, even if consumed)", tComp);
  const tHum = e.addTask("humans"); const humQ = e.fileRequest({ taskId: tHum });
  check("(S7) the fixture's human path stamps answeredVia 'human' through the real db write", e.db.getQuestion(humQ)?.answeredVia === "human");
  check("(S7) a human-stamped approval: spawn succeeds", !!(await spawn(tHum))?.id);

  // (S9) an ssh_exec hold's approval (permissionAction carries the reserved prefix) is NOT a card approval
  const tSsh = e.addTask("sshapp"); const sshQ = e.fileRequest({ taskId: tSsh });
  e.db.db.prepare("UPDATE questions SET permission_action = ? WHERE id = ?").run("ssh_exec connection=c1 command=ls", sshQ);
  await refuseCase("(S9) a human-authorized permission Request that is an ssh_exec hold", tSsh);
  const tNonSsh = e.addTask("nonssh"); const nsQ = e.fileRequest({ taskId: tNonSsh });
  e.db.db.prepare("UPDATE questions SET permission_action = ? WHERE id = ?").run("deploy the thing", nsQ);
  check("(S9) CONTROL: a human-authorized permission Request with an ordinary permissionAction still counts", !!(await spawn(tNonSsh))?.id);

  // title that does not match the selector ⇒ the policy never applies
  const tFix = e.addTask("fixc", "fix(cpf): a fix");
  check("(S5) a card whose title does not match the selector is not blocked", !!(await spawn(tFix))?.id);

  // (S10) STICKY matching: a card that matched a policy keeps it after a retitle (an agent can rewrite a title via tasks_update).
  // The policy here is `types:[feat]`/approved-request; each card is created as `feat(...)`, then retitled out of the selector.
  const tCtl = e.addTask("stickyctl");
  await refuseCase("(S10) CONTROL: an un-retitled feat(...) card", tCtl);
  const tRtFix = e.addTask("stickyfix");
  e.db.updateTask(tRtFix, { title: "fix(cpf): retitled away from the selector" });
  await refuseCase("(S10) a feat card retitled to fix(...) is STILL refused (the old title's match is sticky)", tRtFix);
  const tRtProse = e.addTask("stickyprose");
  e.db.updateTask(tRtProse, { title: "just some bare prose, no conventional prefix" });
  await refuseCase("(S10) a feat card retitled to bare prose is STILL refused", tRtProse);
  const tRtTwice = e.addTask("stickytwice");
  e.db.updateTask(tRtTwice, { title: "fix(cpf): first retitle" }); e.db.updateTask(tRtTwice, { title: "chore(cpf): second retitle" });
  await refuseCase("(S10) retitled twice (a title write can only ADD, never remove) is STILL refused", tRtTwice);
  const tFixOrig = e.addTask("stickynever", "fix(cpf): never matched");
  e.db.updateTask(tFixOrig, { title: "docs(cpf): still not a feat" });
  check("(S10) CONTROL: a card that NEVER matched is not made sticky by retitling", !!(await spawn(tFixOrig))?.id);
  const tRtWaive = e.addTask("stickywaive");
  e.db.updateTask(tRtWaive, { title: "no prefix" });
  e.db.upsertCardPolicyWaiver({ taskId: tRtWaive, projectId: e.projId, policyId: "p1", requirementKind: "approved-request", reason: "owner ok", waivedBy: "human", createdAt: e.now });
  check("(S10) the human waiver still clears a sticky-matched card", !!(await spawn(tRtWaive))?.id);
  const tRtGone = e.addTask("stickygone");
  e.db.updateTask(tRtGone, { title: "no prefix either" });
  e.setPolicies([policy({ id: "other", require: [REQ_APPROVED] })]);
  check("(S10) a recorded id whose policy no longer exists is ignored (a deleted/replaced policy stops applying)", !!(await spawn(tRtGone))?.id);
  e.setPolicies([policy({ require: [REQ_APPROVED] })]);
  const tRtLate = e.addTask("stickylate", "fix(cpf): created non-matching");
  e.db.updateTask(tRtLate, { title: "feat(cpf): retitled INTO the selector" });
  await refuseCase("(S10) a card retitled INTO the selector is caught by the live match", tRtLate);

  // unreadable stored config ⇒ every tasked spawn refused (fail closed), naming Settings; review spawn still fine
  e.setPolicies("not-a-list");
  const tCfg = e.addTask("cfg");
  const cfgMsg = await throws(() => spawn(tCfg));
  check("(S6) unreadable stored cardPolicies: tasked spawn refused (fail closed) naming Settings", !!cfgMsg && /Settings/.test(cfgMsg) && /unreadable/.test(cfgMsg));
  e.setPolicies([{ id: "x", match: { types: ["feat"] }, require: [{ kind: "levitate" }] }]);
  check("(S6) unknown requirement kind (whole-list rejection): tasked spawn refused", !!(await throws(() => spawn(e.addTask("cfg2")))));

  // review spawn is never blocked (taskless), even under an unmet / unreadable policy
  const rv = await e.makeWorker("rv");
  const rvSpawn = await e.sessionsSpawn.spawnWorker(e.mgrId, { agentId: e.agentId, kickoffPrompt: "REVIEW", reviewOfTaskId: rv.taskId });
  check("(S7) REVIEW spawn (taskless reviewOfTaskId) is never blocked, even under an unreadable policy config", !!rvSpawn?.id && e.db.getSession(rvSpawn.id).taskId === null);
  e.setPolicies([policy({ require: [REQ_APPROVED] })]);
  const rvSpawn2 = await e.sessionsSpawn.spawnWorker(e.mgrId, { agentId: e.agentId, kickoffPrompt: "REVIEW2", reviewOfTaskId: rv.taskId });
  check("(S7) REVIEW spawn is never blocked under an unmet approved-request policy that matches the reviewed card", !!rvSpawn2?.id);

  // investigate-checkpoint: kickoff paragraph
  e.setPolicies([policy({ require: [REQ_CHECK] })]);
  const tCk = e.addTask("ck");
  const wCk = await spawn(tCk);
  const ckPrompt = e.optsFor(wCk.id)?.startupPrompt ?? "";
  check("(S8) investigate-checkpoint card: the fixed investigate paragraph is appended to the kickoff", ckPrompt.includes("report your plan with worker_report") && ckPrompt.includes("KICK_OFF"));
  check("(S8) the paragraph comes AFTER the manager's kickoff text", ckPrompt.indexOf("KICK_OFF") < ckPrompt.indexOf("report your plan with worker_report"));
  const tCkW = e.addTask("ckw");
  e.db.upsertCardPolicyWaiver({ taskId: tCkW, projectId: e.projId, policyId: "p1", requirementKind: "investigate-checkpoint", reason: "r", waivedBy: "human", createdAt: e.now });
  const wCkW = await spawn(tCkW);
  check("(S8) a waived investigate-checkpoint adds no paragraph", !(e.optsFor(wCkW.id)?.startupPrompt ?? "").includes("report your plan with worker_report"));
  check("(S8) merge-phase requirements never block a SPAWN (investigate-checkpoint is merge-enforced)", !!wCk?.id);
}

// ════════════════════════════════════ (M) solo merge ════════════════════════════════════
{
  const e = await makeEnv();
  const confirm = (w) => e.sessions.confirmWorkerMergeTracked(e.mgrId, w.workerId);
  const val = (r) => (r.settled && r.ok ? r.value : undefined);

  // (M1) no policy: lands, zero policy-only reads
  let policyReads = 0;
  for (const m of ["listCardPolicyWaivers", "listReviewSessionsOfTask"]) { const o = e.db[m].bind(e.db); e.db[m] = (...a) => { policyReads++; return o(...a); }; }
  const w1 = await e.makeWorker("m1");
  const r1 = val(await confirm(w1));
  check("(M1) no policy: the branch lands (merged:true)", r1?.merged === true && e.landed("m1.txt"));
  check("(M1) no policy: ZERO policy-only evidence reads on the merge path", policyReads === 0);

  // (M2) code-review-report
  e.setPolicies([policy({ require: [REQ_REVIEW] })]);
  const w2 = await e.makeWorker("m2");
  const r2 = val(await confirm(w2));
  check("(M2) no review: refused (merged:false) with policyRefusal {policyId:p1, requirement:code-review-report}", r2?.merged === false && r2.policyRefusal?.policyId === "p1" && r2.policyRefusal?.requirement === "code-review-report");
  check("(M2) refusal text names the policy, the review remedy and the waiver", /Feat policy/.test(r2?.reason ?? "") && /reviewOfTaskId=/.test(r2?.reason ?? "") && /waiver/.test(r2?.reason ?? ""));
  check("(M2) the refusal MINTED NO op (no pending/retained merge op for the worker)", e.sessions.peekPendingMerge(w2.workerId) === undefined);
  check("(M2) nothing landed", !e.landed("m2.txt"));
  // a review of an OLDER tip is not enough
  const oldTip = w2.tip();
  e.fileReview({ taskId: w2.taskId, baseSha: oldTip });
  fs.writeFileSync(path.join(w2.worktreePath, "m2-more.txt"), "more\n");
  commitAll(w2.worktreePath, "feat(cpf): m2 more", GIT_ID);
  const r2b = val(await confirm(w2));
  check("(M2) review exists but the branch MOVED after it: refused", r2b?.merged === false && r2b.policyRefusal?.requirement === "code-review-report");
  check("(M2) the moved-branch refusal names both shas (old review, new tip)", (r2b?.reason ?? "").includes(oldTip.slice(0, 8)) && (r2b?.reason ?? "").includes(w2.tip().slice(0, 8)));
  // a review whose report is NOT done does not count
  e.fileReview({ taskId: w2.taskId, baseSha: w2.tip(), status: "blocked" });
  check("(M2) a review at the current tip whose worker_report is only `blocked` does NOT count", val(await confirm(w2))?.merged === false);
  // a review of a DIFFERENT card at the current tip does not count
  e.fileReview({ taskId: w1.taskId, baseSha: w2.tip() });
  check("(M2) a done review of ANOTHER card at the same sha does NOT count (join is by reviewOfTaskId)", val(await confirm(w2))?.merged === false);
  // satisfy: review of THIS card at the CURRENT tip, done ⇒ the SAME call now lands (the refusal was never cached)
  e.fileReview({ taskId: w2.taskId, baseSha: w2.tip() });
  const r2ok = val(await confirm(w2));
  check("(M2) done review of this card at the CURRENT tip: lands (the earlier refusals were not cached)", r2ok?.merged === true && e.landed("m2.txt") && e.landed("m2-more.txt"));

  // (M3) investigate-checkpoint (detective: report BEFORE the first commit)
  e.setPolicies([policy({ require: [REQ_CHECK] })]);
  const w3 = await e.makeWorker("m3");
  const r3 = val(await confirm(w3));
  check("(M3) no checkpoint report: refused (investigate-checkpoint)", r3?.merged === false && r3.policyRefusal?.requirement === "investigate-checkpoint");
  e.fileReport(w3.workerId, "done", iso(-3_600_000));
  check("(M3) an EARLY `done` report is not a checkpoint (only blocked|progress count)", val(await confirm(w3))?.merged === false);
  e.fileReport(w3.workerId, "progress", iso(+3_600_000));
  check("(M3) a progress report AFTER the first commit does not count", val(await confirm(w3))?.merged === false);
  e.fileReport(w3.workerId, "blocked", iso(-3_600_000));
  const r3ok = val(await confirm(w3));
  check("(M3) a blocked report BEFORE the first commit satisfies it: lands", r3ok?.merged === true && e.landed("m3.txt"));
  // lineage: the checkpoint lives on the recycled PREDECESSOR
  const w3b = await e.makeWorker("m3b");
  const succId = `cpf-succ-${e.sfx}`;
  e.db.insertSession({ id: succId, projectId: e.projId, agentId: e.agentId, engineSessionId: null, title: null, cwd: w3b.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: e.now, lastActivity: e.now, lastError: null, role: "worker", parentSessionId: e.mgrId, taskId: w3b.taskId, worktreePath: w3b.worktreePath, branch: w3b.branch, cutBaseSha: e.db.getSession(w3b.workerId).cutBaseSha, recycledFrom: w3b.workerId });
  e.db.setProcessState(w3b.workerId, "exited");
  e.fileReport(w3b.workerId, "progress", iso(-3_600_000));
  const r3b = val(await e.sessions.confirmWorkerMergeTracked(e.mgrId, succId));
  check("(M3) the checkpoint report on the recycled PREDECESSOR (recycledFrom lineage) counts for the successor's landing", r3b?.merged === true && e.landed("m3b.txt"));

  // (M4) unreadable evidence fails CLOSED and still names the waiver
  e.setPolicies([policy({ require: [REQ_CHECK] })]);
  const w4 = await e.makeWorker("m4");
  e.fileReport(w4.workerId, "blocked", iso(-3_600_000));
  e.db.getSession(w4.workerId); // sanity
  e.db.db?.prepare?.("UPDATE sessions SET cut_base_sha = NULL WHERE id = ?")?.run?.(w4.workerId);
  const r4 = val(await confirm(w4));
  check("(M4) unknown cut base ⇒ checkpoint evidence unreadable ⇒ refused, names 'Could not verify' and the waiver", r4?.merged === false && /Could not verify/.test(r4.reason ?? "") && /waiver/.test(r4.reason ?? ""));
  e.setPolicies([policy({ require: [REQ_REVIEW] })]);
  const w4b = await e.makeWorker("m4b");
  const origReader = e.sessions.confirmMergeBranchTipReader;
  e.sessions.confirmMergeBranchTipReader = async () => null;
  const r4b = val(await confirm(w4b));
  e.sessions.confirmMergeBranchTipReader = origReader;
  check("(M4) an unreadable branch tip ⇒ code-review evidence unreadable ⇒ refused (fail closed), not passed", r4b?.merged === false && r4b.policyRefusal?.requirement === "code-review-report" && /Could not verify/.test(r4b.reason ?? ""));
  e.setPolicies("garbage");
  const r4c = val(await confirm(w4b));
  check("(M4) unreadable stored config ⇒ merge refused naming Settings (policyId (config))", r4c?.merged === false && r4c.policyRefusal?.policyId === "(config)" && /Settings/.test(r4c.reason ?? ""));

  e.setPolicies([policy({ require: [REQ_CHECK] })]);
  const w4d = await e.makeWorker("m4d");
  e.fileReport(w4d.workerId, "blocked", iso(-3_600_000));
  e.db.db.prepare("UPDATE sessions SET cut_base_sha = ? WHERE id = ?").run("0".repeat(40), w4d.workerId);
  const r4d = val(await confirm(w4d));
  check("(M4) a git read that FAILS (cut base absent from the repo) ⇒ checkpoint unreadable ⇒ refused (a report exists, yet it is not trusted)", r4d?.merged === false && r4d.policyRefusal?.requirement === "investigate-checkpoint" && /Could not verify/.test(r4d.reason ?? ""));

  // (M5) waived ⇒ lands (per requirement)
  e.setPolicies([policy({ require: [REQ_REVIEW, REQ_CHECK] })]);
  const w5 = await e.makeWorker("m5");
  e.db.upsertCardPolicyWaiver({ taskId: w5.taskId, projectId: e.projId, policyId: "p1", requirementKind: "code-review-report", reason: "owner ok", waivedBy: "human", createdAt: e.now });
  const r5 = val(await confirm(w5));
  check("(M5) waiving only code-review leaves investigate-checkpoint blocking", r5?.merged === false && r5.policyRefusal?.requirement === "investigate-checkpoint");
  e.db.upsertCardPolicyWaiver({ taskId: w5.taskId, projectId: e.projId, policyId: "p1", requirementKind: "investigate-checkpoint", reason: "owner ok", waivedBy: "human", createdAt: e.now });
  check("(M5) waiving both lets it land", val(await confirm(w5))?.merged === true && e.landed("m5.txt"));
  e.db.deleteCardPolicyWaiver(w5.taskId, e.projId, "p1", "code-review-report");

  // (M6) the BACKSTOP in confirmWorkerMerge refuses on its own (a caller that bypasses the tracked wrapper)
  e.setPolicies([policy({ require: [REQ_REVIEW] })]);
  const w6 = await e.makeWorker("m6");
  const r6 = await e.sessions.confirmWorkerMerge(e.mgrId, w6.workerId);
  check("(M6) confirmWorkerMerge called DIRECTLY: refused with policyRefusal, before any gate/git work", r6?.merged === false && r6.policyRefusal?.requirement === "code-review-report" && r6.gateRan === false);
  check("(M6) the backstop landed nothing", !e.landed("m6.txt"));

  // (M7) the card's sticky `mergedSha` exempts NOTHING: only THIS worker's own branch being proven landed does.
  e.db.updateTask(w6.taskId, { mergedSha: "abc1234def" });
  check("(M7) a card with a recorded mergedSha whose worker's own branch has NOT landed is still policy-refused", (await e.sessions.mergePolicyRefusal(w6.workerId)) !== null);
  // land one card (review satisfied), then prove the idempotent re-confirm of THAT worker is not refused...
  const w12 = await e.makeWorker("m12");
  e.fileReview({ taskId: w12.taskId, baseSha: w12.tip() });
  check("(M12) setup: a worker with a current-tip review lands", val(await confirm(w12))?.merged === true && e.landed("m12.txt"));
  e.db.updateTask(w12.taskId, { mergedSha: e.git(e.repo, "rev-parse HEAD") });
  check("(M12) the LANDED worker's own re-confirm is not policy-refused (its own branch is proven landed)", (await e.sessions.mergePolicyRefusal(w12.workerId)) === null);
  // ...but move the card back out of done, spawn a NEW worker on it, and confirm with no review: refused despite the sticky mergedSha.
  e.db.updateTask(w12.taskId, { columnKey: "in_progress" });
  const w12b = await e.makeWorker("m12b", { taskId: w12.taskId });
  check("(M12) a NEW worker on a once-landed card (mergedSha set, moved back out of done) is policy-refused by mergePolicyRefusal", (await e.sessions.mergePolicyRefusal(w12b.workerId)) !== null);
  const r12 = val(await confirm(w12b));
  check("(M12) ...and its solo confirm is REFUSED with no review (nothing landed)", r12?.merged === false && r12.policyRefusal?.requirement === "code-review-report" && !e.landed("m12b.txt"));

  // (M15) STICKY matching at the merge phase: retitled out of the selector, the card is still held to its policy
  e.setPolicies([policy({ require: [REQ_REVIEW] })]);
  const w15 = await e.makeWorker("m15"), w15b = await e.makeWorker("m15b"), w15c = await e.makeWorker("m15c", { title: "fix(cpf): never a feat" });
  e.db.updateTask(w15.taskId, { title: "fix(cpf): retitled away" });
  e.db.updateTask(w15b.taskId, { title: "bare prose title" });
  e.db.updateTask(w15c.taskId, { title: "docs(cpf): retitled but never matched" });
  const r15 = val(await confirm(w15)), r15b = val(await confirm(w15b)), r15c = val(await confirm(w15c));
  check("(M15) a feat card retitled to fix(...): solo confirm REFUSED by the policy, nothing landed", r15?.merged === false && r15.policyRefusal?.requirement === "code-review-report" && !e.landed("m15.txt"));
  check("(M15) a feat card retitled to bare prose: solo confirm REFUSED, nothing landed", r15b?.merged === false && r15b.policyRefusal?.requirement === "code-review-report" && !e.landed("m15b.txt"));
  check("(M15) CONTROL: a card that never matched lands after a retitle", r15c?.merged === true && e.landed("m15c.txt"));
  e.fileReview({ taskId: w15.taskId, baseSha: w15.tip() });
  check("(M15) the sticky-matched card lands once its review exists (satisfiable, not a permanent block)", val(await confirm(w15))?.merged === true && e.landed("m15.txt"));

  // (M14) the PRE-SQUASH re-check judges the tip the squash is PINNED to: a worker commit after the review (a tip the top-of-op read
  // never saw) does not ride through, while Loom's own union-merge of main past the reviewed tip does (the same chain walk reviewedTipVerdict uses).
  e.setPolicies([policy({ require: [REQ_REVIEW] })]);
  const w14 = await e.makeWorker("m14");
  const reviewedTip = w14.tip();
  e.fileReview({ taskId: w14.taskId, baseSha: reviewedTip });
  check("(M14) at the reviewed tip the policy is met, pinned or not", (await e.sessions.mergePolicyRefusal(w14.workerId)) === null && (await e.sessions.mergePolicyRefusal(w14.workerId, { pinnedTip: reviewedTip })) === null);
  const mainB14 = e.git(e.repo, "rev-parse --abbrev-ref HEAD");
  fs.writeFileSync(path.join(e.repo, "m14-main.txt"), "main moved\n");
  execSync("git add m14-main.txt", { cwd: e.repo });
  execSync(`git ${GIT_ID} commit -q -m "chore(cpf): m14 main moved"`, { cwd: e.repo });
  execSync(`git ${GIT_ID} merge ${mainB14} --no-edit`, { cwd: w14.worktreePath });
  const unionTip = w14.tip();
  check("(M14) setup: the union-merge moved the branch tip past the reviewed one", unionTip !== reviewedTip);
  check("(M14) a pinned tip that is the reviewed tip PLUS Loom's own union-merge of main still counts", (await e.sessions.mergePolicyRefusal(w14.workerId, { pinnedTip: unionTip })) === null);
  fs.writeFileSync(path.join(w14.worktreePath, "m14-late.txt"), "late work\n");
  commitAll(w14.worktreePath, "feat(cpf): m14 late commit after the review", GIT_ID);
  const lateTip = w14.tip();
  const late = await e.sessions.mergePolicyRefusal(w14.workerId, { pinnedTip: lateTip });
  check("(M14) a worker commit AFTER the review, pinned: refused (code-review-report), naming both shas", late?.requirement === "code-review-report" && /Could not verify|review at/.test(late?.text ?? "") && (late?.text ?? "").includes(lateTip.slice(0, 8)));
  check("(M14) ...and the SAME late tip is not rescued by the pin being unset (live read agrees)", (await e.sessions.mergePolicyRefusal(w14.workerId)) !== null);

  // (M8) the terminal COLUMN is not proof of landing: a card dragged to done with no review is still refused
  e.setPolicies([policy({ require: [REQ_REVIEW] })]);
  const w8 = await e.makeWorker("m8");
  e.db.updateTask(w8.taskId, { columnKey: "done" });
  const r8 = val(await confirm(w8));
  check("(M8) card in the terminal column, no review, no mergedSha: solo confirm is REFUSED by the policy", r8?.merged === false && r8.policyRefusal?.requirement === "code-review-report" && !e.landed("m8.txt"));
  check("(M8) mergePolicyRefusal itself does not exempt on column", (await e.sessions.mergePolicyRefusal(w8.workerId)) !== null);

  // (M9) investigate-checkpoint counts the worker's OWN first commit (first-parent), never a main commit a merge-forward brought in
  e.setPolicies([policy({ require: [REQ_CHECK] })]);
  const mainBranch = e.git(e.repo, "rev-parse --abbrev-ref HEAD");
  const w9 = await e.makeWorker("m9", { commit: false });
  const hours = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
  fs.writeFileSync(path.join(e.repo, "m9-main.txt"), "main moved\n");
  execSync("git add m9-main.txt", { cwd: e.repo });
  execSync(`git ${GIT_ID} commit -q -m "chore(cpf): main moved (dated 2h ago)"`, { cwd: e.repo, env: { ...process.env, GIT_AUTHOR_DATE: hours(2), GIT_COMMITTER_DATE: hours(2) } });
  e.fileReport(w9.workerId, "progress", hours(1));
  fs.writeFileSync(path.join(w9.worktreePath, "m9.txt"), "own work\n");
  commitAll(w9.worktreePath, "feat(cpf): m9 own first commit", GIT_ID);
  execSync(`git ${GIT_ID} merge ${mainBranch} --no-edit`, { cwd: w9.worktreePath });
  const r9 = val(await confirm(w9));
  check("(M9) checkpoint reported BEFORE the worker's own first commit, then main merged forward: NOT refused (main's older commit does not count)", r9?.merged === true && e.landed("m9.txt"));
  const w9b = await e.makeWorker("m9b", { commit: false });
  e.fileReport(w9b.workerId, "progress", iso(+3_600_000));
  fs.writeFileSync(path.join(w9b.worktreePath, "m9b.txt"), "own work\n");
  commitAll(w9b.worktreePath, "feat(cpf): m9b own first commit", GIT_ID);
  execSync(`git ${GIT_ID} merge ${mainBranch} --no-edit`, { cwd: w9b.worktreePath });
  const r9b = val(await confirm(w9b));
  check("(M9) the original case still refuses: report AFTER the worker's own first commit (merge-forward present) => refused", r9b?.merged === false && r9b.policyRefusal?.requirement === "investigate-checkpoint");

  // (M10) a code-review requirement does not exempt a call that would ATTACH to an already-RUNNING op
  const e5 = await makeEnv({ syncAttachBudgetMs: 0 });
  const w10 = await e5.makeWorker("m10");
  const gate = (await import("./_wait.mjs")).deferred();
  const runningKey = `merge:${w10.workerId}`;
  const minted = await e5.sessions.pendingOps.attach(runningKey, "merge", e5.mgrId, 0, () => gate.promise);
  e5.setPolicies([policy({ require: [REQ_REVIEW] })]);
  fs.writeFileSync(path.join(w10.worktreePath, "m10-more.txt"), "moved after admission\n");
  commitAll(w10.worktreePath, "feat(cpf): m10 tip moves", GIT_ID);
  const rr = await e5.sessions.confirmWorkerMergeTracked(e5.mgrId, w10.workerId);
  check("(M10) re-confirm while an op is RUNNING (policy now unmet, tip moved): ATTACHES to the in-flight op, no policy refusal", rr.settled === false && rr.op?.opId === minted.op?.opId && !("value" in rr && rr.value?.policyRefusal));
  gate.resolve({ merged: false, reason: "test settle", notified: false, opId: minted.op?.opId });
  await (await import("./_wait.mjs")).waitUntil(() => e5.sessions.pendingOps.peek(runningKey)?.state !== "running", { label: "test op to settle" });
  const after = val(await e5.sessions.confirmWorkerMergeTracked(e5.mgrId, w10.workerId));
  check("(M10) once nothing is running, the SAME call is policy-refused (the exemption was only for the running op)", after?.merged === false && after.policyRefusal?.requirement === "code-review-report");

  // (M11) a recycled reviewer's `done` report still counts as that card's review (reviewOfTaskId carried forward)
  e.setPolicies([policy({ require: [REQ_REVIEW] })]);
  const w11 = await e.makeWorker("m11");
  const reviewer = await e.sessionsSpawn.spawnWorker(e.mgrId, { agentId: e.agentId, kickoffPrompt: "REVIEW", reviewOfTaskId: w11.taskId });
  const successor = await e.sessionsSpawn.recycleWorker(e.mgrId, reviewer.id, "HANDOFF");
  const srow = e.db.getSession(successor.id);
  check("(M11) the recycled reviewer's successor carries reviewOfTaskId AND reviewBaseSha forward", srow.reviewOfTaskId === w11.taskId && srow.reviewBaseSha === w11.tip());
  check("(M11) before any report the requirement is still unmet", (await e.sessions.mergePolicyRefusal(w11.workerId)) !== null);
  e.fileReport(successor.id, "done", iso(0));
  check("(M11) the SUCCESSOR's done report satisfies the code-review requirement (evidence follows the recycle lineage)", (await e.sessions.mergePolicyRefusal(w11.workerId)) === null);
}

// ════════════════════════════════════ (T) tasks_get policy view ════════════════════════════════════
{
  const e = await makeEnv();
  const t = e.addTask("tg");
  const keysNo = Object.keys(await getProjectTask(e.db, e.projId, t)).sort();
  check("(T1) no policy: tasks_get has NO `policy` key", !keysNo.includes("policy"));
  e.setPolicies([policy({ require: [REQ_APPROVED, REQ_REVIEW] })]);
  const withP = await getProjectTask(e.db, e.projId, t);
  check("(T2) matching policy: `policy` view lists each requirement", Array.isArray(withP.policy) && withP.policy.length === 2);
  check("(T2) approved-request shows `unmet`, the merge-phase one shows `deferred`", withP.policy.find((p) => p.requirement === "approved-request")?.status === "unmet" && withP.policy.find((p) => p.requirement === "code-review-report")?.status === "deferred");
  check("(T2) every other key is unchanged by the policy view", Object.keys(withP).filter((k) => k !== "policy").sort().join() === keysNo.join());
  e.fileRequest({ taskId: t });
  check("(T3) once an authorizing permission Request exists the view shows `met`", (await getProjectTask(e.db, e.projId, t)).policy.find((p) => p.requirement === "approved-request")?.status === "met");
  const tOther = e.addTask("tg2", "docs(cpf): not matched");
  check("(T4) a card the selector does not match has NO `policy` key", !("policy" in (await getProjectTask(e.db, e.projId, tOther))));
}

closeAll();
console.log(failures === 0 ? "\n✅ ALL PASS — card-policy enforcement" : `\n${failures} check(s) FAILED.`);
await finishAndExit(failures === 0 ? 0 : 1);
