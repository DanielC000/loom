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
//   (B2) card 54434e27 — a crash lands BETWEEN the early reparent and the later (banner/archive/event)
//       phase (recovered bucket): boot 2 runs ONLY the early prefix and is left in the half-done state
//       (reparented, no marker on main — the bug); boot 3 runs the full sequence and must detect + finish
//       it via the new durable marker, since hasSuccessor is already permanently false by then; boot 4
//       proves idempotency.
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
//   (F) BOTH DEAD — card a4c5f234: the predecessor is ALSO unresumable this boot (never captured an
//       engine id). Superseded behavior: the old NEVER RESURRECT gate used to leave BOTH sides untouched
//       forever (nothing archived/reparented), stranding ownership permanently split. NOW: the lineage is
//       CONSOLIDATED onto the predecessor as pure bookkeeping (workers/wakes/questions/etc. reparented,
//       the successor unlinked + archived, `recycle_split_lineage_consolidated` filed) — NEVER RESURRECT
//       still holds (nothing is auto-resumed; the predecessor is only made VISIBLE, un-archived + banner
//       stamped, for a human `allowSuperseded` resume). Also proves: idempotent across a THIRD boot; the
//       crash-orphan derivation sees the reparented worker (worktree-GC protection reaches it for free)
//       but the manager-first resume order means neither the predecessor nor the worker is ever actually
//       resumed through that side door — see card a4c5f234's own decision record for the full trace.
//   (F2) BOTH DEAD, BUT ALREADY RESOLVED — card a4c5f234 must respect dfc3b014's resolution marker: a
//       `recycle_ownership_transfer_resolved` event already named the (now also dead) successor before
//       the restart, so `currentHaltedSuccessor` stops matching before the new consolidation branch is
//       ever reached — the lineage stays exactly as it was, untouched.
//   (F3) card 54434e27 — the SAME crash-between-phases shape as (B2), for the `consolidated` bucket: boot
//       2's half-done state (reparented, no marker on main), boot 3's marker-driven detection + completion
//       (including the banner's child-session count reading the REAL current fleet, not the zero a
//       continuation's own reparent return value would give it), and boot 4's idempotency.
//   (F4) card 54434e27 Code Review m1 — STALE MARKER: a marker for S1 is left pending, then P is resumed
//       and halt-recycled AGAIN to a brand-new S2 (also dies unresumable) entirely in-process, with S1's
//       marker never reprocessed (the early reconcile only runs at boot). A real boot must reconcile S2
//       normally AND clear S1's now-stale marker without acting — no event/nudge/banner naming S1. Round
//       2 item 4: the nudge check uses a real `enqueueDurableNudge` spy and matches the 8-char id prefix
//       the banner/nudge text actually embeds (matching the FULL id, as an earlier draft did, is vacuous).
//   (F4b) card 54434e27 Code Review round 2 item 3 — the SAME stale-marker shape as (F4), but via the
//       OTHER staleness disjunct: S2 dies WHILE P is alive and the IN-PROCESS reclaim watch unlinks it (no
//       reboot) — `hasSuccessor(P)` reads false again, so only the "latest halt event names someone else"
//       disjunct catches this.
//   (F5) card 54434e27 Code Review m2/m3a — a throw in the LATER phase (a stubbed
//       `unlinkAndArchiveDeadRecycleSuccessor`) leaves the marker set and nothing banner/archived/eventful;
//       a subsequent run completes it cleanly, exactly once.
//   (F5b) card 54434e27 Code Review round 2 item 2 — the DUPLICATE GUARD, exercised directly: a
//       completion event for (P, freshId) is pre-seeded WHILE the marker is still set ⇒ the recovered
//       branch finishes with exactly ONE event and ZERO new nudges (spied directly).
//   (F5c) card 54434e27 Code Review round 2 item 2 — ATOMICITY: a throw inside
//       `finishHaltedRecyclePending`'s own marker-clear statement rolls the completion EVENT back too.
//   (F6) card 54434e27 Code Review m3b — a throw MID-`reparentHaltedRecycleLineage` (a stubbed
//       `reparentWebhookTargets`) rolls back the WHOLE transaction: the worker stays on the dead
//       successor, `recycled_from` stays linked, and no marker is left behind.
//   (F7a)/(F7b) card 54434e27 Code Review round 2 item 1 — the recovered branch's stale-banner clear is
//       SCOPED to this mechanism's own exact text tied to the freshId: an UNRELATED orphaned-fleet banner
//       (archiveOnExit's own) survives (F7a); this mechanism's own stale banner for the SAME freshId is
//       cleared (F7b).
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
// Card 91ac2b79's own (A4) scenario resumes M2 directly (sessions.resume) to simulate the real watchdog —
// a RESUME always carries a non-null resumeModeTarget (sessions/service.ts), which routes SessionStart
// through cycleToMode's async footer-read machinery; the fake pty never produces footer output, so that
// machinery can only ever settle via its own bounded fallback (mirrors pty-ready-fallback-ceiling.mjs's
// own env pattern: MODE_CYCLE_FALLBACK_MS deliberately large, the ABSOLUTE_CEILING the one actually hit).
process.env.LOOM_MODE_CYCLE_FALLBACK_MS = "60000";
process.env.LOOM_READY_FALLBACK_ABSOLUTE_CEILING_MS = "200";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { runBootRecoveryPrefix } = await import("../dist/sessions/boot-backstop.js");
const { deriveCrashOrphanedWorkers, deriveCrashOrphanedManagers, isSupersededByRecycle } = await import("../dist/orchestration/crash-orphaned-workers.js");
const { CLEAN_STALENESS } = await import("./_deploy-staleness-fixture.mjs");
const { recordUnexpectedExit, CrashRecoveryWatcher, willRecoverAutomatically } = await import("../dist/orchestration/crash-recovery-watcher.js");

/** Drives a REAL CrashRecoveryWatcher.tick() against `db` (mirrors recycle-reattempt.mjs's own identical
 *  helper) and returns the list of session ids it actually attempted to resume — proves "waiting for
 *  automatic recovery" (or its absence) is an HONEST claim about what the watchdog will do, not merely
 *  that watchHaltedRecycleSuccessor's own gate used the same predicate in isolation. */
function tickAttempts(db) {
  const resumes = [];
  const watcher = new CrashRecoveryWatcher({ db, control: new OrchestrationControl(), resume: (id) => { resumes.push(id); return true; } });
  watcher.tick();
  return resumes;
}

/** Same as tickAttempts, but against a CALLER-SUPPLIED control — so a pause set on it is honoured, unlike
 *  tickAttempts' own always-fresh (never-paused) OrchestrationControl. (A6) uses this to prove a pause
 *  genuinely blocks the real watchdog's tick too, not merely this file's own gate in isolation. */
function tickAttemptsWithControl(db, control) {
  const resumes = [];
  const watcher = new CrashRecoveryWatcher({ db, control, resume: (id) => { resumes.push(id); return true; } });
  watcher.tick();
  return resumes;
}

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

/** Card 54434e27, Code Review round 2 item 4: observes the REAL `enqueueDurableNudge` call arguments
 *  directly, rather than inferring "was a nudge sent" from a downstream queue read (`listUnresolvedQueuedMessagesForWorker`
 *  can under-report — a message already delivered is excluded from "unresolved" — which made an earlier
 *  draft of this file's own (F4) check vacuous). Caller restores. */
