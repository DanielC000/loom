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
// Card 39b58667 adds:
// (H) a setup-singleton boot collapse (two "setup" rows for one agent, both DB-flagged live before the
//     restart) is EXPECTED housekeeping, never a `failed`/fleet_resume_failed crash signal — the loser
//     lands in `setupResumeSuperseded` and files one informational setup_resume_superseded event naming
//     both ids. (H-neg-1)/(H-neg-2) control that the interception is scoped to the EXACT reason string
//     AND role "setup" — a genuinely-unresumable setup row, or that same reason text on a non-setup
//     entry, must still count as a real failure.
// (H-real) drives REAL resume() (no resumeOne stub) through a real PtyHost/SeamHost, proving the
//     interception also catches the reason text as resume()'s own thrown Error.message actually arrives,
//     wrapped by resumeFleetOnBoot's default resumeOne — not just the shape a test hand-constructs.
// Round 2 (Code Review 8f29fece, Minor 1): (H-neg-2) used to seed its reason-bearing entry as the
//     restart REQUESTER — which the per-entry loop skips entirely (`if (e.sessionId === reqId)
//     continue;`), so it never reached the interception in the first place and stayed green even with
//     the `e.role === "setup"` gate removed. Fixed: a separate, non-requester WORKER entry under the
//     requester now carries the reason text instead.
// Run: 1) build daemon, 2) node test/restart-fleet-entry-crash-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rfecg-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
// (H-real) below drives REAL resume() (no resumeOne stub) through a real PtyHost/SeamHost — it needs a
// sandboxed HOME/USERPROFILE so engineTranscriptExists resolves against a fixture transcript rather than
// the real user's ~/.claude/projects. Must be set BEFORE any dist import below: claude-transcript.ts's
// CLAUDE_PROJECTS_ROOT is a module-load-time const (os.homedir() captured once at import).
const rfecgSandboxHome = path.join(process.env.LOOM_HOME, "home");
fs.mkdirSync(rfecgSandboxHome, { recursive: true });
process.env.USERPROFILE = rfecgSandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = rfecgSandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { SessionService, SETUP_SESSION_RESUME_BARRED_ERROR } = await import("../dist/sessions/service.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { commitAll } = await import("./_git-commit.mjs");
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

  // ============================ (H) CARD 39b58667: A SETUP-SINGLETON BOOT COLLAPSE IS HOUSEKEEPING, NEVER A CRASH ============================
  // Two "setup" rows for ONE agent were BOTH DB-flagged live before this restart (a historical duplicate —
  // exactly what resume()'s new singleton refusal now prevents going forward). resumeOne for the LOSER
  // (sB) returns {ok:false, reason: SETUP_SESSION_RESUME_BARRED_ERROR} — the shape resume() itself now
  // throws. This must NOT land in `failed`/fire the unconditional fleet_resume_failed "worker-crashed"
  // aggregate; it must land in `setupResumeSuperseded`, file ONE informational setup_resume_superseded
  // event naming both ids, and get NO continuation nudge. `isAlive` tracks a configurable alive-id set
  // (unlike PtyStub's hardcoded `false`) so the WINNER (sA) resolves as genuinely alive for the
  // `supersededBy` re-derivation inside the interception — mirrors a real post-resume pty.
  class AliveTrackingPtyStub {
    constructor(aliveIds) { this.q = new Map(); this.aliveIds = aliveIds ?? new Set(); }
    isAlive(id) { return this.aliveIds.has(id); }
    enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
    getPending(id) { return [...(this.q.get(id) ?? [])]; }
    isComposerDirty() { return false; }
    waitForMcpSeen() { return Promise.resolve(true); }
  }
  const projH = `rfecg-H-${sfx}`;
  mkProject(projH); mkAgent(`${projH}-ag`, projH);
  const mgrH = `rfecg-mgrH-${sfx}`;
  const sA = `rfecg-sA-${sfx}`, sB = `rfecg-sB-${sfx}`;
  mkSession({ id: mgrH, projId: projH, agentId: `${projH}-ag`, role: "manager" });
  mkSession({ id: sA, projId: projH, agentId: `${projH}-ag`, role: "setup" });
  mkSession({ id: sB, projId: projH, agentId: `${projH}-ag`, role: "setup" });
  const intentH = {
    reason: "deploy", managerSessionId: mgrH, requestedAt: now,
    resume: [
      { sessionId: mgrH, role: "manager", parentSessionId: null },
      { sessionId: sA, role: "setup", parentSessionId: null },
      { sessionId: sB, role: "setup", parentSessionId: null },
    ],
  };
  const resumeOneH = (sid) => (sid === sB ? { ok: false, reason: SETUP_SESSION_RESUME_BARRED_ERROR } : { ok: true });
  const ptyH = new AliveTrackingPtyStub(new Set([sA]));
  const sessionsH = new SessionService(db, ptyH, new OrchestrationControl());
  let threwH = null;
  let resultH;
  try {
    resultH = sessionsH.resumeFleetOnBoot(intentH, { resumeOne: resumeOneH, deployStaleness: CLEAN_STALENESS });
  } catch (e) {
    threwH = e;
  }
  await flush();
  check("(H) resumeFleetOnBoot never throws on a setup-singleton collapse", threwH === null);
  check("(H) sA (the winner) IS in resumed", !!resultH && resultH.resumed.includes(sA));
  check("(H) sB (the loser) is NOT in resumed", !!resultH && !resultH.resumed.includes(sB));
  check("(H) sB is in setupResumeSuperseded, exactly once", !!resultH && resultH.setupResumeSuperseded.filter((id) => id === sB).length === 1);
  check("(H) sB is NEVER in `failed` — the whole point of the fix", !!resultH && !resultH.failed.includes(sB));
  check("(H) NO fleet_resume_failed aggregate fires — nothing genuinely failed in this restart",
    db.listEvents(mgrH).filter((ev) => ev.kind === "fleet_resume_failed").length === 0);
  check("(H) NO fleet_resume_entry_failed event fires for sB either (not misclassified as an ordinary per-entry crash)",
    db.listEvents(sB).filter((ev) => ev.kind === "fleet_resume_entry_failed").length === 0);
  const supersededEvents = db.listEvents(sB).filter((ev) => ev.kind === "setup_resume_superseded");
  check("(H) exactly ONE setup_resume_superseded event, filed under the LOSER's own id", supersededEvents.length === 1);
  check("(H) detail names the correct agentId + the WINNER as supersededBy",
    supersededEvents[0]?.detail?.agentId === `${projH}-ag` && supersededEvents[0]?.detail?.supersededBy === sA);
  check("(H) sB gets ZERO messages — no continuation nudge for a row that was never actually resumed",
    ptyH.getPending(sB).length === 0);
  const mgrHq = ptyH.getPending(mgrH);
  check("(H) the requester still gets its normal 'code is live, whole fleet resumed' nudge — the collapse never poisons the fleetOk text",
    mgrHq.length === 1 && /now LIVE/.test(mgrHq[0]) && /resumed too/i.test(mgrHq[0]) && !/failed to resume/i.test(mgrHq[0]));

  // --- (H-neg-1) CONTROL: a genuine OTHER setup resume failure still counts as a real failure ---
  // Proves the interception matches on the EXACT reason string, not "role === setup never fails".
  const projH2 = `rfecg-H2-${sfx}`;
  mkProject(projH2); mkAgent(`${projH2}-ag`, projH2);
  const mgrH2 = `rfecg-mgrH2-${sfx}`;
  const sC = `rfecg-sC-${sfx}`;
  mkSession({ id: mgrH2, projId: projH2, agentId: `${projH2}-ag`, role: "manager" });
  mkSession({ id: sC, projId: projH2, agentId: `${projH2}-ag`, role: "setup" });
  const intentH2 = {
    reason: "deploy", managerSessionId: mgrH2, requestedAt: now,
    resume: [
      { sessionId: mgrH2, role: "manager", parentSessionId: null },
      { sessionId: sC, role: "setup", parentSessionId: null },
    ],
  };
  const resumeOneH2 = (sid) => (sid === sC ? { ok: false, reason: "session has no engine id to resume" } : { ok: true });
  const ptyH2 = new AliveTrackingPtyStub();
  const sessionsH2 = new SessionService(db, ptyH2, new OrchestrationControl());
  const resultH2 = sessionsH2.resumeFleetOnBoot(intentH2, { resumeOne: resumeOneH2, deployStaleness: CLEAN_STALENESS });
  check("(H-neg-1) CONTROL: a genuinely-unresumable setup row DOES land in `failed`", resultH2.failed.includes(sC));
  check("(H-neg-1) CONTROL: it is NOT swallowed into setupResumeSuperseded", !resultH2.setupResumeSuperseded.includes(sC));
  check("(H-neg-1) CONTROL: the fleet_resume_failed aggregate DOES fire this time",
    db.listEvents(mgrH2).filter((ev) => ev.kind === "fleet_resume_failed").length === 1);

  // --- (H-neg-2) CONTROL: the exact SETUP_SESSION_RESUME_BARRED_ERROR text on a NON-setup entry is NOT intercepted ---
  // Proves the interception also gates on e.role === "setup", not merely the reason string. Round 2
  // (Code Review 8f29fece, Minor 1): the entry carrying this text must be NEITHER the restart requester
  // NOR role "setup" — a requester entry is skipped by the per-entry loop entirely (`if (e.sessionId ===
  // reqId) continue;`, service.ts ~5890) and takes the SEPARATE final-block path instead, which has no
  // setup interception of its own to disable; removing `e.role === "setup"` from the per-entry guard
  // therefore left THIS test green even though the role gate was gone. A non-requester, non-setup WORKER
  // entry is what actually reaches the per-entry interception's condition.
  const projH3 = `rfecg-H3-${sfx}`;
  mkProject(projH3); mkAgent(`${projH3}-ag`, projH3);
  const mgrH3 = `rfecg-mgrH3-${sfx}`;
  const wH3 = `rfecg-wH3-${sfx}`;
  mkSession({ id: mgrH3, projId: projH3, agentId: `${projH3}-ag`, role: "manager" });
  mkSession({ id: wH3, projId: projH3, agentId: `${projH3}-ag`, role: "worker", parentSessionId: mgrH3, taskId: `${wH3}-task` });
  const intentH3 = {
    reason: "deploy", managerSessionId: mgrH3, requestedAt: now,
    resume: [
      { sessionId: mgrH3, role: "manager", parentSessionId: null },
      { sessionId: wH3, role: "worker", parentSessionId: mgrH3 },
    ],
  };
  const resumeOneH3 = (sid) => (sid === wH3 ? { ok: false, reason: SETUP_SESSION_RESUME_BARRED_ERROR } : { ok: true });
  const ptyH3 = new AliveTrackingPtyStub();
  const sessionsH3 = new SessionService(db, ptyH3, new OrchestrationControl());
  const resultH3 = sessionsH3.resumeFleetOnBoot(intentH3, { resumeOne: resumeOneH3, deployStaleness: CLEAN_STALENESS });
  check("(H-neg-2) CONTROL: a non-setup, non-requester entry carrying this exact reason text still lands in `failed`", resultH3.failed.includes(wH3));
  check("(H-neg-2) CONTROL: it is NOT swallowed into setupResumeSuperseded", !resultH3.setupResumeSuperseded.includes(wH3));

  // ============================ (H-real) THE SAME COLLAPSE, DRIVEN THROUGH REAL resume() ============================
  // Round 2 (Code Review 8f29fece, Nit): every (H)/(H-neg) scenario above injects a hand-shaped
  // `resumeOne` stub — none of them prove the interception's `rawAttempt.reason ===
  // SETUP_SESSION_RESUME_BARRED_ERROR` comparison matches the ACTUAL text resume() throws, wrapped by
  // resumeFleetOnBoot's own DEFAULT resumeOne (`(id) => { try { this.resume(id); return {ok:true}; }
  // catch (e) { return {ok:false, reason: e.message}; } }`, service.ts ~5636). This variant omits
  // `resumeOne` entirely, driving the REAL SessionService.resume() through a real PtyHost/SeamHost (only
  // the OS process is faked; isAlive/spawn/setProcessState are all genuine) against a real temp git repo
  // + stub engine transcript, so a future change that re-wraps/re-throws the error differently (losing
  // byte-identity with the exported constant) would be caught here.
  const repoHReal = path.join(process.env.LOOM_HOME, "repo-hreal");
  fs.mkdirSync(repoHReal, { recursive: true });
  fs.writeFileSync(path.join(repoHReal, "README.md"), "# (H-real) fixture repo\n");
  execSync(`git init -q`, { cwd: repoHReal });
  commitAll(repoHReal, "init", "-c user.email=rfecg@loom -c user.name=rfecg");
  const writeHRealTranscript = (eng) => {
    const dir = path.join(rfecgSandboxHome, ".claude", "projects", encodeProjectDir(repoHReal));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${eng}.jsonl`), `{"type":"user","message":{"content":"hi"}}\n`);
  };
  const projHReal = `rfecg-Hreal-${sfx}`;
  mkProject(projHReal);
  // Direct insertAgent (not the shared mkAgent helper) with an explicit profileId:null — this scenario
  // is the one case in this file that drives a REAL resolveAgentSpawn/pty.spawn, mirroring the proven
  // shape setup-session-resume-barred.mjs uses for the same reason.
  db.insertAgent({ id: `${projHReal}-ag`, projectId: projHReal, name: "t", startupPrompt: "SETUP", position: 0, profileId: null });
  const mgrHReal = `rfecg-mgrHreal-${sfx}`;
  const sAr = `rfecg-sAr-${sfx}`, sBr = `rfecg-sBr-${sfx}`;
  // A REAL resume() needs a REAL (cwd, engineSessionId, transcript) triple for every session here — the
  // shared `mkSession` helper (used by every stubbed-resumeOne scenario above) seeds `cwd: os.tmpdir()`
  // with no transcript file, which is fine when `resumeOne` is stubbed but would make the REQUESTER's
  // own real resume() throw "transcript missing" here. Seed all three (manager + both setup rows) the
  // same way instead.
  const seedHRealSession = (id, role) => {
    writeHRealTranscript(`eng-${id}`);
    db.insertSession({
      id, projectId: projHReal, agentId: `${projHReal}-ag`, engineSessionId: `eng-${id}`,
      title: null, cwd: repoHReal, processState: "live", resumability: "unknown",
      busy: false, createdAt: now, lastActivity: now, lastError: null, role, parentSessionId: null,
    });
  };
  seedHRealSession(mgrHReal, "manager");
  seedHRealSession(sAr, "setup");
  seedHRealSession(sBr, "setup");
  const intentHReal = {
    reason: "deploy", managerSessionId: mgrHReal, requestedAt: now,
    resume: [
      { sessionId: mgrHReal, role: "manager", parentSessionId: null },
      { sessionId: sAr, role: "setup", parentSessionId: null },
      { sessionId: sBr, role: "setup", parentSessionId: null },
    ],
  };
  const eventsHReal = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const hostHReal = new (createSeamHost(PtyHost))(eventsHReal);
  const sessionsHReal = new SessionService(db, hostHReal, new OrchestrationControl());
  let threwHReal = null;
  let resultHReal;
  try {
    // NO resumeOne override — exercises the REAL default, wrapping real resume() throws.
    resultHReal = sessionsHReal.resumeFleetOnBoot(intentHReal, { deployStaleness: CLEAN_STALENESS });
  } catch (e) {
    threwHReal = e;
  }
  await flush();
  check("(H-real) resumeFleetOnBoot never throws on a REAL setup-singleton collapse", threwHReal === null);
  check("(H-real) exactly one of sAr/sBr resumed, the other superseded (order-dependent, both acceptable)",
    !!resultHReal &&
    ((resultHReal.resumed.includes(sAr) && resultHReal.setupResumeSuperseded.includes(sBr) && !resultHReal.resumed.includes(sBr)) ||
     (resultHReal.resumed.includes(sBr) && resultHReal.setupResumeSuperseded.includes(sAr) && !resultHReal.resumed.includes(sAr))));
  check("(H-real) neither row is ever in `failed`", !!resultHReal && !resultHReal.failed.includes(sAr) && !resultHReal.failed.includes(sBr));
  check("(H-real) NO fleet_resume_failed aggregate fires", db.listEvents(mgrHReal).filter((ev) => ev.kind === "fleet_resume_failed").length === 0);
  const loserHReal = resultHReal?.setupResumeSuperseded?.[0];
  const winnerHReal = loserHReal === sAr ? sBr : sAr;
  check("(H-real) the winner is genuinely pty-alive (a real spawn happened, not a stubbed return)", !!loserHReal && hostHReal.isAlive(winnerHReal));
  const supersededEventsHReal = loserHReal ? db.listEvents(loserHReal).filter((ev) => ev.kind === "setup_resume_superseded") : [];
  check("(H-real) exactly ONE setup_resume_superseded event, filed under the loser's own id", supersededEventsHReal.length === 1);
  check("(H-real) detail names the real winner as supersededBy", supersededEventsHReal[0]?.detail?.supersededBy === winnerHReal);

} finally {
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
