import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 49107314 (see docs/decisions/49107314-*.md) — d9512de7's boot-time observer
// (waitForHaltedSuccessorReadyThenResolve, armed once from finishReconcilingHaltedRecycleSuccessors) only
// waits RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS (~55s in production) from the moment it is ARMED. A successor
// that was already EXITED (not live/starting) at the moment of a restart — the
// reason:"halted-waiting-crash-recovery" alert shape — is invisible to liveFleetResumeSet/
// recoverStaleSessions, so neither resumeFleetOnBoot nor the crash-path derivations ever revive it; only
// CrashRecoveryWatcher (or a human's manual resume) does.
//
// Fix: SessionService.resume() (the ONE chokepoint every revival path funnels through — CrashRecoveryWatcher's
// own resume call, resumeFleetOnBoot, and a human's manual resume) now calls
// armHaltedSuccessorReadyObserverIfRevived(sessionId) right before each of its two successful-revival
// returns. It re-arms the SAME bounded waitForHaltedSuccessorReadyThenResolve observer when (and only when)
// the just-resumed session is the CURRENT halted successor for a predecessor with a still-open unresolved
// alert.
//
// ROUND 2 (Code Reviewer b19b191f) — MAJOR, reproduced: `index.ts`'s boot order runs
// `crashRecoveryWatcher.start()` BEFORE two real `await`s (`startVaultVersioners`, `logVaultPushStatus`)
// that precede `finishReconcilingHaltedRecycleSuccessors`'s own arm — so the watcher's first tick is NOT
// guaranteed to land after the boot-armed observer's own window closes; it can land INSIDE it (also true,
// independent of the watcher entirely, for ANY other early revival — a human's manual resume — or any
// project configured with a short crashRecoveryWatchMs). The ORIGINAL design treated a second arm for an
// already-in-flight freshId as a no-op and DROPPED it — so a revival landing inside the boot window, whose
// own readiness then arrived AFTER the boot observer's original (earlier) deadline, left the alert open
// forever, even though the fix had supposedly already handled it. FIXED: a later arm for the SAME freshId
// now EXTENDS the shared deadline (`SessionService.haltedSuccessorReadyWaitDeadlines`, a `Map<freshId,
// deadline>` the one owning poller re-reads every iteration) instead of being dropped — see (M1) below,
// which reproduces the exact race. The in-flight ownership (exactly one real poller per freshId) still
// lives INSIDE waitForHaltedSuccessorReadyThenResolve, added synchronously at entry and deleted in a
// `finally` once it settles (resolved, stood down, or timed out) — never at either call site.
//
// Proves (varying revival path, ready-vs-never-ready, retry, non-halted resume, a non-halted successor's
// alert, the codex-redirect call site, and the act-after-reboot shape independently rather than holding any
// of them constant):
//   (R1) CRASH-RECOVERY-WATCHER TICK, post-restart, REVIVES AFTER THE BOOT WINDOW ALREADY CLOSED, reaches
//        ready: a successor already EXITED before the restart (liveFleetResumeSet/recoverStaleSessions both
//        miss it, confirmed directly) is revived by a real CrashRecoveryWatcher.tick() call AFTER the
//        boot-armed observer has already timed out and left the alert open (this scenario deliberately
//        waits that out first) — the resume()-hook arms a FRESH observer that files exactly one
//        recycle_fleet_resolved once the successor reaches ready again.
//   (R2) MANUAL resume(), post-restart (after the boot window has closed), reaches ready: identical shape
//        to (R1), but revived by a direct `sessions.resume(freshId)` call instead of the watchdog — proving
//        the hook fires from resume() itself, not from anything CrashRecoveryWatcher-specific.
//   (R3) BOOT resumeFleetOnBoot, successor STILL LIVE at restart (the ORIGINAL d9512de7 shape) — DEDUPE
//        REGRESSION CHECK: the boot-armed observer and the resume()-hook's own arm attempt (fired when
//        resumeFleetOnBoot calls resume() on the very same successor, INSIDE the boot window) must not
//        stack a second real poller — the hook's own attempt is proven to be a guarded no-op (a distinct,
//        near-instantly-resolving promise), and exactly ONE recycle_fleet_resolved is ever filed.
//   (R4) NEVER REACHES READY: revived (via a real tick) but never delivered a SessionStart hook — the
//        resume()-armed observer times out silently, the alert stays open, and its deadline-map entry is
//        cleared (so a LATER revival could still re-arm).
//   (R5) REVIVE-FAIL-REVIVE: the first revival (tick attempt 1) dies again before ever reaching ready — its
//        observer times out and clears; a second tick (attempt 2) revives it again and THIS time it reaches
//        ready — asserts EXACTLY ONE recycle_fleet_resolved across the whole sequence, never a stacked
//        observer from the first, already-timed-out arm.
//   (M1) ROUND 2 — REVIVAL INSIDE THE BOOT WINDOW, the Code Reviewer b19b191f MAJOR reproduced + fixed: a
//        revival lands WELL BEFORE the boot-armed observer's own original deadline D0; readiness then
//        arrives AFTER D0 but WITHIN the extended deadline the revival should have bought — asserts EXACTLY
//        ONE recycle_fleet_resolved is still filed (the ORIGINAL design would have left the alert open
//        forever here, since the boot-armed poller would already have given up on its own, earlier,
//        never-extended deadline). ROUND 3 (Code Reviewer cb74fc3b): made fully deterministic — reads D0/D1
//        directly off the deadline map (no timing needed to prove extend-vs-drop at all) and waits on a
//        condition anchored to the REAL D0 (`Date.now() > D0 + 2*pollMs`), never a guessed sleep duration.
//   (m1, Minor) ORDINARY (non-halted) successor pre-check: `openUnresolvedRecycleFleetAlert` deliberately
//        does NOT filter by reason/halted (db4b778c) — an ordinary settle-timeout alert (reason:"timeout",
//        no halt event anywhere) matches it just as readily as a halted one. The ONLY thing stopping the
//        hook from wrongly arming an observer for such a successor is the earlier `currentHaltedSuccessor`
//        gate — pinned directly here via a focused call to `armHaltedSuccessorReadyObserverIfRevived`.
//   (m1b, Minor) the SAME ordinary-successor exclusion as (m1), but driven through the REAL resume()
//        chokepoint via a genuine CrashRecoveryWatcher.tick() — proving the exclusion holds at the actual
//        call site every other scenario here exercises, not just via a direct call to the gating function.
//   (m2, Minor) CODEX-REDIRECT call site: a legacy codex-pinned manager row (harness:"codex", a
//        TRANSCRIPT_ROOT_DENY_ROLES member, card 7955458e) takes resume()'s OTHER successful-revival
//        return — resumeForcedRoleAsFreshClaude's own fresh-claude redirect — proving the hook is armed
//        from THAT call site too, not just the ordinary --resume path every other scenario exercises.
//   (R6) NON-HALTED resume(): an ordinary (never-recycled) manager's resume() is byte-identical — no
//        observer is armed, no recycle_fleet_* event of any kind is ever filed.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: mirrors
// recycle-fleet-resolved-after-halted-boot-reconcile.mjs's own harness exactly — a REAL Db + SessionService +
// PtyHost driven against the shared fake-pty seam; a restart is simulated by closing db1 and reopening the
// SAME fixed file as db2 (Db() always opens the one file derived from LOOM_HOME). Unlike that sibling file,
// EVERY db/host pair here (both pre- and post-"restart") is built via makeHarness() (not the boot-reconcile
// sibling's own onExit-less makeBoot()) because several scenarios here kill the successor's pty a SECOND
// time, post-restart, and need the real onExit wiring (processState -> "exited") to fire again for
// CrashRecoveryWatcher's own candidate query to see it.
//
// Run: 1) build (turbo builds shared first), 2) node test/resume-arms-halted-successor-observer.mjs
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

