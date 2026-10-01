import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f1969787, FIX ROUND after Code Review (follow-up to recycle-manager-ownership-transfer-halt.mjs).
// The Code Reviewer found the HALT branch (recycleManager, when an ownership-transfer step is still
// failing after retry) never armed any successor-death recovery, unlike the ordinary successful-recycle
// path (e07b1b1a's settleRecycleHandoff): if the halted successor died before ever reaching SessionStart,
// whatever DID transfer to it (e.g. live workers, when only "wakes" failed) stayed parented to a DEAD
// session forever, while the live predecessor owned nothing of it — on main, nothing ever reclaimed it,
// neither in-process nor across a daemon restart.
//
// Fix: `SessionService.watchHaltedRecycleSuccessor` (armed from the halt branch) mirrors
// settleRecycleHandoff's death-watch WITHOUT its "reached ready -> stop predecessor" branch (a halted
// predecessor is never stopped, no matter what); and a new boot-time pair
// (`halted-recycle-reconcile.ts`'s `reconcileHaltedRecycleSuccessorsEarly` +
// `SessionService.finishReconcilingHaltedRecycleSuccessors`) catches the identical case across a restart,
// mirroring recycle-settle-lost-to-restart.mjs's own early/late split.
//
// ROUND 3 SCOPE CUT: an earlier fix round also carved `resume()`/`deriveCrashOrphanedManagers` open for a
// HALTED predecessor despite `hasSuccessor` staying permanently true. A delta review REPRODUCED a CRITICAL
// in that carve-out: the event it keyed on (`recycle_ownership_transfer_failed`) is PERMANENT, so a
// predecessor that halted once, was later cleanly reclaimed (its halted successor died, ownership came
// back), and was then cleanly re-recycled to a BRAND NEW successor would still auto-resume ALONGSIDE that
// new successor — two live managers. That carve-out was REMOVED; `resume()` and
// `deriveCrashOrphanedManagers` now behave exactly like main again for a halted predecessor (scenarios
// (C)/(E) below prove the carve-out is GONE, not that it works). Auto-resuming a halted predecessor
// through one superseded predicate keyed to its current successor is follow-up work, not this card.
//
// Proves:
//   (A) IN-PROCESS — a halted successor that dies before ever reaching ready has its transferred fleet
//       (the worker, which DID transfer) reclaimed back onto the predecessor; the predecessor is NEVER
//       stopped; the permanently-stranded piece (the wake, which never transferred) is untouched.
//   (A2) REGRESSION — a halted successor that DOES reach ready is left alone: ownership stays split, the
//       predecessor is never stopped, no recovery event fires.
//   (B) ACROSS A BOOT RECONCILE — the identical death-before-ready case, but the daemon restarts before
//       the in-process watch could ever see it (the successor never captured an engine id at all). The
//       REAL boot sequence (runBootRecoveryPrefix + finishReconcilingHaltedRecycleSuccessors) reclaims the
//       transferred fleet, exactly like (A) but driven by the boot-time pair instead of the live watch.
//   (C) resume() REFUSES A STILL-SPLIT HALTED PREDECESSOR ACROSS A RESTART, same as main — the successor
//       DOES durably survive the restart (real engine id + transcript), but `resumeFleetOnBoot` still
//       refuses the predecessor (hasSuccessor stays true, no carve-out): it lands in `failed`, while the
//       surviving successor resumes normally. A human resume is required to bring the predecessor back —
//       this is a known, accepted gap (follow-up card), not a regression.
//   (D) NEGATIVE CONTROL — an ORDINARY (non-halted) recycled predecessor is STILL refused by resume(),
//       proving (C)'s refusal isn't special-cased either way — halted and ordinary predecessors are
//       refused identically.
//   (E) CRASH PATH — the same still-split lineage as (C), but via the crash-path candidate derivation
//       (deriveCrashOrphanedManagers + recoverCrashOrphanedWorkers, no RestartIntent): the predecessor is
//       NOT a crash-recovery candidate (hasSuccessor excludes it, same as main) while the surviving
//       successor still is.
//   (F) BOTH DEAD — the predecessor is ALSO unresumable this boot (never captured an engine id): the
//       halted-reconcile's own NEVER RESURRECT gate (mirrors reconcileStrandedRecycleSettlesEarly's
//       isDurablyResumable(predecessor) check) leaves BOTH untouched — nothing archived, overwritten, or
//       reparented onto a predecessor that can't come back either.
//   (G) STALE GENERATION — a predecessor that halted once (naming successor S1), was reclaimed after S1
//       died, and was then cleanly re-recycled to a BRAND NEW successor S2: the permanent halt event still
//       names S1, but the halted-reconcile must only act when the predecessor's CURRENT successor is the
//       EXACT one that event named (id + gen) — S2 is a different lineage entirely and is left alone.
//       Code Review (fix round, card f1969787) found this scenario VACUOUS for the guard it's named for:
//       (G) also makes M1 unresumable, so the EARLIER `isDurablyResumable(predecessor)` NEVER RESURRECT
//       gate (08c81809) already blocks the reparent regardless of what the stale-generation guard itself
//       decides — the guard's own effect is never actually exercised. See (G') below, which isolates it.
//   (G') STALE GENERATION, GUARD-DISCRIMINATING — the same lineage shape as (G), but with M1 DURABLY
//       RESUMABLE, so the NEVER RESURRECT gate can no longer mask the stale-generation guard: only the
//       guard itself stands between S2's live, unrelated fleet and a wrongful reparent onto the stale M1.
//       S2 reaches ready and the in-process settle genuinely completes (M1 is stopped), then S2 is left
//       unresumable (no captured engine id) across the simulated restart — proving the guard, not the
//       resumability gate, is what protects this lineage.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: mirrors recycle-manager-fleet-recovery.mjs and
// recycle-settle-lost-to-restart.mjs's own harnesses — a REAL Db + SessionService + PtyHost driven against
// a FAKE low-level pty (the shared createPty() seam). (B)/(C)/(D)/(E)/(F)/(G) simulate a restart by closing
// db1 and reopening the SAME fixed file as db2 (Db() always opens the one file derived from LOOM_HOME) —
// the same technique recycle-settle-lost-to-restart.mjs uses, verified faithful there.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-manager-halted-successor-dies.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-rmhsd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every settle bound BEFORE importing dist/** (mirrors both sibling files).
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = "40";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = "15";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = "3600000";
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { runBootRecoveryPrefix } = await import("../dist/sessions/boot-backstop.js");
const { deriveCrashOrphanedWorkers, deriveCrashOrphanedManagers } = await import("../dist/orchestration/crash-orphaned-workers.js");
const { CLEAN_STALENESS } = await import("./_deploy-staleness-fixture.mjs");

