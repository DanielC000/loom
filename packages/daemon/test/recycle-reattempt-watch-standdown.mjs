import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b59d11f6 — Code Review of 91ac2b79 flagged an unverified race: `recycle_reattempt` reaching
// "resolved" fires `settleRecycleHandoff` unawaited (which stops M1), while `watchHaltedRecycleSuccessor`
// — armed independently from recycleManager's own HALT branch, still looping on its own timer — has no
// idea anything resolved. If M2 then crashes, the watch's existing reclaim branch
// (`recoverFleetAfterFailedRecycleSuccessor`) can hand the fleet BACK onto M1 — which `settleRecycleHandoff`
// is about to stop (or already has) — stranding it a second time.
//
// Investigate-first checkpoint confirmed the race at source (see
// docs/decisions/b59d11f6-watch-standdown-after-reattempt-resolved.md for the full trace) and the LEAD
// ruling approved the fix: `watchHaltedRecycleSuccessor` now checks, as the FIRST statement of every loop
// iteration, whether a `recycle_ownership_transfer_resolved` event for oldId names THIS lineage's freshId
// as `detail.successorId` — and stands down for good the instant one does, regardless of M2's state. It
// never stops anything itself (@decision f1969787 unchanged) — settleRecycleHandoff stays the sole
// stopper. (Lineage scoping added in a final round, finding 3 — see (S-D) below.)
//
// Proves:
//   (S-A) resolved, then M2 dies with nothing to automatically revive it: on OLD code the watch would
//        reclaim the fleet onto M1 (wrongly — ownership already resolved to M2, M1 is being retired). FIX:
//        the watch stands down instead — no reclaim, hasSuccessor(M1) stays true, M2 stays durably
//        resumable and unarchived (never dead-stamped by a wrongful reclaim), so a future recovery
//        mechanism remains the correct path back for M2, not a reclaim onto M1.
//   (S-B) resolved, then settleRecycleHandoff's own stop(M1) has been ISSUED but M1's exit has not yet
//        fired (the real kill()->'exit' async window, driven via a deferred-exit fake pty so the window is
//        test-controlled rather than timing-dependent) — THEN M2 dies, THEN a watch tick. Same FIX: no
//        reclaim, regardless of M1's stale-alive reading at that instant.
//   (S-C) REGRESSION, NO REATTEMPT: a halted successor dying with nothing to revive it still reclaims onto
//        the predecessor exactly as on main — proves the new stand-down check is scoped to a genuinely
//        resolved lineage, never a blanket "never reclaim" change. (The existing recycle-manager-
//        halted-successor-dies.mjs (A)/(A3)/(A5) and recycle-reattempt.mjs (R3a)/(R3b) scenarios are the
//        broader version of this same regression guard — run directly as part of this card's DoD, not
//        re-derived here.)
//   (S-D) LINEAGE PRECISION: a `recycle_ownership_transfer_resolved` marker for oldId whose
//        `detail.successorId` names an UNRELATED successor (never freshId) must NOT stand down this
//        watch — it still reclaims onto M1, identically to (S-C). Proves the stand-down check matches on
//        the successor id, not merely on whether oldId has EVER had any resolved marker at all.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: mirrors recycle-manager-halted-successor-dies.mjs
// and recycle-reattempt.mjs's own harnesses — a REAL Db + SessionService + PtyHost driven against a FAKE
// low-level pty (the shared createPty() seam), extended here with a deferred-exit variant so the real
// kill()->'exit' async window can be driven explicitly instead of via a timing guess.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-reattempt-watch-standdown.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