function spyOnEnqueueDurableNudge() {
  const calls = [];
  const original = SessionService.prototype.enqueueDurableNudge;
  SessionService.prototype.enqueueDurableNudge = function (...args) {
    calls.push(args);
    return original.apply(this, args);
  };
  return { calls, restore: () => { SessionService.prototype.enqueueDurableNudge = original; } };
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

  // ==================== (A4) card 91ac2b79 — a GENUINE post-ready crash is WAITED on, not reclaimed ====================
  // The gap (A3)'s own retraction named as real but out of scope: M2 reaches ready (kickoff delivered) and
  // THEN dies, all inside one poll gap (no await anywhere between the hook delivery/turnSeq bump and the
  // kill — mirrors scenario (H)'s own race-simulation technique) — the watch loop's own poll can never have
  // observed the intermediate alive+ready state. With real context (turnSeq>0) and a genuine recovery
  // trigger on record, the fix now WAITS instead of reclaiming, then correctly stops watching (never M1)
  // once the successor is revived and ready again — proven via watchPromise's own resolution, never a
  // fixed sleep, so the absence of a reclaim event is asserted only once no further iteration can run.
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmhsd-a4";
    seedProject(db, P);
    // startupModeCycles:0 — markReady must run SYNCHRONOUSLY off the hook below (mirrors (A2)/(G')/(H)).
    db.setProjectConfig(P, { permission: { startupModeCycles: 0 } });
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId } = seedFleet(db, P, m1.id);

    let watchPromise;
    const originalWatch = SessionService.prototype.watchHaltedRecycleSuccessor;
    SessionService.prototype.watchHaltedRecycleSuccessor = function (...args) {
      watchPromise = originalWatch.apply(this, args);
      return watchPromise;
    };

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — forcing a halt, then the successor reaches ready and dies in the same poll gap");
    unstub();
    SessionService.prototype.watchHaltedRecycleSuccessor = originalWatch;
    check("(A4 pre) the recycle HALTED", hasEvent(db, m2.id, "recycle_ownership_transfer_failed"));
    check("(A4 setup) the watch was armed and its promise captured", !!watchPromise);

    // Deliver ready + a completed turn, then kill + file a real crash trigger — all with NO await in
    // between, so the loop's own poll (asleep in its first iteration's setTimeout at this point) can never
    // have observed the intermediate alive+ready state.
    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    writeFakeTranscript(m2.cwd, engineSessionId);
    db.incrementTurnSeq(m2.id); // a real turn ran — genuine, delivered context worth preserving
    check("(A4 setup) M2 reached ready synchronously, with a completed turn", host.hasReachedReady(m2.id) === true && db.getSession(m2.id)?.turnSeq === 1);
    const m2Pty = host.handles.get(m2.id);
    m2Pty.kill();
    recordUnexpectedExit(db, m2.id, false); // the real onExit wiring's own trigger for a genuine unintended crash
    check("(A4 setup) M2 confirmed dead", host.isAlive(m2.id) === false);

    check("(A4) WAIT IS HONEST: the watchdog's own REAL tick GENUINELY attempts M2", tickAttempts(db).includes(m2.id));

    // Give the REAL watchHaltedRecycleSuccessor loop (armed above, still running, polling every
    // LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS=15ms) several genuine chances to observe the dead state and
    // make its OWN decision BEFORE this scenario intervenes with a manual resume() below — without this,
    // the manual resume() races ahead of the loop's own first post-death poll and the scenario can never
    // exercise the reclaim-vs-wait fork at all, old code or new (verified: reverting this fix to the old
    // unconditional reclaim and re-running this file still passed every (A4) check, because resume() ran
    // before the old loop ever got to react — this wait is what makes the test non-vacuous either way).
    // The actual proof this guards is NOT timed to this wait — it's the `!hasEvent(...,
    // "recycle_fleet_recovered")` check far below, anchored to `watchPromise`'s own resolution, which
    // cannot settle early (sync-early-return) and is unaffected by whether this wait is 60ms or 6000ms.
    await sleep(60); // 4x LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS (15ms, set above)

    // REGRESSION GUARD (card 91ac2b79, round 2): on the old unconditional-reclaim code, the real watch
    // loop's first post-death poll — given a genuine chance to run by the sleep above — already reclaimed
    // AND ARCHIVED M2 by this point, which makes `sessions.resume(m2.id)` below throw "session was
    // administratively retired". Left unguarded, that throw is UNCAUGHT at module top level: it aborts
    // this whole file immediately, silently skipping (A5) and every later scenario, which is a FAR worse
    // failure than a loud, named check here. Detect the regression signal directly first, then only call
    // resume() when it's actually safe to, so a regression shows up as a named (A4) FAIL and the file keeps
    // running — never as a crash.
    const alreadyReclaimed = hasEvent(db, m1.id, "recycle_fleet_recovered") || !!db.getSession(m2.id)?.archivedAt;
    check("(A4) REGRESSION GUARD: M2 was NOT already reclaimed before the simulated resume (true here means the old unconditional-reclaim bug is back)", !alreadyReclaimed);

    if (!alreadyReclaimed) {
      // Simulate the real watchdog's resume succeeding: M2 comes back alive and reaches ready again (its
      // SessionStart hook fires on every resume too, real or fake) — the EXISTING hasReachedReady branch
      // then stops the WATCH LOOP, never M1 (@decision f1969787 — a halted predecessor is never stopped).
      // Unlike a FRESH spawn ((A2)'s own synchronous pattern), a RESUME's readiness is not guaranteed
      // synchronous off a single hook delivery — wait for it (anchored to the observable state, never a
      // fixed sleep) rather than asserting immediately.
      sessions.resume(m2.id);
      check("(A4) M2 is genuinely alive again after the simulated resume", host.isAlive(m2.id) === true);
      host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
      const revivedReady = await waitUntil(() => host.hasReachedReady(m2.id) === true);
      check("(A4) M2 reaches ready again after the simulated resume", revivedReady);
      await watchPromise; // resolves the instant the loop's own next poll observes alive+ready and returns

      check("(A4) FIX 91ac2b79: the loop never reclaimed across its whole lifetime — no recycle_fleet_recovered event", !hasEvent(db, m1.id, "recycle_fleet_recovered"));
      check("(A4) FIX: M2 was never archived by the watch — real context was preserved, not discarded", !(db.getSession(m2.id)?.lastError ?? "").includes("[loom:recycle-failed]"));
      check("(A4) FIX: M1 was NEVER stopped — still alive (ownership stays split, exactly like (A2))", host.isAlive(m1.id) === true);
      check("(A4) FIX: hasSuccessor(M1) stays true — nothing reclaimed/unlinked", db.hasSuccessor(m1.id) === true);
      check("(A4) the worker stays on M2 — nothing was wrongly reclaimed", db.getSession(workerId)?.parentSessionId === m2.id);
    } else {
      console.log("(A4) SKIPPED the rest of this scenario's checks — M2 was already reclaimed (see the regression guard check above)");
    }
  }

  // ==================== (A5) card 91ac2b79 — an INTENDED STOP (no trigger ever filed) still RECLAIMS ====================
  // Same post-ready-crash shape as (A4) — real context (turnSeq>0), durably resumable — but NO
  // recordUnexpectedExit call this time, mirroring an intended stop (production's onExit wiring never
  // files a trigger for one). willRecoverAutomatically correctly says "nothing will ever revive this", so
  // the fix reclaims exactly as it always did for the no-context case — "wait" must never be promised when
  // nothing will actually attempt it (the exact false-promise shape 09b14f15 killed for recycle_reattempt).
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmhsd-a5";
    seedProject(db, P);
    db.setProjectConfig(P, { permission: { startupModeCycles: 0 } });
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId } = seedFleet(db, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — forcing a halt, then the successor reaches ready and dies from an INTENDED stop");
    unstub();
    check("(A5 pre) the recycle HALTED", hasEvent(db, m2.id, "recycle_ownership_transfer_failed"));

    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    writeFakeTranscript(m2.cwd, engineSessionId);
    db.incrementTurnSeq(m2.id);
    check("(A5 setup) M2 reached ready synchronously, with a completed turn", host.hasReachedReady(m2.id) === true && db.getSession(m2.id)?.turnSeq === 1);
    const m2Pty = host.handles.get(m2.id);
    m2Pty.kill(); // an INTENDED stop — no recordUnexpectedExit call, so NO trigger is ever filed

    check("(A5) ESCALATE IS HONEST: the watchdog's own REAL tick does NOT attempt M2 — no trigger exists", !tickAttempts(db).includes(m2.id));

    const settled = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_recovered"));
    check("(A5) FIX 91ac2b79: RECLAIMS despite real context — nothing will ever revive a trigger-less death", settled);
    check("(A5) the worker (which DID transfer) is reclaimed back onto M1", db.getSession(workerId)?.parentSessionId === m1.id);
    check("(A5) M1 was NEVER stopped — still alive", host.isAlive(m1.id) === true);
    check("(A5) hasSuccessor(M1) is now false (M2 unlinked)", db.hasSuccessor(m1.id) === false);
    check("(A5) M2 IS archived", !!db.getSession(m2.id)?.archivedAt);
  }

  // ==================== (A6) card 91ac2b79 (LEAD RULING, round 2) — a HUMAN PAUSE never ends the wait ====================
  // Same genuine post-ready-crash shape as (A4) — real context (turnSeq>0), durably resumable, a real
  // crash trigger on record — but the global scope is PAUSED at the moment M2 dies. A pause is REVERSIBLE
  // (it gates new work only) while reclaiming is NOT (it discards a completed turn), so the fix must keep
  // WAITING through the pause rather than treating it like an exhausted-cap/intended-stop/superseded
  // reason to give up. Once unpaused, a real tick genuinely attempts M2 and the loop resolves exactly like
  // (A4) — never reclaiming, never stopping M1.
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmhsd-a6";
    seedProject(db, P);
    db.setProjectConfig(P, { permission: { startupModeCycles: 0 } });
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId } = seedFleet(db, P, m1.id);

    let watchPromise;
    const originalWatch = SessionService.prototype.watchHaltedRecycleSuccessor;
    SessionService.prototype.watchHaltedRecycleSuccessor = function (...args) {
      watchPromise = originalWatch.apply(this, args);
      return watchPromise;
    };

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — forcing a halt, then the successor reaches ready and dies while the fleet is paused");
    unstub();
    SessionService.prototype.watchHaltedRecycleSuccessor = originalWatch;
    check("(A6 pre) the recycle HALTED", hasEvent(db, m2.id, "recycle_ownership_transfer_failed"));
    check("(A6 setup) the watch was armed and its promise captured", !!watchPromise);

    sessions.control.pause("global"); // the human pauses the WHOLE fleet before M2 ever dies

    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    writeFakeTranscript(m2.cwd, engineSessionId);
    db.incrementTurnSeq(m2.id); // a real turn ran — genuine, delivered context worth preserving
    check("(A6 setup) M2 reached ready synchronously, with a completed turn", host.hasReachedReady(m2.id) === true && db.getSession(m2.id)?.turnSeq === 1);
    const m2Pty = host.handles.get(m2.id);
    m2Pty.kill();
    recordUnexpectedExit(db, m2.id, false); // the real onExit wiring's own trigger for a genuine unintended crash
    check("(A6 setup) M2 confirmed dead", host.isAlive(m2.id) === false);

    // The PAUSE itself blocks the real watchdog's tick (CrashRecoveryWatcher.tick() checks pause too) —
    // this is expected and correct; it does NOT mean "nothing will ever revive it". Use the SAME shared
    // control the watch loop itself holds (sessions.control), never tickAttempts' always-fresh one.
    check("(A6) the real tick does NOT attempt M2 while paused (pause blocks new work fleet-wide, including a resume attempt)",
      !tickAttemptsWithControl(db, sessions.control).includes(m2.id));

    // BEHAVIOURAL NEGATIVE CONTROL: call the real, exported willRecoverAutomatically directly, against the
    // EXACT same db/control/successor the watch loop itself is using right now, with and without
    // ignorePause. Proves the scenario actually exercises the toggle (not vacuous): without it, this
    // paused successor would flip from "wait" to "nothing will ever revive it" and get reclaimed.
    const freshSuccessor = db.getSession(m2.id);
    const withIgnorePause = willRecoverAutomatically(db, sessions.control, freshSuccessor, { ignorePause: true });
    const withoutIgnorePause = willRecoverAutomatically(db, sessions.control, freshSuccessor);
    check("(A6) NEGATIVE CONTROL: willRecoverAutomatically(..., {ignorePause:true}) is true while paused",
      withIgnorePause === true);
    check("(A6) NEGATIVE CONTROL: the SAME call WITHOUT ignorePause flips to false while paused — proving the toggle, not another gate, is what keeps this scenario waiting",
      withoutIgnorePause === false);

    // Give the REAL watchHaltedRecycleSuccessor loop several genuine chances to observe the dead (still
    // paused) state and make its OWN decision BEFORE this scenario intervenes below — mirrors (A4)'s own
    // wait, same reasoning (including the SAME caveat: this sleep backs nothing directly — a fixed wait
    // immediately followed by a negative-polarity check is unfalsifiable in one trial and
    // fixed-wait-negative-guard.mjs correctly rejects that shape; the real proof is anchored to
    // `watchPromise`'s own resolution, far below, which cannot settle early).
    await sleep(60); // 4x LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS (15ms, set above)

    // Unpause. The real tick now genuinely attempts M2 — the pause was the only thing standing in the way.
    sessions.control.resume("global");
    check("(A6) UNPAUSED: the real tick NOW attempts M2", tickAttemptsWithControl(db, sessions.control).includes(m2.id));

    // REGRESSION GUARD (mirrors (A4)'s own, same reasoning): only call the simulated resume if nothing
    // reclaimed M2 while we were setting this up — a reclaim would make resume() throw "administratively
    // retired" and crash the whole file uncaught.
    const alreadyReclaimed = hasEvent(db, m1.id, "recycle_fleet_recovered") || !!db.getSession(m2.id)?.archivedAt;
    check("(A6) REGRESSION GUARD: M2 was NOT already reclaimed before the simulated resume", !alreadyReclaimed);

    if (!alreadyReclaimed) {
      sessions.resume(m2.id);
      check("(A6) M2 is genuinely alive again after the simulated resume", host.isAlive(m2.id) === true);
      host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
      const revivedReady = await waitUntil(() => host.hasReachedReady(m2.id) === true);
      check("(A6) M2 reaches ready again after the simulated resume", revivedReady);
      await watchPromise; // resolves the instant the loop's own next poll observes alive+ready and returns

      check("(A6) FIX 91ac2b79 (ruling 4): the loop never reclaimed across its whole lifetime, pause included — no recycle_fleet_recovered event", !hasEvent(db, m1.id, "recycle_fleet_recovered"));
      check("(A6) FIX: M2 was never archived by the watch — real context was preserved, not discarded", !(db.getSession(m2.id)?.lastError ?? "").includes("[loom:recycle-failed]"));
      check("(A6) FIX: M1 was NEVER stopped — still alive (ownership stays split)", host.isAlive(m1.id) === true);
      check("(A6) FIX: hasSuccessor(M1) stays true — nothing reclaimed/unlinked", db.hasSuccessor(m1.id) === true);
      check("(A6) the worker stays on M2 — nothing was wrongly reclaimed", db.getSession(workerId)?.parentSessionId === m2.id);
    } else {
      console.log("(A6) SKIPPED the rest of this scenario's checks — M2 was already reclaimed (see the regression guard check above)");
    }
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

  // ==================== (B2) card 54434e27 — CRASH BETWEEN THE EARLY REPARENT AND THE LATER PHASE (recovered bucket) ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-b2";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-b2" });
    writeFakeTranscript(m1.cwd, "eng-m1-b2");
    const { workerId } = seedFleet(db1, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions1.recycleManager(m1.id, "handoff — a crash lands between the early reparent and the later (banner/archive/event) phase");
    unstub();
    check("(B2 pre) the recycle HALTED", hasEvent(db1, m2.id, "recycle_ownership_transfer_failed"));
    db1.close();

    // Boot 2: run ONLY the early, DB-only prefix — simulates a crash right after it, before the later
    // phase (which needs SessionService/PtyHost, constructed far later in index.ts) ever runs.
    const { db: db2 } = makeBoot();
    const haltedEarly2 = runBootRecoveryPrefix(db2).haltedEarly;
    check("(B2) boot 2: the early phase classified the pair `recovered`", haltedEarly2.recovered.some((r) => r.predecessorId === m1.id && r.freshId === m2.id));
    check("(B2) boot 2: hasSuccessor(M1) is now false (the reparent already ran)", db2.hasSuccessor(m1.id) === false);
    check("(B2) boot 2: the worker IS already reparented onto M1", db2.getSession(workerId)?.parentSessionId === m1.id);
    check("(B2) boot 2: the durable marker IS set, naming M2", db2.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id && r.freshId === m2.id));
    // The half-done state this card fixes: reparented, but NOT yet completed — RED on main (main has no
    // marker at all, and the NEXT boot would simply never find this lineage again). M2's own archivedAt
    // is NOT a usable signal here — the generic crash-path backstop (snapshotAndArchiveRecovered, earlier
    // in this SAME prefix) already archives any stale live/starting session regardless of the
    // halted-recycle logic; `recycle_fleet_recovered` is the one event ONLY the later phase ever files.
    check("(B2) boot 2: no recycle_fleet_recovered event yet", !hasEvent(db2, m1.id, "recycle_fleet_recovered"));
    db2.close(); // simulates the crash landing exactly in this gap

    // Boot 3: the FULL sequence — must detect the pending lineage via the marker (never via the
    // now-permanently-false hasSuccessor check) and complete it.
    const { db: db3, host: host3 } = makeBoot();
    const { haltedEarly: haltedEarly3, haltedFinish: haltedFinish3 } = runRealBootSequenceUpToResume(db3, host3);
    check("(B2) boot 3: the marker-driven loop re-detected the pair `recovered`", haltedEarly3.recovered.some((r) => r.predecessorId === m1.id && r.freshId === m2.id));
    check("(B2) boot 3: the later phase recovered the predecessor", haltedFinish3.recovered.includes(m1.id));
    check("(B2) boot 3: the worker is STILL on M1", db3.getSession(workerId)?.parentSessionId === m1.id);
    check("(B2) boot 3: M2 is NOW archived", !!db3.getSession(m2.id)?.archivedAt);
    const recoveredEvents3 = db3.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered");
    check("(B2) boot 3: exactly ONE recycle_fleet_recovered event (not duplicated)", recoveredEvents3.length === 1);
    check("(B2) boot 3: the marker is now CLEARED", !db3.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id));

    // Boot 4: idempotency — a further boot must not re-fire anything for this already-resolved lineage.
    db3.close();
    const { db: db4, host: host4 } = makeBoot();
    const { haltedEarly: haltedEarly4, haltedFinish: haltedFinish4 } = runRealBootSequenceUpToResume(db4, host4);
    check("(B2) boot 4: no longer scanned into `recovered` again", !haltedEarly4.recovered.some((r) => r.predecessorId === m1.id));
    check("(B2) boot 4: the later phase recovered nothing new for this lineage", !haltedFinish4.recovered.includes(m1.id));
    check("(B2) boot 4: still exactly ONE recycle_fleet_recovered event", db4.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered").length === 1);
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

  // ==================== (F) BOTH DEAD — card a4c5f234: now CONSOLIDATED onto the predecessor, bookkeeping only ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-f";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    // M1 never captures a real engine id (no SessionStart hook delivered) — isDurablyResumable(M1) is FALSE.
    const { workerId } = seedFleet(db1, P, m1.id);
    // Code Review ROUND 2, finding 6e: a NON-WORKER category that actually transfers during the live halt
    // (only "wakes" is stubbed to fail below — "questions" succeeds normally) — proves `consolidated`
    // reparents more than just workers, not only the one category every other scenario in this file checks.
    const questionId = `${m1.id}-question`;
    db1.insertQuestion({
      id: questionId, sessionId: m1.id, projectId: P, type: "decision", title: "t", body: "b",
      options: null, recommendation: null, state: "pending", chosenOption: null, note: null,
      createdAt: new Date().toISOString(), answeredAt: null, consumedAt: null, taskId: null,
    });

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions1.recycleManager(m1.id, "handoff — forcing a halt where BOTH predecessor and successor are unresumable");
    unstub();
    check("(F pre) the recycle HALTED", hasEvent(db1, m2.id, "recycle_ownership_transfer_failed"));
    check("(F pre) M1 never captured a real engine id — unresumable", db1.getSession(m1.id)?.engineSessionId == null);
    check("(F pre) M2 never captured a real engine id either (never reached SessionStart) — unresumable", db1.getSession(m2.id)?.engineSessionId == null);
    check("(F pre) the question DID transfer onto M2 during the live halt (questions step was never stubbed)", db1.getQuestion(questionId)?.sessionId === m2.id);

    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const { sessions: sessions2, haltedEarly, haltedFinish, crashOrphanedWorkers, crashOrphanedManagers } = runRealBootSequenceUpToResume(db2, host2);

    check("(F) FIX a4c5f234: the early phase CONSOLIDATED — recorded in `consolidated`, never `recovered`", haltedEarly.consolidated.some((c) => c.predecessorId === m1.id && c.freshId === m2.id));
    check("(F) FIX a4c5f234: the early phase did NOT also mark it `recovered`", !haltedEarly.recovered.some((r) => r.predecessorId === m1.id));
    check("(F) FIX a4c5f234: the later phase consolidated it too", haltedFinish.consolidated.includes(m1.id));
    check("(F) FIX a4c5f234: the later phase did NOT also mark it `recovered`", !haltedFinish.recovered.includes(m1.id));

    // The "workers" ownership-transfer step itself ALWAYS succeeds here (only "wakes" was stubbed to fail)
    // — exactly like (A)/(B), the worker DID transfer onto M2 before the halt was ever detected. P, not S1,
    // is the consolidation target (see card a4c5f234's own record for why) — the worker now comes BACK.
    check("(F) FIX a4c5f234: the worker IS reclaimed back onto M1 (the consolidation target is P, never S1)", db2.getSession(workerId)?.parentSessionId === m1.id);
    check("(F) FIX a4c5f234: M2's recycledFrom link IS unlinked now", db2.getSession(m2.id)?.recycledFrom === null);
    check("(F) FIX a4c5f234: M2 is archived (administratively retired)", !!db2.getSession(m2.id)?.archivedAt);
    check("(F) FIX a4c5f234: hasSuccessor(M1) is now FALSE", db2.hasSuccessor(m1.id) === false);
    const consolidatedEvents = db2.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_split_lineage_consolidated");
    check("(F) FIX a4c5f234: exactly one recycle_split_lineage_consolidated event, naming M2", consolidatedEvents.length === 1 && consolidatedEvents[0].detail?.deadSuccessorId === m2.id);
    check("(F) FIX a4c5f234: no recycle_fleet_recovered event was fabricated for M1 (consolidated, not recovered)", !hasEvent(db2, m1.id, "recycle_fleet_recovered"));
    // Code Review ROUND 2, finding 6e: the question (a non-worker category) moved back onto M1 too.
    check("(F) FIX a4c5f234 (6e): the question moved back onto M1 — consolidation isn't worker-only", db2.getQuestion(questionId)?.sessionId === m1.id);

    // NEVER RESURRECT: M1 is made VISIBLE (un-archived, exited) but never actually resumed.
    check("(F) FIX a4c5f234: M1 is un-archived (visible on the live rail)", db2.getSession(m1.id)?.archivedAt == null);
    check("(F) FIX a4c5f234: M1's processState is exited, NOT live — never resumed", db2.getSession(m1.id)?.processState === "exited");
    // Code Review ROUND 2 MAJOR 2: the banner must NOT point at `allowSuperseded` (it can't actually work
    // here — see the decision record) — it uses `stampStranded`'s own honest wording instead.
    check("(F) FIX a4c5f234 (MAJOR 2): M1's lastError carries the orphaned-fleet banner with the HONEST remedy, never allowSuperseded",
      /\[loom:orphaned-fleet\]/.test(db2.getSession(m1.id)?.lastError ?? "") &&
      /no automatic owner/i.test(db2.getSession(m1.id)?.lastError ?? "") &&
      /human must intervene/i.test(db2.getSession(m1.id)?.lastError ?? "") &&
      !/allowSuperseded/.test(db2.getSession(m1.id)?.lastError ?? ""));
    check("(F) M1 was never actually resumed (not alive)", host2.isAlive(m1.id) === false);

    // Code Review follow-up (1): the crash-orphan derivation NOW sees the reparented worker naming M1 as
    // its manager — proving the worktree-protection wiring (index.ts's protectedSessionIds, card 9fc41af5)
    // reaches it for free — but the manager-first resume order (sha:b65d9a5e) means NEITHER M1 nor the
    // worker is ever actually resumed: resume()'s preconditions are a confirmed strict superset of
    // isDurablyResumable's (including the forced-role-fresh-start bypass, MAJOR 1), so M1's own attempt is
    // guaranteed to fail first.
    check("(F) crash-orphan derivation: the reparented worker surfaces, naming M1 as its manager", crashOrphanedWorkers.some((c) => c.workerSessionId === workerId && c.managerSessionId === m1.id));
    // Code Review ROUND 2, finding 6a: inject the real `resumeOne` seam and record every id it's actually
    // called with — proves the worker id is NEVER passed to it, not merely that it ends up not-live.
    const resumeOneCalls = [];
    const { managersFailed } = sessions2.recoverCrashOrphanedWorkers(crashOrphanedWorkers, {
      soloManagerIds: crashOrphanedManagers,
      resumeOne: (id) => { resumeOneCalls.push(id); try { sessions2.resume(id); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; } },
    });
    check("(F) crash-path (6a): M1's own id WAS passed to resumeOne (its attempt is real, not skipped)", resumeOneCalls.includes(m1.id));
    check("(F) crash-path (6a): the worker's id was NEVER passed to resumeOne at all (manager-first ordering)", !resumeOneCalls.includes(workerId));
    check("(F) crash-path: M1's own resume attempt FAILS (NEVER RESURRECT holds through this side door)", managersFailed.includes(m1.id));
    check("(F) crash-path: M1 was NOT actually resumed", host2.isAlive(m1.id) === false);
    check("(F) crash-path: the worker was NEVER individually attempted (manager-first ordering) — still not live", host2.isAlive(workerId) === false);
    // Code Review ROUND 2, finding 6c: the attempt's own outcome — the audit event under M1, M1's
    // resumability afterwards (NOT "dead" — M1 fails on "no engine id", not the transcript/cwd paths that
    // set that stamp, per MAJOR 2's own finding), and the banner still present.
    check("(F) crash-path (6c): a manager_crash_resume_failed event was filed under M1", hasEvent(db2, m1.id, "manager_crash_resume_failed"));
    check("(F) crash-path (6c): M1's resumability is NOT stamped \"dead\" (it failed on \"no engine id\", not transcript/cwd)", db2.getSession(m1.id)?.resumability !== "dead");
    check("(F) crash-path (6c): the orphaned-fleet banner is STILL present after the failed attempt", /\[loom:orphaned-fleet\]/.test(db2.getSession(m1.id)?.lastError ?? ""));

    // Idempotency: a THIRD boot (fresh db/host reopened against the SAME file, mirroring (K)/(L)'s own
    // technique in recycle-settle-lost-to-restart.mjs) must be a no-op — the lineage is already resolved.
    db2.close();
    const { db: db3, host: host3 } = makeBoot();
    const { haltedEarly: haltedEarly3, haltedFinish: haltedFinish3 } = runRealBootSequenceUpToResume(db3, host3);
    check("(F) SECOND BOOT: the lineage is no longer even scanned into `consolidated` again — hasSuccessor(M1) is already false", !haltedEarly3.consolidated.some((c) => c.predecessorId === m1.id));
    check("(F) SECOND BOOT: the later phase consolidated nothing new for this lineage", !haltedFinish3.consolidated.includes(m1.id));
    check("(F) SECOND BOOT: still exactly ONE recycle_split_lineage_consolidated event — no duplicate", db3.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_split_lineage_consolidated").length === 1);
    check("(F) SECOND BOOT: M1 is STILL not resumed", host3.isAlive(m1.id) === false);
  }

  // ==================== (F2) BOTH DEAD, BUT ALREADY RESOLVED — card a4c5f234 must respect the resolved marker ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-f2";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    // M1 never captures a real engine id — unresumable, same shape as (F).
    const { workerId } = seedFleet(db1, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions1.recycleManager(m1.id, "handoff — both dead, but a recycle_reattempt already resolved it before the restart");
    unstub();
    check("(F2 pre) the recycle HALTED", hasEvent(db1, m2.id, "recycle_ownership_transfer_failed"));

    // Simulate a live recycle_reattempt having ALREADY resolved this exact lineage (dfc3b014's own
    // resolution marker) before the crash/restart — same field shape `reattemptManagerOwnershipTransfer`
    // files (service.ts): managerSessionId = the successor, workerSessionId = the predecessor.
    db1.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(), managerSessionId: m2.id, workerSessionId: m1.id,
      kind: "recycle_ownership_transfer_resolved", detail: { successorId: m2.id },
    });
    check("(F2 pre) the resolution marker now names M2 for M1", hasEvent(db1, m1.id, "recycle_ownership_transfer_resolved"));

    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const { haltedEarly, haltedFinish } = runRealBootSequenceUpToResume(db2, host2);

    check("(F2) FIX a4c5f234: the already-resolved lineage is NEVER consolidated — currentHaltedSuccessor stops matching before the new branch is ever reached", !haltedEarly.consolidated.some((c) => c.predecessorId === m1.id));
    check("(F2) the already-resolved lineage is also never in `recovered`", !haltedEarly.recovered.some((r) => r.predecessorId === m1.id));
    check("(F2) the later phase did nothing for this lineage either", !haltedFinish.consolidated.includes(m1.id) && !haltedFinish.recovered.includes(m1.id));
    check("(F2) FIX a4c5f234: the worker is left exactly where it was (still on M2) — nothing reparented it", db2.getSession(workerId)?.parentSessionId === m2.id);
    check("(F2) M2's recycledFrom link is untouched by this card's new branch", db2.getSession(m2.id)?.recycledFrom === m1.id);
    check("(F2) no recycle_split_lineage_consolidated event was fabricated", !hasEvent(db2, m1.id, "recycle_split_lineage_consolidated"));
  }

  // ==================== (F3) card 54434e27 — CRASH BETWEEN THE EARLY REPARENT AND THE LATER PHASE (consolidated bucket) ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-f3";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    // M1 never captures a real engine id — unresumable, same shape as (F).
    const { workerId } = seedFleet(db1, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions1.recycleManager(m1.id, "handoff — both dead, and a crash lands between the early reparent and the later (banner/archive/event) phase");
    unstub();
    check("(F3 pre) the recycle HALTED", hasEvent(db1, m2.id, "recycle_ownership_transfer_failed"));
    check("(F3 pre) M1 never captured a real engine id — unresumable", db1.getSession(m1.id)?.engineSessionId == null);
    check("(F3 pre) M2 never captured a real engine id either — unresumable", db1.getSession(m2.id)?.engineSessionId == null);
    db1.close();

    // Boot 2: run ONLY the early, DB-only prefix — simulates a crash right after it, before the later
    // phase (which needs SessionService/PtyHost, constructed far later in index.ts) ever runs.
    const { db: db2 } = makeBoot();
    const haltedEarly2 = runBootRecoveryPrefix(db2).haltedEarly;
    check("(F3) boot 2: the early phase classified the pair `consolidated`", haltedEarly2.consolidated.some((c) => c.predecessorId === m1.id && c.freshId === m2.id));
    check("(F3) boot 2: hasSuccessor(M1) is now false (the reparent already ran)", db2.hasSuccessor(m1.id) === false);
    check("(F3) boot 2: the worker IS already reparented onto M1", db2.getSession(workerId)?.parentSessionId === m1.id);
    check("(F3) boot 2: the durable marker IS set, naming M2", db2.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id && r.freshId === m2.id));
    // The half-done state this card fixes: reparented, but NOT yet completed — RED on main (main has no
    // marker at all, and the NEXT boot would simply never find this lineage again). M2's own archivedAt
    // is NOT a usable signal here — the generic crash-path backstop (snapshotAndArchiveRecovered, earlier
    // in this SAME prefix) already archives any stale live/starting session regardless of the
    // halted-recycle logic. M1's own banner IS a usable signal — only the later phase ever stamps it.
    check("(F3) boot 2: M1 is NOT yet un-archived/bannered — the later phase never ran", db2.getSession(m1.id)?.lastError == null);
    check("(F3) boot 2: no recycle_split_lineage_consolidated event yet", !hasEvent(db2, m1.id, "recycle_split_lineage_consolidated"));
    db2.close(); // simulates the crash landing exactly in this gap

    // Boot 3: the FULL sequence — must detect the pending lineage via the marker (never via the
    // now-permanently-false hasSuccessor check) and complete it.
    const { db: db3, host: host3 } = makeBoot();
    const { haltedEarly: haltedEarly3, haltedFinish: haltedFinish3 } = runRealBootSequenceUpToResume(db3, host3);
    check("(F3) boot 3: the marker-driven loop re-detected the pair `consolidated`", haltedEarly3.consolidated.some((c) => c.predecessorId === m1.id && c.freshId === m2.id));
    check("(F3) boot 3: the later phase consolidated it", haltedFinish3.consolidated.includes(m1.id));
    check("(F3) boot 3: the worker is STILL on M1", db3.getSession(workerId)?.parentSessionId === m1.id);
    check("(F3) boot 3: M2 is NOW archived", !!db3.getSession(m2.id)?.archivedAt);
    check("(F3) boot 3: M1 is un-archived (visible) but never resumed", db3.getSession(m1.id)?.archivedAt == null && db3.getSession(m1.id)?.processState === "exited" && host3.isAlive(m1.id) === false);
    // Lead review: the banner's worker count must reflect the CURRENT fleet on M1, not the (zero, since
    // this boot's reparent moved nothing new) threaded reparentedWorkers value from boot 3's own early phase.
    check("(F3) boot 3: the banner quotes the REAL current child-session count (1), not 0", /\(1 child session\(s\)/.test(db3.getSession(m1.id)?.lastError ?? ""));
    const consolidatedEvents3 = db3.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_split_lineage_consolidated");
    check("(F3) boot 3: exactly ONE recycle_split_lineage_consolidated event (not duplicated)", consolidatedEvents3.length === 1);
    check("(F3) boot 3: the marker is now CLEARED", !db3.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id));

    // Boot 4: idempotency — a further boot must not re-fire anything for this already-resolved lineage.
    db3.close();
    const { db: db4, host: host4 } = makeBoot();
    const { haltedEarly: haltedEarly4, haltedFinish: haltedFinish4 } = runRealBootSequenceUpToResume(db4, host4);
    check("(F3) boot 4: no longer scanned into `consolidated` again", !haltedEarly4.consolidated.some((c) => c.predecessorId === m1.id));
    check("(F3) boot 4: the later phase consolidated nothing new for this lineage", !haltedFinish4.consolidated.includes(m1.id));
    check("(F3) boot 4: still exactly ONE recycle_split_lineage_consolidated event", db4.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_split_lineage_consolidated").length === 1);
    check("(F3) boot 4: M1 is STILL not resumed", host4.isAlive(m1.id) === false);
  }

  // ==================== (F4) card 54434e27 Code Review m1 — STALE MARKER: P moved on to a NEW successor
  // before the stale marker was ever processed ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-f4";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-f4" });
    writeFakeTranscript(m1.cwd, "eng-m1-f4");
    const { workerId } = seedFleet(db1, P, m1.id);

    const unstub1 = stubWakesPermanentFailure();
    const s1 = await sessions1.recycleManager(m1.id, "handoff — S1 will be left as a stale marker");
    unstub1();
    check("(F4 pre) the first recycle HALTED (naming S1)", hasEvent(db1, s1.id, "recycle_ownership_transfer_failed"));
    db1.close();

    // Boot 2: run ONLY the early prefix — sets the durable marker for (M1, S1) and reparents the worker
    // back onto M1, exactly like (B2)/(F3). Simulates a crash before the later phase ever processes it.
    const { db: db2, host: host2 } = makeBoot();
    const haltedEarly2 = runBootRecoveryPrefix(db2).haltedEarly;
    check("(F4) boot 2: the marker IS set, naming S1", db2.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id && r.freshId === s1.id));
    check("(F4) boot 2: the worker IS reparented onto M1", db2.getSession(workerId)?.parentSessionId === m1.id);
    void haltedEarly2;

    // Continue LIVE on the SAME db2/host2 (no boot, no crash) — M1 is resumed, then halt-recycled AGAIN to
    // a BRAND NEW successor S2, which also dies unresumable — all while S1's marker sits unprocessed
    // (the daemon never restarted, so the early reconcile never ran again to clear it).
    let sessions2;
    host2.events.onExit = (id, code, info) => {
      db2.setProcessState(id, "exited");
      db2.setBusy(id, false);
      const exited = db2.getSession(id);
      if (exited) sessions2.archiveOnExit(exited);
      if (exited) sessions2.reconcileNeverStartedRecycleSuccessor(id, info.intended);
    };
    sessions2 = new SessionService(db2, host2, new OrchestrationControl());
    sessions2.resume(m1.id);
    check("(F4) M1 is genuinely live again after the resume", host2.isAlive(m1.id) === true);

    const unstub2 = stubWakesPermanentFailure();
    const s2 = await sessions2.recycleManager(m1.id, "handoff — a SECOND halt, to S2, while S1's marker is still pending");
    unstub2();
    check("(F4) the second recycle ALSO halted (naming S2)", hasEvent(db2, s2.id, "recycle_ownership_transfer_failed"));
    check("(F4) S2 never captured a real engine id — unresumable", db2.getSession(s2.id)?.engineSessionId == null);
    db2.close(); // the crash this time — S1's marker is STALE, S2's halt is brand new and unprocessed

    // Boot 3: the FULL sequence. S2's lineage must be reconciled normally (via the event-kind loop, since
    // the stale S1 marker must NOT occupy predecessorId in the skip-set); S1's stale marker must be
    // cleared WITHOUT any action — no event, no nudge, no banner naming S1.
    const { db: db3, host: host3 } = makeBoot();
    // Code Review round 2 item 4: spy on the REAL enqueueDurableNudge call directly — a downstream queue
    // read (listUnresolvedQueuedMessagesForWorker) can under-report (it excludes an already-delivered
    // message), which made an earlier draft of this exact check vacuous.
    const nudgeSpy3 = spyOnEnqueueDurableNudge();
    let haltedEarly3, haltedFinish3;
    try {
      ({ haltedEarly: haltedEarly3, haltedFinish: haltedFinish3 } = runRealBootSequenceUpToResume(db3, host3));
    } finally {
      nudgeSpy3.restore();
    }

    check("(F4) FIX m1: S2's lineage IS reconciled — classified `recovered` (M1 is durably resumable)",
      haltedEarly3.recovered.some((r) => r.predecessorId === m1.id && r.freshId === s2.id));
    check("(F4) FIX m1: the stale S1 marker is NEVER classified `recovered` or `consolidated`",
      !haltedEarly3.recovered.some((r) => r.freshId === s1.id) && !haltedEarly3.consolidated.some((c) => c.freshId === s1.id));
    check("(F4) FIX m1: the later phase actually recovered M1 for S2", haltedFinish3.recovered.includes(m1.id));
    check("(F4) FIX m1: the worker (never touched by S1 OR S2) is STILL on M1", db3.getSession(workerId)?.parentSessionId === m1.id);
    check("(F4) FIX m1: the stale S1 marker is now CLEARED", !db3.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id));
    check("(F4) FIX m1: NO event anywhere names S1 as the dead successor",
      !db3.listEventsForSession(m1.id).some((e) =>
        (e.kind === "recycle_fleet_recovered" || e.kind === "recycle_split_lineage_consolidated") &&
        e.detail?.deadSuccessorId === s1.id));
    // Code Review round 2 item 4: match the 8-char prefix the banner/nudge text actually embeds — matching
    // the FULL id here is vacuous (it can never appear, so the check passes regardless of the bug).
    check("(F4) FIX m1: NO real enqueueDurableNudge call mentions S1's id",
      !nudgeSpy3.calls.some((args) => args[2]?.includes(s1.id.slice(0, 8))));
    check("(F4) FIX m1: M1's lastError does not mention S1 either", !(db3.getSession(m1.id)?.lastError ?? "").includes(s1.id.slice(0, 8)));
  }

  // ==================== (F4b) card 54434e27 Code Review round 2 item 3 — STALE MARKER via the OTHER
  // disjunct: a newer halt event, with NO new successor currently linked (hasSuccessor alone would miss
  // this) ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-f4b";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-f4b" });
    writeFakeTranscript(m1.cwd, "eng-m1-f4b");
    const { workerId } = seedFleet(db1, P, m1.id);

    const unstub1 = stubWakesPermanentFailure();
    const s1 = await sessions1.recycleManager(m1.id, "handoff — S1 will be left as a stale marker");
    unstub1();
    check("(F4b pre) the first recycle HALTED (naming S1)", hasEvent(db1, s1.id, "recycle_ownership_transfer_failed"));
    db1.close();

    // Boot 2: run ONLY the early prefix — sets the durable marker for (M1, S1), exactly like (F4).
    const { db: db2, host: host2 } = makeBoot();
    runBootRecoveryPrefix(db2);
    check("(F4b) boot 2: the marker IS set, naming S1", db2.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id && r.freshId === s1.id));

    // Continue LIVE: M1 is resumed, halt-recycled AGAIN to S2 — identical to (F4) so far.
    let sessions2;
    host2.events.onExit = (id, code, info) => {
      db2.setProcessState(id, "exited");
      db2.setBusy(id, false);
      const exited = db2.getSession(id);
      if (exited) sessions2.archiveOnExit(exited);
      if (exited) sessions2.reconcileNeverStartedRecycleSuccessor(id, info.intended);
    };
    sessions2 = new SessionService(db2, host2, new OrchestrationControl());
    sessions2.resume(m1.id);
    const unstub2 = stubWakesPermanentFailure();
    const s2 = await sessions2.recycleManager(m1.id, "handoff — a SECOND halt, to S2");
    unstub2();
    check("(F4b) the second recycle ALSO halted (naming S2)", hasEvent(db2, s2.id, "recycle_ownership_transfer_failed"));

    // UNLIKE (F4): S2 now dies too, WHILE M1 IS STILL ALIVE, and the IN-PROCESS reclaim watch
    // (watchHaltedRecycleSuccessor) unlinks S2 and reclaims it back onto M1 — all before any reboot. This
    // makes `hasSuccessor(M1)` FALSE again (the `hasSuccessor` disjunct alone would miss this lineage),
    // while S2 is now the predecessor's LATEST halt event — the SECOND staleness disjunct.
    const s2Pty = host2.handles.get(s2.id);
    check("(F4b setup) S2's fake pty handle captured", !!s2Pty);
    s2Pty.kill();
    const reclaimed = await waitUntil(() => hasEvent(db2, m1.id, "recycle_fleet_recovered"));
    check("(F4b) the in-process watch reclaimed S2's fleet onto M1 (no reboot)", reclaimed);
    check("(F4b) hasSuccessor(M1) is FALSE again — the hasSuccessor disjunct alone would miss this", db2.hasSuccessor(m1.id) === false);
    db2.close(); // the crash this time — S1's marker is stale via the SECOND disjunct; S2 is already fully resolved

    // Boot 3: the FULL sequence. S1's stale marker must be cleared WITHOUT any action, and nothing new
    // happens for S2 either — its lineage is ALREADY resolved via the in-process path.
    const { db: db3, host: host3 } = makeBoot();
    const nudgeSpy = spyOnEnqueueDurableNudge();
    let haltedEarly3, haltedFinish3;
    try {
      ({ haltedEarly: haltedEarly3, haltedFinish: haltedFinish3 } = runRealBootSequenceUpToResume(db3, host3));
    } finally {
      nudgeSpy.restore();
    }

    check("(F4b) FIX round 2 item 3: the stale S1 marker is NEVER classified `recovered` or `consolidated`",
      !haltedEarly3.recovered.some((r) => r.freshId === s1.id) && !haltedEarly3.consolidated.some((c) => c.freshId === s1.id));
    check("(F4b) FIX round 2 item 3: nothing new happened for M1 (S2's lineage was already resolved in-process)",
      !haltedFinish3.recovered.includes(m1.id) && !haltedFinish3.consolidated.includes(m1.id));
    check("(F4b) FIX round 2 item 3: the worker is STILL on M1", db3.getSession(workerId)?.parentSessionId === m1.id);
    check("(F4b) FIX round 2 item 3: the stale S1 marker is now CLEARED", !db3.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id));
    check("(F4b) FIX round 2 item 3: NO event anywhere names S1 as the dead successor",
      !db3.listEventsForSession(m1.id).some((e) =>
        (e.kind === "recycle_fleet_recovered" || e.kind === "recycle_split_lineage_consolidated") &&
        e.detail?.deadSuccessorId === s1.id));
    check("(F4b) FIX round 2 item 3: NO real enqueueDurableNudge call mentions S1's id",
      !nudgeSpy.calls.some((args) => args[2]?.includes(s1.id.slice(0, 8))));
    check("(F4b) FIX round 2 item 3: M1's lastError does not mention S1 either", !(db3.getSession(m1.id)?.lastError ?? "").includes(s1.id.slice(0, 8)));
  }

  // ==================== (F5) card 54434e27 Code Review m3 — a throw in the LATER phase leaves the marker
  // set; a subsequent run completes it ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rmhsd-f5";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    // M1 never captures a real engine id — unresumable, so this exercises the `consolidated` branch.
    const { workerId } = seedFleet(db1, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions1.recycleManager(m1.id, "handoff — a throw in the later phase must leave the marker set");
    unstub();
    check("(F5 pre) the recycle HALTED", hasEvent(db1, m2.id, "recycle_ownership_transfer_failed"));
    db1.close();

    const { db: db2, host: host2 } = makeBoot();
    const haltedEarly = runBootRecoveryPrefix(db2).haltedEarly;
    check("(F5) early phase classified the pair `consolidated`", haltedEarly.consolidated.some((c) => c.predecessorId === m1.id && c.freshId === m2.id));

    const sessions2 = new SessionService(db2, host2, new OrchestrationControl());
    const originalUnlinkAndArchive = SessionService.prototype.unlinkAndArchiveDeadRecycleSuccessor;
    let throwCount = 0;
    SessionService.prototype.unlinkAndArchiveDeadRecycleSuccessor = function (...args) {
      if (throwCount === 0) { throwCount++; throw new Error("injected later-phase failure (F5 test)"); }
      return originalUnlinkAndArchive.apply(this, args);
    };
    try {
      const finish1 = sessions2.finishReconcilingHaltedRecycleSuccessors(haltedEarly);
      check("(F5) the throwing attempt did NOT consolidate M1", !finish1.consolidated.includes(m1.id));
    } finally {
      SessionService.prototype.unlinkAndArchiveDeadRecycleSuccessor = originalUnlinkAndArchive;
    }
    check("(F5) the marker SURVIVES the throw", db2.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id && r.freshId === m2.id));
    check("(F5) M1 is NOT yet un-archived/bannered — the throw happened before any of that ran", db2.getSession(m1.id)?.lastError == null);
    check("(F5) no recycle_split_lineage_consolidated event was fabricated by the failed attempt", !hasEvent(db2, m1.id, "recycle_split_lineage_consolidated"));

    // A subsequent run (same process, simulating "the next boot") completes it cleanly.
    const haltedEarly2 = runBootRecoveryPrefix(db2).haltedEarly;
    const finish2 = sessions2.finishReconcilingHaltedRecycleSuccessors(haltedEarly2);
    check("(F5) the subsequent run DOES consolidate M1", finish2.consolidated.includes(m1.id));
    check("(F5) the marker is now CLEARED", !db2.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id));
    check("(F5) exactly ONE recycle_split_lineage_consolidated event — the failed attempt never fabricated one", db2.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_split_lineage_consolidated").length === 1);
    check("(F5) the worker ended up on M1 regardless", db2.getSession(workerId)?.parentSessionId === m1.id);
  }

  // ==================== (F6) card 54434e27 Code Review m3 — a throw mid-reparent rolls back fully: no
  // partial state, no marker ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmhsd-f6";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId } = seedFleet(db, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — reparentHaltedRecycleLineage itself will throw mid-way");
    unstub();
    check("(F6 pre) the recycle HALTED", hasEvent(db, m2.id, "recycle_ownership_transfer_failed"));
    check("(F6 pre) the worker DID transfer onto M2 during the live halt", db.getSession(workerId)?.parentSessionId === m2.id);

    const originalReparentWebhookTargets = Db.prototype.reparentWebhookTargets;
    Db.prototype.reparentWebhookTargets = function () { throw new Error("injected mid-reparent failure (F6 test)"); };
    let thrown = null;
    try { db.reparentHaltedRecycleLineage(m2.id, m1.id); } catch (e) { thrown = e; }
    Db.prototype.reparentWebhookTargets = originalReparentWebhookTargets;

    check("(F6) FIX m3: reparentHaltedRecycleLineage DID throw", thrown !== null && /injected mid-reparent failure/.test(thrown.message));
    check("(F6) FIX m3: the worker is STILL on M2 — the reparent rolled back fully", db.getSession(workerId)?.parentSessionId === m2.id);
    check("(F6) FIX m3: M2's recycledFrom link is STILL intact — not partially unlinked", db.getSession(m2.id)?.recycledFrom === m1.id);
    check("(F6) FIX m3: NO marker was left behind by the failed transaction", !db.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id));
    check("(F6) FIX m3: hasSuccessor(M1) is STILL true — nothing committed", db.hasSuccessor(m1.id) === true);
  }

  // ==================== (F5b) card 54434e27 Code Review round 2 item 2 — the DUPLICATE GUARD, exercised
  // directly: a completion event for (M1, M2) already exists WHILE the marker is still set ⇒ the recovered
  // branch finishes with exactly ONE event and ZERO new nudges ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmhsd-f5b";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    host.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-f5b" });
    writeFakeTranscript(m1.cwd, "eng-m1-f5b");
    const { workerId } = seedFleet(db, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — a completion event for this pair already exists, pre-seeded");
    unstub();
    check("(F5b pre) the recycle HALTED", hasEvent(db, m2.id, "recycle_ownership_transfer_failed"));

    // Simulate the EARLY phase having already run (reparent + marker set) AND the later phase having
    // already fired its event once in some prior (pre-atomicity-fix) run, without ever clearing the
    // marker — the exact shape the duplicate guard exists to protect against.
    const reparentedWorkers = db.reparentHaltedRecycleLineage(m2.id, m1.id);
    db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(), managerSessionId: m1.id,
      kind: "recycle_fleet_recovered", detail: { deadSuccessorId: m2.id, oldStillLive: true, reparentedWorkers },
    });
    check("(F5b pre) exactly one recycle_fleet_recovered event exists (the pre-seeded one)",
      db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered").length === 1);
    check("(F5b pre) the marker is STILL set (the old run never cleared it)",
      db.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id && r.freshId === m2.id));

    const nudgeSpy = spyOnEnqueueDurableNudge();
    let finish;
    try {
      finish = sessions.finishReconcilingHaltedRecycleSuccessors({
        recovered: [{ predecessorId: m1.id, freshId: m2.id, reparentedWorkers }], pendingResolution: [], consolidated: [],
      });
    } finally {
      nudgeSpy.restore();
    }

    check("(F5b) FIX round 2 item 2: the run finishes (recovered includes M1)", finish.recovered.includes(m1.id));
    check("(F5b) FIX round 2 item 2: the marker is now CLEARED", !db.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id));
    check("(F5b) FIX round 2 item 2: STILL exactly ONE recycle_fleet_recovered event — no duplicate",
      db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered").length === 1);
    check("(F5b) FIX round 2 item 2: ZERO new enqueueDurableNudge calls", nudgeSpy.calls.length === 0);
    check("(F5b) the worker is on M1", db.getSession(workerId)?.parentSessionId === m1.id);
  }

  // ==================== (F5c) card 54434e27 Code Review round 2 item 2 — ATOMICITY: a throw inside
  // finishHaltedRecyclePending's own marker-clear statement rolls the completion EVENT back too ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmhsd-f5c";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    host.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-f5c" });
    writeFakeTranscript(m1.cwd, "eng-m1-f5c");
    seedFleet(db, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — the marker-clear statement itself will throw");
    unstub();
    check("(F5c pre) the recycle HALTED", hasEvent(db, m2.id, "recycle_ownership_transfer_failed"));
    const reparentedWorkers = db.reparentHaltedRecycleLineage(m2.id, m1.id);

    const originalClearStatement = Db.prototype.clearHaltedRecyclePendingStatement;
    Db.prototype.clearHaltedRecyclePendingStatement = function () { throw new Error("injected marker-clear failure (F5c test)"); };
    let finish;
    try {
      finish = sessions.finishReconcilingHaltedRecycleSuccessors({
        recovered: [{ predecessorId: m1.id, freshId: m2.id, reparentedWorkers }], pendingResolution: [], consolidated: [],
      });
    } finally {
      Db.prototype.clearHaltedRecyclePendingStatement = originalClearStatement;
    }

    check("(F5c) FIX round 2 item 2: the branch did NOT recover M1 — the throw was caught", !finish.recovered.includes(m1.id));
    check("(F5c) FIX round 2 item 2: the marker is STILL set — the clear genuinely failed",
      db.listHaltedRecyclePending().some((r) => r.predecessorId === m1.id && r.freshId === m2.id));
    check("(F5c) FIX round 2 item 2: the completion event was ALSO rolled back — the SAME transaction never committed",
      db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered").length === 0);
  }

  // ==================== (F7) card 54434e27 Code Review round 2 item 1 — the recovered branch's stale-
  // banner clear is SCOPED to this mechanism's own text, never a bare [loom:orphaned-fleet] match ====================
  {
    // (F7a) an UNRELATED orphaned-fleet banner (e.g. archiveOnExit's own) must SURVIVE the recovered branch.
    const { db, host, sessions } = makeHarness();
    const P = "rmhsd-f7a";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    host.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-f7a" });
    writeFakeTranscript(m1.cwd, "eng-m1-f7a");
    seedFleet(db, P, m1.id);
    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — an unrelated orphaned-fleet banner must survive");
    unstub();
    const reparentedWorkers = db.reparentHaltedRecycleLineage(m2.id, m1.id);
    const unrelatedBanner = "[loom:orphaned-fleet] This manager exited while 2 worker(s)/child sessions were still live; archived instead of orphaning them — review before resuming.";
    db.setLastError(m1.id, unrelatedBanner);

    sessions.finishReconcilingHaltedRecycleSuccessors({
      recovered: [{ predecessorId: m1.id, freshId: m2.id, reparentedWorkers }], pendingResolution: [], consolidated: [],
    });
    check("(F7a) FIX round 2 item 1: an UNRELATED orphaned-fleet banner SURVIVES the recovered branch",
      db.getSession(m1.id)?.lastError === unrelatedBanner);
  }
  {
    // (F7b) THIS mechanism's own banner, for this exact freshId, IS cleared.
    const { db, host, sessions } = makeHarness();
    const P = "rmhsd-f7b";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    host.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-f7b" });
    writeFakeTranscript(m1.cwd, "eng-m1-f7b");
    seedFleet(db, P, m1.id);
    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — this mechanism's own stale banner must be cleared");
    unstub();
    const reparentedWorkers = db.reparentHaltedRecycleLineage(m2.id, m1.id);
    // Exactly the text a prior boot's PARTIAL `consolidated` attempt for this SAME freshId would have
    // stamped (see the `consolidated` branch's own banner) before throwing.
    const ownStaleBanner = `[loom:orphaned-fleet] A halted recycle's successor ${m2.id.slice(0, 8)} is unresumable, and this predecessor is also not resumable this boot — its fleet (1 child session(s), plus whatever wakes/questions/pending had transferred) has been consolidated back onto THIS session as bookkeeping only. No automatic owner exists; a human must intervene (reassign the workers or start a new manager).`;
    db.setLastError(m1.id, ownStaleBanner);

    sessions.finishReconcilingHaltedRecycleSuccessors({
      recovered: [{ predecessorId: m1.id, freshId: m2.id, reparentedWorkers }], pendingResolution: [], consolidated: [],
    });
    check("(F7b) FIX round 2 item 1: THIS mechanism's own stale banner (for this freshId) IS cleared",
      db.getSession(m1.id)?.lastError == null);
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
  ? "\n✅ ALL PASS — a halted recycle's successor-death watch reclaims whatever DID transfer (in-process and across a boot reconcile); card 386e4eb5's isSupersededByRecycle carve-out correctly auto-resumes a halted predecessor ONLY while its successor still exactly matches its latest unresolved halt (id — the real discriminator; gen only a defensive secondary check) — via resume(), the crash-recovery candidate derivation, and resumeFleetOnBoot's capture alike — while an ordinary recycle and a re-recycle to a different successor (id mismatch) than its halt event named both stay refused exactly as before; card a4c5f234's both-dead lineage is now CONSOLIDATED onto the predecessor as bookkeeping only (never resumed, idempotent, never through the crash-orphan side door either) unless dfc3b014's own resolution marker already named it, in which case it stays untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
