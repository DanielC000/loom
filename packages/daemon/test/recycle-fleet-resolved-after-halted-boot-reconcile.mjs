import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d9512de7 — investigation (see docs/decisions/d9512de7-*.md) enumerated every exit of the
// boot-restart path for a halted lineage whose latest event is an unresolved `recycle_fleet_unresolved`
// alert and found NONE of them (reconcileHaltedRecycleSuccessorsEarly/finishReconcilingHaltedRecycleSuccessors,
// resumeFleetOnBoot, recoverCrashOrphanedWorkers, the shared resume(), PtyHost.markReady) ever file the
// matching recycle_fleet_resolved when the successor is durably resumable and was LIVE (or starting) at
// the restart, so it is auto-resumed by resumeFleetOnBoot/recoverCrashOrphanedWorkers and reaches ready
// within the observer's own bound. A successor already EXITED before the restart (the
// reason:"halted-waiting-crash-recovery" alert shape) is a NAMED RESIDUAL this card does not cover — see
// the decision record and follow-up card 49107314. db4b778c's own fix only covers the two LIVE in-memory
// ready branches
// (settleRecycleHandoff/watchHaltedRecycleSuccessor) — neither survives a daemon restart, and
// watchHaltedRecycleSuccessor is never re-armed at boot (an accepted, recorded residual — f1969787/91ac2b79).
//
// The LEAD's ruling (see the decision record) rejected resolving this from the early DB-only pass alone,
// and rejected calling resume() a second time from the reconcile pass — resumeFleetOnBoot/
// recoverCrashOrphanedWorkers already own that. The fix instead arms a bounded, fire-and-forget observer
// (SessionService.waitForHaltedSuccessorReadyThenResolve) per still-open lineage, which polls
// pty.hasReachedReady and files exactly one recycle_fleet_resolved once it actually observes readiness —
// reusing RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS/_POLL_MS rather than new constants.
//
// Proves:
//   (K1) RESTART-INTENT PATH (daemon_restart): an unresolved alert fires pre-restart; the successor is
//        durably resumable and survives the simulated restart; resumeFleetOnBoot resumes it; it reaches
//        ready again — the observer files EXACTLY ONE recycle_fleet_resolved, naming the successor.
//   (K2) CRASH PATH (no RestartIntent): identical shape to (K1), but recovered via a call to the real
//        recoverCrashOrphanedWorkers resume machinery with soloManagerIds HAND-PASSED as [m1.id, m2.id] —
//        this proves the observer resolves once that resume machinery revives M2; it does NOT prove the
//        real deriveCrashOrphanedManagers selection would itself have picked M2 as a candidate.
//   (K3) NEVER REACHES READY: the successor is resumed but never reaches ready within the bound — the
//        observer gives up silently; no recycle_fleet_resolved is fabricated, and the alert stays open.
//   (K4) NO PRIOR UNRESOLVED: the restart lands before the live watch's own alert ever fires — the early
//        phase never arms an observer at all (pendingResolution is empty), and no resolved event appears
//        even once the successor reaches ready after boot.
//   (K5) ANOTHER PATH RESOLVES FIRST: two stand-down shapes, each proving the observer never duplicates —
//        (a) a `recycle_fleet_resolved` already exists for this exact pair (some other path got there
//        first) when the observer sees readiness — still exactly one total, never a second; (b) a
//        `recycle_ownership_transfer_resolved` names this successor (a live recycle_reattempt took the
//        lineage over, b59d11f6-style) — the observer stands down and files nothing, leaving that
//        responsibility to settleRecycleHandoff's own ready branch.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: mirrors recycle-manager-halted-successor-dies.mjs
// and recycle-fleet-resolved-after-halted-settle.mjs's own harnesses exactly — a REAL Db + SessionService +
// PtyHost driven against the shared fake-pty seam; a restart is simulated by closing db1 and reopening the
// SAME fixed file as db2 (Db() always opens the one file derived from LOOM_HOME).
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-fleet-resolved-after-halted-boot-reconcile.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