const tmpHome = path.join(os.tmpdir(), `loom-rrws-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every settle bound BEFORE importing dist/** (mirrors both sibling files), with one
// deliberate difference from them: TIMEOUT_MS is SHORT (not effectively unreachable) and SLOW_POLL_MS is
// long. (S-B) needs the watch's own next tick to land STRICTLY AFTER settleRecycleHandoff's real stop(M1)
// has been issued — both run on independent timers, so the only DETERMINISTIC way to guarantee that
// ordering (rather than a probabilistic race between two independently-phased poll intervals) is to park
// the watch in its long slow-poll cadence (via an explicit buffer past its own short alert bound) BEFORE
// touching M2 at all, so its next tick can only fall long after the whole short critical sequence that
// follows. (S-A)/(S-C) are unaffected by this — their own ready-to-death transition has no real-time gap
// for a tick to land in at all (see each scenario's own comment), so they just resolve `watchPromise` a
// little later than they would with a short SLOW_POLL_MS, never incorrectly.
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = "20";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = "10";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = "30";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_SLOW_POLL_MS = "2000";
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { recordUnexpectedExit } = await import("../dist/orchestration/crash-recovery-watcher.js");

const repo = path.join(os.tmpdir(), `loom-rrws-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# recycle-reattempt-watch-standdown test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rrws@loom -c user.name=rrws");

// Extends the shared fake-pty seam with a DEFERRED-EXIT variant: when a session id is added to
// `deferredKillIds`, calling pty.kill() on its handle records the real exit callback instead of firing it
// — so `live.alive` stays true (mirrors the REAL kill()->'exit' async window pty/host.ts documents) until
// the test explicitly calls `host.fireDeferredExit(id)`. Every other session's kill() is unaffected
// (fires immediately, exactly like the shared fixture).
class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map(); // sessionId -> the fake low-level pty object
  stoppedIds = new Set();
  deferredKillIds = new Set();
  pendingExitCb = new Map(); // sessionId -> the captured real exit callback, held until fired manually
  createPty(opts) {
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    let exitCb = null;
    pty.onExit = (cb) => { exitCb = cb; return { dispose() {} }; };
    pty.kill = () => {
      if (this.deferredKillIds.has(opts.sessionId)) {
        this.pendingExitCb.set(opts.sessionId, exitCb);
        return; // kill "issued" — the real exit callback is deliberately NOT fired yet
      }
      const cb = exitCb; exitCb = null; cb?.({ exitCode: 0 });
    };
    return pty;
  }
  fireDeferredExit(id) {
    const cb = this.pendingExitCb.get(id);
    this.pendingExitCb.delete(id);
    cb?.({ exitCode: 0 });
  }
  stop(id, mode) { this.stoppedIds.add(id); return super.stop(id, mode); }
}

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

function seedProject(db, id, { disableCrashRecovery = false } = {}) {
  const now = new Date().toISOString();
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  // startupModeCycles:0 — markReady runs synchronously off a single SessionStart hook delivery (mirrors
  // both sibling files' own identical reasoning). crashRecoveryMaxAttempts:0 (when requested) makes
  // willRecoverAutomatically false even for a genuinely-crashed, durably-resumable successor — the shape
  // needed to force OLD code's reclaim branch (necessary for a RED-on-main repro; see (S-A)'s own comment).
  const orchestration = disableCrashRecovery ? { crashRecoveryMaxAttempts: 0 } : undefined;
  db.setProjectConfig(id, { permission: { startupModeCycles: 0 }, ...(orchestration ? { orchestration } : {}) });
}

/** Seeds a live worker onto `managerId` (mirrors both sibling files' own identical helper). */
function seedFleet(db, projectId, managerId) {
  const now = new Date().toISOString();
  const workerId = `${managerId}-worker`;
  db.insertTask({ id: `${managerId}-task`, projectId, title: "t", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: workerId, projectId, agentId: `${projectId}-mgr`, engineSessionId: "eng-w", title: null, cwd: repo, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: managerId, taskId: `${managerId}-task` });
  return { workerId };
}

/** Writes a real (empty) engine transcript file so `isDurablyResumable` reads true (mirrors both sibling
 *  files' own identically-named helper). */
function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

const hasEvent = (db, id, kind) => db.listEventsForSession(id).some((e) => e.kind === kind);

/** Forces the "wakes" ownership-transfer step to fail permanently (mirrors both sibling files' own
 *  identically-named helper) so recycleManager halts. Caller restores. */
function stubWakesPermanentFailure() {
  const original = Db.prototype.reparentWakes;
  Db.prototype.reparentWakes = function () { throw new Error("injected PERMANENT failure (recycle-reattempt-watch-standdown test)"); };
  return () => { Db.prototype.reparentWakes = original; };
}

/** Halts M1->M2, capturing recycleManager's own internally-armed watchHaltedRecycleSuccessor promise
 *  (mirrors recycle-manager-halted-successor-dies.mjs's (A2)/(A4)/(A6) technique) — the PRODUCTION watch,
 *  not a second manual one racing it. Returns everything a scenario needs, including `watchPromise`. */
