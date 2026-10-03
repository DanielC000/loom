import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 09e9ba29: resumeFleetOnBoot's per-entry guard. Proves the fix for "one throwing entry strands the
// whole fleet" — a fleet of 3 workers where the 2nd's resumeOne THROWS (not a graceful {ok:false}) must
// still resume the 1st and 3rd, must still deliver the requester's "code is live" nudge, and must file
// exactly ONE durable fleet_resume_entry_failed event, under the crashed worker's own manager, with a
// generic (never raw) reason — plus its manager gets notified via the existing durable-nudge path.
// Also proves the SAME guard on the final block that resumes the restart requester itself: a throwing
// resumeOne for the requester must not escape resumeFleetOnBoot either.
// RED under the pre-fix code (no per-entry try/catch): the 2nd worker's thrown error propagates out of
// resumeFleetOnBoot entirely, so the 3rd worker is NEVER resumed and the requester NEVER gets its nudge.
// Round 2 (Code Review 7fdafcc0 of f44134fa) adds:
// (C) the REALISTIC shape — resumeOne itself SUCCEEDS, and the throw happens AFTER (injected from
//     db.listEventsForWorker, the call deriveAwaitingReview makes for a resumed worker entry). RED under
//     f44134fa: that commit's recordEntryCrash always pushed to `failed` regardless of whether resumeOne
//     had already succeeded, so a live, already-resumed worker was ALSO counted as failed — and the
//     filed event's reason was the generic fallback instead of naming that it was already resumed.
// (D) the parked-parent case — a crashing worker's PARENT manager is parked; recordEntryCrash must not
//     push a nudge into that parked parent's cap. RED under f44134fa: that commit's recordEntryCrash had
//     no park check at all, so a parked parent got the crash nudge anyway.
// Card c5415a04 round 2 (Code Review 1c5431b8, Minor-2) adds:
// (F) isParked(reqId) ITSELF throws — the OLD fallback gate (`reqResumeOk && !reqNudgeSent` alone) fired
//     the fallback self-nudge anyway, even though the park state was never actually confirmed false (the
//     requester might genuinely be parked). RED under the pre-round-2 gate.
// (G) enqueueDurableNudge persists the real nudge and THEN throws (the immediate-dispatch/platform
//     requester shape) — the OLD code set `reqNudgeSent = true` only AFTER the call returned, so a throw
//     mid-call left it `false` and the catch block sent a SECOND, contradictory fallback nudge on top of
//     the one already persisted. RED under the pre-round-2 ordering (flag set after, not before, the call).
// Run: 1) build daemon, 2) node test/restart-fleet-entry-crash-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rfecg-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { RESUME_UNKNOWN_REASON_FALLBACK } = await import("../dist/orchestration/resume-nudge.js");
const { CLEAN_STALENESS } = await import("./_deploy-staleness-fixture.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const flush = () => new Promise((r) => setTimeout(r, 0));

// Minimal claude-free PTY stub (mirrors restart-fleet.mjs's own) — a resumed pty is not-ready, so every
// enqueueStdin QUEUES and getPending returns a snapshot of what was sent, in order.
class PtyStub {
  constructor() { this.q = new Map(); }
  isAlive() { return false; }
  enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
  getPending(id) { return [...(this.q.get(id) ?? [])]; }
  isComposerDirty() { return false; }
  waitForMcpSeen() { return Promise.resolve(true); }
}

const db = new Db();
const mkProject = (id) => db.insertProject({ id, name: id, repoPath: `/tmp/${id}`, vaultPath: `/tmp/${id}`, config: {}, createdAt: now, archivedAt: null });
const mkAgent = (id, projId) => db.insertAgent({ id, projectId: projId, name: "t", startupPrompt: "", position: 0 });
function mkSession(o) {
  db.insertSession({
    id: o.id, projectId: o.projId, agentId: o.agentId, engineSessionId: `eng-${o.id}`,
    title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown",
    busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: o.role ?? null, parentSessionId: o.parentSessionId ?? null,
    taskId: o.taskId ?? null, worktreePath: null, branch: null,
    rateLimitedUntil: o.rateLimitedUntil ?? null,
  });
}

try {
  // ============================ (A) ONE CRASHING WORKER MID-FLEET ============================
  const proj = `rfecg-A-${sfx}`;
  mkProject(proj); mkAgent(`${proj}-ag`, proj);
  const mgr = `rfecg-mgr-${sfx}`;
  const w1 = `rfecg-w1-${sfx}`, w2 = `rfecg-w2-${sfx}`, w3 = `rfecg-w3-${sfx}`;
  mkSession({ id: mgr, projId: proj, agentId: `${proj}-ag`, role: "manager" });
  mkSession({ id: w1, projId: proj, agentId: `${proj}-ag`, role: "worker", parentSessionId: mgr, taskId: `${w1}-task` });
  mkSession({ id: w2, projId: proj, agentId: `${proj}-ag`, role: "worker", parentSessionId: mgr, taskId: `${w2}-task` });
  mkSession({ id: w3, projId: proj, agentId: `${proj}-ag`, role: "worker", parentSessionId: mgr, taskId: `${w3}-task` });

  const intent = {
    reason: "deploy merged daemon code", managerSessionId: mgr, requestedAt: now,
    resume: [
      { sessionId: mgr, role: "manager", parentSessionId: null },
      { sessionId: w1, role: "worker", parentSessionId: mgr },
      { sessionId: w2, role: "worker", parentSessionId: mgr },
      { sessionId: w3, role: "worker", parentSessionId: mgr },
    ],
  };

  const pty = new PtyStub();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const resumeCalls = [];
  // The 2nd worker's resumeOne THROWS — not a graceful {ok:false} return. This is the shape a custom
  // resumeOne (or anything reached from inside the per-entry branch) can produce, and the one the old
  // unguarded loop could not survive.
  const resumeOne = (sid) => {
    resumeCalls.push(sid);
    if (sid === w2) throw new Error(`injected test failure for ${sid} — a host path or uuid that must NEVER reach the durable event/nudge`);
    return true;
  };

  let threw = null;
  let result;
  try {
    result = sessions.resumeFleetOnBoot(intent, { resumeOne, deployStaleness: CLEAN_STALENESS });
  } catch (e) {
    threw = e;
  }
  await flush();

  check("(A) resumeFleetOnBoot itself never throws even though w2's resumeOne does", threw === null);
  // Everything below ASSUMES result is defined — true only when the guard above actually held. On the
  // pre-fix code the throw escapes resumeFleetOnBoot entirely, result stays undefined, and these must
  // report as failures too (never crash the script itself with a raw TypeError on `result.resumed`).
  check("(A) w1 and w3 (before/after the crashing entry) are resumed", !!result && result.resumed.includes(w1) && result.resumed.includes(w3));
  check("(A) w2 is NOT in resumed", !!result && !result.resumed.includes(w2));
  check("(A) w2 is counted as failed (exactly once)", !!result && result.failed.filter((id) => id === w2).length === 1);
  check("(A) the requester (mgr) itself still resumed", !!result && result.resumed.includes(mgr));
  check("(A) resumeOne was called for all 4 sessions (w1, w2, w3, mgr) — the loop never stopped early", resumeCalls.length === 4 && resumeCalls.includes(w1) && resumeCalls.includes(w2) && resumeCalls.includes(w3) && resumeCalls.includes(mgr));

  // w1/w3 still got their ordinary continuation nudge — proof the fleet wasn't stranded, just w2's entry.
  const w1q = pty.getPending(w1), w3q = pty.getPending(w3);
  check("(A) w1 got its ordinary worker continuation nudge", w1q.length === 1 && /daemon-restarted/.test(w1q[0]));
  check("(A) w3 got its ordinary worker continuation nudge", w3q.length === 1 && /daemon-restarted/.test(w3q[0]));

  // Exactly ONE fleet_resume_entry_failed event, filed under the crashed worker's own MANAGER (mgr),
  // naming w2 as workerSessionId — mirrors manager_crash_resume_failed's per-entity (never batched) filing.
  const crashEvents = db.listEvents(mgr).filter((ev) => ev.kind === "fleet_resume_entry_failed");
  check("(A) exactly one fleet_resume_entry_failed event, filed under w2's manager", crashEvents.length === 1);
  check("(A) the event names w2 as workerSessionId and its real taskId", crashEvents[0]?.workerSessionId === w2 && crashEvents[0]?.taskId === `${w2}-task`);
  check("(A) detail.role is \"worker\"", crashEvents[0]?.detail?.role === "worker");
  check("(A) detail.reason is the GENERIC fallback, never the raw thrown message (no host path/uuid leak)",
    crashEvents[0]?.detail?.reason === RESUME_UNKNOWN_REASON_FALLBACK && !String(crashEvents[0]?.detail?.reason ?? "").includes("injected test failure"));

  // mgr (w2's parent) gets a durable nudge about the crash, ADDITIVE to its own normal requester nudge.
  const mgrq = pty.getPending(mgr);
  check("(A) mgr got 2 messages: the crash notice (first) + its own 'code is live' requester nudge (last)",
    mgrq.length === 2 && /unexpected error/i.test(mgrq[0]) && mgrq[0].includes(w2) && /now LIVE/.test(mgrq[1]));
  check("(A) the crash notice to mgr never leaks the raw injected message either",
    !mgrq[0].includes("injected test failure"));

  // ============================ (B) THE REQUESTER ITSELF CRASHES ============================
  // The final block (which resumes reqId last, after clearRestartIntent on the real boot path) gets the
  // SAME guard — a throw there must not escape resumeFleetOnBoot either.
  const proj2 = `rfecg-B-${sfx}`;
  mkProject(proj2); mkAgent(`${proj2}-ag`, proj2);
  const mgr2 = `rfecg-mgr2-${sfx}`;
  mkSession({ id: mgr2, projId: proj2, agentId: `${proj2}-ag`, role: "manager" });
  const intent2 = { reason: "deploy", managerSessionId: mgr2, requestedAt: now, resume: [{ sessionId: mgr2, role: "manager", parentSessionId: null }] };
  const pty2 = new PtyStub();
  const sessions2 = new SessionService(db, pty2, new OrchestrationControl());
  let threw2 = null;
  let result2;
  try {
    result2 = sessions2.resumeFleetOnBoot(intent2, { resumeOne: () => { throw new Error("injected requester-resume failure"); }, deployStaleness: CLEAN_STALENESS });
  } catch (e) {
    threw2 = e;
  }
  check("(B) resumeFleetOnBoot never throws even when the REQUESTER's own resumeOne throws", threw2 === null);
  check("(B) the requester is counted as failed", result2?.failed?.includes(mgr2));
  const crashEvents2 = db.listEvents(mgr2).filter((ev) => ev.kind === "fleet_resume_entry_failed");
  check("(B) exactly one fleet_resume_entry_failed event, filed under the requester's OWN id (no parent)", crashEvents2.length === 1 && crashEvents2[0]?.workerSessionId == null);
  check("(B) detail.resumeFailed is true (a genuine resume failure, not a resumed-but-nudge-crashed one)",
    crashEvents2[0]?.detail?.resumeFailed === true);
  // Card c5415a04 DoD-1: the REQUESTER's own crash must ALSO file the fleet-wide aggregate — before this
  // fix it was filed ONLY inside the requester-resumed-and-unparked branch, so a crashing requester (this
  // exact scenario) left nothing but the per-entry event above, with no fleet-wide owner at all.
  const aggEvents2 = db.listEvents(mgr2).filter((ev) => ev.kind === "fleet_resume_failed");
  check("(B) exactly ONE fleet_resume_failed aggregate event is filed per boot, even on the crash path", aggEvents2.length === 1);
  check("(B) the aggregate's detail carries the requester itself (count 1, identity + fallback reason)",
    aggEvents2[0]?.detail?.count === 1 &&
    Array.isArray(aggEvents2[0]?.detail?.failed) &&
    aggEvents2[0].detail.failed.some((f) => f.sessionId === mgr2 && f.reason === RESUME_UNKNOWN_REASON_FALLBACK));

  // ============================ (C) THE REALISTIC SHAPE: resumeOne SUCCEEDS, the throw is AFTER ============================
  // Round 2 (Code Review 7fdafcc0, MAJOR 2): inject the throw from db.listEventsForWorker — the call
  // deriveAwaitingReview makes for a resumed WORKER entry, after resumeOne has already succeeded and the
  // entry has already been pushed to `resumed`. RED under f44134fa: it pushed this entry to BOTH
  // `resumed` and `failed`, and filed the generic fallback reason instead of a true one.
  const proj3 = `rfecg-C-${sfx}`;
  mkProject(proj3); mkAgent(`${proj3}-ag`, proj3);
  const mgr3 = `rfecg-mgr3-${sfx}`;
  const wC = `rfecg-wC-${sfx}`;
  mkSession({ id: mgr3, projId: proj3, agentId: `${proj3}-ag`, role: "manager" });
  mkSession({ id: wC, projId: proj3, agentId: `${proj3}-ag`, role: "worker", parentSessionId: mgr3, taskId: `${wC}-task` });
  const intent3 = {
    reason: "deploy merged daemon code", managerSessionId: mgr3, requestedAt: now,
    resume: [
      { sessionId: mgr3, role: "manager", parentSessionId: null },
      { sessionId: wC, role: "worker", parentSessionId: mgr3 },
    ],
  };
  const pty3 = new PtyStub();
  const sessions3 = new SessionService(db, pty3, new OrchestrationControl());
  const origListEventsForWorker = db.listEventsForWorker.bind(db);
  db.listEventsForWorker = (id) => {
    if (id === wC) throw new Error(`injected POST-resume failure for ${wC} — must never leak raw either`);
    return origListEventsForWorker(id);
  };
  let threw3 = null;
  let result3;
  try {
    result3 = sessions3.resumeFleetOnBoot(intent3, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
  } catch (e) {
    threw3 = e;
  } finally {
    db.listEventsForWorker = origListEventsForWorker;
  }
  await flush();
  check("(C) resumeFleetOnBoot never throws even on the realistic post-resume shape", threw3 === null);
  check("(C) wC IS in resumed (it genuinely was)", !!result3 && result3.resumed.includes(wC));
  check("(C) wC is NOT ALSO in failed — it must never be double-counted", !!result3 && !result3.failed.includes(wC));
  const crashEvents3 = db.listEvents(mgr3).filter((ev) => ev.kind === "fleet_resume_entry_failed");
  check("(C) exactly one fleet_resume_entry_failed event, filed under wC's manager", crashEvents3.length === 1);
  // Card c5415a04 (e): renamed from "...could not be composed" to "...could not be delivered".
  check("(C) detail.reason names that it was already resumed, never the generic unknown-reason fallback",
    crashEvents3[0]?.detail?.reason === "resumed, but its continuation nudge could not be delivered" &&
    crashEvents3[0]?.detail?.reason !== RESUME_UNKNOWN_REASON_FALLBACK);
  // Card c5415a04 (DoD-2): the resumed-but-nudge-not-delivered case must NEVER be classified as a genuine
  // resume failure — resumeFailed is the explicit discriminator classify() (attention-push.ts) gates on.
  check("(C) detail.resumeFailed is false (wC genuinely resumed — must never alert as crashed)",
    crashEvents3[0]?.detail?.resumeFailed === false);
  // The requester's own "code is live" text must not contradict itself: since wC ended up NOT in
  // `failed`, fleetOk is true and the fleet-wide sentence must say the fleet was resumed, never that
  // anything failed to resume.
  const mgr3q = pty3.getPending(mgr3);
  // Card c5415a04 (a): wC genuinely resumed (resumeOk=true), so the parent-nudge text is now the BRANCHED
  // "was resumed, but its continuation nudge was not delivered" wording, never the genuine-failure text.
  check("(C) mgr3 got 2 messages: the crash notice (first) + its own requester nudge (last)",
    mgr3q.length === 2 && /was resumed, but its continuation nudge was not delivered/i.test(mgr3q[0]) &&
    /send it a specific worker_message/i.test(mgr3q[0]) && !/unexpected error/i.test(mgr3q[0]) && /now LIVE/.test(mgr3q[1]));
  check("(C) the requester text says the fleet was resumed (fleetOk), never that anything failed to resume",
    /resumed too/i.test(mgr3q[1]) && !/failed to resume/i.test(mgr3q[1]));

  // ============================ (D) A CRASHING WORKER'S PARENT IS PARKED ============================
  // Round 2 (Code Review 7fdafcc0, MAJOR 1): recordEntryCrash must never push a nudge into a PARKED
  // parent's own cap — mirrors recoverCrashOrphanedWorkers's identical skip (card 55d40cfd). RED under
  // f44134fa: it had no park check at all, so the parked parent got the crash nudge anyway.
  const proj4 = `rfecg-D-${sfx}`;
  mkProject(proj4); mkAgent(`${proj4}-ag`, proj4);
  const reqMgr4 = `rfecg-reqmgr4-${sfx}`;
  const parkedMgr4 = `rfecg-parkedmgr4-${sfx}`;
  const wD = `rfecg-wD-${sfx}`;
  mkSession({ id: reqMgr4, projId: proj4, agentId: `${proj4}-ag`, role: "manager" });
  mkSession({
    id: parkedMgr4, projId: proj4, agentId: `${proj4}-ag`, role: "manager",
    rateLimitedUntil: new Date(Date.now() + 60 * 60_000).toISOString(), // parked, 1h out
  });
  mkSession({ id: wD, projId: proj4, agentId: `${proj4}-ag`, role: "worker", parentSessionId: parkedMgr4, taskId: `${wD}-task` });
  const intent4 = {
    reason: "deploy", managerSessionId: reqMgr4, requestedAt: now,
    resume: [
      { sessionId: reqMgr4, role: "manager", parentSessionId: null },
      { sessionId: parkedMgr4, role: "manager", parentSessionId: null },
      { sessionId: wD, role: "worker", parentSessionId: parkedMgr4 },
    ],
  };
  const pty4 = new PtyStub();
  const sessions4 = new SessionService(db, pty4, new OrchestrationControl());
  const resumeOne4 = (sid) => { if (sid === wD) throw new Error(`injected pre-resume failure for ${wD}`); return true; };
  let threw4 = null;
  let result4;
  try {
    result4 = sessions4.resumeFleetOnBoot(intent4, { resumeOne: resumeOne4, deployStaleness: CLEAN_STALENESS });
  } catch (e) {
    threw4 = e;
  }
  await flush();
  check("(D) resumeFleetOnBoot never throws", threw4 === null);
  check("(D) wD is counted as failed", !!result4 && result4.failed.includes(wD));
  const crashEvents4 = db.listEvents(parkedMgr4).filter((ev) => ev.kind === "fleet_resume_entry_failed");
  check("(D) the durable fleet_resume_entry_failed event is STILL filed, under the parked parent", crashEvents4.length === 1 && crashEvents4[0]?.workerSessionId === wD);
  const parkedMgr4q = pty4.getPending(parkedMgr4);
  check("(D) the parked parent gets ZERO messages — no crash nudge pushed into its parked cap", parkedMgr4q.length === 0);

  // ============================ (E) THE REQUESTER RESUMES OK, THEN THROWS (post-resume) ============================
  // Card c5415a04 items (c)/(d): the SAME realistic shape as (C), but for the restart requester's own
  // final block rather than a worker. Crash is injected on the THIRD db.getSession(mgrE) call — the
  // first (the `originProjectId` lookup, card 11b847e1) and second (inside isParked) both succeed, so the
  // crash lands AFTER isParked resolved false (i.e. inside the "code is live" text-composition branch),
  // mirroring a genuine post-resume failure there. Round 2 (Minor-2) correction: this threshold used to be
  // `>= 2`, which actually crashed INSIDE isParked itself (the `originProjectId` lookup is call #1, so
  // call #2 is isParked, not the post-isParked text composition this scenario means to exercise) — that
  // off-by-one didn't matter against the OLD fallback gate (`reqResumeOk && !reqNudgeSent` alone, blind to
  // WHERE the crash landed), but now it does: scenario (F) below is the dedicated "isParked itself throws"
  // case, and this scenario must land its crash genuinely AFTER isParked for its own assertions to hold.
  const proj5 = `rfecg-E-${sfx}`;
  mkProject(proj5); mkAgent(`${proj5}-ag`, proj5);
  const mgrE = `rfecg-mgrE-${sfx}`;
  mkSession({ id: mgrE, projId: proj5, agentId: `${proj5}-ag`, role: "manager" });
  const DEPLOY_SHA_E = "abc1234567890def1234567890abc1234567890"; // realistic 40-hex sha for extractCommitShas
  const intentE = {
    reason: `deploying ${DEPLOY_SHA_E}`, managerSessionId: mgrE, requestedAt: now, deploySha: DEPLOY_SHA_E,
    resume: [{ sessionId: mgrE, role: "manager", parentSessionId: null }],
  };
  const ptyE = new PtyStub();
  const sessionsE = new SessionService(db, ptyE, new OrchestrationControl());
  const origGetSessionE = db.getSession.bind(db);
  let getSessionCallsForMgrE = 0;
  db.getSession = (id) => {
    if (id === mgrE) {
      getSessionCallsForMgrE++;
      if (getSessionCallsForMgrE >= 3) throw new Error(`injected post-resume failure for ${mgrE} — must never leak raw`);
    }
    return origGetSessionE(id);
  };
  let threwE = null;
  let resultE;
  try {
    resultE = sessionsE.resumeFleetOnBoot(intentE, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
  } catch (e) {
    threwE = e;
  } finally {
    db.getSession = origGetSessionE;
  }
  await flush();
  check("(E) resumeFleetOnBoot never throws even when the requester's own post-resume processing crashes", threwE === null);
  check("(E) the requester IS in resumed (it genuinely resumed) — item (c)", !!resultE && resultE.resumed.includes(mgrE));
  check("(E) the requester is NOT in failed — must never be double-counted — item (c)", !!resultE && !resultE.failed.includes(mgrE));
  check("(E) no deploy SHA was recorded delivered to the requester (recordDeployShasDelivered never reached) — item (c)",
    sessionsE.deployShasAlreadyDelivered(mgrE, [DEPLOY_SHA_E]).length === 0);
  // No OTHER entry failed in this scenario, and the requester itself isn't pushed to `failed` (resumeOk
  // was already true) — so the fleet-wide aggregate must NOT fire here; only the per-entry event does.
  const aggEventsE = db.listEvents(mgrE).filter((ev) => ev.kind === "fleet_resume_failed");
  check("(E) no fleet_resume_failed aggregate fires — nothing genuinely failed", aggEventsE.length === 0);
  const crashEventsE = db.listEvents(mgrE).filter((ev) => ev.kind === "fleet_resume_entry_failed");
  check("(E) exactly one fleet_resume_entry_failed event, filed under the requester's own id", crashEventsE.length === 1);
  check("(E) detail.resumeFailed is false (it genuinely resumed)", crashEventsE[0]?.detail?.resumeFailed === false);
  // Item (d): the requester has no parent to be notified via the ordinary parent-nudge path, so it must
  // get its OWN fallback self-nudge instead of being left silently idle.
  const mgrEq = ptyE.getPending(mgrE);
  check("(E) the requester gets exactly one self-nudge (item d) — never silently idle", mgrEq.length === 1);
  check("(E) the self-nudge never leaks the raw injected error text",
    mgrEq.length === 1 && !mgrEq[0].includes("injected post-resume failure"));
  check("(E) the self-nudge tells it to verify directly rather than claiming the code is live",
    mgrEq.length === 1 && /verify directly/i.test(mgrEq[0]) && !/now LIVE/.test(mgrEq[0]));

  // ============================ (F) THE REQUESTER'S OWN isParked CHECK THROWS (round 2 Minor-2a) ============================
  // Round 2 (Code Review 1c5431b8, Minor-2): the pre-round-2 fallback gate was `reqResumeOk &&
  // !reqNudgeSent` alone — if isParked(reqId) itself throws, reqNudgeSent is still false (the real nudge
  // never got a chance to fire either), so that gate fired the fallback self-nudge even though the
  // requester's park state was never actually confirmed false. It might genuinely BE parked, and sending
  // ANY nudge in that case pushes a turn into a parked cap the park exists to prevent. RED under the
  // pre-fix gate: the fallback fires unconditionally whenever `isParked` throws.
  // Crash is injected starting from the SECOND db.getSession(mgrF) call — the first is the unrelated
  // `originProjectId` lookup (card 11b847e1, runs before the per-entry guard even begins), which must
  // succeed so the throw genuinely lands INSIDE isParked (the second call) rather than escaping
  // resumeFleetOnBoot entirely from a call site with no guard at all.
  const projF = `rfecg-F-${sfx}`;
  mkProject(projF); mkAgent(`${projF}-ag`, projF);
  const mgrF = `rfecg-mgrF-${sfx}`;
  mkSession({ id: mgrF, projId: projF, agentId: `${projF}-ag`, role: "manager" });
  const intentF = { reason: "deploy", managerSessionId: mgrF, requestedAt: now, resume: [{ sessionId: mgrF, role: "manager", parentSessionId: null }] };
  const ptyF = new PtyStub();
  const sessionsF = new SessionService(db, ptyF, new OrchestrationControl());
  const origGetSessionF = db.getSession.bind(db);
  let getSessionCallsForMgrF = 0;
  db.getSession = (id) => {
    if (id === mgrF) {
      getSessionCallsForMgrF++;
      if (getSessionCallsForMgrF >= 2) throw new Error(`injected isParked failure for ${mgrF} — must never leak raw`);
    }
    return origGetSessionF(id);
  };
  let threwF = null;
  let resultF;
  try {
    resultF = sessionsF.resumeFleetOnBoot(intentF, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
  } catch (e) {
    threwF = e;
  } finally {
    db.getSession = origGetSessionF;
  }
  await flush();
  check("(F) resumeFleetOnBoot never throws even when isParked(reqId) itself throws", threwF === null);
  check("(F) the requester IS in resumed (it genuinely resumed before the park check crashed)", !!resultF && resultF.resumed.includes(mgrF));
  const msgsF = ptyF.getPending(mgrF);
  check("(F) the requester gets ZERO messages — the park state was never confirmed false, so the fallback must NOT fire (Minor-2a fix)", msgsF.length === 0);

  // ============================ (G) THE REAL NUDGE PERSISTS, THEN THROWS (round 2 Minor-2b) ============================
  // Round 2 (Code Review 1c5431b8, Minor-2): for an immediate-dispatch (non-orchestration-MCP) requester
  // — e.g. "platform" — enqueueDurableNudge can persist the real nudge and THEN throw on its own dispatch.
  // The pre-fix code set `reqNudgeSent = true` only AFTER the call returned, so a throw mid-call left it
  // `false`, and the catch block sent a SECOND, contradictory "composing your confirmation failed" fallback
  // on top of the real nudge already sitting in the queue. This stub's `enqueueStdin` simulates exactly
  // that shape: it pushes to its queue (persist) and then throws.
  class PersistThenThrowPtyStub {
    constructor() { this.q = new Map(); }
    isAlive() { return false; }
    enqueueStdin(id, text) {
      const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a);
      throw new Error(`injected persist-then-throw for ${id}`);
    }
    getPending(id) { return [...(this.q.get(id) ?? [])]; }
    isComposerDirty() { return false; }
    waitForMcpSeen() { return Promise.resolve(true); }
  }
  const projG = `rfecg-G-${sfx}`;
  mkProject(projG); mkAgent(`${projG}-ag`, projG);
  const leadG = `rfecg-leadG-${sfx}`;
  mkSession({ id: leadG, projId: projG, agentId: `${projG}-ag`, role: "platform" });
  const intentG = { reason: "deploy", managerSessionId: leadG, requestedAt: now, resume: [{ sessionId: leadG, role: "platform", parentSessionId: null }] };
  const ptyG = new PersistThenThrowPtyStub();
  const sessionsG = new SessionService(db, ptyG, new OrchestrationControl());
  let threwG = null;
  let resultG;
  try {
    resultG = sessionsG.resumeFleetOnBoot(intentG, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
  } catch (e) {
    threwG = e;
  }
  await flush();
  check("(G) resumeFleetOnBoot never throws even when enqueueDurableNudge persists then throws", threwG === null);
  check("(G) the requester IS in resumed", !!resultG && resultG.resumed.includes(leadG));
  const msgsG = ptyG.getPending(leadG);
  check("(G) exactly ONE message reaches the queue — no contradictory fallback double-send (Minor-2b fix)", msgsG.length === 1);
  check("(G) that one message is the real 'code is live' nudge, not the fallback 'unexpected error' text",
    msgsG.length === 1 && /now LIVE/.test(msgsG[0]) && !/unexpected error/i.test(msgsG[0]));

} finally {
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