const tmpHome = path.join(os.tmpdir(), `loom-rfrahbr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every settle bound BEFORE importing dist/** — the same constants back BOTH the pre-restart
// live watch's own alert AND the new post-restart observer's own give-up bound. Unlike recycle-fleet-
// resolved-after-halted-settle.mjs's siblings (which only ever touch a LIVE, never-restarted pty), every
// scenario here RESUMES a session post-restart — a resume always carries a non-null resumeModeTarget
// (sessions/service.ts), which routes SessionStart through cycleToMode's async footer-read machinery; the
// fake pty never produces footer output, so that machinery can only ever settle via its own bounded
// fallback (mirrors recycle-manager-halted-successor-dies.mjs scenario (A4)'s own identical env pattern).
// RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS must comfortably exceed READY_FALLBACK_ABSOLUTE_CEILING_MS, or the
// observer gives up before a resumed session's own readiness fallback ever gets a chance to fire.
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = "20";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = "20";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = "1500";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_SLOW_POLL_MS = "2000";
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";
process.env.LOOM_MODE_CYCLE_FALLBACK_MS = "60000";
process.env.LOOM_READY_FALLBACK_ABSOLUTE_CEILING_MS = "200";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { runBootRecoveryPrefix } = await import("../dist/sessions/boot-backstop.js");
const { CLEAN_STALENESS } = await import("./_deploy-staleness-fixture.mjs");

const repo = path.join(os.tmpdir(), `loom-rfrahbr-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# recycle-fleet-resolved-after-halted-boot-reconcile test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rfrahbr@loom -c user.name=rfrahbr");

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

function seedProject(db, id) {
  const now = new Date().toISOString();
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  // startupModeCycles:0 — markReady runs synchronously off a single SessionStart hook delivery (mirrors
  // every sibling recycle test's own identical reasoning).
  db.setProjectConfig(id, { permission: { startupModeCycles: 0 } });
}

function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

const eventsOfKind = (db, id, kind) => db.listEventsForSession(id).filter((e) => e.kind === kind);
const hasEvent = (db, id, kind) => eventsOfKind(db, id, kind).length > 0;

function stubWakesPermanentFailure() {
  const original = Db.prototype.reparentWakes;
  Db.prototype.reparentWakes = function () { throw new Error("injected PERMANENT failure (recycle-fleet-resolved-after-halted-boot-reconcile test)"); };
  return () => { Db.prototype.reparentWakes = original; };
}

/** Halts m1->m2 in a fresh project, gives BOTH a real engine id + transcript (durably resumable across a
 *  simulated restart — mirrors recycle-manager-halted-successor-dies.mjs scenario (C)'s own setup), and —
 *  unless `skipAlert` is set — waits for the live watch's own `recycle_fleet_unresolved` alert to fire
 *  before returning, capturing `preRestartFleet` right before the caller closes db1. */
async function setupHaltedLineage(projectSuffix, { skipAlert = false } = {}) {
  const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
  const P = `rfrahbr-${projectSuffix}`;
  seedProject(db1, P);
  const m1 = sessions1.startManager(`${P}-mgr`);
  host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: `eng-m1-${projectSuffix}` });
  writeFakeTranscript(m1.cwd, `eng-m1-${projectSuffix}`);

  let watchPromise;
  const originalWatch = SessionService.prototype.watchHaltedRecycleSuccessor;
  SessionService.prototype.watchHaltedRecycleSuccessor = function (...args) {
    watchPromise = originalWatch.apply(this, args);
    return watchPromise;
  };
  const unstub = stubWakesPermanentFailure();
  const m2 = await sessions1.recycleManager(m1.id, `handoff — halted lineage surviving a restart (${projectSuffix})`);
  unstub();
  SessionService.prototype.watchHaltedRecycleSuccessor = originalWatch;
  if (!hasEvent(db1, m2.id, "recycle_ownership_transfer_failed")) throw new Error(`setup failed to halt (${projectSuffix})`);

  // M2 DOES durably survive the restart — a real engine id + transcript, set DIRECTLY on the DB (mirrors
  // recycle-manager-halted-successor-dies.mjs scenario (A3)'s own technique) rather than via a real
  // SessionStart hook delivery — a hook delivery would ALSO flip M2 reached-ready in host1's live map,
  // which would let the watch's OWN ready branch (db4b778c) resolve this in-process before we ever get to
  // simulate the restart, defeating the whole point of this scenario.
  const engineSessionId = `eng-m2-${projectSuffix}`;
  db1.setEngineSessionId(m2.id, engineSessionId);
  writeFakeTranscript(m2.cwd, engineSessionId);

  if (!skipAlert) {
    const alerted = await waitUntil(() => hasEvent(db1, m1.id, "recycle_fleet_unresolved"));
    if (!alerted) throw new Error(`setup failed to alert unresolved (${projectSuffix})`);
  }

  const preRestartFleet = sessions1.liveFleetResumeSet(); // captured BEFORE the restart, mirrors scenario (C)
  db1.close();
  return { m1, m2, preRestartFleet };
}