async function haltedLineageWithWatch(projectSuffix, { disableCrashRecovery = false } = {}) {
  const { db, host, sessions } = makeHarness();
  const P = `rrws-${projectSuffix}`;
  seedProject(db, P, { disableCrashRecovery });
  const m1 = sessions.startManager(`${P}-mgr`);
  const { workerId } = seedFleet(db, P, m1.id);

  let watchPromise;
  const originalWatch = SessionService.prototype.watchHaltedRecycleSuccessor;
  SessionService.prototype.watchHaltedRecycleSuccessor = function (...args) {
    watchPromise = originalWatch.apply(this, args);
    return watchPromise;
  };
  const unstub = stubWakesPermanentFailure();
  const m2 = await sessions.recycleManager(m1.id, `handoff — forcing a halt (${projectSuffix})`);
  unstub();
  SessionService.prototype.watchHaltedRecycleSuccessor = originalWatch;
  if (!hasEvent(db, m2.id, "recycle_ownership_transfer_failed")) throw new Error(`setup failed to halt (${projectSuffix})`);
  if (!watchPromise) throw new Error(`setup failed to arm the watch (${projectSuffix})`);
  return { db, host, sessions, m1, m2, workerId, watchPromise };
}

try {
  // ==================== (S-A) resolved, then M2 dies — the watch must NOT reclaim ====================
  {
    const { db, host, sessions, m1, m2, workerId, watchPromise } = await haltedLineageWithWatch("sa", { disableCrashRecovery: true });

    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    writeFakeTranscript(m2.cwd, engineSessionId);
    check("(S-A pre) M2 reached real ready via a genuine SessionStart hook", host.hasReachedReady(m2.id) === true);

    // The forced wakes-failure is lifted implicitly by haltedLineageWithWatch's own unstub() — retry now.
    const result = await sessions.reattemptManagerOwnershipTransfer(m1.id, "S-A handoff — resolved, then M2 crashes before the watch's next tick");
    check("(S-A) recycle_reattempt RESOLVED", result.outcome === "resolved" && result.successorId === m2.id);
    check("(S-A) the resolution marker is on record for M1", hasEvent(db, m1.id, "recycle_ownership_transfer_resolved"));

    // M2 crashes right after resolving — real context (turnSeq>0), durably resumable, a genuine crash
    // trigger IS filed, but crash recovery is deliberately disabled for this project (seedProject above)
    // so willRecoverAutomatically reads false — the ONE shape that makes the OLD watch code's reclaim
    // branch fire unconditionally (a prerequisite for a RED-on-main repro; see this file's header).
    db.incrementTurnSeq(m2.id);
    host.handles.get(m2.id).kill();
    recordUnexpectedExit(db, m2.id, false);
    check("(S-A setup) M2 confirmed dead, with real context and a filed trigger", host.isAlive(m2.id) === false && db.getSession(m2.id)?.turnSeq > 0);

    await watchPromise; // resolves the instant the loop's own next poll makes its decision (stand down or reclaim) — no timer

    check("(S-A) FIX b59d11f6: the watch did NOT reclaim the fleet onto M1", !hasEvent(db, m1.id, "recycle_fleet_recovered"));
    check("(S-A) hasSuccessor(M1) stays true — ownership was never pulled back", db.hasSuccessor(m1.id) === true);
    check("(S-A) the worker stays parented to M2 — nothing was wrongly reclaimed", db.getSession(workerId)?.parentSessionId === m2.id);
    check("(S-A) M2 was NOT archived/dead-stamped by a wrongful reclaim", !db.getSession(m2.id)?.archivedAt);
    // DISCRIMINATING on main: `isDurablyResumable` (dropped — it never reads `resumability`, so it reads
    // true even on buggy main's dead-stamped M2, and its old label overclaimed a "future recovery
    // mechanism" that this scenario's own disableCrashRecovery:true setup guarantees will never run).
    // `unlinkAndArchiveDeadRecycleSuccessor`'s reclaim path unconditionally stamps `resumability:"dead"`
    // (same transaction as the archive above) — checking it directly is what actually tells fixed from
    // buggy behavior here, not merely restating the archivedAt check above under a different name.
    check("(S-A) FINAL STATE: M2's resumability was NOT stamped 'dead' by a wrongful reclaim — ownership stays with M2, never pulled back onto M1", db.getSession(m2.id)?.resumability !== "dead");
  }

  // ==================== (S-B) resolved, settle's stop(M1) ISSUED but M1 not yet exited, then M2 dies ====================
  // The watch and settleRecycleHandoff run on INDEPENDENT timers. To get a DETERMINISTIC (not racy) proof
  // that the watch's decisive tick lands strictly AFTER settle's real stop(M1) has been issued, this
  // scenario first parks the watch in its long SLOW_POLL_MS cadence (by waiting past its own short
  // TIMEOUT_MS alert bound) BEFORE touching M2 at all — so its next tick can only fall long after the
  // short (sub-50ms) critical sequence that follows, never by chance landing inside it.
  {
    const { db, host, sessions, m1, m2, workerId, watchPromise } = await haltedLineageWithWatch("sb", { disableCrashRecovery: true });

    // Pure setup, not a correctness proof: parks the watch in its 2000ms slow-poll before anything below
    // touches M2 or M1 — so its next tick can only land long after the short critical sequence that
    // follows, never by chance landing inside it. LOAD-BEARING for the RED half: without this, the watch
    // may not yet have crossed its own `alerted` threshold on a slow/contended host, and the critical
    // sequence's tick would race the ALERT tick instead of the guaranteed slow-poll one — a false GREEN
    // on main. Waited on the watch's own `recycle_fleet_unresolved` alert (filed the instant `alerted`
    // flips true, before its first slow-poll sleep) rather than a fixed sleep, so entry into slow-poll is
    // an OBSERVED event, not a timing guess.
    const enteredSlowPoll = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_unresolved"));
    check("(S-B setup) the watch's own alert fired — it has entered its slow-poll cadence", enteredSlowPoll);

    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    writeFakeTranscript(m2.cwd, engineSessionId);

    // M1's kill() will be ISSUED by settleRecycleHandoff below but its exit callback withheld — the real
    // kill()->'exit' async window, test-controlled rather than timing-dependent.
    host.deferredKillIds.add(m1.id);

    let settlePromise;
    const originalSettle = SessionService.prototype.settleRecycleHandoff;
    SessionService.prototype.settleRecycleHandoff = function (...args) {
      settlePromise = originalSettle.apply(this, args);
      return settlePromise;
    };
    const result = await sessions.reattemptManagerOwnershipTransfer(m1.id, "S-B handoff — settle stops M1 before M2 crashes");
    check("(S-B) recycle_reattempt RESOLVED", result.outcome === "resolved" && result.successorId === m2.id);
    check("(S-B setup) settleRecycleHandoff's own promise was captured", !!settlePromise);

    // settleRecycleHandoff's ready-branch is guaranteed true on its first check (M2 was already ready
    // before "resolved" was reached) — await its own promise: an OBSERVABLE completion, never a duration.
    // It returns right after issuing the stop, since `alerted` is false on this first check.
    await settlePromise;
    SessionService.prototype.settleRecycleHandoff = originalSettle;
    check("(S-B) settleRecycleHandoff DID call stop(M1)", host.stoppedIds.has(m1.id));
    check("(S-B) M1's exit is WITHHELD — isAlive(M1) still reads true, exactly like the real kill()->'exit' window", host.isAlive(m1.id) === true);

    // NOW M2 crashes — real context, durably resumable, a genuine trigger, recovery disabled (same shape
    // as (S-A), for the same RED-on-main reason).
    db.incrementTurnSeq(m2.id);
    host.handles.get(m2.id).kill();
    recordUnexpectedExit(db, m2.id, false);
    check("(S-B setup) M2 confirmed dead, with real context and a filed trigger", host.isAlive(m2.id) === false && db.getSession(m2.id)?.turnSeq > 0);

    await watchPromise; // resolves the instant the loop's own next poll makes its decision — no timer

    check("(S-B) FIX b59d11f6: no reclaim onto M1, even while M1's isAlive still read stale-true", !hasEvent(db, m1.id, "recycle_fleet_recovered"));
    check("(S-B) hasSuccessor(M1) stays true — ownership was never pulled back", db.hasSuccessor(m1.id) === true);
    check("(S-B) the worker stays parented to M2 — nothing was wrongly reclaimed", db.getSession(workerId)?.parentSessionId === m2.id);
    check("(S-B) M2 was NOT archived/dead-stamped by a wrongful reclaim", !db.getSession(m2.id)?.archivedAt);

    // Let M1's deferred exit actually fire now, so the harness's own teardown doesn't leave a dangling
    // callback — not load-bearing for the assertions above, just hermetic cleanup.
    host.fireDeferredExit(m1.id);
  }

  // ==================== (S-C) REGRESSION, NO REATTEMPT — still reclaims exactly as on main ====================
  {
    const { db, host, sessions, m1, m2, workerId, watchPromise } = await haltedLineageWithWatch("sc", { disableCrashRecovery: true });

    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    writeFakeTranscript(m2.cwd, engineSessionId);
    db.incrementTurnSeq(m2.id);
    host.handles.get(m2.id).kill(); // dies — no recycle_reattempt was ever called for this lineage
    recordUnexpectedExit(db, m2.id, false);

    await watchPromise;

    check("(S-C) REGRESSION: with no reattempt, the watch STILL reclaims the fleet onto M1 exactly as on main", hasEvent(db, m1.id, "recycle_fleet_recovered"));
    check("(S-C) the worker (which DID transfer) is reclaimed back onto M1", db.getSession(workerId)?.parentSessionId === m1.id);
    check("(S-C) M1 was NEVER stopped — still alive (the watch itself never stops anything — f1969787)", host.isAlive(m1.id) === true);
    check("(S-C) hasSuccessor(M1) is now false (M2 unlinked)", db.hasSuccessor(m1.id) === false);
    check("(S-C) M2 IS archived", !!db.getSession(m2.id)?.archivedAt);
    check("(S-C) no recycle_ownership_transfer_resolved marker exists — the new check was never in play", !hasEvent(db, m1.id, "recycle_ownership_transfer_resolved"));
  }

  // ==================== (S-D) LINEAGE PRECISION: a resolved marker for a DIFFERENT successor must NOT stand down this watch ====================
  // Code Review (final round), finding 3: a bare "has oldId EVER had a resolved marker" check is
  // lineage-blind. This plants a `recycle_ownership_transfer_resolved` event for m1.id whose
  // `detail.successorId` names an UNRELATED successor (never m2.id, the one this watch is actually armed
  // for) — e.g. a separate recycle lineage that happened to resolve. The fix requires that id to match
  // `freshId` before standing down; this decoy must be ignored, and the watch must still reclaim onto M1
  // exactly as (S-C) does with no reattempt at all.
  {
    const { db, host, sessions, m1, m2, workerId, watchPromise } = await haltedLineageWithWatch("sd", { disableCrashRecovery: true });

    const decoySuccessorId = `${m1.id}-decoy-successor`;
    db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(), managerSessionId: decoySuccessorId, workerSessionId: m1.id,
      kind: "recycle_ownership_transfer_resolved", detail: { successorId: decoySuccessorId, gen: 999 },
    });
    check("(S-D setup) a recycle_ownership_transfer_resolved marker for m1.id now exists, for an UNRELATED successor", hasEvent(db, m1.id, "recycle_ownership_transfer_resolved"));

    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    writeFakeTranscript(m2.cwd, engineSessionId);
    db.incrementTurnSeq(m2.id);
    host.handles.get(m2.id).kill(); // M2 — the REAL successor this watch is armed for — dies
    recordUnexpectedExit(db, m2.id, false);

    await watchPromise;

    check("(S-D) LINEAGE PRECISION: the decoy marker (a different successorId) did NOT stand down the watch — it still reclaims onto M1", hasEvent(db, m1.id, "recycle_fleet_recovered"));
    check("(S-D) the worker is reclaimed back onto M1", db.getSession(workerId)?.parentSessionId === m1.id);
    check("(S-D) M1 was NEVER stopped — still alive (the watch itself never stops anything — f1969787)", host.isAlive(m1.id) === true);
    check("(S-D) hasSuccessor(M1) is now false (M2 unlinked)", db.hasSuccessor(m1.id) === false);
    check("(S-D) M2 IS archived — the decoy did not shield it", !!db.getSession(m2.id)?.archivedAt);
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — watchHaltedRecycleSuccessor stands down for good, every tick, once recycle_reattempt has resolved THIS lineage (recycle_ownership_transfer_resolved on oldId with detail.successorId === freshId) — never reclaiming afterward, whether the watch observes the successor's death before settleRecycleHandoff's own stop of the predecessor fires, or after it has been issued but not yet exited; with no reattempt at all (or a resolved marker for an unrelated successor), the watch reclaims exactly as it always did."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
