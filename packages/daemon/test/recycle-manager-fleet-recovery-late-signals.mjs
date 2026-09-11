import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card e07b1b1a, Code Review follow-up — the scenarios that need their OWN process-wide, SHORT
// `READY_FALLBACK_MS`/settle bound, kept in a SEPARATE file from recycle-manager-fleet-recovery.mjs
// because that file's own scenario (D) needs M2 to stay genuinely neither-ready-nor-dead for the WHOLE
// test — a short global fallback here would flip it to ready out from under that scenario. Every constant
// below is env-set ONCE, before any dist/** import, and shared by every scenario in this file.
//
// Proves the Code Review MAJOR fix (settleRecycleHandoff must never stop OBSERVING after its own
// unresolved-alert bound fires) and decision (2) (a confirmed-dead successor is a failed recycle even if
// it reached SessionStart — `isAlive`, never `hasSuccessor` alone):
//   (F-manager) / (F-platform) — LATE READY VIA THE REAL FALLBACK, NO HOOK DRIVEN AT ALL: M2 is left
//       completely untouched (no deliverHook, no kill). The settle bound is shorter than
//       READY_FALLBACK_MS, so the unresolved alert fires FIRST (proving the loop entered its slower,
//       still-watching phase) — then the REAL claude readiness fallback (pty/host.ts's spawn-armed
//       timer, not a test hook) eventually marks M2 ready, and the settle loop — still running — stops
//       M1 and records `recycle_fleet_resolved` (a late-but-genuine success, never silence).
//   (H) SESSIONSTART LANDED, THEN DIED BEFORE READY — the exact regression Code Review found: M2's
//       `engineSessionId` gets captured (SessionStart genuinely landed) but it dies before `markReady`
//       ever ran. `reconcileNeverStartedRecycleSuccessor` early-returns once `engineSessionId` is set, so
//       `hasSuccessor(oldId)` would stay wrongly TRUE forever under the old (pre-Code-Review) check. This
//       settle loop instead tests `pty.isAlive(freshId)` directly, catches the death, recovers the fleet
//       onto the still-live M1, and makes M2 ineligible for crash-recovery resume (unlinked + archived)
//       DESPITE `hasSuccessor(oldId)` never having been cleared by f349f5cb's own mechanism.
//   (I) MAJOR FIX (Code Review round 2/3, DoD): the SAME (H) shape, but reproducing the reviewer's own
//       harness IN PRODUCTION ORDER: `recordUnexpectedExit` (as index.ts's real onExit calls it,
//       SYNCHRONOUSLY on the kill — before settleRecycleHandoff's own independent poll loop next wakes and
//       stamps `resumability:"dead"`) records M2's `session_died` FIRST, and only THEN does settle catch
//       up and mark it dead. So M2 legitimately enters the watcher's candidate set — the assertion that
//       matters is that one REAL `CrashRecoveryWatcher.tick()` still never calls `resume()` for it, because
//       the tick's OWN per-candidate `resumability === "dead"` check (crash-recovery-watcher.ts ~L316) is
//       the gate that actually protects production, not `recordUnexpectedExit`'s own gate (round-2's
//       ordering called `recordUnexpectedExit` AFTER settle had already stamped dead, so ITS gate absorbed
//       the whole bug and the real ~L316 gate was never exercised — round-3 finding, fixed here).
//
// TIMING DISCIPLINE: every wait is `waitUntil(predicate)`, polling an OBSERVABLE signal — see the sibling
// file's own header for the full reasoning; not repeated here.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-manager-fleet-recovery-late-signals.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-rmfrls-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

// Env-shorten BEFORE importing dist/** (module-load-time reads). Deliberately: READY_FALLBACK_MS >
// RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS, so the unresolved alert fires BEFORE the real fallback marks
// ready — the exact ordering (F) needs to prove the loop kept watching past its own alert.
const FLUSH_DELAY_MS = 20;
const SETTLE_TIMEOUT_MS = 90;
const SLOW_POLL_MS = 20;
const READY_FALLBACK_MS = 260;
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = String(FLUSH_DELAY_MS);
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = "15";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = String(SETTLE_TIMEOUT_MS);
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_SLOW_POLL_MS = String(SLOW_POLL_MS);
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";
process.env.LOOM_READY_FALLBACK_MS = String(READY_FALLBACK_MS);

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { CrashRecoveryWatcher, recordUnexpectedExit } = await import("../dist/orchestration/crash-recovery-watcher.js");