/** Runs the real boot-reconcile sequence against `db2`/`host2` (mirrors
 *  recycle-manager-halted-successor-dies.mjs's own runRealBootSequenceUpToResume), capturing the new
 *  observer's own promise per (predecessorId, freshId) pair so a scenario can await it directly. */
function runBootSequence(db2, host2) {
  const { haltedEarly } = runBootRecoveryPrefix(db2);
  const sessions2 = new SessionService(db2, host2, new OrchestrationControl());
  const waiterPromises = new Map(); // freshId -> promise
  const original = SessionService.prototype.waitForHaltedSuccessorReadyThenResolve;
  SessionService.prototype.waitForHaltedSuccessorReadyThenResolve = function (predecessorId, freshId) {
    const p = original.call(this, predecessorId, freshId);
    waiterPromises.set(freshId, p);
    return p;
  };
  const haltedFinish = sessions2.finishReconcilingHaltedRecycleSuccessors(haltedEarly);
  SessionService.prototype.waitForHaltedSuccessorReadyThenResolve = original;
  return { sessions2, haltedEarly, haltedFinish, waiterPromises };
}

try {
  // ==================== (K1) RESTART-INTENT PATH — resumeFleetOnBoot ====================
  {
    const { m1, m2, preRestartFleet } = await setupHaltedLineage("k1");
    const { db: db2, host: host2 } = makeBoot();
    const { haltedEarly, haltedFinish, sessions2, waiterPromises } = runBootSequence(db2, host2);

    // NOTE: the test harness's Db() is a singleton keyed to LOOM_HOME, so every scenario in this file
    // shares one accumulating on-disk database — every check below is scoped to THIS scenario's own
    // m1/m2 ids (mirrors recycle-manager-halted-successor-dies.mjs's own .some()/.includes() style),
    // never a bare array length, which would wrongly fail once an EARLIER scenario's lineage (still
    // genuinely open, e.g. (K3)'s) is re-scanned by a LATER scenario's own boot-reconcile pass.
    check("(K1) the early phase recorded the pair in pendingResolution", haltedEarly.pendingResolution.some((e) => e.predecessorId === m1.id && e.freshId === m2.id));
    check("(K1) the later phase armed an observer naming M2", haltedFinish.pendingResolutionArmed.includes(m2.id));
    check("(K1) the early phase left THIS lineage untouched (no reclaim)", !haltedFinish.recovered.includes(m1.id));
    const waiterPromise = waiterPromises.get(m2.id);
    check("(K1 setup) the observer's own promise was captured", !!waiterPromise);

    const restartIntent = { reason: "test", managerSessionId: m2.id, resume: preRestartFleet };
    const { resumed, failed } = sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS });
    check("(K1) M1 (the halted-but-matching predecessor) IS resumed via the ordinary fleet-resume pass", resumed.includes(m1.id));
    check("(K1) M2 (the surviving successor) is ALSO resumed normally", resumed.includes(m2.id));
    check("(K1) nothing failed to resume", failed.length === 0);

    host2.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: `eng-m2-k1` });
    // A RESUME (unlike a fresh spawn) routes SessionStart through cycleToMode's async footer-read
    // machinery; the fake pty produces no footer output, so readiness only arrives via the bounded
    // fallback (LOOM_READY_FALLBACK_ABSOLUTE_CEILING_MS) — never synchronous off the hook itself.
    const reachedReady = await waitUntil(() => host2.hasReachedReady(m2.id) === true);
    check("(K1) M2 reached real ready, post-restart (via the resume's own bounded mode-cycle fallback)", reachedReady);

    await waiterPromise; // resolves the instant the observer's own next poll observes ready

    check("(K1) FIX d9512de7: EXACTLY ONE recycle_fleet_resolved was filed", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 1);
    const resolved = eventsOfKind(db2, m1.id, "recycle_fleet_resolved")[0];
    check("(K1) the resolved event names M2 as the successor", resolved?.detail?.successorId === m2.id);
    check("(K1) M1 was never stopped by the observer — it has no stopping authority (f1969787)", host2.isAlive(m1.id) === true && !host2.stoppedIds.has(m1.id));
    db2.close();
  }

  // ==================== (K2) CRASH PATH — recoverCrashOrphanedWorkers ====================
  {
    const { m1, m2 } = await setupHaltedLineage("k2");
    const { db: db2, host: host2 } = makeBoot();
    const { haltedEarly, haltedFinish, sessions2, waiterPromises } = runBootSequence(db2, host2);
    check("(K2) the early phase recorded the pair in pendingResolution", haltedEarly.pendingResolution.some((e) => e.predecessorId === m1.id && e.freshId === m2.id));
    const waiterPromise = waiterPromises.get(m2.id);
    check("(K2 setup) the observer's own promise was captured", !!waiterPromise);

    // Neither M1 nor M2 has any worker in this test — drive them as solo-manager crash candidates
    // directly, mirroring recycle-manager-halted-successor-dies.mjs scenario (E)'s own crash-path resume,
    // without re-deriving candidates off a second raw boot pass (runBootSequence's own
    // runBootRecoveryPrefix call already consumed recoverStaleSessions once).
    const { managersFailed } = sessions2.recoverCrashOrphanedWorkers([], { soloManagerIds: [m1.id, m2.id] });
    check("(K2) M1 IS resumed via the crash path — not in managersFailed", !managersFailed.includes(m1.id));
    check("(K2) M1 is genuinely live again after the crash-path resume", host2.isAlive(m1.id) === true);
    check("(K2) M2 IS ALSO resumed via the crash path", !managersFailed.includes(m2.id));
    check("(K2) M2 is genuinely live again too", host2.isAlive(m2.id) === true);

    host2.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: `eng-m2-k2` });
    const reachedReady = await waitUntil(() => host2.hasReachedReady(m2.id) === true);
    check("(K2) M2 reached real ready, post-restart (via the resume's own bounded mode-cycle fallback)", reachedReady);

    await waiterPromise;

    check("(K2) FIX d9512de7: EXACTLY ONE recycle_fleet_resolved was filed via the crash path too", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 1);
    const resolved = eventsOfKind(db2, m1.id, "recycle_fleet_resolved")[0];
    check("(K2) the resolved event names M2 as the successor", resolved?.detail?.successorId === m2.id);
    db2.close();
  }

  // ==================== (K3) NEVER REACHES READY — the observer gives up silently ====================
  {
    const { m1, m2, preRestartFleet } = await setupHaltedLineage("k3");
    const { db: db2, host: host2 } = makeBoot();
    const { haltedFinish, sessions2, waiterPromises } = runBootSequence(db2, host2);
    const waiterPromise = waiterPromises.get(m2.id);
    check("(K3 setup) an observer was armed naming M2", haltedFinish.pendingResolutionArmed.includes(m2.id));
    check("(K3 setup) the observer's own promise was captured", !!waiterPromise);

    const restartIntent = { reason: "test", managerSessionId: m2.id, resume: preRestartFleet };
    sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS });
    check("(K3 setup) M2 is resumed (alive) but deliberately never delivered a SessionStart hook", host2.isAlive(m2.id) === true && host2.hasReachedReady(m2.id) === false);

    await waiterPromise; // resolves once the observer's own deadline passes with no ready observed

    check("(K3) FIX d9512de7: NO recycle_fleet_resolved was fabricated — the successor never reached ready", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 0);
    const { openUnresolvedRecycleFleetAlert } = await import("../dist/orchestration/crash-orphaned-workers.js");
    check("(K3) the unresolved alert is still genuinely open — nothing claimed a resolution it didn't observe", !!openUnresolvedRecycleFleetAlert(db2, m1.id, m2.id));
    db2.close();
  }

  // ==================== (K4) NO PRIOR UNRESOLVED — the early phase never arms an observer ====================
  {
    const { m1, m2 } = await setupHaltedLineage("k4", { skipAlert: true });
    const { db: db2, host: host2 } = makeBoot();
    const { haltedEarly, haltedFinish, sessions2 } = runBootSequence(db2, host2);

    check("(K4) no recycle_fleet_unresolved event exists for M1 at all", !hasEvent(db2, m1.id, "recycle_fleet_unresolved"));
    check("(K4) FIX d9512de7: no pendingResolution entry exists for THIS lineage — it never alerted", !haltedEarly.pendingResolution.some((e) => e.predecessorId === m1.id && e.freshId === m2.id));
    check("(K4) no observer was armed for THIS lineage either", !haltedFinish.pendingResolutionArmed.includes(m2.id));

    sessions2.resume(m2.id); // M2 already carries its real engine id/transcript from setup
    host2.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: `eng-m2-k4` });
    const reachedReady = await waitUntil(() => host2.hasReachedReady(m2.id) === true);
    check("(K4 setup) M2 reached real ready, post-restart (via the resume's own bounded mode-cycle fallback)", reachedReady);
    check("(K4) no recycle_fleet_resolved appears even once M2 reaches ready — there was nothing to resolve", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 0);
    db2.close();
  }

  // ==================== (K5a) ANOTHER PATH RESOLVES FIRST — a recycle_fleet_resolved already exists ====================
  {
    const { m1, m2, preRestartFleet } = await setupHaltedLineage("k5a");
    const { db: db2, host: host2 } = makeBoot();
    const { haltedFinish, sessions2, waiterPromises } = runBootSequence(db2, host2);
    const waiterPromise = waiterPromises.get(m2.id);
    check("(K5a setup) an observer was armed naming M2", haltedFinish.pendingResolutionArmed.includes(m2.id));

    const restartIntent = { reason: "test", managerSessionId: m2.id, resume: preRestartFleet };
    sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS });

    // Simulate another path (e.g. a human admin action) having already resolved this exact pair BEFORE
    // the observer ever sees readiness.
    db2.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(), managerSessionId: m1.id,
      kind: "recycle_fleet_resolved", detail: { successorId: m2.id },
    });
    check("(K5a setup) a recycle_fleet_resolved already exists, filed by \"another path\"", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 1);

    host2.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: `eng-m2-k5a` });
    await waiterPromise; // the observer's own next poll must see the alert no longer matches and stand down

    check("(K5a) FIX d9512de7: STAND-DOWN — still exactly ONE recycle_fleet_resolved, never duplicated", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 1);
    db2.close();
  }

  // ==================== (K5b) ANOTHER PATH RESOLVES FIRST — recycle_ownership_transfer_resolved (b59d11f6-style) ====================
  {
    const { m1, m2, preRestartFleet } = await setupHaltedLineage("k5b");
    const { db: db2, host: host2 } = makeBoot();
    const { haltedFinish, sessions2, waiterPromises } = runBootSequence(db2, host2);
    const waiterPromise = waiterPromises.get(m2.id);
    check("(K5b setup) an observer was armed naming M2", haltedFinish.pendingResolutionArmed.includes(m2.id));

    const restartIntent = { reason: "test", managerSessionId: m2.id, resume: preRestartFleet };
    sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS });

    // Simulate a live recycle_reattempt having resolved the lineage via the OTHER mechanism (b59d11f6) —
    // settleRecycleHandoff now owns this lineage and will file its own recycle_fleet_resolved via its own
    // ready branch; this observer must stand down and file NOTHING.
    db2.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(), managerSessionId: m2.id, workerSessionId: m1.id,
      kind: "recycle_ownership_transfer_resolved", detail: { successorId: m2.id },
    });
    check("(K5b setup) a recycle_ownership_transfer_resolved now names M2 for M1", hasEvent(db2, m1.id, "recycle_ownership_transfer_resolved"));

    host2.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: `eng-m2-k5b` });
    await waiterPromise; // the observer's own next poll must see this and stand down

    check("(K5b) FIX d9512de7: STAND-DOWN (b59d11f6) — the observer filed NO recycle_fleet_resolved, leaving it to settleRecycleHandoff's own ready branch", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 0);
    db2.close();
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a halted lineage's durably-resumable successor, auto-resumed across a daemon restart or crash reboot, files EXACTLY ONE recycle_fleet_resolved once it actually reaches ready (never before, never when it doesn't, never when no alert was ever open, and never a duplicate when another path got there first)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
