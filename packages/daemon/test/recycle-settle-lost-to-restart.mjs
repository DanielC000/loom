import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 08c81809 — follow-up to e07b1b1a's own "Accepted gaps": SessionService.settleRecycleHandoff
// is a purely in-memory async poll loop. A daemon restart while it is still polling loses it entirely,
// and NOTHING automatic ever revisits the lineage afterward: resume() refuses the predecessor forever
// (hasSuccessor, since recycled_from is never unlinked) and refuses the successor forever if it never
// durably reached ready ("session has no engine id to resume", thrown before any pty spawn for the
// never-started case — so no onExit ever fires and reconcileNeverStartedRecycleSuccessor is unreachable);
// CrashRecoveryWatcher's own candidate filters independently exclude both for the identical two reasons.
//
// @decision 08c81809 — Code Review round 2 (reviewer a4c83fbc) found the FIRST version of this fix
// (commit 53ca3ab4) unsound: its own test's "restart simulation" skipped three real index.ts boot steps
// (`recoverStaleSessions`, `deriveCrashOrphanedWorkers`, `snapshotAndArchiveRecovered`) that run BEFORE
// any reconcile pass — hiding that the fix's own reparent moved ZERO rows on a real boot (workers were
// already flipped to `process_state='exited'` by then), that "has an engineSessionId" wrongly classified
// a successor that captured an id then died before ready as "confirmed live" (leaving the predecessor
// stranded forever), and that its stranded-lineage banner was invisible once the crash-path backstop
// archived the predecessor. This file now runs the REAL boot sequence, in the REAL order, via the SAME
// exported functions index.ts itself calls (never re-implemented) — see `runRealBootSequenceUpToResume`
// below — and the fix itself is now split into an EARLY, DB-only phase
// (`reconcileStrandedRecycleSettlesEarly`, sessions/recycle-settle-reconcile.ts) that runs BEFORE those
// three steps, and a LATER phase (`SessionService.finishReconcilingRecycleSettles`) that runs after —
// see both files' own doc comments for the full design.
//
// Proves:
//   (A) MANAGER, RECOVERED — daemon_restart path. M2 never reached ready; the daemon "restarts" (a fresh
//       {Db,PtyHost,SessionService} trio against the SAME db file, simulating every in-process timer
//       being lost) before settleRecycleHandoff ever resolves. The REAL boot sequence runs in order; the
//       fleet ends up back on M1, ACTUALLY resumed (not merely made resumable) — proving finding 1 fixed.
//   (B) MANAGER, RECOVERED — crash path (no RestartIntent). Same shape as (A) but drives
//       recoverCrashOrphanedWorkers instead of resumeFleetOnBoot — proves the crash-path candidate
//       derivation (deriveCrashOrphanedWorkers) itself sees the CORRECTED lineage (workers grouped under
//       M1, not the dead M2) because the early phase's reparent runs before that derivation reads it.
//   (C) MANAGER, ENGINE ID CAPTURED BUT NEVER READY — daemon_restart path. M2 captures a real
//       engineSessionId (SessionStart landed) but never reaches ready (e07b1b1a's own named case,
//       service.ts's doc for settleRecycleHandoff). Proves finding 2: this is classified as "M2 dead,
//       recover M1", never as "M2 confirmed live" — the wrong discriminator finding 2 caught in 53ca3ab4.
//   (D) MANAGER, SUCCESSOR DURABLY READY — daemon_restart path. M2 genuinely reached ready (the durable
//       reachedReadyAt latch is set) before the restart — the legitimate owner. M1 stays correctly
//       superseded; M2 is verified via a REAL resume(freshId) attempt and confirmed.
//   (E) PLATFORM LEAD, RECOVERED — daemon_restart path. Same shape as (A) via recyclePlatformLead, PLUS:
//       L1's row is `exited` (the atomic handoff) the whole time — never captured by liveFleetResumeSet —
//       proving finishReconcilingRecycleSettles resumes L1 by calling resume() itself, never by relying
//       on any boot-resume derivation to have included it.
//   (F) TRUE STRAND — crash path. M2 never reached ready AND M1 is ALSO unresumable (its engine
//       transcript is missing). Against the REAL snapshotAndArchiveRecovered archive step: proves finding
//       3 — the [loom:orphaned-fleet] banner is un-archived back onto the live rail, not left invisible.
//   (G) NORMAL SETTLE (no restart) clears the marker — the live in-memory loop resolves normally within
//       one boot; proves the marker is cleared and a later reconcile pass is then a total no-op.
//
// RESTART SIMULATION: `new Db()` (no path arg) always opens the SAME fixed file, derived once from
// LOOM_HOME at module-load time — so within one scenario, constructing a SECOND {Db, PtyHost} pair
// (after closing the first Db handle) faithfully reproduces a real restart's two load-bearing facts:
// every in-process timer/Promise chain from "boot 1" is gone, and the DB's committed state survives. The
// switch happens with NO await between `recycleManager()` returning and closing db1 — its own synchronous
// prefix (through `insertRecycleSuccessor`) has already committed by the time it returns;
// settleRecycleHandoff's fire-and-forget promise is parked at its very first await (the flush-delay
// timer) and is discarded, never advanced — matching "restart lands right after recycle begins."
// `sessions1.liveFleetResumeSet()` is captured BEFORE `db1.close()` (mirrors `requestDaemonRestart`'s own
// pre-exit snapshot) so the daemon_restart scenarios can build a real `RestartIntent`.
//
// TIMING DISCIPLINE: every scenario but (G) never awaits a fixed delay between "boot 1" and "boot 2" —
// the restart is simulated synchronously, nothing to race. (G) is the one scenario that lets the real
// in-process loop run; its own wait is `waitUntil(predicate)` against an observable signal
// (`host.isAlive(m1.id) === false`), never a bare fixed sleep gating a negative assertion.
// @decision 08c81809 — Code Review finding 7 (this section previously claimed boot-1's leaked settle
// timer was "discarded, never advanced" — FALSE: closing db1 does not cancel pending JS timers, and the
// timer chain keeps re-scheduling itself in the background against the now-closed db1 handle). What's
// actually true, verified by running this file: `SETTLE_TIMEOUT_MS` is set to an hour, so the ALERT
// branch never fires within this file's real runtime — but the READY/DEAD branches are NOT gated by that
// bound, and a scenario that genuinely drives M2 to real readiness in boot 1 (scenario D) DOES cause its
// leaked loop to reach the ready branch later (once the event loop gets an idle moment during a LATER
// scenario's own `await`s) and its `finally` then throws `"The database connection is not open"` against
// the closed db1. This is EXPECTED, not a bug: `recycleManager`'s own call site already wraps
// `settleRecycleHandoff` in `.catch(e => console.error(...))` — the throw is caught there and only ever
// logged (you'll see `[recycle] settle failed for manager ...` in this file's own output for exactly this
// reason), never propagated, never a test failure, and never able to touch a DIFFERENT scenario's state
// (each scenario's db1 is independently scoped and already abandoned by the time this fires). The bound
// still matters for scenarios that DON'T drive M2 to a terminal state in boot 1 (A/B/C/E/F) — there, the
// leaked loop has no terminal branch to reach at all within this file's lifetime, so it never touches the
// closed db, and `process.exit()` below kills the whole process before it ever could.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: mirrors recycle-manager-fleet-recovery.mjs's own harness —
// a REAL Db + SessionService + PtyHost driven against a FAKE low-level pty (the shared createPty() seam).
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-settle-lost-to-restart.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const tmpHome = path.join(os.tmpdir(), `loom-rslr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every settle bound BEFORE importing dist/** — only scenario (G) actually needs the real
// in-process loop to resolve quickly. SETTLE_TIMEOUT_MS is deliberately an HOUR (see the file header's
// note on finding 7) — every OTHER scenario never lets boot-1's loop run long enough to matter, and this
// bound just needs to comfortably outlast this whole file's real runtime so a leaked loop never reaches
// the alert branch and throws against a closed db.
const FLUSH_DELAY_MS = 40;
const POLL_MS = 15;
const SETTLE_TIMEOUT_MS = 3_600_000;
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = String(FLUSH_DELAY_MS);
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = String(POLL_MS);
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = String(SETTLE_TIMEOUT_MS);
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25"; // enqueueDurableNudge's usesOrchestrationMcp gate (waitForMcpSeen)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { reconcileStrandedRecycleSettlesEarly } = await import("../dist/sessions/recycle-settle-reconcile.js");
const { runBootRecoveryPrefix } = await import("../dist/sessions/boot-backstop.js");
// Card 062fa934: every resumeFleetOnBoot call in this corpus must pass a deployStaleness fixture — the
// real currentDeployStaleness() read is slow and can flip non-deterministically on a cache-replayed build.
const { CLEAN_STALENESS } = await import("./_deploy-staleness-fixture.mjs");

class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map();
  createPty(opts) {
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    return pty;
  }
}

/** Constructs a fresh {db, host} pair — a fresh Db() (see the file header: always the SAME fixed file)
 *  and a fresh in-memory PtyHost, wired with the SAME event callbacks index.ts's real production
 *  PtyHost construction uses (onEngineSessionId → setEngineSessionId, onReady → setReachedReady). No
 *  SessionService here — that's constructed only inside `runRealBootSequenceUpToResume`, at the exact
 *  point index.ts itself constructs it (after the derivation steps), never before. */
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

/** "Boot 1": a full harness including a live SessionService, for setting up a scenario (spawning M1,
 *  recycling it, etc.) — exactly what recycle-manager-fleet-recovery.mjs's own makeHarness() does.
 *  archiveOnExit/reconcileNeverStartedRecycleSuccessor are wired on exit, mirroring index.ts's real hook
 *  (unused by most scenarios here — none of them let a REAL onExit fire on boot 1 — but present for
 *  parity, and exercised implicitly if a scenario's own pty.kill() calls do fire it). */
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

/**
 * @decision 08c81809 — Code Review round 3 finding 6: replicates index.ts's REAL boot order via the SAME
 * exported `runBootRecoveryPrefix` (sessions/boot-backstop.ts) index.ts itself now calls — the early
 * recycle-settle reconcile, THEN recoverStaleSessions, THEN the crash-path candidate derivation, THEN
 * snapshotAndArchiveRecovered — followed here by SessionService construction, THEN the later recycle-
 * settle reconcile, exactly matching index.ts's own line order. Both this file and index.ts now share the
 * SAME prefix function, so they can never silently drift apart on ordering again.
 * Returns everything a scenario needs to then drive whichever resume path (daemon_restart or crash) it's
 * testing, plus `finish` (the later phase's own return) for direct assertions.
 */
function runRealBootSequenceUpToResume(db, host) {
  const { early, recovered, crashOrphanedWorkers, crashOrphanedManagers } = runBootRecoveryPrefix(db);
  const sessions = new SessionService(db, host, new OrchestrationControl());
  const finish = sessions.finishReconcilingRecycleSettles(early);
  return { sessions, recovered, crashOrphanedWorkers, crashOrphanedManagers, finish };
}

function seedProject(db, id) {
  const now = new Date().toISOString();
  const repo = path.join(tmpHome, `repo-${id}`);
  fs.mkdirSync(repo, { recursive: true });
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  return { repo, now };
}

/** Seeds a live worker + wake + question onto `managerId`, all reparent-able (mirrors
 *  recycle-manager-fleet-recovery.mjs's own helper). */
function seedFleet(db, sessions, projectId, managerId) {
  const now = new Date().toISOString();
  const workerId = `${managerId}-worker`;
  db.insertTask({ id: `${managerId}-task`, projectId, title: "t", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: workerId, projectId, agentId: `${projectId}-mgr`, engineSessionId: "eng-w", title: null, cwd: db.getProject(projectId).repoPath, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: managerId, taskId: `${managerId}-task` });
  db.insertWake({ id: `${managerId}-wake`, sessionId: managerId, wakeAt: new Date(Date.now() + 3_600_000).toISOString(), note: "test wake", createdAt: now, route: null });
  db.insertQuestion({ id: `${managerId}-q`, sessionId: managerId, projectId, title: "q", body: "b", state: "pending", createdAt: now });
  return { workerId };
}

/** Fabricates a fake engine transcript so resume()'s engineTranscriptExists check passes. Writes under
 *  os.homedir()/.claude/projects/<encoded cwd> — safely inside this test's own sandboxed HOME/USERPROFILE
 *  (set above, before any dist import), never the real user's ~/.claude. */
function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

const hasEvent = (db, id, kind) => db.listEventsForSession(id).some((e) => e.kind === kind);

try {
  // ==================== (A) MANAGER, RECOVERED — daemon_restart path ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rslr-a";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-a" });
    writeFakeTranscript(m1.cwd, "eng-m1-a");
    const { workerId } = seedFleet(db1, sessions1, P, m1.id);

    const m2 = await sessions1.recycleManager(m1.id, "handoff — a restart lands before settle resolves");
    check("(A pre) FIX: the durable settle marker is set on M1, naming M2", db1.listRecycleSettlePending().some((r) => r.predecessorId === m1.id && r.freshId === m2.id));
    check("(A pre) M2 never reached ready (no reachedReadyAt)", db1.getSession(m2.id)?.reachedReadyAt == null);
    // @decision 08c81809 — Code Review round 3 finding 2: seed a queued durable message addressed to M2
    // (mirrors a `session_message`/worker report still in-flight to the manager at the moment its
    // successor dies) — M2 is `starting`, never delivered SessionStart, so this stays genuinely unresolved
    // rather than being immediately drained. Reuses the SAME `enqueueDurableMessage` production code path
    // (private at compile time, but this file imports compiled JS — `private` is erased at runtime) every
    // real caller goes through, rather than hand-rolling an `orchestration_events` row.
    const QUEUED_MESSAGE_TEXT = "a message still queued on M2 when the restart lands";
    sessions1.enqueueDurableMessage(m2.id, QUEUED_MESSAGE_TEXT, { sender: m1.id });
    check("(A pre) FIX: the queued message is unresolved against M2", db1.listUnresolvedQueuedMessagesForWorker(m2.id).some((e) => e.detail?.text === QUEUED_MESSAGE_TEXT));

    const preRestartFleet = sessions1.liveFleetResumeSet(); // captured BEFORE the restart, exactly like requestDaemonRestart
    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const { sessions: sessions2, finish } = runRealBootSequenceUpToResume(db2, host2);
    check("(A) FIX: the early+later reconcile recovered the predecessor", finish.recoveredPredecessors.includes(m1.id));
    check("(A) FIX finding 2: M2's queued durable message was re-minted onto M1 before M2 was archived",
      db2.listUnresolvedQueuedMessagesForWorker(m1.id).some((e) => e.detail?.text === QUEUED_MESSAGE_TEXT));

    const restartIntent = { reason: "test", managerSessionId: m1.id, resume: preRestartFleet };
    const { resumed, failed } = sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS, excludeRetiredIds: new Set(finish.retiredSuccessorIds) });
    check("(A) resumeFleetOnBoot did not ALSO fail M1 (already resumed by the reconcile; resume()'s isAlive short-circuit made this a no-op)", !failed.includes(m1.id));
    void resumed;

    check("(A) FIX: the durable marker is cleared", db2.listRecycleSettlePending().length === 0);
    check("(A) FIX: M1 is ACTUALLY resumed (live), not merely made resumable", host2.isAlive(m1.id) === true);
    check("(A) FIX: hasSuccessor(M1) is now false (M2 unlinked)", db2.hasSuccessor(m1.id) === false);
    check("(A) FIX: the worker is reparented back onto M1 — REPARENT AGAINST THE REAL BOOT SEQUENCE (this is what 53ca3ab4's own test skipped)", db2.getSession(workerId)?.parentSessionId === m1.id);
    check("(A) FIX: the wake is reparented back onto M1", db2.listWakesForSession(m1.id).some((w) => w.id === `${m1.id}-wake`));
    check("(A) FIX: the question is reparented back onto M1", db2.listQuestionsForSession(m1.id).some((q) => q.id === `${m1.id}-q`));
    check("(A) FIX: M2 is unlinked (recycledFrom: null)", db2.getSession(m2.id)?.recycledFrom === null);
    check("(A) FIX: M2 is archived", !!db2.getSession(m2.id)?.archivedAt);
    const recovered = db2.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered");
    check("(A) FIX: exactly one recycle_fleet_recovered event, naming the reparent count", recovered.length === 1 && recovered[0].detail?.reparentedWorkers === 1);
    check("(A) no recycle_fleet_stranded_across_restart event fabricated", hasEvent(db2, m1.id, "recycle_fleet_stranded_across_restart") === false);

    // @decision 08c81809 — Code Review round 4 item 6 (the reviewer's own X2 shape): the durable record
    // alone (asserted above) does NOT prove DELIVERY — at the instant `carryPendingToSuccessor` re-minted
    // it, M1 had no live pty entry in this fresh boot yet (it wasn't resumed until `resumeFleetOnBoot`,
    // just above), so the durable record is the ONLY surviving trace at that point. `recoverUndeliveredMessagesOnBoot`
    // (index.ts's own next boot step, real production order) is the actual re-enqueue owner once the
    // recipient is genuinely live — drive the REAL two-step sequence and assert the message reaches M1's
    // pending queue exactly once, never duplicated by the early carry attempt plus the later redrive.
    sessions2.recoverUndeliveredMessagesOnBoot();
    const m1Pending = host2.getPending(m1.id);
    check("(A) FIX item 6: the carried message reaches M1's pending queue exactly once after the real resumeFleetOnBoot -> recoverUndeliveredMessagesOnBoot sequence",
      m1Pending.filter((t) => t.includes(QUEUED_MESSAGE_TEXT)).length === 1);
  }

  // ==================== (B) MANAGER, RECOVERED — crash path ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rslr-b";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-b" });
    writeFakeTranscript(m1.cwd, "eng-m1-b");
    const { workerId } = seedFleet(db1, sessions1, P, m1.id);
    // seedFleet's worker carries engineSessionId "eng-w" — needs a real transcript too, or the crash
    // path's own resume(workerId) attempt (asserted on below) fails on an unrelated ground.
    writeFakeTranscript(db1.getProject(P).repoPath, "eng-w");
    const m2 = await sessions1.recycleManager(m1.id, "handoff — a crash lands before settle resolves");
    void m2;

    db1.close(); // crash path: no RestartIntent captured at all
    const { db: db2, host: host2 } = makeBoot();
    const { sessions: sessions2, crashOrphanedWorkers, crashOrphanedManagers, finish } = runRealBootSequenceUpToResume(db2, host2);
    check("(B) FIX: the early+later reconcile recovered the predecessor", finish.recoveredPredecessors.includes(m1.id));
    // The load-bearing proof: deriveCrashOrphanedWorkers (called INSIDE runRealBootSequenceUpToResume,
    // reading recoverStaleSessions' OWN snapshot) already sees the worker grouped under M1, not the dead
    // M2 — because the early reconcile's reparent ran BEFORE that derivation. 53ca3ab4's own version
    // reparented too late for this to ever be true on the crash path.
    check("(B) FIX: deriveCrashOrphanedWorkers groups the worker under the RECOVERED M1, not the dead M2", crashOrphanedWorkers.some((c) => c.workerSessionId === workerId && c.managerSessionId === m1.id));

    const { resumed, failed, managersFailed } = sessions2.recoverCrashOrphanedWorkers(crashOrphanedWorkers, { soloManagerIds: crashOrphanedManagers, excludeRetiredIds: new Set(finish.retiredSuccessorIds) });
    check("(B) FIX: the worker is ACTUALLY resumed via the crash path's own candidate derivation", resumed.includes(workerId));
    check("(B) the worker did not end up in the crash path's own failed list", !failed.includes(workerId));
    check("(B) M1 itself was not left in managersFailed (already resumed by the reconcile)", !managersFailed.includes(m1.id));
    check("(B) FIX: the worker row is parented to M1", db2.getSession(workerId)?.parentSessionId === m1.id);
    check("(B) FIX: M1 is live", host2.isAlive(m1.id) === true);
  }

  // ==================== (I) MANAGER, RETIRED SUCCESSOR RESUMABLE ON PAPER — crash path ====================
  // @decision 08c81809 — Code Review round 4 item 1 (BLOCKING): the crash-path retired-successor filter
  // (`recoverCrashOrphanedWorkers`'s candidate filter AND its `soloManagerIds` filter) is load-bearing but
  // was UNPINNED — scenario (B) never gives M2 a real engine id/transcript, so `resume(M2)` fails on an
  // UNRELATED ground (no engine id) regardless of whether the filter runs at all, and disabling both
  // filters in dist still left the whole file ALL PASS. This scenario mirrors (B)'s shape but ALSO gives
  // M2 a real SessionStart + transcript (mirroring scenario C's own fix for the identical daemon_restart-
  // path gap) so `resume(M2)` would actually SUCCEED if the filter didn't run — a genuine discriminator.
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rslr-i";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-i" });
    writeFakeTranscript(m1.cwd, "eng-m1-i");
    const { workerId } = seedFleet(db1, sessions1, P, m1.id);
    writeFakeTranscript(db1.getProject(P).repoPath, "eng-w");
    const m2 = await sessions1.recycleManager(m1.id, "handoff — a crash lands before settle resolves, M2 looks resumable on paper");
    // M2 captures a REAL engine id (a genuine SessionStart hook) but NOT startupModeCycles:0, so it never
    // durably reaches ready — classified `recovered` by the early phase, exactly like scenario C.
    host1.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-x1" });
    writeFakeTranscript(m2.cwd, "eng-m2-x1");
    check("(I pre) M2 captured a real engine id", db1.getSession(m2.id)?.engineSessionId === "eng-m2-x1");
    check("(I pre) FIX: M2 never durably reached ready", db1.getSession(m2.id)?.reachedReadyAt == null);

    db1.close(); // crash path: no RestartIntent captured at all
    const { db: db2, host: host2 } = makeBoot();
    const { sessions: sessions2, crashOrphanedWorkers, crashOrphanedManagers, finish } = runRealBootSequenceUpToResume(db2, host2);
    check("(I) FIX: the early+later reconcile recovered the predecessor", finish.recoveredPredecessors.includes(m1.id));
    check("(I) FIX: M2 is in retiredSuccessorIds (finalizeRecovery retired it)", finish.retiredSuccessorIds.includes(m2.id));

    const { resumed, failed, managersFailed, retiredSkipped } = sessions2.recoverCrashOrphanedWorkers(crashOrphanedWorkers, { soloManagerIds: crashOrphanedManagers });
    check("(I) FIX: M2 is NOT resurrected as a second live manager (Code Review round 4 item 1)", host2.isAlive(m2.id) === false);
    check("(I) FIX: M2 is filtered as a retired recycle successor, not merely an ordinary resume failure", retiredSkipped.includes(m2.id) && !resumed.includes(m2.id) && !failed.includes(m2.id) && !managersFailed.includes(m2.id));
    check("(I) FIX: the worker is ACTUALLY resumed via the crash path's own candidate derivation", resumed.includes(workerId));
    check("(I) FIX: the worker row is parented to M1", db2.getSession(workerId)?.parentSessionId === m1.id);
    check("(I) FIX: M1 is live", host2.isAlive(m1.id) === true);
    check("(I) FIX: M2 is unlinked + archived", db2.getSession(m2.id)?.recycledFrom === null && !!db2.getSession(m2.id)?.archivedAt);
  }

  // ==================== (J) MARKER + EXCLUSION SURVIVE A THROW MID-FINALIZE ====================
  // @decision 08c81809 — Code Review round 4 item 3: pin the reordering inside `finalizeRecovery` — a
  // throw injected into `carryPendingToSuccessor` (mid-function, BEFORE the archive/resume/clear-marker
  // steps) must leave the durable settle marker SET (never lost) while the CRITICAL exclusion
  // (`retiredRecycleSuccessorIds`) is ALREADY in effect (pushed to before either throwable step runs) —
  // M2 stays excluded from a later `resumeFleetOnBoot` attempt even though `finalizeRecovery` itself never
  // reached completion.
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rslr-j";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-j" });
    writeFakeTranscript(m1.cwd, "eng-m1-j");
    const m2 = await sessions1.recycleManager(m1.id, "handoff — a throw mid-finalize must not lose the marker or the exclusion");
    // Give M2 a real engine id + transcript (mirroring scenarios C/I) so a later resumeFleetOnBoot attempt
    // would actually SUCCEED in resurrecting it if the exclusion weren't already in effect — a genuine
    // discriminator, not a resume failure on an unrelated ground.
    host1.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-j" });
    writeFakeTranscript(m2.cwd, "eng-m2-j");
    check("(J pre) FIX: the durable settle marker is set on M1, naming M2", db1.listRecycleSettlePending().some((r) => r.predecessorId === m1.id && r.freshId === m2.id));

    const preRestartFleet = sessions1.liveFleetResumeSet();
    db1.close();
    const { db: db2, host: host2 } = makeBoot();

    const origCarryPending = SessionService.prototype.carryPendingToSuccessor;
    const injectedError = new Error("(J) injected throw — carryPendingToSuccessor mid-finalizeRecovery");
    SessionService.prototype.carryPendingToSuccessor = function () { throw injectedError; };
    let sessions2, finish;
    try {
      ({ sessions: sessions2, finish } = runRealBootSequenceUpToResume(db2, host2));
    } finally {
      SessionService.prototype.carryPendingToSuccessor = origCarryPending; // restore BEFORE any assertion can throw and skip this
    }
    check("(J) FIX: the marker STAYS SET after a throw mid-finalize (round 4 item 3)",
      db2.listRecycleSettlePending().some((r) => r.predecessorId === m1.id && r.freshId === m2.id));
    check("(J) FIX: M1 is NOT in recoveredPredecessors (finalizeRecovery never reached completion)", !finish.recoveredPredecessors.includes(m1.id));
    check("(J) FIX: M1 is NOT in strandedPredecessors either (the throw happened before stampStranded could run)", !finish.strandedPredecessors.includes(m1.id));

    const restartIntent = { reason: "test", managerSessionId: m1.id, resume: preRestartFleet };
    const { retiredSkipped } = await sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS });
    check("(J) FIX: M2 is STILL excluded from resumeFleetOnBoot despite the incomplete finalize (retiredRecycleSuccessorIds was set BEFORE the throw)",
      host2.isAlive(m2.id) === false && retiredSkipped.includes(m2.id));
  }

  // ==================== (K) DEFERRED-BRANCH THROW-AFTER-UNLINK MUST NOT RESURRECT ON A LATER BOOT ====================
  // @decision 08c81809 — Code Review round 5 MAJOR (reproduced by the reviewer's own 3-boot probe):
  // round 4's "keep the marker set on any throw" fix, applied uniformly to the `early.deferred` loop's
  // outer catch, is UNSAFE for this specific shape. By the time a throw happens INSIDE `finalizeRecovery`
  // (reached via the deferred branch's own NEVER-RESURRECT fallback), the PREDECESSOR has already been
  // resumed and the SUCCESSOR already unlinked (`recycledFrom` cleared) by the code just above that call
  // — a prior boot already chose the predecessor as the owner. Leaving the marker set then made a LATER
  // boot's early phase re-classify the row as `deferred` AGAIN (`reachedReadyAt` is a durable column that
  // never clears), calling `resume(freshId)` DIRECTLY on a FRESH process whose `retiredRecycleSuccessorIds`
  // is empty — if the successor's transcript has since become available, that resume can genuinely
  // SUCCEED, resurrecting it alongside the already-resumed predecessor. Three real boots, mirroring the
  // reviewer's own repro exactly.
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rslr-k";
    seedProject(db1, P);
    db1.setProjectConfig(P, { permission: { startupModeCycles: 0 } }); // markReady runs SYNCHRONOUSLY off the hook below
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-k" });
    writeFakeTranscript(m1.cwd, "eng-m1-k");
    const { workerId } = seedFleet(db1, sessions1, P, m1.id);
    const m2 = await sessions1.recycleManager(m1.id, "handoff — boot 1: the successor reaches ready but its transcript is missing");
    host1.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-k" });
    // Deliberately NO writeFakeTranscript for M2 across boots 1/2 — mirrors scenario H's own setup.
    check("(K pre) FIX: M2 durably reached ready (reachedReadyAt set)", db1.getSession(m2.id)?.reachedReadyAt != null);
    db1.close();

    // ---- BOOT 2: the deferred fallback resumes M1 and unlinks M2, then a LATER step inside
    // finalizeRecovery throws — round 4's own fix leaves the marker set.
    const { db: db2, host: host2 } = makeBoot();
    const origCarryPending2 = SessionService.prototype.carryPendingToSuccessor;
    const injectedError2 = new Error("(K) boot2 injected throw — carryPendingToSuccessor mid-finalizeRecovery");
    SessionService.prototype.carryPendingToSuccessor = function () { throw injectedError2; };
    let sessions2, finish2;
    try {
      ({ sessions: sessions2, finish: finish2 } = runRealBootSequenceUpToResume(db2, host2));
    } finally {
      SessionService.prototype.carryPendingToSuccessor = origCarryPending2;
    }
    check("(K boot2) M2's resume(freshId) attempt failed (no transcript) — fell through to the predecessor", !finish2.confirmedLiveSuccessors.includes(m2.id));
    check("(K boot2) M1 WAS resumed (the deferred fallback's own resume(predecessor) succeeded before the later throw)", host2.isAlive(m1.id) === true);
    check("(K boot2) M2 is NOT alive", host2.isAlive(m2.id) === false);
    check("(K boot2) the durable marker STAYS SET despite the successful predecessor resume (round 4's own fix, still exercised)",
      db2.listRecycleSettlePending().some((r) => r.predecessorId === m1.id && r.freshId === m2.id));
    check("(K boot2) M2 is already unlinked (recycledFrom: null) — the unlink ran BEFORE the throw", db2.getSession(m2.id)?.recycledFrom === null);
    check("(K boot2) the worker is already reparented onto M1 — the reparent ran BEFORE the throw too", db2.getSession(workerId)?.parentSessionId === m1.id);

    const preRestartFleet2 = sessions2.liveFleetResumeSet();
    db2.close();

    // ---- BOOT 3: M2's transcript has since become available (simulating a transient earlier gap) — a
    // LATER boot must NEVER re-attempt resume(freshId) on a row a prior boot already decided.
    writeFakeTranscript(m2.cwd, "eng-m2-k");
    const { db: db3, host: host3 } = makeBoot();
    const { sessions: sessions3, finish: finish3 } = runRealBootSequenceUpToResume(db3, host3);
    check("(K) FIX: M2 is NOT re-classified as a confirmed-live successor on boot 3 (round 5 MAJOR fix)", !finish3.confirmedLiveSuccessors.includes(m2.id));
    check("(K) FIX: M2 is NOT resurrected as a second live manager on boot 3", host3.isAlive(m2.id) === false);
    check("(K) FIX: M1 is still the sole live owner after boot 3's own reconcile", host3.isAlive(m1.id) === true);

    const restartIntent3 = { reason: "test", managerSessionId: m1.id, resume: preRestartFleet2 };
    await sessions3.resumeFleetOnBoot(restartIntent3, { deployStaleness: CLEAN_STALENESS });
    check("(K) FIX: M2 is STILL not alive after resumeFleetOnBoot runs too", host3.isAlive(m2.id) === false);
    check("(K) FIX: the worker stays parented to M1", db3.getSession(workerId)?.parentSessionId === m1.id);
    check("(K) FIX: the durable marker is finally cleared", db3.listRecycleSettlePending().length === 0);
  }

  // ==================== (C) MANAGER, ENGINE ID CAPTURED BUT NEVER READY — daemon_restart path ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rslr-c";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-c" });
    writeFakeTranscript(m1.cwd, "eng-m1-c");
    const { workerId } = seedFleet(db1, sessions1, P, m1.id);
    const m2 = await sessions1.recycleManager(m1.id, "handoff — the successor captures an engine id then dies before ready");
    // M2 captures a REAL engine id (a genuine SessionStart hook) — but NOT startupModeCycles:0, so the
    // mode-cycle convergence markReady itself waits on never completes against this fake pty (write() is
    // an inert no-op — nothing ever confirms the footer moved). reachedReadyAt stays null.
    host1.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-c" });
    // @decision 08c81809 — Code Review round 3 finding 3: WITHOUT this transcript, `resume(m2.id)` fails
    // on the engineTranscriptExists check regardless of which discriminator (`reachedReadyAt` vs the old
    // `engineSessionId`) classifies M2 — so the checks below would ALL still pass even if the
    // discriminator regressed back to `engineSessionId` (M2 "confirmed live" → deferred → its own
    // resume() attempt throws on the missing transcript → falls through to recovering M1 anyway). Writing
    // a REAL transcript here means a regressed discriminator would instead let `resume(m2.id)` actually
    // SUCCEED — M2 wrongly becomes the confirmed-live owner instead of M1 — which is what makes this
    // scenario an actual RED/GREEN proof of the discriminator, not a vacuously-passing one. This is ALSO
    // finding 1's own repro fixture: it's what lets M2 pass resume()'s preconditions at all, making it a
    // genuine candidate for the ordinary boot-resume path below to (without the finding-1 fix) wrongly
    // resurrect alongside the recovered M1.
    writeFakeTranscript(m2.cwd, "eng-m2-c");
    check("(C pre) M2 captured a real engine id", db1.getSession(m2.id)?.engineSessionId === "eng-m2-c");
    check("(C pre) FIX: M2 never durably reached ready DESPITE the captured engine id — this is finding 2's exact case", db1.getSession(m2.id)?.reachedReadyAt == null);

    const preRestartFleet = sessions1.liveFleetResumeSet();
    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const { sessions: sessions2, finish } = runRealBootSequenceUpToResume(db2, host2);
    check("(C) FIX: classified as RECOVERED (M2 dead), never as a confirmed-live successor — the engineSessionId-based discriminator 53ca3ab4 used would have wrongly treated this as confirmed-live", finish.recoveredPredecessors.includes(m1.id));
    check("(C) FIX: M2 is NOT in confirmedLiveSuccessors", !finish.confirmedLiveSuccessors.includes(m2.id));
    check("(C) FIX: M2 is in retiredSuccessorIds (finalizeRecovery retired it)", finish.retiredSuccessorIds.includes(m2.id));

    const restartIntent = { reason: "test", managerSessionId: m1.id, resume: preRestartFleet };
    // @decision 08c81809 — Code Review round 3 finding 1 (CRITICAL, reproduced): WITHOUT `excludeRetiredIds`,
    // M2 is still in `preRestartFleet` (captured while genuinely alive, pre-restart) AND now durably
    // resumable (the transcript written above) — resumeFleetOnBoot would resume it right alongside the
    // already-recovered M1, producing TWO live managers on one lineage. Assert the fix below.
    const excludeRetiredIds = new Set(finish.retiredSuccessorIds);
    const { resumed, failed, retiredSkipped } = await sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS, excludeRetiredIds });
    check("(C) FIX: M1 is ACTUALLY resumed", host2.isAlive(m1.id) === true);
    check("(C) FIX: the worker is reparented back onto M1", db2.getSession(workerId)?.parentSessionId === m1.id);
    check("(C) FIX: M2 is unlinked + archived", db2.getSession(m2.id)?.recycledFrom === null && !!db2.getSession(m2.id)?.archivedAt);
    check("(C) FIX: M2 is NOT resurrected as a second live manager (Code Review round 3 finding 1)", host2.isAlive(m2.id) === false);
    check("(C) FIX: M2 is filtered as a retired recycle successor, not merely an ordinary resume failure", retiredSkipped.includes(m2.id) && !resumed.includes(m2.id) && !failed.includes(m2.id));

    // @decision 08c81809 — Code Review round 5 nit (pins round 4 item 7): call resumeFleetOnBoot AGAIN
    // with M2 artificially named as the REQUESTER (managerSessionId) — reqId can't practically be a
    // retired successor in production (it just issued the daemon_restart call), but this exercises the
    // requester-specific branch directly and pins that a retired requester is excluded there too, and
    // NOT also double-counted into `failed` (a round-4 defect: the exclusion is supposed to be a
    // distinct, counted outcome, never an ordinary failure).
    const requesterRetiredIntent = { reason: "test", managerSessionId: m2.id, resume: [] };
    const { resumed: resumed2, failed: failed2, retiredSkipped: retiredSkipped2 } = await sessions2.resumeFleetOnBoot(requesterRetiredIntent, { deployStaleness: CLEAN_STALENESS });
    check("(C) FIX round 5 nit: a retired requester is excluded, not resurrected, and not also pushed into `failed`",
      host2.isAlive(m2.id) === false && retiredSkipped2.includes(m2.id) && !failed2.includes(m2.id) && !resumed2.includes(m2.id));
  }

  // ==================== (D) MANAGER, SUCCESSOR DURABLY READY — daemon_restart path ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rslr-d";
    seedProject(db1, P);
    db1.setProjectConfig(P, { permission: { startupModeCycles: 0 } }); // markReady runs SYNCHRONOUSLY off the hook below
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-d" });
    writeFakeTranscript(m1.cwd, "eng-m1-d");
    const { workerId } = seedFleet(db1, sessions1, P, m1.id);
    const m2 = await sessions1.recycleManager(m1.id, "handoff — the successor genuinely reaches ready, then a restart lands");
    host1.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-d" });
    writeFakeTranscript(m2.cwd, "eng-m2-d");
    check("(D pre) FIX: M2 durably reached ready (reachedReadyAt set)", db1.getSession(m2.id)?.reachedReadyAt != null);

    const preRestartFleet = sessions1.liveFleetResumeSet();
    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const { sessions: sessions2, finish } = runRealBootSequenceUpToResume(db2, host2);
    check("(D) FIX: M2 is classified + VERIFIED as the confirmed-live successor via a real resume() attempt", finish.confirmedLiveSuccessors.includes(m2.id));
    check("(D) FIX: M1 is NOT in recoveredPredecessors", !finish.recoveredPredecessors.includes(m1.id));

    const restartIntent = { reason: "test", managerSessionId: m2.id, resume: preRestartFleet };
    await sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS, excludeRetiredIds: new Set(finish.retiredSuccessorIds) });
    check("(D) FIX: M2 is ACTUALLY resumed (live)", host2.isAlive(m2.id) === true);
    check("(D) FIX: M1 stays correctly superseded — NEVER resumed", host2.isAlive(m1.id) === false);
    check("(D) FIX: hasSuccessor(M1) stays true — M2 is the real, live owner", db2.hasSuccessor(m1.id) === true);
    check("(D) FIX: the fleet stays on M2, untouched", db2.getSession(workerId)?.parentSessionId === m2.id);
    check("(D) no recycle_fleet_recovered/stranded event fabricated for a legitimate live successor",
      db2.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered" || e.kind === "recycle_fleet_stranded_across_restart").length === 0);
  }

  // ==================== (E) PLATFORM LEAD, RECOVERED — daemon_restart path ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rslr-e";
    seedProject(db1, P);
    db1.insertAgent({ id: `${P}-lead`, projectId: P, name: "Lead", startupPrompt: "LEAD", position: 1, profileId: null });
    const l1 = sessions1.startPlatformLead(`${P}-lead`);
    host1.deliverHook(l1.id, { hook_event_name: "SessionStart", session_id: "eng-l1-e" });
    writeFakeTranscript(l1.cwd, "eng-l1-e");
    db1.insertWake({ id: `${l1.id}-wake`, sessionId: l1.id, wakeAt: new Date(Date.now() + 3_600_000).toISOString(), note: "test wake", createdAt: new Date().toISOString(), route: null });
    db1.insertQuestion({ id: `${l1.id}-q`, sessionId: l1.id, projectId: P, title: "q", body: "b", state: "pending", createdAt: new Date().toISOString() });

    const l2 = await sessions1.recyclePlatformLead(l1.id, "handoff — a restart lands before settle resolves");
    check("(E pre) L1's row is exited (the atomic handoff — liveFleetResumeSet would never capture it)", db1.getSession(l1.id)?.processState === "exited");
    const preRestartFleet = sessions1.liveFleetResumeSet();
    check("(E pre) FIX (confirms the trace): L1 is genuinely absent from the captured pre-restart fleet", !preRestartFleet.some((e) => e.sessionId === l1.id));
    check("(E pre) FIX: the durable settle marker is set on L1, naming L2", db1.listRecycleSettlePending().some((r) => r.predecessorId === l1.id && r.freshId === l2.id));

    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const { sessions: sessions2, finish } = runRealBootSequenceUpToResume(db2, host2);
    check("(E) FIX: the reconcile recovered the predecessor", finish.recoveredPredecessors.includes(l1.id));

    // The condition-3 proof: L1 is resumed by THIS reconcile pass directly (it calls resume() itself),
    // never merely unlinked-and-left for resumeFleetOnBoot's own entries (which never named it).
    const restartIntent = { reason: "test", managerSessionId: l1.id, resume: preRestartFleet };
    await sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS, excludeRetiredIds: new Set(finish.retiredSuccessorIds) }); // l1 is NOT in `resume` — proves the reconcile alone did it
    check("(E) FIX: L1 is ACTUALLY resumed (live), regardless of which boot-resume path runs after this", host2.isAlive(l1.id) === true);
    check("(E) FIX: L1's processState is restored to live", db2.getSession(l1.id)?.processState === "live");
    check("(E) FIX: hasSuccessor(L1) is now false (L2 unlinked)", db2.hasSuccessor(l1.id) === false);
    check("(E) FIX: the wake is reparented back onto L1", db2.listWakesForSession(l1.id).some((w) => w.id === `${l1.id}-wake`));
    check("(E) FIX: the question is reparented back onto L1", db2.listQuestionsForSession(l1.id).some((q) => q.id === `${l1.id}-q`));
    check("(E) FIX: L2 is unlinked + archived", db2.getSession(l2.id)?.recycledFrom === null && !!db2.getSession(l2.id)?.archivedAt);
  }

  // ==================== (F) TRUE STRAND — crash path, against the REAL archive step ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rslr-f";
    seedProject(db1, P);
    const m1 = sessions1.startManager(`${P}-mgr`);
    // M1 DOES capture a real engine id (a real running manager would have) but its transcript is NEVER
    // written — the realistic "Claude pruned the JSONL" shape resume()'s own dead-transcript branch covers.
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-f" });
    const m2 = await sessions1.recycleManager(m1.id, "handoff — the successor never reaches ready AND the predecessor is also unresumable");
    void m2;

    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    void host2;
    const { crashOrphanedWorkers, crashOrphanedManagers, finish } = runRealBootSequenceUpToResume(db2, host2);
    check("(F) FIX: the predecessor is reported stranded — no automatic owner", finish.strandedPredecessors.includes(m1.id));
    check("(F) FIX: the durable marker is cleared (nothing left to auto-retry)", db2.listRecycleSettlePending().length === 0);
    const stranded = db2.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_stranded_across_restart");
    check("(F) FIX: exactly one DISTINCT recycle_fleet_stranded_across_restart event (never the generic fleet_resume_failed)",
      stranded.length === 1 && stranded[0].detail?.deadSuccessorId === m2.id);
    check("(F) no recycle_fleet_recovered event fabricated — nothing was actually recovered", hasEvent(db2, m1.id, "recycle_fleet_recovered") === false);
    // Finding 3's exact proof: snapshotAndArchiveRecovered (inside runRealBootSequenceUpToResume, the
    // REAL boot-backstop archive step) already archived M1 by this point — the banner must have
    // un-archived it again, or listAllSessions()/isOrphanedFleet would never see it.
    check("(F) FIX: M1 is VISIBLE on the live rail (un-archived) despite the real crash-path backstop having archived it", db2.getSession(m1.id)?.archivedAt == null);
    check("(F) FIX: M1's lastError carries the [loom:orphaned-fleet] banner (reuses the existing Mission Control surface)",
      (db2.getSession(m1.id)?.lastError ?? "").startsWith("[loom:orphaned-fleet]"));
    check("(F) FIX: M1's processState is exited", db2.getSession(m1.id)?.processState === "exited");
    // NEVER RESURRECT reasoning: the RECONCILE ITSELF never touches M2's recycled_from/lastError when the
    // predecessor is also unresumable — it stays LINKED (recycledFrom still m1.id), unlike the recovered
    // scenarios above where the reconcile explicitly unlinks it. M2's own archivedAt IS still set here —
    // that's the REAL, ordinary snapshotAndArchiveRecovered backstop archiving any exited session
    // (M2 was live pre-restart, same as it would be for a manager never involved in a recycle at all),
    // entirely independent of and unrelated to this reconcile's own NEVER RESURRECT decision.
    check("(F) FIX: the reconcile never unlinks M2 — still linked to the stranded predecessor", db2.getSession(m2.id)?.recycledFrom === m1.id);
    // A stray manager candidate under a doomed M1 crash-path attempt is harmless (finding 5's accepted
    // residual) — just confirm the derivation didn't ALSO crash on this shape.
    void crashOrphanedWorkers; void crashOrphanedManagers;
  }

  // ==================== (G) NORMAL SETTLE (no restart) clears the marker ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rslr-g";
    seedProject(db, P);
    db.setProjectConfig(P, { permission: { startupModeCycles: 0 } }); // markReady runs SYNCHRONOUSLY off the hook below
    const m1 = sessions.startManager(`${P}-mgr`);
    const m2 = await sessions.recycleManager(m1.id, "handoff — this one settles normally, no restart");
    check("(G pre) FIX: the durable settle marker is set", db.listRecycleSettlePending().some((r) => r.predecessorId === m1.id && r.freshId === m2.id));

    host.deliverHook(m2.id, { hook_event_name: "SessionStart" }); // real ready, no restart involved
    const stopped = await waitUntil(() => host.isAlive(m1.id) === false);
    check("(G) M1 is eventually stopped (the ordinary, un-restarted happy path)", stopped);

    check("(G) FIX: the durable settle marker is CLEARED once the live loop resolves normally", db.listRecycleSettlePending().length === 0);
    const early = reconcileStrandedRecycleSettlesEarly(db);
    check("(G) FIX: the early reconcile pass is a total no-op for an un-restarted, already-settled lineage",
      early.recovered.length === 0 && early.deferred.length === 0 && early.stranded.length === 0);
  }

  // ==================== (H) DEFERRED FALLBACK — M2 durably reached ready, but its transcript goes missing before the restart ====================
  // @decision 08c81809 — Code Review round 3 finding 7: no prior scenario exercised the ONE place
  // `reparentAllChildren` is load-bearing in `finishReconcilingRecycleSettles`'s `early.deferred` loop
  // (service.ts ~10570) — the KNOWN, NARROW RESIDUAL branch reached only when the successor durably
  // latched ready (so the EARLY phase classifies it `deferred`, lineage left untouched) but the LATER
  // phase's own real `resume(freshId)` attempt still fails (here: the engine transcript is gone by boot
  // time — e.g. Claude pruned the JSONL — a shape the early phase's own pre-check can't see, since it only
  // pre-checks the PREDECESSOR, never the successor). This falls through to the SAME NEVER-RESURRECT
  // recovery `early.recovered` gets, just reached from the opposite classification.
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rslr-h";
    seedProject(db1, P);
    db1.setProjectConfig(P, { permission: { startupModeCycles: 0 } }); // markReady runs SYNCHRONOUSLY off the hook below
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-h" });
    writeFakeTranscript(m1.cwd, "eng-m1-h");
    const { workerId } = seedFleet(db1, sessions1, P, m1.id);
    const m2 = await sessions1.recycleManager(m1.id, "handoff — the successor reaches ready but its transcript is gone by the time the reconcile actually verifies it");
    host1.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-h" });
    // Deliberately NO writeFakeTranscript for M2 — reachedReadyAt IS durably set (the early phase's own
    // discriminator sees it as provisionally legitimate), but the LATER phase's real resume(freshId)
    // attempt is the only thing that can catch a transcript that's gone missing by boot time.
    check("(H pre) FIX: M2 durably reached ready (reachedReadyAt set)", db1.getSession(m2.id)?.reachedReadyAt != null);

    const preRestartFleet = sessions1.liveFleetResumeSet();
    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const { sessions: sessions2, finish } = runRealBootSequenceUpToResume(db2, host2);
    check("(H) FIX: the deferred fallback still recovers M1 despite M2's transcript going missing after reaching ready", finish.recoveredPredecessors.includes(m1.id));
    check("(H) FIX: M2 is NOT in confirmedLiveSuccessors", !finish.confirmedLiveSuccessors.includes(m2.id));
    check("(H) FIX: M2 is in retiredSuccessorIds (finalizeRecovery retired it via the fallback path)", finish.retiredSuccessorIds.includes(m2.id));

    const restartIntent = { reason: "test", managerSessionId: m1.id, resume: preRestartFleet };
    const { resumed, failed, retiredSkipped } = await sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS, excludeRetiredIds: new Set(finish.retiredSuccessorIds) });
    check("(H) FIX: M1 is ACTUALLY resumed", host2.isAlive(m1.id) === true);
    check("(H) FIX: the worker is reparented back onto M1 — finding 7's exact load-bearing case for reparentAllChildren in the deferred-fallback branch", db2.getSession(workerId)?.parentSessionId === m1.id);
    check("(H) FIX: M2 is unlinked + archived", db2.getSession(m2.id)?.recycledFrom === null && !!db2.getSession(m2.id)?.archivedAt);
    check("(H) FIX: M2 stays dead after resumeFleetOnBoot — never resurrected", host2.isAlive(m2.id) === false);
    check("(H) FIX: M2 is filtered as a retired recycle successor, not merely an ordinary resume failure", retiredSkipped.includes(m2.id) && !resumed.includes(m2.id) && !failed.includes(m2.id));
  }
} catch (e) {
  console.error(e);
  failures++;
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