const repo = path.join(os.tmpdir(), `loom-rmhsd-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# recycle-manager-halted-successor-dies test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rmhsd@loom -c user.name=rmhsd");

class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map(); // sessionId -> the fake low-level pty object
  stoppedIds = new Set();
  createPty(opts) {
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    return pty;
  }
  stop(id, mode) { this.stoppedIds.add(id); return super.stop(id, mode); }
}

/** Fresh {db, host} pair wired like index.ts's real PtyHost construction (onEngineSessionId/onReady). */
function makeBoot() {
  const db = new Db();
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onReady(id) { db.setReachedReady(id); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
  };
  const host = new SeamHost(events);
  return { db, host };
}

/** "Boot 1": a full harness including a live SessionService (mirrors the sibling files' own makeHarness). */
function makeHarness() {
  const { db, host } = makeBoot();
  let sessions;
  host.events.onExit = (id, code, info) => {
    db.setProcessState(id, "exited");
    db.setBusy(id, false);
    const exited = db.getSession(id);
    if (exited) sessions.archiveOnExit(exited);
    if (exited) sessions.reconcileNeverStartedRecycleSuccessor(id, info.intended);
  };
  sessions = new SessionService(db, host, new OrchestrationControl());
  return { db, host, sessions };
}

/** Replicates index.ts's real boot order via the SAME exported runBootRecoveryPrefix, then both later
 *  reconcile phases, exactly matching index.ts's own line order (recycle-settle FIRST, then halted-recycle). */
function runRealBootSequenceUpToResume(db, host) {
  const { early, haltedEarly, recovered, crashOrphanedWorkers, crashOrphanedManagers } = runBootRecoveryPrefix(db);
  const sessions = new SessionService(db, host, new OrchestrationControl());
  const finish = sessions.finishReconcilingRecycleSettles(early);
  const haltedFinish = sessions.finishReconcilingHaltedRecycleSuccessors(haltedEarly);
  return { sessions, recovered, crashOrphanedWorkers, crashOrphanedManagers, finish, haltedFinish, haltedEarly };
}

function seedProject(db, id) {
  const now = new Date().toISOString();
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
}

/** Seeds a live worker + wake onto `managerId` (mirrors the sibling files' own helper). */
function seedFleet(db, projectId, managerId) {
  const now = new Date().toISOString();
  const workerId = `${managerId}-worker`;
  db.insertTask({ id: `${managerId}-task`, projectId, title: "t", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: workerId, projectId, agentId: `${projectId}-mgr`, engineSessionId: "eng-w", title: null, cwd: repo, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: managerId, taskId: `${managerId}-task` });
  db.insertWake({ id: `${managerId}-wake`, sessionId: managerId, wakeAt: new Date(Date.now() + 3_600_000).toISOString(), note: "test wake", createdAt: now, route: null });
  return { workerId };
}

function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

const hasEvent = (db, id, kind) => db.listEventsForSession(id).some((e) => e.kind === kind);

/** Forces the "wakes" ownership-transfer step to fail permanently (mirrors
 *  recycle-manager-ownership-transfer-halt.mjs's own stub) so recycleManager halts. Caller restores. */
function stubWakesPermanentFailure() {
  const original = Db.prototype.reparentWakes;
  Db.prototype.reparentWakes = function () { throw new Error("injected PERMANENT failure (halted-successor-dies test)"); };
  return () => { Db.prototype.reparentWakes = original; };
}

try {
  // ==================== (A) IN-PROCESS — halted successor dies before ready ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmhsd-a";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId } = seedFleet(db, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — forcing a halt, then the successor dies");
    unstub();

    check("(A pre) the recycle HALTED (ownership_transfer_failed event fired)", hasEvent(db, m2.id, "recycle_ownership_transfer_failed"));
    check("(A pre) hasSuccessor(M1) is true — M2 genuinely exists", db.hasSuccessor(m1.id) === true);
    check("(A pre) the worker DID transfer onto M2", db.getSession(workerId)?.parentSessionId === m2.id);
    check("(A pre) the wake is STRANDED on M1 (never transferred)", db.listWakesForSession(m1.id).some((w) => w.id === `${m1.id}-wake`));

    const m2Pty = host.handles.get(m2.id);
    check("(A setup) M2's fake pty handle captured", !!m2Pty);
    m2Pty.kill(); // the successor dies before ever reaching SessionStart

    const settled = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_recovered"));
    check("(A) the in-process watch reached a terminal outcome (recycle_fleet_recovered)", settled);

    check("(A) FIX: the worker (which DID transfer) is reclaimed back onto M1", db.getSession(workerId)?.parentSessionId === m1.id);
    check("(A) FIX: M1 was NEVER stopped — still alive", host.isAlive(m1.id) === true);
    check("(A) FIX: hasSuccessor(M1) is now false (M2 unlinked)", db.hasSuccessor(m1.id) === false);
    check("(A) FIX: M2 is archived", !!db.getSession(m2.id)?.archivedAt);
    check("(A) the never-transferred wake is still on M1, untouched by the reclaim", db.listWakesForSession(m1.id).some((w) => w.id === `${m1.id}-wake`));
  }

  // ==================== (A2) REGRESSION — halted successor DOES reach ready ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmhsd-a2";
    seedProject(db, P);
    // startupModeCycles:0 — markReady must run synchronously off the hook below (mirrors
    // recycle-manager-fleet-recovery.mjs scenario C's identical reasoning).
    db.setProjectConfig(P, { permission: { startupModeCycles: 0 } });
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId } = seedFleet(db, P, m1.id);

    // There is no terminal EVENT to wait on here (the whole point of this scenario is that NOTHING
    // fires) — a bare fixed sleep before the assertions below would be unfalsifiable (fixed-wait-negative-
    // guard.mjs's own target shape: a timer expiring before the watch loop's next poll is indistinguishable
    // from the loop correctly doing nothing). Spy on watchHaltedRecycleSuccessor itself and AWAIT ITS OWN
    // RETURNED PROMISE instead — it resolves the instant the loop's next iteration observes `hasReachedReady`
    // and takes the no-op return branch, an OBSERVABLE completion signal, never a guessed duration.
    let watchPromise;
    const originalWatch = SessionService.prototype.watchHaltedRecycleSuccessor;
    SessionService.prototype.watchHaltedRecycleSuccessor = function (...args) {
      watchPromise = originalWatch.apply(this, args);
      return watchPromise;
    };

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — forcing a halt, then the successor reaches ready");
    unstub();
    SessionService.prototype.watchHaltedRecycleSuccessor = originalWatch;
    check("(A2 pre) the recycle HALTED", hasEvent(db, m2.id, "recycle_ownership_transfer_failed"));
    check("(A2 setup) the watch was armed and its promise captured", !!watchPromise);

    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-a2" });
    check("(A2 pre) M2 reached real ready via a genuine SessionStart hook", host.hasReachedReady(m2.id) === true);

    await watchPromise; // resolves once the loop's own next poll observes ready and returns — no timer involved

    check("(A2) FIX: M1 is STILL never stopped — ownership stays split once the successor is ready", host.isAlive(m1.id) === true);
    check("(A2) FIX: hasSuccessor(M1) stays TRUE — nothing resolved the halt", db.hasSuccessor(m1.id) === true);
    check("(A2) FIX: the worker stays on M2 — nothing was wrongly reclaimed", db.getSession(workerId)?.parentSessionId === m2.id);
    check("(A2) no recycle_fleet_recovered event fabricated", db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered").length === 0);
  }

  // ==================== (B) ACROSS A BOOT RECONCILE — successor never captured an engine id ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-b";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-b" });
    writeFakeTranscript(m1.cwd, "eng-m1-b");
    const { workerId } = seedFleet(db1, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions1.recycleManager(m1.id, "handoff — a restart lands before the halted successor is ever observed to die");
    unstub();
    check("(B pre) the recycle HALTED", hasEvent(db1, m2.id, "recycle_ownership_transfer_failed"));
    check("(B pre) M2 never captured an engine id (never reached SessionStart)", db1.getSession(m2.id)?.engineSessionId == null);

    const preRestartFleet = sessions1.liveFleetResumeSet(); // captured BEFORE the restart
    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const { sessions: sessions2, haltedFinish, haltedEarly } = runRealBootSequenceUpToResume(db2, host2);

    check("(B) FIX: the early phase classified M2 as unresumable and reparented the worker", haltedEarly.recovered.some((r) => r.predecessorId === m1.id && r.freshId === m2.id));
    check("(B) FIX: the later phase recovered the predecessor", haltedFinish.recovered.includes(m1.id));
    check("(B) FIX: the worker (which DID transfer) is reclaimed back onto M1 — REPARENT AGAINST THE REAL BOOT SEQUENCE", db2.getSession(workerId)?.parentSessionId === m1.id);
    check("(B) FIX: M2 is unlinked (recycledFrom: null)", db2.getSession(m2.id)?.recycledFrom === null);
    check("(B) FIX: M2 is archived", !!db2.getSession(m2.id)?.archivedAt);
    check("(B) FIX: hasSuccessor(M1) is now false", db2.hasSuccessor(m1.id) === false);
    const recovered = db2.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered");
    check("(B) FIX: exactly one recycle_fleet_recovered event, naming the reparent count", recovered.length === 1 && recovered[0].detail?.reparentedWorkers === 1);

    const restartIntent = { reason: "test", managerSessionId: m1.id, resume: preRestartFleet };
    const { resumed, failed } = sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS });
    check("(B) FIX: M1 is ACTUALLY resumed by the ordinary fleet-resume pass (already-unlinked, so no carve-out even needed here)", resumed.includes(m1.id));
    check("(B) M1 is not in the failed list", !failed.includes(m1.id));
  }

  // ==================== (C) resume() REFUSES a still-split halted predecessor, same as main ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-c";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-c" });
    writeFakeTranscript(m1.cwd, "eng-m1-c");

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions1.recycleManager(m1.id, "handoff — the successor DOES survive the restart");
    unstub();
    check("(C pre) the recycle HALTED", hasEvent(db1, m2.id, "recycle_ownership_transfer_failed"));
    // M2 DOES durably survive this restart (unlike scenario B) — give it a real engine id + transcript.
    host1.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-c" });
    writeFakeTranscript(m2.cwd, "eng-m2-c");
    check("(C pre) M2 IS durably resumable", db1.getSession(m2.id)?.engineSessionId === "eng-m2-c");

    const preRestartFleet = sessions1.liveFleetResumeSet();
    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const { sessions: sessions2, haltedFinish } = runRealBootSequenceUpToResume(db2, host2);
    check("(C) the halted-reconcile left the still-resumable lineage untouched", haltedFinish.recovered.length === 0);
    check("(C pre-resume) hasSuccessor(M1) is STILL true going into the fleet resume", db2.hasSuccessor(m1.id) === true);

    let thrown;
    try { sessions2.resume(m1.id); } catch (e) { thrown = e; }
    check("(C) ROUND 3: resume() REFUSES the halted predecessor directly, same as an ordinary recycled one",
      !!thrown && /recycled.*successor exists/.test(thrown.message));

    const restartIntent = { reason: "test", managerSessionId: m1.id, resume: preRestartFleet };
    const { resumed, failed } = sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS });
    check("(C) ROUND 3: M1 (the halted predecessor) is NOT resumed — lands in `failed`, no carve-out", !resumed.includes(m1.id) && failed.includes(m1.id));
    check("(C) the surviving successor M2 is STILL resumed normally — its own resumability is unaffected", resumed.includes(m2.id));
    check("(C) hasSuccessor(M1) is STILL true after the attempt — nothing wrongly unlinked it", db2.hasSuccessor(m1.id) === true);
  }

  // ==================== (D) NEGATIVE CONTROL — an ORDINARY recycled predecessor stays refused ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmhsd-d";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    host.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-d" });
    writeFakeTranscript(m1.cwd, "eng-m1-d");
    const m2 = await sessions.recycleManager(m1.id, "handoff — an ORDINARY recycle, no halt");
    void m2;
    check("(D pre) no halt event exists for this lineage", !hasEvent(db, m1.id, "recycle_ownership_transfer_failed"));
    check("(D pre) hasSuccessor(M1) is true", db.hasSuccessor(m1.id) === true);

    // resume()'s FIRST check is an isAlive short-circuit — M1's fake pty is still alive in this
    // single-process harness, so it must be killed first to actually reach the hasSuccessor refusal,
    // exactly like a real crashed-and-restarted predecessor would be.
    host.handles.get(m1.id).kill();
    check("(D setup) M1 is confirmed not alive", host.isAlive(m1.id) === false);

    let thrown;
    try { sessions.resume(m1.id); } catch (e) { thrown = e; }
    check("(D) FIX IS SCOPED: an ORDINARY (non-halted) recycled predecessor is STILL refused by resume()",
      !!thrown && /recycled.*successor exists/.test(thrown.message));
  }

  // ==================== (E) CRASH PATH — the still-split lineage is NOT a crash-recovery candidate ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-e";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-e" });
    writeFakeTranscript(m1.cwd, "eng-m1-e");

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions1.recycleManager(m1.id, "handoff — the successor survives, crash path (no RestartIntent)");
    unstub();
    host1.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-e" });
    writeFakeTranscript(m2.cwd, "eng-m2-e");
    check("(E pre) the recycle HALTED", hasEvent(db1, m2.id, "recycle_ownership_transfer_failed"));

    db1.close(); // crash path: no RestartIntent captured at all
    const { db: db2, host: host2 } = makeBoot();
    const { sessions: sessions2, crashOrphanedWorkers, crashOrphanedManagers, haltedFinish } = runRealBootSequenceUpToResume(db2, host2);
    check("(E) the halted-reconcile left the still-resumable lineage untouched", haltedFinish.recovered.length === 0);
    check("(E pre) hasSuccessor(M1) is STILL true going into crash recovery", db2.hasSuccessor(m1.id) === true);
    check("(E) ROUND 3: M1 is NOT a crash-recovery candidate — hasSuccessor excludes it, same as main", !crashOrphanedManagers.includes(m1.id));
    check("(E) M2 (the surviving successor) is STILL a crash-recovery candidate", crashOrphanedManagers.includes(m2.id));

    const { resumed, managersFailed } = sessions2.recoverCrashOrphanedWorkers(crashOrphanedWorkers, { soloManagerIds: crashOrphanedManagers });
    check("(E) ROUND 3: M1 is NOT resumed via the crash path — never attempted, not just failed", !resumed.includes(m1.id) && !managersFailed.includes(m1.id));
    // `resumed` only ever carries WORKER session ids (recoverCrashOrphanedWorkers never pushes a manager's
    // own id onto it, even on a successful solo-manager resume) — a manager's success is "not in
    // managersFailed", the same contract this file's own pre-existing (E) assertion already relied on.
    check("(E) M2 IS resumed via the crash path — not in managersFailed", !managersFailed.includes(m2.id));
  }

  // ==================== (F) BOTH DEAD — the halted reconcile must never resurrect ONTO an unresumable predecessor ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-f";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    // M1 never captures a real engine id (no SessionStart hook delivered) — isDurablyResumable(M1) is FALSE.
    const { workerId } = seedFleet(db1, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions1.recycleManager(m1.id, "handoff — forcing a halt where BOTH predecessor and successor are unresumable");
    unstub();
    check("(F pre) the recycle HALTED", hasEvent(db1, m2.id, "recycle_ownership_transfer_failed"));
    check("(F pre) M1 never captured a real engine id — unresumable", db1.getSession(m1.id)?.engineSessionId == null);
    check("(F pre) M2 never captured a real engine id either (never reached SessionStart) — unresumable", db1.getSession(m2.id)?.engineSessionId == null);

    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const { haltedEarly, haltedFinish } = runRealBootSequenceUpToResume(db2, host2);

    check("(F) FIX: the early phase reparented NOTHING — the predecessor is ALSO not a viable destination (NEVER RESURRECT)", haltedEarly.recovered.length === 0);
    check("(F) FIX: the later phase recovered NOTHING either", haltedFinish.recovered.length === 0);
    // The "workers" ownership-transfer step itself ALWAYS succeeds here (only "wakes" was stubbed to fail)
    // — exactly like (A)/(B), the worker DID transfer onto M2 before the halt was ever detected. With BOTH
    // sides unresumable, nothing can reclaim it back: it stays on M2 (a dead, archived session) rather than
    // being moved onto an equally-unresumable M1 — the known, accepted residual this scenario proves.
    check("(F) the worker transferred onto M2 before the halt, exactly like (A)/(B)", db2.getSession(workerId)?.parentSessionId === m2.id);
    check("(F) FIX: the worker was NOT reclaimed back onto the equally-unresumable M1", db2.getSession(workerId)?.parentSessionId !== m1.id);
    check("(F) FIX: M2's recycledFrom link is untouched — never unlinked", db2.getSession(m2.id)?.recycledFrom === m1.id);
    check("(F) FIX: hasSuccessor(M1) is STILL true — nothing unlinked M2", db2.hasSuccessor(m1.id) === true);
    check("(F) FIX: no recycle_fleet_recovered event was fabricated for M1", !hasEvent(db2, m1.id, "recycle_fleet_recovered"));
  }

  // ==================== (G) STALE GENERATION — a cleanly re-recycled lineage is left untouched ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-g";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    // M1 never captures a real engine id either — deliberately, so the UNRELATED ordinary settle-reconcile
    // (08c81809, armed by the second/clean recycle below) ALSO can't reclaim S2 back onto M1. That isolates
    // this scenario to the ONE thing it's actually proving: the halted reconcile's own stale-generation
    // guard, uncontaminated by the ordinary mechanism legitimately doing its own, unrelated job.

    // First halt: M1 -> S1, then S1 dies before reaching ready — the in-process watch reclaims ownership
    // back onto M1, filing the PERMANENT recycle_ownership_transfer_failed event naming S1.
    const unstub = stubWakesPermanentFailure();
    const s1 = await sessions1.recycleManager(m1.id, "handoff — first halt, S1 will die and be reclaimed");
    unstub();
    check("(G pre) the first recycle HALTED (naming S1)", hasEvent(db1, s1.id, "recycle_ownership_transfer_failed"));
    const s1Pty = host1.handles.get(s1.id);
    s1Pty.kill();
    const reclaimed = await waitUntil(() => hasEvent(db1, m1.id, "recycle_fleet_recovered"));
    check("(G pre) S1's death was reclaimed back onto M1", reclaimed);
    check("(G pre) hasSuccessor(M1) is false again after the reclaim", db1.hasSuccessor(m1.id) === false);

    // M1 now cleanly re-recycles to a BRAND NEW successor S2 — an ORDINARY recycle, no stub this time.
    // S2 deliberately never captures a real engine id, so it's unresumable across the restart below.
    const s2 = await sessions1.recycleManager(m1.id, "handoff — a clean re-recycle after the reclaim");
    check("(G pre) the second recycle did NOT halt", !hasEvent(db1, s2.id, "recycle_ownership_transfer_failed"));
    check("(G pre) hasSuccessor(M1) now points at S2", db1.getSuccessor(m1.id)?.id === s2.id);
    check("(G pre) M1's OLD permanent halt event (naming dead S1) is STILL on record", hasEvent(db1, m1.id, "recycle_ownership_transfer_failed"));

    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const { haltedEarly, finish } = runRealBootSequenceUpToResume(db2, host2);

    check("(G) FIX: the stale halt event (naming dead S1) is NOT mistaken for M1's CURRENT successor S2",
      !haltedEarly.recovered.some((r) => r.predecessorId === m1.id));
    // M1 is deliberately also not durably resumable here, so the UNRELATED ordinary settle-reconcile
    // correctly declines too (its own `isDurablyResumable(predecessor)` gate) — proving the lineage stays
    // untouched because BOTH mechanisms correctly recognize it, not because only one of them ran.
    check("(G) the ORDINARY settle-reconcile also declined (M1 isn't durably resumable either)", !finish.recoveredPredecessors.includes(m1.id));
    check("(G) FIX: S2's lineage is untouched — still linked to M1", db2.getSession(s2.id)?.recycledFrom === m1.id);
    check("(G) FIX: hasSuccessor(M1) still points at S2, not reparented away by either reconcile", db2.getSuccessor(m1.id)?.id === s2.id);
  }

  // ==================== (G') STALE GENERATION, GUARD-DISCRIMINATING — M1 IS durably resumable ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-g2";
    seedProject(db1, P);
    // startupModeCycles:0 (mirrors (A2) / recycle-manager-fleet-recovery.mjs's own happy-path scenario C):
    // S2's markReady below must run SYNCHRONOUSLY off the deliverHook call, not behind an async mode-cycle.
    db1.setProjectConfig(P, { permission: { startupModeCycles: 0 } });
    const m1 = sessions1.startManager(`${P}-mgr`);
    // UNLIKE (G): M1 captures a REAL engine id + transcript here, so isDurablyResumable(M1) is TRUE — the
    // one change that stops the NEVER RESURRECT gate from masking the stale-generation guard's own effect.
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-g2" });
    writeFakeTranscript(m1.cwd, "eng-m1-g2");
    check("(G' pre) M1 IS durably resumable — the one thing (G) deliberately was NOT", db1.getSession(m1.id)?.engineSessionId === "eng-m1-g2");
    const { workerId } = seedFleet(db1, P, m1.id);

    // First halt: M1 -> S1, then S1 dies before reaching ready — the in-process watch reclaims ownership
    // (and the transferred worker) back onto M1, filing the PERMANENT recycle_ownership_transfer_failed
    // event naming S1 — identical to (G)'s own first half.
    const unstub = stubWakesPermanentFailure();
    const s1 = await sessions1.recycleManager(m1.id, "handoff — first halt, S1 will die and be reclaimed");
    unstub();
    check("(G' pre) the first recycle HALTED (naming S1)", hasEvent(db1, s1.id, "recycle_ownership_transfer_failed"));
    const s1Pty = host1.handles.get(s1.id);
    s1Pty.kill();
    const reclaimed = await waitUntil(() => hasEvent(db1, m1.id, "recycle_fleet_recovered"));
    check("(G' pre) S1's death was reclaimed back onto M1", reclaimed);
    check("(G' pre) hasSuccessor(M1) is false again after the reclaim", db1.hasSuccessor(m1.id) === false);
    check("(G' pre) the worker is back on M1 after the reclaim", db1.getSession(workerId)?.parentSessionId === m1.id);

    // M1 now cleanly re-recycles to a BRAND NEW successor S2 — an ORDINARY recycle, no stub — and UNLIKE
    // (G), S2 actually reaches ready and the in-process settle genuinely COMPLETES (M1 is stopped, exactly
    // like recycle-manager-fleet-recovery.mjs's own happy-path scenario C). S2 never captures a real engine
    // id (no session_id on its SessionStart hook), so it stays unresumable across the restart below — a
    // realistic hazard (its transcript could equally have been pruned/lost), not a contrived one.
    const s2 = await sessions1.recycleManager(m1.id, "handoff — a clean re-recycle that settles normally");
    check("(G' pre) the second recycle did NOT halt", !hasEvent(db1, s2.id, "recycle_ownership_transfer_failed"));
    check("(G' pre) hasSuccessor(M1) now points at S2", db1.getSuccessor(m1.id)?.id === s2.id);
    check("(G' pre) the worker transferred onto S2 at recycle time", db1.getSession(workerId)?.parentSessionId === s2.id);

    host1.deliverHook(s2.id, { hook_event_name: "SessionStart" }); // no session_id: S2 never captures an engine id
    check("(G' pre) S2 reached real ready via a genuine SessionStart hook", host1.hasReachedReady(s2.id) === true);
    const settledNormally = await waitUntil(() => host1.isAlive(m1.id) === false);
    check("(G' pre) the in-process settle completed normally — M1 was stopped", settledNormally);
    check("(G' pre) S2 never captured a real engine id — unresumable across the restart below", db1.getSession(s2.id)?.engineSessionId == null);
    check("(G' pre) M1's OLD permanent halt event (naming dead S1) is STILL on record", hasEvent(db1, m1.id, "recycle_ownership_transfer_failed"));

    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const { haltedEarly } = runRealBootSequenceUpToResume(db2, host2);

    check("(G') FIX: the stale halt event (naming dead S1) is NOT mistaken for M1's CURRENT, durably-resumable successor S2 — no reparent recorded for M1",
      !haltedEarly.recovered.some((r) => r.predecessorId === m1.id));
    check("(G') FIX: S2 is still linked — recycledFrom untouched", db2.getSession(s2.id)?.recycledFrom === m1.id);
    // S2 WAS genuinely live at the simulated restart, so the unconditional, unrelated crash-recovery sweep
    // (runBootRecoveryPrefix's own recoverStaleSessions + snapshotAndArchiveRecovered, which runs for EVERY
    // live/starting session regardless of this feature) flips and archives it either way — a bare
    // `archivedAt` check can't discriminate that from the bug. `unlinkAndArchiveDeadRecycleSuccessor` (the
    // reconcile's OWN archival path, fired only via haltedEarly.recovered) is what's actually under test
    // here, and it stamps a specific `[loom:recycle-failed]` lastError — assert its ABSENCE instead.
    check("(G') FIX: S2 was NOT archived via the reconcile's OWN dead-successor path (no [loom:recycle-failed] stamp)",
      !(db2.getSession(s2.id)?.lastError ?? "").includes("[loom:recycle-failed]"));
    check("(G') FIX: the worker (S2's real, live fleet) stays on S2 — NOT wrongly reparented onto the stale M1", db2.getSession(workerId)?.parentSessionId === s2.id);
    check("(G') FIX: hasSuccessor(M1) still points at S2", db2.getSuccessor(m1.id)?.id === s2.id);
    // M1 already legitimately earned ONE recycle_fleet_recovered event from the real S1 reclaim above (see
    // "(G' pre) S1's death was reclaimed back onto M1") — that event is permanent and expected. The guard's
    // job is to prevent a SECOND one naming S2 as the (wrongly) reclaimed dead successor.
    const m1Recovered = db2.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered");
    check("(G') FIX: still exactly the ONE legitimate recycle_fleet_recovered event for M1 (naming S1, not a second one fabricated for S2)",
      m1Recovered.length === 1 && m1Recovered[0].detail?.deadSuccessorId === s1.id);
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a halted recycle's successor-death watch reclaims whatever DID transfer, in-process and across a boot reconcile; resume() and the crash-recovery candidate derivation both still refuse a still-split halted predecessor, exactly like main (no carve-out)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
