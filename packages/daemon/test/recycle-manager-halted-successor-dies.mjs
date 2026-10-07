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
// ROUND 3 SCOPE CUT (NOW LANDED — card 386e4eb5): an earlier fix round carved `resume()`/
// `deriveCrashOrphanedManagers` open for a HALTED predecessor despite `hasSuccessor` staying permanently
// true, keyed on the BARE PRESENCE of `recycle_ownership_transfer_failed`. A delta review REPRODUCED a
// CRITICAL in that carve-out: the event is PERMANENT, so a predecessor that halted once, was later cleanly
// reclaimed (its halted successor died, ownership came back), and was then cleanly re-recycled to a BRAND
// NEW successor would still auto-resume ALONGSIDE that new successor — two live managers. That carve-out
// was REMOVED, and `resume()`/`deriveCrashOrphanedManagers`/`liveFleetResumeSet` went back to refusing
// every halted predecessor unconditionally (main's old behavior) until card 386e4eb5 reintroduced the SAME
// idea correctly scoped: `isSupersededByRecycle` (orchestration/crash-orphaned-workers.ts) now carves out
// ONLY a predecessor whose CURRENT successor is EXACTLY the one its latest halt event named (id AND gen) —
// never bare presence. Scenarios (C)/(E) below now prove this carve-out WORKS (a still-matching halted
// predecessor auto-resumes); (D)/(G)/(G') prove it stays correctly SCOPED (an ordinary recycle, or a
// re-recycle to a different successor than the halt event named, is still refused, exactly like before).
//
// Proves:
//   (A) IN-PROCESS — a halted successor that dies before ever reaching ready has its transferred fleet
//       (the worker, which DID transfer) reclaimed back onto the predecessor; the predecessor is NEVER
//       stopped; the permanently-stranded piece (the wake, which never transferred) is untouched.
//   (A2) REGRESSION — a halted successor that DOES reach ready is left alone: ownership stays split, the
//       predecessor is never stopped, no recovery event fires.
//   (A3) card 6e5af155 (RETRACTED, round 3) — a durably-resumable (real captured engine id) halted
//       successor that dies before ever reaching ready is STILL reclaimed exactly like (A)'s unresumable
//       one — see this scenario's own inline comment for the full argument.
//   (B) ACROSS A BOOT RECONCILE — the identical death-before-ready case, but the daemon restarts before
//       the in-process watch could ever see it (the successor never captured an engine id at all). The
//       REAL boot sequence (runBootRecoveryPrefix + finishReconcilingHaltedRecycleSuccessors) reclaims the
//       transferred fleet, exactly like (A) but driven by the boot-time pair instead of the live watch.
//   (C) FIX 386e4eb5 — A STILL-SPLIT HALTED PREDECESSOR WITH A STILL-MATCHING SUCCESSOR IS NOW CAPTURED +
//       RESUMED. The successor DOES durably survive the restart (real engine id + transcript); the
//       predecessor is itself still genuinely `live` (never stopped) WITH a successor that still EXACTLY
//       matches its own latest unresolved halt event (same id + gen) — `liveFleetResumeSet` now INCLUDES
//       it in the capture (via `isSupersededByRecycle`'s halted-and-matching carve-out), `resume()` called
//       directly now SUCCEEDS, and `resumeFleetOnBoot` actually resumes it alongside the surviving
//       successor (two live managers is the CORRECT end state here — ownership is genuinely still split).
//   (D) NEGATIVE CONTROL — an ORDINARY (non-halted) recycled predecessor is STILL refused by resume(),
//       proving (C)'s new carve-out isn't a blanket hasSuccessor bypass — only a halted+matching lineage
//       is exempt.
//   (E) FIX 386e4eb5 — CRASH PATH: the same still-matching lineage as (C), but via the crash-path candidate
//       derivation (deriveCrashOrphanedManagers + recoverCrashOrphanedWorkers, no RestartIntent): the
//       predecessor NOW IS a crash-recovery candidate (same carve-out) and IS resumed, alongside the
//       surviving successor.
//   (F) BOTH DEAD — the predecessor is ALSO unresumable this boot (never captured an engine id): the
//       halted-reconcile's own NEVER RESURRECT gate (mirrors reconcileStrandedRecycleSettlesEarly's
//       isDurablyResumable(predecessor) check) leaves BOTH untouched — nothing archived, overwritten, or
//       reparented onto a predecessor that can't come back either. 386e4eb5's carve-out changes nothing
//       here either: `resume()`'s EARLIER unresumability checks (no engine id) refuse the predecessor
//       before the code ever reaches the superseded check, exactly as before this card.
//   (G) A DIFFERENT SUCCESSOR (ID MISMATCH) — a predecessor that halted once (naming successor S1), was
//       reclaimed after S1 died, and was then cleanly re-recycled to a BRAND NEW successor S2: the
//       permanent halt event still names S1, but the halted-reconcile (and, since 386e4eb5,
//       `isSupersededByRecycle` itself) must only treat the lineage as still-halted when the
//       predecessor's CURRENT successor is the EXACT one that event named — id is the real discriminator
//       here (S2's id differs from S1's; gen is checked too, but only as a defensive secondary check,
//       since a real round-2 lineage like this one mints S2 with the SAME gen as S1 — both P.gen+1) — S2
//       is a different lineage entirely and is correctly refused, same as an ordinary recycle. Code Review
//       (fix round, card f1969787) found this scenario VACUOUS for the guard it's named for: (G) also makes
//       M1 unresumable, so the EARLIER `isDurablyResumable(predecessor)` NEVER RESURRECT gate (08c81809)
//       already blocks the reparent regardless of what the id-mismatch guard itself decides — the guard's
//       own effect is never actually exercised. See (G') below, which isolates it, and asserts R1 (card
//       386e4eb5's own DoD: halt, reclaim, clean re-recycle ⇒ refused) directly through
//       `isSupersededByRecycle`/`resume()`, not just through the boot-reconcile side.
//   (G') A DIFFERENT SUCCESSOR (ID MISMATCH), GUARD-DISCRIMINATING — the same lineage shape as (G), but
//       with M1 DURABLY RESUMABLE, so the NEVER RESURRECT gate can no longer mask the id-mismatch guard:
//       only the guard itself stands between S2's live, unrelated fleet and a wrongful reparent onto the
//       stale M1. S2 reaches ready and the in-process settle genuinely completes (M1 is stopped), then S2
//       is left unresumable (no captured engine id) across the simulated restart — proving the guard, not
//       the resumability gate, is what protects this lineage. Also asserts R1 directly: `isSupersededByRecycle`
//       is TRUE for M1 and `resume(m1.id)` still throws, even though M1 is durably resumable here — and R1
//       here is discriminated by id ALONE: S1 and S2 share the SAME gen (both P.gen+1), so a gen-only match
//       would wrongly treat S2 as the halt event's own successor.
//   (H) R2 (card 386e4eb5's own DoD) — CRASH BETWEEN READY AND SETTLE: the same halt→reclaim→clean-
//       re-recycle lineage as (G)/(G'), but the second (clean) recycle's successor S2 reaches ready and the
//       simulated crash lands in the RACE WINDOW before the in-process settle loop's own next poll ever
//       observes it (no await between delivering S2's ready hook and closing db1) — i.e. the ORDINARY
//       (non-halted) settle-lost-to-restart mechanism (08c81809) must resolve this, not 386e4eb5's own
//       carve-out (which correctly excludes M1 here as a different successor than its halt event named).
//       Asserts the real boot sequence ends with ONLY S2 live — M1 stays excluded from every automatic
//       resume path, including the REAL crash-recovery candidate derivation + resume attempt (not merely
//       untried).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: mirrors recycle-manager-fleet-recovery.mjs and
// recycle-settle-lost-to-restart.mjs's own harnesses — a REAL Db + SessionService + PtyHost driven against
// a FAKE low-level pty (the shared createPty() seam). (B)/(C)/(D)/(E)/(F)/(G)/(G')/(H) simulate a restart
// by closing db1 and reopening the SAME fixed file as db2 (Db() always opens the one file derived from
// LOOM_HOME) — the same technique recycle-settle-lost-to-restart.mjs uses, verified faithful there.
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
const { deriveCrashOrphanedWorkers, deriveCrashOrphanedManagers, isSupersededByRecycle } = await import("../dist/orchestration/crash-orphaned-workers.js");
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

  // ==================== (A3) card 6e5af155 (RETRACTED, round 3) — a durably-resumable but PRE-READY
  // halted successor is STILL reclaimed exactly like (A)'s unresumable one ====================
  // Card 6e5af155 explored leaving a dead-but-resumable halted successor alone instead of reclaiming
  // whatever DID transfer to it. Round 3 RETRACTED that premise: the kickoff/handoff is delivered only
  // post-ready (scheduleKickoffGuarantee, pty/host.ts, runs from inside markReady strictly AFTER
  // live.ready is set), so a successor that died before ever reaching ready — which is ALL this scenario
  // (and (A)) ever construct — never received any instruction at all; a captured engine id + empty
  // transcript is not context worth preserving. See docs/decisions/6e5af155-… for the full argument,
  // including the one PRE-EXISTING (card f1969787, unrelated to this card) ordering wrinkle in
  // watchHaltedRecycleSuccessor itself (it checks `!isAlive` BEFORE `hasReachedReady`, unlike
  // settleRecycleHandoff) that in principle lets a GENUINELY ready-then-died successor reach this same
  // branch too — carded separately as a narrower, out-of-scope follow-up, not exercised here.
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmhsd-a3";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId } = seedFleet(db, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — forcing a halt, then the durably-resumable successor dies before ready");
    unstub();

    check("(A3 pre) the recycle HALTED (ownership_transfer_failed event fired)", hasEvent(db, m2.id, "recycle_ownership_transfer_failed"));
    check("(A3 pre) the worker DID transfer onto M2", db.getSession(workerId)?.parentSessionId === m2.id);
    check("(A3 pre) the wake is STRANDED on M1 (never transferred)", db.listWakesForSession(m1.id).some((w) => w.id === `${m1.id}-wake`));

    // M2 captures a real engine id + transcript (SessionStart landed) — the ONE difference from (A)'s
    // own M2, which never captures one at all. Proven true here so this scenario can't be satisfied
    // vacuously by an unresumable M2 the same way (A) already is.
    const engineSessionId = `eng-${m2.id}`;
    db.setEngineSessionId(m2.id, engineSessionId);
    writeFakeTranscript(m2.cwd, engineSessionId);
    check("(A3 setup) M2 DOES carry a real engine id — the discriminating setup vs (A)", db.getSession(m2.id)?.engineSessionId === engineSessionId);
    check("(A3 setup) M2 has NOT reached ready — no kickoff was ever delivered", host.hasReachedReady(m2.id) === false);

    const m2Pty = host.handles.get(m2.id);
    check("(A3 setup) M2's fake pty handle captured", !!m2Pty);
    m2Pty.kill(); // dies before ever reaching ready — despite carrying a real engine id

    const settled = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_recovered"));
    check("(A3) FIX (retracted premise): the ORDINARY reclaim fires — a captured engine id alone never earns a leave-alone", settled);

    check("(A3) the worker (which DID transfer) is reclaimed back onto M1 — NOT left stranded on the resumable-but-blank M2", db.getSession(workerId)?.parentSessionId === m1.id);
    check("(A3) M1 was NEVER stopped — still alive", host.isAlive(m1.id) === true);
    check("(A3) hasSuccessor(M1) is now false (M2 unlinked, exactly like (A))", db.hasSuccessor(m1.id) === false);
    check("(A3) M2 IS archived (never left resumable for crash-recovery to resurrect blank)", !!db.getSession(m2.id)?.archivedAt);
    check("(A3) the never-transferred wake is still on M1, untouched by the reclaim", db.listWakesForSession(m1.id).some((w) => w.id === `${m1.id}-wake`));
    check("(A3) no recycle_successor_down_resumable event exists — that event kind was retracted with the gate", !hasEvent(db, m1.id, "recycle_successor_down_resumable"));
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

  // ==================== (C) FIX 386e4eb5 — a still-split, still-MATCHING halted predecessor IS captured + resumed ====================
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

    // M1 is still genuinely `live` at capture time (never stopped — the halt branch keeps it live
    // forever) AND its current successor M2 still EXACTLY matches its own latest unresolved halt event
    // (id + gen, nothing reclaimed or re-recycled since) — `liveFleetResumeSet` must now INCLUDE it.
    const preRestartFleet = sessions1.liveFleetResumeSet();
    check("(C) FIX 386e4eb5: liveFleetResumeSet INCLUDES the still-live, still-matching halted predecessor", preRestartFleet.some((e) => e.sessionId === m1.id));
    check("(C) the surviving successor M2 IS captured too", preRestartFleet.some((e) => e.sessionId === m2.id));
    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const { sessions: sessions2, haltedFinish } = runRealBootSequenceUpToResume(db2, host2);
    check("(C) the halted-reconcile left the still-resumable lineage untouched", haltedFinish.recovered.length === 0);
    check("(C pre-resume) hasSuccessor(M1) is STILL true going into the fleet resume", db2.hasSuccessor(m1.id) === true);

    let thrown;
    let resumedDirect;
    try { resumedDirect = sessions2.resume(m1.id); } catch (e) { thrown = e; }
    check("(C) FIX 386e4eb5: resume() called DIRECTLY now SUCCEEDS for the still-matching halted predecessor",
      !thrown && resumedDirect?.id === m1.id);

    // Card 6859f9e7's own test shape (DoD): the restart is requested by M2 (the surviving successor,
    // post-handoff) — NOT by M1 — so M1 is exercised purely through the ORDINARY entries loop
    // (liveFleetResumeSet's capture), never through resumeFleetOnBoot's separate "requester" branch. M1
    // was just resumed directly above (host2 now has a live entry for it) — resumeFleetOnBoot's own
    // already-live short-circuit (resume()'s `pty.isAlive` check) makes a second attempt here a no-op
    // success, which is still correctly counted as `resumed`, not `failed`.
    const restartIntent = { reason: "test", managerSessionId: m2.id, resume: preRestartFleet };
    const { resumed, failed } = sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS });
    check("(C) FIX 386e4eb5: M1 (the halted-but-matching predecessor) IS resumed via the ordinary fleet-resume pass", resumed.includes(m1.id));
    check("(C) the surviving successor M2 (the restart requester here) is ALSO resumed normally — two live managers is the correct end state (ownership genuinely still split)", resumed.includes(m2.id));
    check("(C) hasSuccessor(M1) is STILL true after the attempt — nothing unlinked it (no reclaim happened, just an ordinary resume)", db2.hasSuccessor(m1.id) === true);
    check("(C) no fleet_resume_failed event was fabricated for this restart", !hasEvent(db2, m1.id, "fleet_resume_failed") && !hasEvent(db2, m2.id, "fleet_resume_failed") && failed.length === 0);
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

  // ==================== (E) FIX 386e4eb5 — CRASH PATH: the still-matching lineage IS a crash-recovery candidate ====================
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
    check("(E) FIX 386e4eb5: M1 IS a crash-recovery candidate — its successor still matches its unresolved halt", crashOrphanedManagers.includes(m1.id));
    check("(E) M2 (the surviving successor) is STILL a crash-recovery candidate too", crashOrphanedManagers.includes(m2.id));

    const { managersFailed } = sessions2.recoverCrashOrphanedWorkers(crashOrphanedWorkers, { soloManagerIds: crashOrphanedManagers });
    // `recoverCrashOrphanedWorkers`'s own `resumed` array only ever carries WORKER session ids (never a
    // manager's own id, even on a successful solo-manager resume) — a manager's success is "not in
    // managersFailed" AND actually live, which is what we assert directly below.
    check("(E) FIX 386e4eb5: M1 IS resumed via the crash path — not in managersFailed", !managersFailed.includes(m1.id));
    check("(E) M1 is genuinely live again after the crash-path resume", host2.isAlive(m1.id) === true);
    check("(E) M2 IS ALSO resumed via the crash path — two live managers is the correct end state here", !managersFailed.includes(m2.id));
    check("(E) M2 is genuinely live again too", host2.isAlive(m2.id) === true);
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

  // ==================== (G) A DIFFERENT SUCCESSOR (ID MISMATCH) — a cleanly re-recycled lineage is left untouched ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-g";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    // M1 never captures a real engine id either — deliberately, so the UNRELATED ordinary settle-reconcile
    // (08c81809, armed by the second/clean recycle below) ALSO can't reclaim S2 back onto M1. That isolates
    // this scenario to the ONE thing it's actually proving: the halted reconcile's own id-mismatch guard
    // (gen is checked too, but only as a defensive secondary check — S1 and S2 share the SAME gen here,
    // both P.gen+1, so id is what actually discriminates), uncontaminated by the ordinary mechanism
    // legitimately doing its own, unrelated job.

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

  // ==================== (G') A DIFFERENT SUCCESSOR (ID MISMATCH), GUARD-DISCRIMINATING — M1 IS durably resumable ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-g2";
    seedProject(db1, P);
    // startupModeCycles:0 (mirrors (A2) / recycle-manager-fleet-recovery.mjs's own happy-path scenario C):
    // S2's markReady below must run SYNCHRONOUSLY off the deliverHook call, not behind an async mode-cycle.
    db1.setProjectConfig(P, { permission: { startupModeCycles: 0 } });
    const m1 = sessions1.startManager(`${P}-mgr`);
    // UNLIKE (G): M1 captures a REAL engine id + transcript here, so isDurablyResumable(M1) is TRUE — the
    // one change that stops the NEVER RESURRECT gate from masking the id-mismatch guard's own effect.
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
    const { sessions: sessions2, haltedEarly } = runRealBootSequenceUpToResume(db2, host2);

    check("(G') FIX: the stale halt event (naming dead S1) is NOT mistaken for M1's CURRENT, durably-resumable successor S2 — no reparent recorded for M1",
      !haltedEarly.recovered.some((r) => r.predecessorId === m1.id));
    // R1 (card 386e4eb5's own DoD: halt, reclaim, clean re-recycle ⇒ refused) — asserted DIRECTLY through
    // the actual changed predicate/resume(), not just through the boot-reconcile side above. M1 IS durably
    // resumable here (the one thing (G) deliberately wasn't), so if 386e4eb5's carve-out were wrongly keyed
    // on bare event presence instead of the exact id+gen match, THIS is where it would wrongly let M1 back in.
    check("(R1) FIX 386e4eb5: isSupersededByRecycle(M1) is TRUE — its current successor (S2) does NOT match the stale halt event (naming dead S1)", isSupersededByRecycle(db2, m1.id) === true);
    let r1Thrown;
    try { sessions2.resume(m1.id); } catch (e) { r1Thrown = e; }
    check("(R1) FIX 386e4eb5: resume() still REFUSES M1 directly, even though it is durably resumable",
      !!r1Thrown && /recycled.*successor exists/.test(r1Thrown.message));
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

  // ==================== (H) R2 — CRASH BETWEEN READY AND SETTLE: only the new successor ends up live ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-h";
    seedProject(db1, P);
    // markReady must run SYNCHRONOUSLY off the deliverHook call below (same reasoning as (A2)/(G')) — the
    // whole point of this scenario is to close db1 with NO await between S2 reaching ready and the crash,
    // so readiness must be observable the instant deliverHook returns.
    db1.setProjectConfig(P, { permission: { startupModeCycles: 0 } });
    const m1 = sessions1.startManager(`${P}-mgr`);
    // M1 captures a REAL engine id + transcript so the LAST assertion below exercises the actual
    // superseded/hasSuccessor refusal, never masked by an earlier "no engine id" refusal.
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-h" });
    writeFakeTranscript(m1.cwd, "eng-m1-h");

    // First halt: M1 -> S1, then S1 dies before reaching ready — the in-process watch reclaims ownership
    // back onto M1, filing the PERMANENT recycle_ownership_transfer_failed event naming S1 — identical to
    // (G)/(G')'s own first half.
    const unstub = stubWakesPermanentFailure();
    const s1 = await sessions1.recycleManager(m1.id, "handoff — first halt, S1 will die and be reclaimed");
    unstub();
    check("(H pre) the first recycle HALTED (naming S1)", hasEvent(db1, s1.id, "recycle_ownership_transfer_failed"));
    const s1Pty = host1.handles.get(s1.id);
    s1Pty.kill();
    const reclaimed = await waitUntil(() => hasEvent(db1, m1.id, "recycle_fleet_recovered"));
    check("(H pre) S1's death was reclaimed back onto M1", reclaimed);
    check("(H pre) hasSuccessor(M1) is false again after the reclaim", db1.hasSuccessor(m1.id) === false);

    // M1 now cleanly re-recycles to a BRAND NEW successor S2 — an ORDINARY recycle, no stub. UNLIKE (G'),
    // S2 WILL capture a real engine id + transcript (durably resumable) — R2 needs the ordinary
    // settle-lost-to-restart mechanism (08c81809) to actually be ABLE to resume S2 for real at boot, not
    // merely decline to touch it.
    const s2 = await sessions1.recycleManager(m1.id, "handoff — a clean re-recycle; the crash lands before settle observes readiness");
    check("(H pre) the second recycle did NOT halt", !hasEvent(db1, s2.id, "recycle_ownership_transfer_failed"));
    check("(H pre) hasSuccessor(M1) now points at S2", db1.getSuccessor(m1.id)?.id === s2.id);

    // THE RACE WINDOW: deliver S2's SessionStart hook (captures its engine id AND marks it ready,
    // synchronously, per startupModeCycles:0 above) and write its transcript, then close db1 IMMEDIATELY —
    // no `await` anywhere in between. settleRecycleHandoff's own poll loop's first await is a
    // RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS (40ms) setTimeout; since nothing here ever yields the event
    // loop, that timer cannot have fired, so the in-process watch can NEVER have observed S2's readiness or
    // stopped M1 — this deterministically simulates the crash landing in the exact gap between "successor
    // reached ready" and "predecessor actually stopped", with no sleep/poll of any kind.
    host1.deliverHook(s2.id, { hook_event_name: "SessionStart", session_id: "eng-s2-h" });
    writeFakeTranscript(s2.cwd, "eng-s2-h");
    check("(H pre) S2 reached real ready synchronously, with NO settle observation yet", host1.hasReachedReady(s2.id) === true);
    check("(H pre) M1 was NEVER stopped — the settle loop never got a chance to observe readiness", host1.isAlive(m1.id) === true);
    db1.close();

    const { db: db2, host: host2 } = makeBoot();
    const { sessions: sessions2, early, finish, crashOrphanedWorkers, crashOrphanedManagers } = (() => {
      const { early, haltedEarly, recovered, crashOrphanedWorkers, crashOrphanedManagers } = runBootRecoveryPrefix(db2);
      const sessions = new SessionService(db2, host2, new OrchestrationControl());
      const finish = sessions.finishReconcilingRecycleSettles(early);
      sessions.finishReconcilingHaltedRecycleSuccessors(haltedEarly);
      return { sessions, early, finish, recovered, crashOrphanedWorkers, crashOrphanedManagers };
    })();

    check("(H) the ordinary (non-halted) settle-reconcile correctly classified S2 as `deferred` (reached ready, still linked)", early.deferred.some((d) => d.predecessorId === m1.id && d.freshId === s2.id));
    check("(H) R2: the later phase actually RESUMED S2 for real (durably resumable)", finish.confirmedLiveSuccessors.includes(s2.id));
    check("(H) R2: M1 was NEVER recovered/resumed by the ordinary settle-reconcile — this is S2's world now", !finish.recoveredPredecessors.includes(m1.id));
    check("(H) R2: ONLY the new successor ends up live — S2 is live", db2.getSession(s2.id)?.processState === "live");
    // M1's CURRENT successor is S2, which does NOT match the stale halt event naming dead S1 — the
    // 386e4eb5 carve-out correctly does NOT apply here either, so M1 stays excluded from every automatic
    // path going forward (a different successor — S2, not S1 — the same id-mismatch shape R1/(G)/(G')
    // already prove, now composed with the ordinary settle-reconcile's own race-window recovery).
    check("(H) R2: M1 stays superseded/excluded going forward (a different successor than its halt event named, same as R1)", isSupersededByRecycle(db2, m1.id) === true);
    let h2Thrown;
    try { sessions2.resume(m1.id); } catch (e) { h2Thrown = e; }
    check("(H) R2: resume() still refuses M1 directly", !!h2Thrown && /recycled.*successor exists/.test(h2Thrown.message));

    // Code Review 1f3951a5 Minor: the PRIOR end-state check ("M1 stays exited") was VACUOUS — nothing above
    // ever gives the crash-recovery resume path a chance to actually touch M1 (recoverCrashOrphanedWorkers/
    // resumeFleetOnBoot never run in this scenario), so M1 "stays exited" merely because nothing acted on
    // it at all, regardless of whether the superseded predicate is even correct. Actually run the real
    // crash-path candidate derivation + resume attempt here so this goes RED under the bare-event-presence
    // mutant on its own, the same way (E) proves the POSITIVE (halted-and-matching) side of this predicate.
    check("(H) R2 FIX 386e4eb5: M1 is NOT a crash-recovery candidate — its current successor (S2) does not match the stale halt event naming dead S1", !crashOrphanedManagers.includes(m1.id));
    check("(H) S2 (the surviving successor) IS still a crash-recovery candidate", crashOrphanedManagers.includes(s2.id));
    const { managersFailed } = sessions2.recoverCrashOrphanedWorkers(crashOrphanedWorkers, { soloManagerIds: crashOrphanedManagers });
    check("(H) R2 FIX: the REAL crash-recovery resume attempt leaves M1 untouched — not live", host2.isAlive(m1.id) === false);
    check("(H) R2 FIX: ONLY the new successor ends up live — M1 stays exited, now genuinely exercised (not vacuous)", db2.getSession(m1.id)?.processState === "exited");
    check("(H) R2: M1 was never even attempted (excluded candidate), so it cannot appear in managersFailed either", !managersFailed.includes(m1.id));
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a halted recycle's successor-death watch reclaims whatever DID transfer (in-process and across a boot reconcile); card 386e4eb5's isSupersededByRecycle carve-out correctly auto-resumes a halted predecessor ONLY while its successor still exactly matches its latest unresolved halt (id — the real discriminator; gen only a defensive secondary check) — via resume(), the crash-recovery candidate derivation, and resumeFleetOnBoot's capture alike — while an ordinary recycle, a re-recycle to a different successor (id mismatch) than its halt event named, and a both-dead lineage all stay refused exactly as before."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