const tmpHome = path.join(os.tmpdir(), `loom-rahso-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every settle bound BEFORE importing dist/** — mirrors
// recycle-fleet-resolved-after-halted-boot-reconcile.mjs's own identical env pattern (same reasoning: every
// scenario here RESUMES a session post-restart, which routes SessionStart through cycleToMode's async
// footer-read machinery; the fake pty never produces footer output, so readiness only ever arrives via the
// bounded fallback).
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = "20";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = "20";
const SETTLE_POLL_MS = Number(process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS); // single source of truth for (M1)'s D0-anchored wait below
// ROUND 2 (Code Reviewer b19b191f): raised from 600 to 1200 so (M1) has comfortable real-wall-clock margin
// between the ORIGINAL boot deadline and the EXTENDED one a later revival produces — see (M1) for the exact
// arithmetic. Every OTHER scenario here only gets slower (it still waits out the same bound to time out),
// never less correct, from this change.
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = "1200";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_SLOW_POLL_MS = "2000";
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";
process.env.LOOM_MODE_CYCLE_FALLBACK_MS = "60000";
process.env.LOOM_READY_FALLBACK_ABSOLUTE_CEILING_MS = "150";
// Isolate codex's OWN transcript root (codex-doctrine.ts's realCodexHome() re-reads CODEX_HOME fresh on
// every call — never cached — so this only needs to be set before first use, but set here for consistency
// with forced-role-resume-retry-safety.mjs's own identical pattern). Used only by (Minor m2) below.
const tmpCodexHome = path.join(os.tmpdir(), `loom-rahso-codex-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpCodexHome, { recursive: true });
process.env.CODEX_HOME = tmpCodexHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { runBootRecoveryPrefix } = await import("../dist/sessions/boot-backstop.js");
const { CLEAN_STALENESS } = await import("./_deploy-staleness-fixture.mjs");
const { CrashRecoveryWatcher, recordUnexpectedExit } = await import("../dist/orchestration/crash-recovery-watcher.js");
const { openUnresolvedRecycleFleetAlert, currentHaltedSuccessor } = await import("../dist/orchestration/crash-orphaned-workers.js");

