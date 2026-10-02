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
  check("(C) detail.reason names that it was already resumed, never the generic unknown-reason fallback",
    crashEvents3[0]?.detail?.reason === "resumed, but its continuation nudge could not be composed" &&
    crashEvents3[0]?.detail?.reason !== RESUME_UNKNOWN_REASON_FALLBACK);
  // The requester's own "code is live" text must not contradict itself: since wC ended up NOT in
  // `failed`, fleetOk is true and the fleet-wide sentence must say the fleet was resumed, never that
  // anything failed to resume.
  const mgr3q = pty3.getPending(mgr3);
  check("(C) mgr3 got 2 messages: the crash notice (first) + its own requester nudge (last)",
    mgr3q.length === 2 && /unexpected error/i.test(mgr3q[0]) && /now LIVE/.test(mgr3q[1]));
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

} finally {
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
