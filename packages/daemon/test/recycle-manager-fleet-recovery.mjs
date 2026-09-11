import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card e07b1b1a (the manager/platform half of f349f5cb's own deferred scope) — after a manager/
// platform recycle's fresh successor (M2) spawns successfully but dies before ever reaching SessionStart,
// f349f5cb's `reconcileNeverStartedRecycleSuccessor` unlinks the stray `recycled_from` link so the
// predecessor (M1) becomes RESUMABLE again — but it does NOT recover the FLEET: M1's live workers/wakes/
// questions/cap-queue entries/pending messages were already reparented onto M2 at recycle time, and the
// unconditional ~3s deferred `pty.stop(oldId, "hard")` would still hard-kill M1 regardless of M2's fate,
// leaving NOTHING in the lineage live.
//
// Fix: `SessionService.settleRecycleHandoff` replaces that unconditional deferred stop with a poll loop
// that waits for a REAL signal — `hasReachedReady(freshId)` (success: stop the predecessor exactly as
// before) or `!pty.isAlive(freshId)` (the successor's real process is confirmed dead, independent of
// whether it ever reached SessionStart: recover the predecessor's fleet via
// `recoverFleetAfterFailedRecycleSuccessor` instead of stopping it) — raising (never RETURNING on) an
// unresolved alert once a bound is crossed with neither signal yet, then continuing to watch at a slower
// cadence. This file covers the SAME-FILE-friendly scenarios (A-E, below); the "late/real-fallback"
// scenarios that need their OWN process-wide `READY_FALLBACK_MS` live in the sibling file
// recycle-manager-fleet-recovery-late-signals.mjs (a short global fallback here would contaminate
// scenario (D), which needs M2 to stay genuinely neither-ready-nor-dead for the whole test).
//
// Proves:
//   (A) MANAGER, RECOVERED — a live worker/wake/question/cap-queue entry reparented onto M2 at recycle
//       time all move BACK onto M1 once M2 is confirmed to have died before SessionStart; M1 is NEVER
//       stopped; a `recycle_fleet_recovered` event fires; a DURABLE nudge (a DB row via
//       listUnresolvedQueuedMessagesForWorker, not just FIFO text — the exact durability discipline
//       project memory `resumefleetonboot-durability-gap-deferred` demands) reaches M1; M2 itself is left
//       unlinked (`recycledFrom: null`) + archived with a clear reason (Code Review: never leave a dead
//       successor resumable, or a later crash-recovery tick can resurrect it as a SECOND live manager).
//   (B) PLATFORM LEAD, RECOVERED — same shape via recyclePlatformLead (no worker/cap-queue legs — "the
//       Lead has none"), PLUS: recyclePlatformLead flips `old.processState` to "exited" SYNCHRONOUSLY as
//       part of its atomic handoff, before ever touching the real pty — the recovery branch must restore
//       it back to "live" now that the real process is confirmed to have never actually died.
//   (C) HAPPY-PATH REGRESSION — M2 reaches real `ready` (a genuine SessionStart hook) well within the
//       settle bound: M1 IS eventually stopped, exactly like the pre-fix unconditional timer — proves the
//       new poll-based settle doesn't regress the ordinary success path.
//   (D) BOUNDED TIMEOUT — M2 neither reaches ready nor exits within the (test-shortened) settle bound: M1
//       is NOT stopped, a `recycle_fleet_unresolved{reason:"timeout"}` event AND a durable nudge fire, and
//       NOTHING is reparented (M2's fate is still unknown, unlike the confirmed-dead case). Code Review
//       MAJOR: the loop does NOT return here — it keeps observing at a slower cadence (proved in the
//       sibling "late-signals" file's own (G) scenario, which needs its own timing budget).
//   (E) NEVER RESURRECT — M1 is ALSO no longer alive (a human hard-stopped it) by the time the settle loop
//       confirms M2 died: NO reparenting happens (the fleet stays on the dead M2, not a dead M1), no
//       processState restore, and the event fired is `recycle_fleet_unresolved{reason:"successor-died",
//       oldStillLive:false}`, never `recycle_fleet_recovered`. Code Review round 2 (m1): M2 is now left
//       ENTIRELY ALONE in this branch — no unlink, no archive, no lastError overwrite, no resumability
//       change — since M2 is the ONLY possible fleet owner here and a later crash-recovery resume of it is
//       exactly what should re-adopt the workers; touching it would pull the orphaned fleet off the live
//       rail and overwrite its TRUE `[loom:orphaned-fleet]` banner (@decision 6cd3ce9e) with a false one.
//
// TIMING DISCIPLINE: every wait below is `waitUntil(predicate)` — polling for an OBSERVABLE terminal
// signal (the settle loop's own appended event, or `pty.isAlive` flipping) — never a bare fixed sleep
// gating a negative assertion (fixed-wait-negative-guard.mjs's own target shape: a timer expiring before
// something happens is indistinguishable from it never happening at all). Once a scenario's terminal event
// is observed, `settleRecycleHandoff` has PROVABLY already taken that one branch — the ready branch (the
// ONLY one that ever calls `pty.stop(oldId)`) is mutually exclusive with the other two AT THAT INSTANT (it
// is checked first, every iteration) — so a "never stopped as a RESULT of THIS observed branch" assertion
// made right after is sound. It is NOT a claim the loop has exited for good (post Code Review, it hasn't,
// for the unresolved branch) — scenario (D) deliberately does not claim more than what it observed.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService + PtyHost driven against a FAKE
// low-level pty (the shared createPty() seam — see _seam-host-fixture.mjs), with every session (M1 AND
// M2) REALLY spawned via SessionService.startManager/startPlatformLead — not DB-seeded-only — because
// `settleRecycleHandoff`'s recovery branch gates on `pty.isAlive(oldId)`, which only a real spawn can
// meaningfully flip. The settle bound/poll interval/initial flush delay and the MCP-seen wait are all
// env-shortened (see the constants below) so this file runs in well under a second instead of the real
// ~55s+9s defaults.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-manager-fleet-recovery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `predicate` until it returns true or `timeoutMs` elapses; returns whether it became true. Used
 *  to anchor every wait in this file to an OBSERVABLE signal instead of a fixed delay — see the TIMING
 *  DISCIPLINE note above. */
async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-rmfr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every bound this scenario touches BEFORE importing dist/** — each constant reads its env
// override at MODULE LOAD time (mirrors READY_FALLBACK_MS/CODEX_BUSY_STALE_MS's own established
// convention in this codebase). These only need to be SMALL enough that waitUntil's own timeoutMs
// (above) comfortably covers them — the assertions themselves never depend on the exact values.
const FLUSH_DELAY_MS = 40;
const POLL_MS = 15;
const SETTLE_TIMEOUT_MS = 200;
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = String(FLUSH_DELAY_MS);
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = String(POLL_MS);
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = String(SETTLE_TIMEOUT_MS);
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25"; // enqueueDurableNudge's usesOrchestrationMcp gate (waitForMcpSeen)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map(); // sessionId -> the fake low-level pty object (pid/write/onData/onExit/kill/resize)
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
    // Mirrors index.ts's real onExit hook (archiveOnExit then reconcileNeverStartedRecycleSuccessor), the
    // SAME shim recycle-successor-dies-before-session-start.mjs uses.
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

/** Seeds a live worker + wake + question onto `managerId`, all reparent-able. */
function seedFleet(db, sessions, projectId, managerId) {
  const now = new Date().toISOString();
  const workerId = `${managerId}-worker`;
  db.insertTask({ id: `${managerId}-task`, projectId, title: "t", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: workerId, projectId, agentId: `${projectId}-mgr`, engineSessionId: "eng-w", title: null, cwd: db.getProject(projectId).repoPath, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: managerId, taskId: `${managerId}-task` });
  db.insertWake({ id: `${managerId}-wake`, sessionId: managerId, wakeAt: new Date(Date.now() + 3_600_000).toISOString(), note: "test wake", createdAt: now, route: null });
  db.insertQuestion({ id: `${managerId}-q`, sessionId: managerId, projectId, title: "q", body: "b", state: "pending", createdAt: now });
  return { workerId };
}

const hasEvent = (db, id, kind) => db.listEventsForSession(id).some((e) => e.kind === kind);

try {
  // ==================== (A) MANAGER, RECOVERED ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmfr-a";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    check("(A pre) M1 is really alive", host.isAlive(m1.id));
    const { workerId } = seedFleet(db, sessions, P, m1.id);

    const m2 = await sessions.recycleManager(m1.id, "handoff — spawn succeeds, then the child dies before SessionStart");
    check("(A) recycleManager succeeded", !!m2 && m2.id !== m1.id);
    check("(A) fleet moved onto M2 at recycle time", db.getSession(workerId)?.parentSessionId === m2.id);
    // Seeded directly onto M2 AFTER the recycle (not via the forward reparent path): recycleManager's own
    // maybeDrainCapQueue fires ONCE, synchronously, right after reparenting — an entry seeded before the
    // recycle would already be POPPED by that unrelated, pre-existing auto-drain by the time this test's
    // own assertions run, which is not what this test is checking. Seeding it here instead isolates the
    // ACTUAL thing this card adds: does the reverse-reparent (recoverFleetAfterFailedRecycleSuccessor) move
    // an entry sitting on the dead M2 back onto M1 — the forward direction is pre-existing, tested code.
    sessions.capQueue.record(m2.id, `${P}-mgr`, null, "queued kickoff");
    check("(A) cap-queue entry seeded on M2", sessions.capQueue.listByManager(m2.id).length === 1);

    const m2Pty = host.handles.get(m2.id);
    check("(setup) M2's fake pty handle captured", !!m2Pty);
    m2Pty.kill(); // the bug's trigger — M2 dies with no onData ever fired (no SessionStart, no ready marker)

    const settled = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_recovered") || hasEvent(db, m1.id, "recycle_fleet_unresolved"));
    check("(A) settle loop reached a terminal outcome", settled);

    check("(A) FIX: hasSuccessor(M1) is false (f349f5cb's own unlink, unaffected)", db.hasSuccessor(m1.id) === false);
    check("(A) FIX: the worker is reparented back onto M1", db.getSession(workerId)?.parentSessionId === m1.id);
    check("(A) FIX: the wake is reparented back onto M1", db.listWakesForSession(m1.id).some((w) => w.id === `${m1.id}-wake`));
    check("(A) FIX: the question is reparented back onto M1", db.listQuestionsForSession(m1.id).some((q) => q.id === `${m1.id}-q`));
    // NOT asserted as a steady-state "now sits on M1": recoverFleetAfterFailedRecycleSuccessor's own
    // cap-queue leg mirrors the forward path exactly (reparent THEN fire-and-forget maybeDrainCapQueue),
    // and M1 has room, so the entry is typically popped again immediately by that same drain — the correct,
    // intended outcome (a queued spawn that can now actually run), not a bug. What this fix actually
    // corrects is the entry never being stranded, permanently unreachable, on the dead M2.
    check("(A) FIX: the cap-queue entry is no longer stranded on the dead M2", sessions.capQueue.listByManager(m2.id).length === 0);
    // Sound because the terminal event above proves settleRecycleHandoff already returned via the
    // recovered branch — the OTHER, mutually-exclusive branch (which alone calls pty.stop(oldId)) already
    // did not run and structurally cannot run later from this same settle call.
    check("(A) FIX: M1 was NEVER stopped — still alive", host.isAlive(m1.id) === true);
    const recovered = db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered");
    check("(A) FIX: exactly one recycle_fleet_recovered event, naming the dead successor", recovered.length === 1 && recovered[0].detail?.deadSuccessorId === m2.id && recovered[0].detail?.oldStillLive === true);
    check("(A) no recycle_fleet_unresolved event fabricated", db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_unresolved").length === 0);
    // Code Review: M2 must be made ineligible for crash-recovery resume — a later tick resuming it would
    // create a SECOND live manager alongside the just-recovered M1.
    check("(A) FIX: M2 is unlinked (recycledFrom: null)", db.getSession(m2.id)?.recycledFrom === null);
    check("(A) FIX: M2 is archived with a clear, non-stale reason (not archiveOnExit's own stale orphaned-fleet banner)",
      !!db.getSession(m2.id)?.archivedAt && (db.getSession(m2.id)?.lastError ?? "").includes("[loom:recycle-failed]") && !(db.getSession(m2.id)?.lastError ?? "").includes("orphaned-fleet"));
    // DURABILITY (project memory resumefleetonboot-durability-gap-deferred): the nudge must be a DB row,
    // not just FIFO text — a FIFO-text-only check would pass identically whether or not the nudge is
    // actually durable, which is exactly the vacuous-check trap that memory note documents. The nudge
    // dispatch is a SEPARATE async step after the event above (enqueueDurableNudge's own MCP-seen wait),
    // so it gets its own terminal-signal poll rather than reusing the event's.
    const nudged = await waitUntil(() => db.listUnresolvedQueuedMessagesForWorker(m1.id).length > 0);
    check("(A) settle loop's nudge became durable", nudged);
    const durable = db.listUnresolvedQueuedMessagesForWorker(m1.id);
    check("(A) FIX: the recycle-failed nudge is DURABLE — a real DB row (not just FIFO text)",
      durable.some((rec) => typeof rec.detail?.text === "string" && rec.detail.text.includes("[loom:recycle-failed]") && rec.detail.text.includes("worker_list")));
  }

  // ==================== (B) PLATFORM LEAD, RECOVERED ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmfr-b";
    seedProject(db, P);
    db.insertAgent({ id: `${P}-lead`, projectId: P, name: "Lead", startupPrompt: "LEAD", position: 1, profileId: null });
    const l1 = sessions.startPlatformLead(`${P}-lead`);
    check("(B pre) L1 is really alive", host.isAlive(l1.id));
    db.insertWake({ id: `${l1.id}-wake`, sessionId: l1.id, wakeAt: new Date(Date.now() + 3_600_000).toISOString(), note: "test wake", createdAt: new Date().toISOString(), route: null });
    db.insertQuestion({ id: `${l1.id}-q`, sessionId: l1.id, projectId: P, title: "q", body: "b", state: "pending", createdAt: new Date().toISOString() });

    const l2 = await sessions.recyclePlatformLead(l1.id, "handoff — spawn succeeds, then the child dies before SessionStart");
    check("(B) recyclePlatformLead succeeded", !!l2 && l2.id !== l1.id);
    check("(B) old.processState flipped to exited synchronously (the atomic handoff)", db.getSession(l1.id)?.processState === "exited");

    const l2Pty = host.handles.get(l2.id);
    check("(setup) L2's fake pty handle captured", !!l2Pty);
    l2Pty.kill();

    const settled = await waitUntil(() => hasEvent(db, l1.id, "recycle_fleet_recovered") || hasEvent(db, l1.id, "recycle_fleet_unresolved"));
    check("(B) settle loop reached a terminal outcome", settled);

    check("(B) FIX: hasSuccessor(L1) is false", db.hasSuccessor(l1.id) === false);
    check("(B) FIX: the wake is reparented back onto L1", db.listWakesForSession(l1.id).some((w) => w.id === `${l1.id}-wake`));
    check("(B) FIX: the question is reparented back onto L1", db.listQuestionsForSession(l1.id).some((q) => q.id === `${l1.id}-q`));
    check("(B) FIX: L1's processState is RESTORED to live (the real process never actually died)", db.getSession(l1.id)?.processState === "live");
    check("(B) FIX: L1 was NEVER stopped — still alive", host.isAlive(l1.id) === true);
    const recovered = db.listEventsForSession(l1.id).filter((e) => e.kind === "recycle_fleet_recovered");
    check("(B) FIX: exactly one recycle_fleet_recovered event", recovered.length === 1 && recovered[0].detail?.oldStillLive === true);
    check("(B) FIX: L2 is unlinked (recycledFrom: null)", db.getSession(l2.id)?.recycledFrom === null);
    check("(B) FIX: L2 is archived with a clear, non-stale reason", !!db.getSession(l2.id)?.archivedAt && (db.getSession(l2.id)?.lastError ?? "").includes("[loom:recycle-failed]"));

    const nudged = await waitUntil(() => db.listUnresolvedQueuedMessagesForWorker(l1.id).length > 0);
    check("(B) settle loop's nudge became durable", nudged);
    const durable = db.listUnresolvedQueuedMessagesForWorker(l1.id);
    check("(B) FIX: the recycle-failed nudge is a DURABLE DB row, worded for a Lead (no worker_list)",
      durable.some((rec) => typeof rec.detail?.text === "string" && rec.detail.text.includes("[loom:recycle-failed]") && !rec.detail.text.includes("worker_list")));
  }

  // ==================== (C) HAPPY-PATH REGRESSION — M2 reaches real ready ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmfr-c";
    seedProject(db, P);
    // startupModeCycles:0 (card 760cd01d's own reasoning, mirrored from the sibling test file's (A2)):
    // markReady must run SYNCHRONOUSLY off the deliverHook call below, not behind an async mode-cycle.
    db.setProjectConfig(P, { permission: { startupModeCycles: 0 } });
    const m1 = sessions.startManager(`${P}-mgr`);
    const m2 = await sessions.recycleManager(m1.id, "handoff — this one succeeds normally");

    host.deliverHook(m2.id, { hook_event_name: "SessionStart" });
    check("(C pre) M2 reached real ready via a genuine SessionStart hook", host.hasReachedReady(m2.id) === true);

    const stopped = await waitUntil(() => host.isAlive(m1.id) === false);
    check("(C) REGRESSION: M1 IS eventually stopped, exactly like the pre-fix behavior", stopped);
    check("(C) hasSuccessor(M1) stays true — a genuine successful recycle, not a failure", db.hasSuccessor(m1.id) === true);
    check("(C) no recycle_fleet_recovered/unresolved event fabricated on the happy path",
      db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered" || e.kind === "recycle_fleet_unresolved").length === 0);
  }

  // ==================== (D) BOUNDED TIMEOUT — M2 neither ready nor exited ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmfr-d";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId } = seedFleet(db, sessions, P, m1.id);
    const m2 = await sessions.recycleManager(m1.id, "handoff — the child hangs, neither ready nor exited");
    // Deliberately do NOT kill m2's pty and do NOT drive it to ready — a genuine hang.

    const unresolvedFired = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_unresolved"), { timeoutMs: SETTLE_TIMEOUT_MS + 2000 });
    check("(D) settle loop's bounded timeout fired", unresolvedFired);

    // Sound because the event above proves the settle loop already returned via the unresolved/timeout
    // branch — the ready branch (the only one that calls pty.stop) already did not run.
    check("(D) FIX: M1 was NEVER stopped on an ambiguous state", host.isAlive(m1.id) === true);
    check("(D) FIX: hasSuccessor(M1) stays TRUE — no failure was ever confirmed", db.hasSuccessor(m1.id) === true);
    check("(D) FIX: NOTHING was reparented — M2's fate is still unknown", db.getSession(workerId)?.parentSessionId === m2.id);
    const unresolved = db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_unresolved");
    check("(D) FIX: exactly one recycle_fleet_unresolved event, reason:timeout, oldStillLive:true",
      unresolved.length === 1 && unresolved[0].detail?.reason === "timeout" && unresolved[0].detail?.oldStillLive === true);
    check("(D) no recycle_fleet_recovered event fabricated", db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered").length === 0);
    // Code Review item 5: the timeout branch must actually nudge a still-live predecessor (a durable DB
    // row, same durability discipline as (A)) — and the wording must be HONEST, never overclaiming a
    // human was alerted (true only if attention-push/alertWebhook happen to be configured).
    const nudged = await waitUntil(() => db.listUnresolvedQueuedMessagesForWorker(m1.id).length > 0);
    check("(D) settle loop's unresolved nudge became durable", nudged);
    const durable = db.listUnresolvedQueuedMessagesForWorker(m1.id);
    check("(D) FIX: the unresolved nudge is a DURABLE DB row with honest wording (never claims a human WAS alerted)",
      durable.some((rec) => typeof rec.detail?.text === "string" && rec.detail.text.includes("[loom:recycle-failed]") &&
        rec.detail.text.includes("still watching") && !rec.detail.text.includes("a human has been alerted")));
  }

  // ==================== (E) NEVER RESURRECT — M1 also no longer alive ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rmfr-e";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId } = seedFleet(db, sessions, P, m1.id);
    const m2 = await sessions.recycleManager(m1.id, "handoff — the child dies AND a human stops the parent mid-settle");
    sessions.capQueue.record(m2.id, `${P}-mgr`, null, "queued kickoff"); // seeded post-recycle — see (A)'s own note on why

    const m2Pty = host.handles.get(m2.id);
    m2Pty.kill(); // M2 dies before SessionStart — the confirmed-failure signal
    const m1Pty = host.handles.get(m1.id);
    check("(setup) M1's fake pty handle captured", !!m1Pty);
    m1Pty.kill(); // simulates a HUMAN hard-stopping M1 in the same window, before settle ever notices

    const settled = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_recovered") || hasEvent(db, m1.id, "recycle_fleet_unresolved"));
    check("(E) settle loop reached a terminal outcome", settled);

    check("(E) FIX: hasSuccessor(M1) is false (M2's death still unlinked it)", db.hasSuccessor(m1.id) === false);
    check("(E) NEVER RESURRECT: the worker was NOT reparented onto the dead M1 — stays on M2", db.getSession(workerId)?.parentSessionId === m2.id);
    check("(E) NEVER RESURRECT: the cap-queue entry was NOT reparented onto the dead M1", sessions.capQueue.listByManager(m1.id).length === 0);
    check("(E) NEVER RESURRECT: the cap-queue entry is left exactly where it was (stranded, for a human to recover)", sessions.capQueue.listByManager(m2.id).length === 1);
    const unresolved = db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_unresolved");
    check("(E) FIX: exactly one recycle_fleet_unresolved event, reason:successor-died, oldStillLive:false",
      unresolved.length === 1 && unresolved[0].detail?.reason === "successor-died" && unresolved[0].detail?.oldStillLive === false);
    check("(E) no recycle_fleet_recovered event fabricated (M1 is dead — nothing was actually recovered)",
      db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered").length === 0);
    check("(E) no nudge fabricated for a dead M1 (nothing to durably tell)", db.listUnresolvedQueuedMessagesForWorker(m1.id).length === 0);
    // Code Review round 2 (m1): when M1 is NOT alive either, M2 is left ENTIRELY ALONE — M2 is the only
    // possible fleet owner, and a crash-recovery resume of M2 is exactly what should re-adopt the workers.
    // recycledFrom is still null here (f349f5cb's OWN unlink mechanism fired on M2's own onExit, independent
    // of this card's fix — asserted above), but this card's own unlinkAndArchiveDeadRecycleSuccessor must
    // NEVER run in this branch: no archive, no lastError overwrite, no resumability change.
    check("(E) FIX (m1): M2 is NOT archived — it stays the live rail's only possible fleet owner", db.getSession(m2.id)?.archivedAt == null);
    check("(E) FIX (m1): M2's TRUE orphaned-fleet banner survives untouched (never overwritten with a false 'predecessor recovered' one)",
      (db.getSession(m2.id)?.lastError ?? "").includes("[loom:orphaned-fleet]") && !(db.getSession(m2.id)?.lastError ?? "").includes("[loom:recycle-failed]"));
    check("(E) FIX (m1): M2's resumability is untouched (still resumable — a human/crash-recovery resume can re-adopt the fleet)",
      db.getSession(m2.id)?.resumability !== "dead");
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a manager/platform recycle whose successor dies before SessionStart now recovers the predecessor's fleet (workers/wakes/questions/cap-queue/pending) instead of stranding it, alerts a human either way, never resurrects a fleet onto a predecessor that is itself no longer alive, and the ordinary successful-recycle path is unregressed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