class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map();
  createPty(opts) {
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    return pty;
  }
}

function makeHarness() {
  const db = new Db();
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id, code, info) {
      db.setProcessState(id, "exited");
      db.setBusy(id, false);
      const exited = db.getSession(id);
      if (exited) sessions.archiveOnExit(exited);
      if (exited) sessions.reconcileNeverStartedRecycleSuccessor(id, info.intended);
    },
  };
  const host = new SeamHost(events);
  const sessions = new SessionService(db, host, new OrchestrationControl());
  return { db, host, sessions };
}

function seedProject(db, id) {
  const now = new Date().toISOString();
  const repo = path.join(tmpHome, `repo-${id}`);
  fs.mkdirSync(repo, { recursive: true });
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  return { repo, now };
}

const hasEvent = (db, id, kind) => db.listEventsForSession(id).some((e) => e.kind === kind);

try {
  // ==================== (F-manager) LATE READY VIA THE REAL FALLBACK — no hook driven at all ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmfrls-fm";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const m2 = await sessions.recycleManager(m1.id, "handoff — M2 never gets a hook; only the real fallback ever marks it ready");
    // Deliberately: no deliverHook, no kill — M2's fake pty just sits there, exactly like a genuinely slow
    // (but not dead) boot. Only pty/host.ts's own spawn-armed READY_FALLBACK_MS timer will ever flip it.

    const unresolvedFired = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_unresolved"));
    check("(F-manager) the unresolved alert fires FIRST (settle bound < READY_FALLBACK_MS)", unresolvedFired);
    check("(F-manager) M1 is still alive right after the alert — the loop hasn't given up on it", host.isAlive(m1.id) === true);

    const stopped = await waitUntil(() => host.isAlive(m1.id) === false, { timeoutMs: READY_FALLBACK_MS + 3000 });
    check("(F-manager) Code Review fix: M1 IS eventually stopped once the REAL fallback marks M2 ready — the loop kept watching past its own alert", stopped);
    check("(F-manager) M2 genuinely reached ready via the real fallback (not a test hook)", host.hasReachedReady(m2.id) === true);
    const resolved = db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_resolved");
    check("(F-manager) exactly one recycle_fleet_resolved event, naming the successor — a late success is recorded, never silent",
      resolved.length === 1 && resolved[0].detail?.successorId === m2.id);
    check("(F-manager) hasSuccessor(M1) stays true — this was a genuine (if late) success, not a failure", db.hasSuccessor(m1.id) === true);
    check("(F-manager) no recycle_fleet_recovered event fabricated (M2 never actually died)",
      db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered").length === 0);
  }

  // ==================== (F-platform) same shape via recyclePlatformLead ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmfrls-fp";
    seedProject(db, P);
    db.insertAgent({ id: `${P}-lead`, projectId: P, name: "Lead", startupPrompt: "LEAD", position: 1, profileId: null });
    const l1 = sessions.startPlatformLead(`${P}-lead`);
    const l2 = await sessions.recyclePlatformLead(l1.id, "handoff — same shape, platform role");

    const unresolvedFired = await waitUntil(() => hasEvent(db, l1.id, "recycle_fleet_unresolved"));
    check("(F-platform) the unresolved alert fires FIRST", unresolvedFired);
    check("(F-platform) L1's row was restored to live at the alert bound (decision 3)", db.getSession(l1.id)?.processState === "live");

    const stopped = await waitUntil(() => host.isAlive(l1.id) === false, { timeoutMs: READY_FALLBACK_MS + 3000 });
    check("(F-platform) Code Review fix: L1 IS eventually stopped once the REAL fallback marks L2 ready", stopped);
    const resolved = db.listEventsForSession(l1.id).filter((e) => e.kind === "recycle_fleet_resolved");
    check("(F-platform) exactly one recycle_fleet_resolved event, naming the successor",
      resolved.length === 1 && resolved[0].detail?.successorId === l2.id);
    check("(F-platform) hasSuccessor(L1) stays true — a genuine (if late) success", db.hasSuccessor(l1.id) === true);
  }

  // ==================== (H) SessionStart landed (engineSessionId captured), then died before ready ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmfrls-h";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    check("(H pre) M1 is really alive", host.isAlive(m1.id));
    db.insertTask({ id: "h-task", projectId: P, title: "t", body: "", columnKey: "in_progress", position: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const workerId = `${m1.id}-worker`;
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-mgr`, engineSessionId: "eng-w", title: null, cwd: db.getProject(P).repoPath, processState: "live", resumability: "resumable", busy: false, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), lastError: null, role: "worker", parentSessionId: m1.id, taskId: "h-task" });

    const m2 = await sessions.recycleManager(m1.id, "handoff — M2 will capture engineSessionId, then die before markReady");
    check("(H) fleet moved onto M2 at recycle time", db.getSession(workerId)?.parentSessionId === m2.id);

    // Simulates a REAL SessionStart hook landing (engineSessionId captured at the DB layer) WITHOUT ever
    // calling markReady — reproducing the exact race Code Review found: SessionStart fires, but the
    // process dies (mode-cycle never completes against an unresponsive pty, or any other cause) before
    // `markReady` latches `live.ready`. Setting it directly at the DB layer isolates that race from
    // PtyHost's own mode-cycle machinery, which this test has no need to also exercise.
    db.setEngineSessionId(m2.id, "eng-m2-landed");
    check("(H pre) M2 captured a real engineSessionId (SessionStart genuinely landed)", db.getSession(m2.id)?.engineSessionId === "eng-m2-landed");
    check("(H pre) M2 never actually reached ready (markReady never ran)", host.hasReachedReady(m2.id) === false);

    const m2Pty = host.handles.get(m2.id);
    check("(setup) M2's fake pty handle captured", !!m2Pty);
    m2Pty.kill(); // dies before SessionStart's own markReady ever ran

    const settled = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_recovered") || hasEvent(db, m1.id, "recycle_fleet_unresolved"));
    check("(H) settle loop reached a terminal outcome", settled);

    // THE REGRESSION THIS PROVES FIXED: reconcileNeverStartedRecycleSuccessor early-returns once
    // engineSessionId is set, so it NEVER unlinks M2 here — hasSuccessor(M1) would stay wrongly TRUE
    // forever under a check that relied on that unlink alone. settleRecycleHandoff's own `!isAlive`
    // check catches it anyway.
    check("(H) FIX: hasSuccessor(M1) is false — settleRecycleHandoff's OWN isAlive check unlinked it (f349f5cb's own mechanism never would have, here)", db.hasSuccessor(m1.id) === false);
    check("(H) FIX: the worker is reparented back onto M1", db.getSession(workerId)?.parentSessionId === m1.id);
    check("(H) FIX: M1 was NEVER stopped — still alive", host.isAlive(m1.id) === true);
    const recovered = db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered");
    check("(H) FIX: exactly one recycle_fleet_recovered event", recovered.length === 1 && recovered[0].detail?.deadSuccessorId === m2.id);
    check("(H) FIX: M2 is unlinked (recycledFrom: null) despite engineSessionId being set", db.getSession(m2.id)?.recycledFrom === null);
    check("(H) FIX: M2 is archived with a clear reason, ineligible for crash-recovery resume",
      !!db.getSession(m2.id)?.archivedAt && (db.getSession(m2.id)?.lastError ?? "").includes("[loom:recycle-failed]"));
  }

  // ==================== (I) MAJOR FIX — a recovered-onto dead M2 must be genuinely UNRESUMABLE ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmfrls-i";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const m2 = await sessions.recycleManager(m1.id, "handoff — M2 captures engineSessionId, then dies before ready (same shape as H)");

    // Same SessionStart-landed-then-died-before-ready shape as (H).
    db.setEngineSessionId(m2.id, "eng-m2-i");
    const m2Pty = host.handles.get(m2.id);
    check("(I setup) M2's fake pty handle captured", !!m2Pty);
    m2Pty.kill();

    // PRODUCTION ORDER (Code Review round 3): `host.ts`'s onExit machinery marks the pty not-alive and
    // fires `events.onExit` SYNCHRONOUSLY in the same callback (~L4210/~L4268) — so `index.ts`'s real
    // onExit hook calls `recordUnexpectedExit(db, sessionId, info.intended)` (~L526) IMMEDIATELY on the
    // kill, well before `settleRecycleHandoff`'s own poll loop (an independent async timer) next wakes up
    // to notice `!isAlive` and stamp `resumability:"dead"`. The harness's own onExit shim above doesn't
    // wire this call in, so it's made explicitly here, in the SAME synchronous position production makes
    // it — right after the kill, BEFORE awaiting the settle loop's own outcome below. Calling it AFTER
    // settle had already stamped "dead" (the prior version of this test) let recordUnexpectedExit's own
    // resumability gate silently absorb the whole bug, so M2 never entered the watcher's candidate set at
    // all and the assertions below passed whether or not the REAL protecting gate (the tick's own
    // `resumability === "dead"` check, crash-recovery-watcher.ts ~L316) existed.
    const wrote = recordUnexpectedExit(db, m2.id, false);
    check("(I) production order: recordUnexpectedExit records session_died for M2 BEFORE settle marks it dead (resumability is still \"resumable\" at this instant)",
      wrote === true && db.listEventsForSession(m2.id).filter((e) => e.kind === "session_died").length === 1);

    const settled = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_recovered") || hasEvent(db, m1.id, "recycle_fleet_unresolved"));
    check("(I pre) settle loop reached a terminal outcome", settled);
    check("(I pre) M1 is alive and the fleet was recovered onto it", host.isAlive(m1.id) === true && hasEvent(db, m1.id, "recycle_fleet_recovered"));
    check("(I) FIX: M2 is marked resumability:\"dead\" — genuinely unresumable, not just unlinked",
      db.getSession(m2.id)?.resumability === "dead");

    // One REAL CrashRecoveryWatcher.tick() — the reviewer's own repro shape — over the SAME db. M2 IS in
    // the tick's candidate set now (a real session_died trigger was recorded above), so the assertion below
    // exercises the ACTUAL protecting gate: the tick's own per-candidate `resumability === "dead"` check
    // (crash-recovery-watcher.ts ~L316), not recordUnexpectedExit's. A recording (never-really-spawning)
    // resume stub, matching this file's sibling crash-recovery-watcher.mjs's own convention.
    const resumeCalls = [];
    const watcher = new CrashRecoveryWatcher({
      db, control: new OrchestrationControl(),
      pty: { enqueueStdin: () => ({ delivered: true }) },
      resume: (id) => { resumeCalls.push(id); return true; },
      stabilityMs: 120_000,
    });
    watcher.tick(new Date());
    check("(I) FIX: a REAL CrashRecoveryWatcher.tick() NEVER calls resume() for the dead M2 — no second manager",
      !resumeCalls.includes(m2.id));
    check("(I) M1 was never targeted by the tick either (already live)", !resumeCalls.includes(m1.id) && host.isAlive(m1.id) === true);
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — settleRecycleHandoff never stops observing after its own unresolved-alert bound fires (a late-but-genuine READY_FALLBACK success still stops the predecessor and is recorded as resolved, for manager AND platform), a successor that captured a real engineSessionId (SessionStart landed) but died before markReady is STILL treated as a failed recycle — recovered onto the predecessor and made ineligible for crash-recovery resume — instead of leaving hasSuccessor() wrongly true forever, and a dead successor recovered onto a live predecessor is marked genuinely unresumable (resumability:\"dead\"), so neither recordUnexpectedExit nor a real CrashRecoveryWatcher tick can ever resurrect it as a second live manager."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