const repo = path.join(os.tmpdir(), `loom-rahso-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# resume-arms-halted-successor-observer test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rahso@loom -c user.name=rahso");

class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map(); // sessionId -> the fake low-level pty object (the LATEST spawn, each resume overwrites)
  stoppedIds = new Set();
  createPty(opts) {
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    return pty;
  }
  stop(id, mode) { this.stoppedIds.add(id); return super.stop(id, mode); }
  // (Minor m2) safety net: nothing in this file should ever legitimately reach a real codex spawn — a
  // codex-pinned TRANSCRIPT_ROOT_DENY_ROLES row (role "manager") must always redirect to a FRESH claude
  // spawn (resumeForcedRoleAsFreshClaude), never a real --resume via codex.
  createCodexPty() { throw new Error("MUST NEVER REACH createCodexPty in this test"); }
}

/** Mirrors recycle-fleet-resolved-after-halted-boot-reconcile.mjs's own makeHarness(), but used on BOTH
 *  sides of the simulated restart here (not just the pre-restart side) — several scenarios below kill the
 *  successor's pty a SECOND time, post-restart, and need the real onExit wiring to fire again. */
function makeHarness() {
  const db = new Db();
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onReady(id) { db.setReachedReady(id); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
  };
  const host = new SeamHost(events);
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
  Db.prototype.reparentWakes = function () { throw new Error("injected PERMANENT failure (resume-arms-halted-successor-observer test)"); };
  return () => { Db.prototype.reparentWakes = original; };
}

/** Installs a global capture on SessionService.prototype.waitForHaltedSuccessorReadyThenResolve, keyed by
 *  freshId -> the LATEST promise returned for it (a later arm for the same freshId overwrites the entry —
 *  deliberately, so a scenario can tell a dedupe no-op's own fast-resolving promise apart from a real,
 *  still-polling one by re-reading the map after each arm attempt). Restore before the file exits. */
function installWaiterCapture() {
  const waiterPromises = new Map();
  const original = SessionService.prototype.waitForHaltedSuccessorReadyThenResolve;
  SessionService.prototype.waitForHaltedSuccessorReadyThenResolve = function (predecessorId, freshId) {
    const p = original.call(this, predecessorId, freshId);
    waiterPromises.set(freshId, p);
    return p;
  };
  return { waiterPromises, restore: () => { SessionService.prototype.waitForHaltedSuccessorReadyThenResolve = original; } };
}

/** Halts m1->m2 in a fresh project, gives BOTH a real engine id + transcript, then makes M2 reach ready and
 *  CRASH — all BEFORE the simulated restart (mirrors recycle-manager-halted-successor-dies.mjs (A4)'s own
 *  "ready, then dies" setup) — so M2 is genuinely `exited` (not live/starting) at the moment db1 closes.
 *  Waits for the live watch's own `recycle_fleet_unresolved` alert (reason:"halted-waiting-crash-recovery",
 *  per 91ac2b79) before returning. */
async function setupHaltedLineageAlreadyExited(projectSuffix) {
  const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
  const P = `rahso-${projectSuffix}`;
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
  const m2 = await sessions1.recycleManager(m1.id, `handoff — halted lineage, successor dies before a restart (${projectSuffix})`);
  unstub();
  SessionService.prototype.watchHaltedRecycleSuccessor = originalWatch;
  if (!hasEvent(db1, m2.id, "recycle_ownership_transfer_failed")) throw new Error(`setup failed to halt (${projectSuffix})`);

  const engineSessionId = `eng-m2-${projectSuffix}`;
  host1.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
  writeFakeTranscript(m2.cwd, engineSessionId);
  db1.incrementTurnSeq(m2.id); // a real turn ran — genuine, delivered context worth preserving
  check(`(setup ${projectSuffix}) M2 reached ready with a completed turn, pre-restart`, host1.hasReachedReady(m2.id) === true && db1.getSession(m2.id)?.turnSeq === 1);

  const m2Pty = host1.handles.get(m2.id);
  m2Pty.kill(); // M2 crashes — independent of (and well before) the whole-daemon restart
  recordUnexpectedExit(db1, m2.id, false); // the real onExit wiring's own trigger for a genuine unintended crash
  check(`(setup ${projectSuffix}) M2 is genuinely exited (not live/starting) BEFORE the simulated restart`, db1.getSession(m2.id)?.processState === "exited");

  const alerted = await waitUntil(() => hasEvent(db1, m1.id, "recycle_fleet_unresolved"));
  if (!alerted) throw new Error(`setup failed to alert unresolved (${projectSuffix})`);
  const unresolvedEvt = eventsOfKind(db1, m1.id, "recycle_fleet_unresolved").at(-1);
  check(`(setup ${projectSuffix}) the pre-restart alert correctly names the halted-waiting-crash-recovery shape`, unresolvedEvt?.detail?.reason === "halted-waiting-crash-recovery");

  const preRestartFleet = sessions1.liveFleetResumeSet();
  check(`(setup ${projectSuffix}) liveFleetResumeSet EXCLUDES the already-exited M2 — the production gap this card targets`, !preRestartFleet.some((e) => e.sessionId === m2.id));
  check(`(setup ${projectSuffix}) liveFleetResumeSet still includes the live (never-stopped) predecessor M1`, preRestartFleet.some((e) => e.sessionId === m1.id));
  db1.close();
  return { m1, m2, preRestartFleet, engineSessionId };
}

/** Mirrors the ORIGINAL d9512de7 shape: M2 is STILL live (never killed) at the moment of the restart — used
 *  only by (R3), the dedupe regression check against the boot-armed observer. */
async function setupHaltedLineageStillLive(projectSuffix) {
  const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
  const P = `rahso-${projectSuffix}`;
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

  const engineSessionId = `eng-m2-${projectSuffix}`;
  db1.setEngineSessionId(m2.id, engineSessionId); // DIRECT — no hook delivery, so M2 stays NOT-reached-ready (mirrors the sibling test's identical reasoning)
  writeFakeTranscript(m2.cwd, engineSessionId);

  const alerted = await waitUntil(() => hasEvent(db1, m1.id, "recycle_fleet_unresolved"));
  if (!alerted) throw new Error(`setup failed to alert unresolved (${projectSuffix})`);

  const preRestartFleet = sessions1.liveFleetResumeSet();
  check(`(setup ${projectSuffix}) liveFleetResumeSet INCLUDES the still-live M2 (the ORIGINAL d9512de7 shape)`, preRestartFleet.some((e) => e.sessionId === m2.id));
  db1.close();
  return { m1, m2, preRestartFleet, engineSessionId };
}

try {
  // ==================== (R1) CRASH-RECOVERY-WATCHER TICK, post-restart, reaches ready ====================
  {
    const { m1, m2, engineSessionId } = await setupHaltedLineageAlreadyExited("r1");
    const { db: db2, host: host2, sessions: sessions2 } = makeHarness();
    const { waiterPromises, restore } = installWaiterCapture();

    const { haltedEarly } = runBootRecoveryPrefix(db2);
    check("(R1) the early phase STILL records the pair in pendingResolution (isDurablyResumable doesn't care about processState)", haltedEarly.pendingResolution.some((e) => e.predecessorId === m1.id && e.freshId === m2.id));
    const haltedFinish = sessions2.finishReconcilingHaltedRecycleSuccessors(haltedEarly);
    check("(R1) the boot-time observer is armed, naming M2", haltedFinish.pendingResolutionArmed.includes(m2.id));
    const bootArmedWaiter = waiterPromises.get(m2.id);
    check("(R1 setup) the boot-armed observer's own promise was captured", !!bootArmedWaiter);

    await bootArmedWaiter; // times out — nothing ever resumed M2 within its bound
    check("(R1) THE GAP, CONFIRMED: the boot-armed observer gave up with NO recycle_fleet_resolved filed", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 0);
    check("(R1) the alert is still genuinely open after the boot-armed observer's timeout", !!openUnresolvedRecycleFleetAlert(db2, m1.id, m2.id));
    check("(R1) the boot-armed observer's in-flight guard entry was cleared on timeout", !sessions2.haltedSuccessorReadyWaitDeadlines.has(m2.id));

    // Now simulate a MUCH LATER CrashRecoveryWatcher tick (production: >=60s after boot, well after the
    // 600ms-shortened bound above has already expired) genuinely reviving M2 via the real resume() path.
    const watcher = new CrashRecoveryWatcher({ db: db2, control: sessions2.control, resume: (id) => { sessions2.resume(id); return true; } });
    watcher.tick();
    check("(R1) THE FIX: the watcher's tick genuinely resumed M2", host2.isAlive(m2.id) === true);
    const hookArmedWaiter = waiterPromises.get(m2.id);
    check("(R1) the resume()-hook armed a FRESH observer for M2", !!hookArmedWaiter && hookArmedWaiter !== bootArmedWaiter);

    host2.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    const reachedReady = await waitUntil(() => host2.hasReachedReady(m2.id) === true);
    check("(R1) M2 reached real ready, post-revival", reachedReady);
    await hookArmedWaiter;

    check("(R1) FIX 49107314: EXACTLY ONE recycle_fleet_resolved was filed", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 1);
    const resolved = eventsOfKind(db2, m1.id, "recycle_fleet_resolved")[0];
    check("(R1) the resolved event names M2 as the successor", resolved?.detail?.successorId === m2.id);
    // NOTE: M1 is never resumed at all in this scenario (only M2 is) — the real assertion is that the hook
    // never TOUCHES M1 (no stopping authority, f1969787), not that M1 is alive here.
    check("(R1) M1 was never stopped — the hook has no stopping authority (f1969787)", !host2.stoppedIds.has(m1.id));
    restore();
    db2.close();
  }

  // ==================== (R2) MANUAL resume(), post-restart, reaches ready ====================
  {
    const { m1, m2, engineSessionId } = await setupHaltedLineageAlreadyExited("r2");
    const { db: db2, host: host2, sessions: sessions2 } = makeHarness();
    const { waiterPromises, restore } = installWaiterCapture();

    const { haltedEarly } = runBootRecoveryPrefix(db2);
    const haltedFinish = sessions2.finishReconcilingHaltedRecycleSuccessors(haltedEarly);
    check("(R2 setup) the boot-armed observer is armed", haltedFinish.pendingResolutionArmed.includes(m2.id));
    await waiterPromises.get(m2.id); // times out
    check("(R2 setup) the boot-armed observer gave up first, as in (R1)", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 0);

    // A direct, manual resume() — NOT via CrashRecoveryWatcher at all — proves the hook lives in resume()
    // itself, not in anything watcher-specific.
    sessions2.resume(m2.id);
    check("(R2) THE FIX: a manual resume() genuinely revived M2", host2.isAlive(m2.id) === true);
    const hookArmedWaiter = waiterPromises.get(m2.id);
    check("(R2) the resume()-hook armed an observer off the manual resume() call", !!hookArmedWaiter);

    host2.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    const reachedReady = await waitUntil(() => host2.hasReachedReady(m2.id) === true);
    check("(R2) M2 reached real ready, post-revival", reachedReady);
    await hookArmedWaiter;

    check("(R2) FIX 49107314: EXACTLY ONE recycle_fleet_resolved was filed via a manual resume() too", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 1);
    restore();
    db2.close();
  }

  // ==================== (R3) BOOT resumeFleetOnBoot, successor STILL LIVE at restart — DEDUPE ====================
  {
    const { m1, m2, preRestartFleet, engineSessionId } = await setupHaltedLineageStillLive("r3");
    const { db: db2, host: host2, sessions: sessions2 } = makeHarness();
    const { waiterPromises, restore } = installWaiterCapture();

    const { haltedEarly } = runBootRecoveryPrefix(db2);
    const haltedFinish = sessions2.finishReconcilingHaltedRecycleSuccessors(haltedEarly);
    check("(R3 setup) the boot-armed observer is armed for the still-live shape, exactly like d9512de7's own K1", haltedFinish.pendingResolutionArmed.includes(m2.id));
    const bootArmedWaiter = waiterPromises.get(m2.id);
    check("(R3) the boot-armed observer's in-flight guard is set BEFORE resumeFleetOnBoot runs", sessions2.haltedSuccessorReadyWaitDeadlines.has(m2.id));

    // resumeFleetOnBoot resumes BOTH M1 and M2 — its own resume(m2.id) call reaches the SAME resume()-hook,
    // for the SAME pair the boot-armed observer is already polling. This must be a no-op, not a second poll.
    const restartIntent = { reason: "test", managerSessionId: m2.id, resume: preRestartFleet };
    const { resumed, failed } = sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS });
    check("(R3) both M1 and M2 were resumed by the ordinary fleet-resume pass", resumed.includes(m1.id) && resumed.includes(m2.id));
    check("(R3) nothing failed to resume", failed.length === 0);

    const hookArmAttempt = waiterPromises.get(m2.id);
    check("(R3) DEDUPE: the resume()-hook's own arm attempt (fired inside resumeFleetOnBoot's resume() call) is a DISTINCT promise from the boot-armed one", hookArmAttempt !== bootArmedWaiter);
    // Deterministic, NOT a fixed-duration wait: a deduped call (`if (inFlight) return;`, no real poll) settles
    // its promise within a single MICROTASK tick, exactly like Promise.resolve() does. A genuinely-polling call
    // (the guard broken) would instead be awaiting a real setTimeout MACROTASK (>=LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS
    // away) — which always loses a race against an already-queued microtask. Racing against a one-tick
    // microtask sentinel (never a sleep()/setTimeout()) discriminates the two without timing the wall clock.
    const microtaskSentinel = Symbol("not-deduped-yet");
    const racedAgainstMicrotask = await Promise.race([hookArmAttempt, Promise.resolve().then(() => microtaskSentinel)]);
    check("(R3) DEDUPE: that second arm attempt settled within a single microtask tick — it hit the in-flight guard and never reached a real poll (which awaits a setTimeout macrotask)", racedAgainstMicrotask !== microtaskSentinel);

    host2.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    const reachedReady = await waitUntil(() => host2.hasReachedReady(m2.id) === true);
    check("(R3) M2 reached real ready, post-restart", reachedReady);
    await bootArmedWaiter; // the REAL (still-polling) observer resolves once it observes readiness

    check("(R3) DEDUPE HOLDS: still exactly ONE recycle_fleet_resolved, never two", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 1);
    restore();
    db2.close();
  }

  // ==================== (R4) NEVER REACHES READY — timeout, alert stays open, guard cleared ====================
  {
    const { m1, m2 } = await setupHaltedLineageAlreadyExited("r4");
    const { db: db2, host: host2, sessions: sessions2 } = makeHarness();
    const { waiterPromises, restore } = installWaiterCapture();

    const { haltedEarly } = runBootRecoveryPrefix(db2);
    const haltedFinish = sessions2.finishReconcilingHaltedRecycleSuccessors(haltedEarly);
    check("(R4 setup) the boot-armed observer is armed", haltedFinish.pendingResolutionArmed.includes(m2.id));
    await waiterPromises.get(m2.id); // times out

    const watcher = new CrashRecoveryWatcher({ db: db2, control: sessions2.control, resume: (id) => { sessions2.resume(id); return true; } });
    watcher.tick();
    check("(R4) the watcher's tick genuinely resumed M2", host2.isAlive(m2.id) === true);
    const hookArmedWaiter = waiterPromises.get(m2.id);
    check("(R4 setup) the resume()-hook armed a fresh observer", !!hookArmedWaiter);
    check("(R4 setup) the in-flight guard is set while this observer polls", sessions2.haltedSuccessorReadyWaitDeadlines.has(m2.id));

    // Deliberately never deliver a SessionStart hook — M2 never reaches ready.
    await hookArmedWaiter; // resolves once ITS OWN deadline passes with no ready observed

    check("(R4) NO recycle_fleet_resolved was fabricated — M2 never reached ready", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 0);
    check("(R4) the unresolved alert is still genuinely open", !!openUnresolvedRecycleFleetAlert(db2, m1.id, m2.id));
    check("(R4) the in-flight guard entry was cleared on this timeout too — a LATER revival could still re-arm", !sessions2.haltedSuccessorReadyWaitDeadlines.has(m2.id));
    restore();
    db2.close();
  }

  // ==================== (R5) REVIVE-FAIL-REVIVE — exactly ONE resolved, no stacked observers ====================
  {
    const { m1, m2, engineSessionId } = await setupHaltedLineageAlreadyExited("r5");
    const { db: db2, host: host2, sessions: sessions2 } = makeHarness();
    const { waiterPromises, restore } = installWaiterCapture();

    const { haltedEarly } = runBootRecoveryPrefix(db2);
    const haltedFinish = sessions2.finishReconcilingHaltedRecycleSuccessors(haltedEarly);
    check("(R5 setup) the boot-armed observer is armed", haltedFinish.pendingResolutionArmed.includes(m2.id));
    await waiterPromises.get(m2.id); // times out — the FIRST give-up

    const watcher = new CrashRecoveryWatcher({ db: db2, control: sessions2.control, resume: (id) => { sessions2.resume(id); return true; } });

    // Attempt #1: the watcher revives M2, the hook arms an observer — but M2 crashes AGAIN before ever
    // reaching ready (no SessionStart hook delivered this attempt at all).
    watcher.tick();
    check("(R5) attempt #1: the watcher genuinely resumed M2", host2.isAlive(m2.id) === true);
    const attempt1Waiter = waiterPromises.get(m2.id);
    check("(R5 setup) attempt #1 armed its own observer", !!attempt1Waiter);
    const m2PtyAttempt1 = host2.handles.get(m2.id);
    m2PtyAttempt1.kill();
    recordUnexpectedExit(db2, m2.id, false); // a second genuine, unintended crash
    check("(R5) M2 is dead again, before ever reaching ready", host2.isAlive(m2.id) === false && host2.hasReachedReady(m2.id) === false);
    await attempt1Waiter; // this observer's own deadline passes with no ready observed — it gives up

    check("(R5) after attempt #1's failure: still no recycle_fleet_resolved", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 0);
    check("(R5) after attempt #1's failure: the in-flight guard was cleared — attempt #2 can re-arm", !sessions2.haltedSuccessorReadyWaitDeadlines.has(m2.id));

    // Attempt #2: a later tick revives M2 again — this time it reaches ready.
    watcher.tick();
    check("(R5) attempt #2: the watcher genuinely resumed M2 again", host2.isAlive(m2.id) === true);
    const attempt2Waiter = waiterPromises.get(m2.id);
    check("(R5 setup) attempt #2 armed a FRESH observer, distinct from attempt #1's", !!attempt2Waiter && attempt2Waiter !== attempt1Waiter);
    host2.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    const reachedReady = await waitUntil(() => host2.hasReachedReady(m2.id) === true);
    check("(R5) M2 reached real ready on attempt #2", reachedReady);
    await attempt2Waiter;

    check("(R5) FIX 49107314: EXACTLY ONE recycle_fleet_resolved across the whole revive-fail-revive sequence", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 1);
    const resolved = eventsOfKind(db2, m1.id, "recycle_fleet_resolved")[0];
    check("(R5) the resolved event names M2", resolved?.detail?.successorId === m2.id);
    restore();
    db2.close();
  }

  // ==================== (M1) ROUND 2 (Code Reviewer b19b191f): REVIVAL INSIDE THE BOOT WINDOW EXTENDS THE DEADLINE ====================
  {
    const { m1, m2, engineSessionId } = await setupHaltedLineageAlreadyExited("m1race");
    const { db: db2, host: host2, sessions: sessions2 } = makeHarness();
    const { waiterPromises, restore } = installWaiterCapture();

    const { haltedEarly } = runBootRecoveryPrefix(db2);
    const haltedFinish = sessions2.finishReconcilingHaltedRecycleSuccessors(haltedEarly);
    check("(M1 setup) the boot-armed observer is armed", haltedFinish.pendingResolutionArmed.includes(m2.id));
    const bootArmedWaiter = waiterPromises.get(m2.id);
    check("(M1 setup) the boot-armed observer's own promise was captured", !!bootArmedWaiter);
    // D0 — the mechanism's OWN original deadline, read directly off the map (never estimated from an
    // external `Date.now()` taken before the arm, which would be measuring a different, earlier origin).
    const D0 = sessions2.haltedSuccessorReadyWaitDeadlines.get(m2.id);
    check("(M1 setup) D0 (the original deadline) was captured from the map", typeof D0 === "number");

    // Revive WELL INSIDE the boot window — 75% through the bound, mirroring Code Reviewer b19b191f's own
    // repro ratio (450/600) — so D_ext (revival-time + 1200ms) sits comfortably past D0, leaving a wide
    // margin before D_ext even after the D0-anchored wait below. Pure test PACING ahead of an ACTION (the
    // revival call); the real proof is the D0-vs-D1 comparison right after, which reads the mechanism's own
    // state directly and needs no timing margin at all.
    // TIMING-GUARD-SAFE: pacing-only sleep; the adjacent checks read the mechanism's state directly (D1 >
    // D0, isAlive) rather than reasoning about elapsed wall-clock, so the wait's own duration proves nothing.
    await sleep(900);
    sessions2.resume(m2.id);
    check("(M1) the revival genuinely resumed M2", host2.isAlive(m2.id) === true);
    // THE FIX, proven with NO timing at all: a later arm must EXTEND D0, never leave it or drop it.
    const D1 = sessions2.haltedSuccessorReadyWaitDeadlines.get(m2.id);
    check("(M1) FIX: the later arm extended the deadline — D1 is strictly later than D0", typeof D1 === "number" && D1 > D0);

    // Deliberately do NOT deliver SessionStart yet. Wait until wall-clock has GENUINELY passed D0 (plus a
    // small margin over the owner loop's own poll granularity) — anchored to the mechanism's REAL deadline,
    // never a guessed constant: this can never be "true by construction" the way comparing against an
    // external, earlier-captured timestamp would be.
    const pastD0 = await waitUntil(() => Date.now() > D0 + 2 * SETTLE_POLL_MS, { timeoutMs: 5000, intervalMs: 10 });
    check("(M1) wall-clock has now genuinely passed D0 (the original deadline)", pastD0);

    // NOW deliver ready — after D0, but still comfortably within D_ext (revival-time + 1200ms; reviving at
    // 75% through the window leaves ~900ms of margin between D0 and D_ext, far more than this wait + the
    // ready-fallback ceiling could plausibly consume even under heavy system load).
    host2.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    const reachedReady = await waitUntil(() => host2.hasReachedReady(m2.id) === true);
    check("(M1) M2 reached real ready, after D0 but inside the extended deadline D_ext", reachedReady);

    // The SAME owner promise the boot-armed observer returned — the revival deduped onto it, extending its
    // deadline, never spawning a second poller. If the deadline had NOT been extended, this promise would
    // already have settled (give-up) at D0, well before this await, and the event count below would be 0 —
    // that is the exact regression this scenario catches.
    await bootArmedWaiter;
    check("(M1) FIX (ROUND 2): EXACTLY ONE recycle_fleet_resolved was filed, despite ready arriving after the original deadline", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 1);
    const resolvedM1 = eventsOfKind(db2, m1.id, "recycle_fleet_resolved")[0];
    check("(M1) the resolved event names M2", resolvedM1?.detail?.successorId === m2.id);
    restore();
    db2.close();
  }

  // ==================== (Minor m1) ORDINARY (non-halted) successor pre-check is load-bearing ====================
  {
    const { db, sessions } = makeHarness();
    const P = "rahso-m1x";
    seedProject(db, P);
    const now2 = new Date().toISOString();
    db.insertSession({
      id: "m1x-pred", projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo,
      processState: "live", resumability: "resumable", busy: false, createdAt: now2, lastActivity: now2,
      lastError: null, role: "manager", harness: undefined, gen: 0,
    });
    db.insertSession({
      id: "m1x-succ", projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo,
      processState: "exited", resumability: "resumable", busy: false, createdAt: now2, lastActivity: now2,
      lastError: null, role: "manager", harness: undefined, gen: 1, recycledFrom: "m1x-pred",
    });
    // The ORDINARY (non-halted) settle-timeout alert shape settleRecycleHandoff's own tail files on a real
    // unresolved settle — reason:"timeout", no recycle_ownership_transfer_failed event anywhere for this
    // predecessor (that absence is what makes this lineage non-halted).
    db.appendEvent({
      id: "m1x-evt-unresolved", ts: now2, managerSessionId: "m1x-pred",
      kind: "recycle_fleet_unresolved", detail: { deadSuccessorId: "m1x-succ", reason: "timeout" },
    });
    check("(m1 setup) the ordinary unresolved alert matches openUnresolvedRecycleFleetAlert — db4b778c's own no-filter design", !!openUnresolvedRecycleFleetAlert(db, "m1x-pred", "m1x-succ"));
    check("(m1 setup) currentHaltedSuccessor correctly returns undefined for this ordinary, non-halted predecessor", currentHaltedSuccessor(db, "m1x-pred") === undefined);

    sessions.armHaltedSuccessorReadyObserverIfRevived("m1x-succ");
    check("(m1) PIN: an ORDINARY (non-halted) successor's open settle-timeout alert does NOT arm an observer", !sessions.haltedSuccessorReadyWaitDeadlines.has("m1x-succ"));
    check("(m1) PIN: no recycle_fleet_resolved was filed for the ordinary lineage", !hasEvent(db, "m1x-pred", "recycle_fleet_resolved"));
    db.close();
  }

  // ==================== (Minor m1b) resume()-level variant of (m1), revived via a REAL watcher tick ====================
  // Same ordinary (non-halted) settle-timeout shape as (m1) above, but driven through the REAL resume()
  // chokepoint via a genuine CrashRecoveryWatcher.tick() — proving the exclusion holds at the call site
  // every other scenario here exercises, not just via a direct call to the gating function in isolation.
  {
    const { db, host, sessions } = makeHarness();
    const P = "rahso-m1b";
    seedProject(db, P);
    const now3 = new Date().toISOString();
    const predEngineId = "eng-m1b-pred";
    const succEngineId = "eng-m1b-succ";
    writeFakeTranscript(repo, predEngineId);
    writeFakeTranscript(repo, succEngineId);
    db.insertSession({
      id: "m1b-pred", projectId: P, agentId: `${P}-mgr`, engineSessionId: predEngineId, title: null, cwd: repo,
      processState: "live", resumability: "resumable", busy: false, createdAt: now3, lastActivity: now3,
      lastError: null, role: "manager", harness: undefined, gen: 0,
    });
    db.insertSession({
      id: "m1b-succ", projectId: P, agentId: `${P}-mgr`, engineSessionId: succEngineId, title: null, cwd: repo,
      processState: "exited", resumability: "resumable", busy: false, createdAt: now3, lastActivity: now3,
      lastError: null, role: "manager", harness: undefined, gen: 1, recycledFrom: "m1b-pred",
    });
    // The SAME ordinary (non-halted) settle-timeout alert shape as (m1), PLUS a real session_died trigger
    // (mirrors recordUnexpectedExit's own event shape) so CrashRecoveryWatcher's candidate query — which
    // reads ONLY durable trigger events, never processState alone — actually picks M2(b) up.
    db.appendEvent({
      id: "m1b-evt-unresolved", ts: now3, managerSessionId: "m1b-pred",
      kind: "recycle_fleet_unresolved", detail: { deadSuccessorId: "m1b-succ", reason: "timeout" },
    });
    db.appendEvent({
      id: "m1b-evt-died", ts: now3, managerSessionId: "m1b-succ", workerSessionId: "m1b-succ",
      kind: "session_died", detail: { role: "manager" },
    });
    check("(m1b setup) the ordinary unresolved alert is open", !!openUnresolvedRecycleFleetAlert(db, "m1b-pred", "m1b-succ"));
    check("(m1b setup) currentHaltedSuccessor correctly returns undefined — no halt event exists", currentHaltedSuccessor(db, "m1b-pred") === undefined);

    const watcher = new CrashRecoveryWatcher({ db, control: sessions.control, resume: (id) => { sessions.resume(id); return true; } });
    watcher.tick();
    check("(m1b) the real watcher tick genuinely resumed the ordinary successor", host.isAlive("m1b-succ") === true);
    check("(m1b) PIN: resume()'s own hook did NOT arm an observer for this ordinary successor", !sessions.haltedSuccessorReadyWaitDeadlines.has("m1b-succ"));
    check("(m1b) PIN: no recycle_fleet_resolved was filed for the ordinary lineage via the real resume() path", !hasEvent(db, "m1b-pred", "recycle_fleet_resolved"));
    db.close();
  }

  // ==================== (Minor m2) CODEX-REDIRECT call site (resumeForcedRoleAsFreshClaude) ====================
  {
    const { m1, m2, engineSessionId } = await setupHaltedLineageAlreadyExited("m2codex");
    const { db: db2, host: host2, sessions: sessions2 } = makeHarness();
    const { waiterPromises, restore } = installWaiterCapture();

    // Convert M2 to a legacy codex-pinned row BEFORE the boot-reconcile's own isDurablyResumable check runs
    // — a real codex rollout fixture (same shape forced-role-resume-retry-safety.mjs's own WINDOW 1 uses)
    // so that check resolves true under harness "codex", not vacuously false.
    const codexDayDir = path.join(tmpCodexHome, "sessions", "2026", "09", "07");
    fs.mkdirSync(codexDayDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDayDir, `rollout-2026-09-07T00-00-00-${engineSessionId}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { session_id: engineSessionId, cwd: repo, originator: "codex-tui" } }) + "\n",
    );
    // db.setSessionHarness ALSO unconditionally nulls engine_session_id as a side effect (its real,
    // documented job: clearing a stale codex id after resumeForcedRoleAsFreshClaude's OWN successful
    // claude spawn) — re-set the (fake codex) conversation id straight back afterward, since here we are
    // deliberately using it in the OPPOSITE direction, purely as a test-setup shortcut.
    db2.setSessionHarness(m2.id, "codex");
    db2.setEngineSessionId(m2.id, engineSessionId);

    const { haltedEarly } = runBootRecoveryPrefix(db2);
    check("(m2 setup) isDurablyResumable now resolves M2 under its CODEX transcript — pendingResolution still records the pair", haltedEarly.pendingResolution.some((e) => e.predecessorId === m1.id && e.freshId === m2.id));
    const haltedFinish = sessions2.finishReconcilingHaltedRecycleSuccessors(haltedEarly);
    check("(m2 setup) the boot-armed observer is armed", haltedFinish.pendingResolutionArmed.includes(m2.id));
    await waiterPromises.get(m2.id); // times out — nothing revived M2 yet

    // The revival itself: resume() detects harness:"codex" + role "manager" (TRANSCRIPT_ROOT_DENY_ROLES)
    // and redirects to resumeForcedRoleAsFreshClaude — a FRESH claude spawn, never --resume of the old
    // codex id.
    sessions2.resume(m2.id);
    check("(m2) the codex-redirect genuinely resumed M2 as fresh claude", host2.isAlive(m2.id) === true);
    check("(m2) the row's harness was corrected to claude", db2.getSession(m2.id)?.harness === undefined);
    const hookArmedWaiter = waiterPromises.get(m2.id);
    check("(m2) THE FIX reaches resumeForcedRoleAsFreshClaude's OWN call site too: a fresh observer was armed", !!hookArmedWaiter);

    const freshEngineId = "eng-m2codex-fresh-claude";
    host2.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: freshEngineId });
    const reachedReady = await waitUntil(() => host2.hasReachedReady(m2.id) === true);
    check("(m2) M2 reached real ready after the codex-redirect", reachedReady);
    await hookArmedWaiter;

    check("(m2) FIX 49107314 reaches the codex-redirect call site too: EXACTLY ONE recycle_fleet_resolved was filed", eventsOfKind(db2, m1.id, "recycle_fleet_resolved").length === 1);
    restore();
    db2.close();
  }

  // ==================== (R6) NON-HALTED resume() — byte-identical, no observer, no event ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rahso-r6";
    seedProject(db, P);
    const m = sessions.startManager(`${P}-mgr`);
    const engineSessionId = "eng-r6-m";
    host.deliverHook(m.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    writeFakeTranscript(m.cwd, engineSessionId);
    check("(R6 setup) M (never recycled) reached ready", host.hasReachedReady(m.id) === true);

    const { waiterPromises, restore } = installWaiterCapture();
    const mPty = host.handles.get(m.id);
    mPty.kill();
    recordUnexpectedExit(db, m.id, false);
    check("(R6 setup) M is dead, with a genuine crash trigger on record", host.isAlive(m.id) === false && hasEvent(db, m.id, "session_died"));

    sessions.resume(m.id);
    check("(R6) M was resumed normally", host.isAlive(m.id) === true);
    check("(R6) NO observer was armed for an ordinary, non-recycled session — recycledFrom is unset", !waiterPromises.has(m.id));
    check("(R6) NO recycle_fleet_unresolved event of any kind was ever filed for M", !hasEvent(db, m.id, "recycle_fleet_unresolved"));
    check("(R6) NO recycle_fleet_resolved event of any kind was ever filed for M", !hasEvent(db, m.id, "recycle_fleet_resolved"));
    restore();
    db.close();
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resume()'s hook arms the SAME bounded halted-successor-ready observer from the actual moment of revival (CrashRecoveryWatcher, a manual resume, or boot resumeFleetOnBoot), closing the restart gap d9512de7 left open for an already-exited successor, without double-arming the boot-armed observer and without ever touching an ordinary, non-halted resume()."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
