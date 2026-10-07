import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card db4b778c — Code Review of b59d11f6 flagged a real gap: once watchHaltedRecycleSuccessor has filed
// recycle_fleet_unresolved(halted:true), nothing ever files the matching recycle_fleet_resolved when the
// lineage later settles. Neither the watch's own ready branch (it just `return`s) nor a later
// recycle_reattempt's "resolved" outcome (it fires a BRAND NEW settleRecycleHandoff loop whose own local
// `alerted` starts false, so its `if (alerted)` guard never fires) filed it — a human alerted "unresolved"
// could never hear it resolved (decision e07b1b1a's own "Do not" list already named this exact failure).
//
// Investigate-first checkpoint enumerated every exit of both methods (see
// docs/decisions/db4b778c-file-recycle-fleet-resolved-when-a-halted-watch-settles.md for the full trace)
// and the LEAD ruling approved the fix: a new `openUnresolvedRecycleFleetAlert(db, oldId, freshId)`
// (orchestration/crash-orphaned-workers.ts) reads the DURABLE event log instead of either loop's own
// in-memory `alerted` flag, and both ready branches consult it before deciding whether to file
// recycle_fleet_resolved.
//
// Proves:
//   (R-1) the WATCH's own ready branch: an unresolved alert fires (halted, successor neither ready nor
//        dead within the bound), then the successor reaches ready (still alive, never killed) — the watch
//        must file EXACTLY ONE recycle_fleet_resolved, naming this successor.
//   (R-2) the REATTEMPT path: the SAME halted-watch alert fires first; THEN recycle_reattempt resolves the
//        lineage (ownership transfer succeeds, successor already ready) — the settle loop IT spawns (a
//        fresh instance, its own `alerted` starting false) must still file EXACTLY ONE
//        recycle_fleet_resolved, reading the watch's own earlier alert off the durable log. The original
//        watch loop must stand down (b59d11f6) without filing a second one.
//   (R-3) LATER, SEPARATE EPISODE: after an EARLIER halted episode resolves via RECLAIM (not ready) —
//        recycle_fleet_recovered, never resolved — a fresh, ordinary (non-halted) recycle to a brand NEW
//        successor must file NO recycle_fleet_resolved at all. NOTE this scenario's own check only
//        discriminates on EVENT KIND (the latest recycle_fleet_* event is "recovered", not "unresolved" —
//        openUnresolvedRecycleFleetAlert rejects it on kind alone, before ever comparing successor ids);
//        it cannot by itself detect a missing/broken `detail.deadSuccessorId === freshId` match. (R-3b)
//        below is the scenario that actually discriminates that.
//   (R-3b) SUCCESSOR-ID DISCRIMINATION: plants a decoy recycle_fleet_unresolved event — matching KIND, but
//        naming an UNRELATED successor id that was never any real successor of this m1 — as the only prior
//        recycle_fleet_* event, then runs an ordinary clean recycle to a brand-new, real successor.
//        openUnresolvedRecycleFleetAlert must reject the decoy on `detail.deadSuccessorId !== freshId` and
//        file NO recycle_fleet_resolved, proving the match is lineage-precise, not just kind-precise
//        (mirrors recycle-reattempt-watch-standdown.mjs's own (S-D) decoy technique, applied to this
//        function instead of the watch's stand-down check).
//   (R-4) NO UNRESOLVED EVER FILED: the same fresh episode in (R-3) reaches ready immediately (well inside
//        the alert deadline) — no recycle_fleet_unresolved was ever filed for it, so no
//        recycle_fleet_resolved is filed either. (Folded into (R-3)'s own fresh episode rather than a
//        separate harness — it is the SAME observation taken from the other direction.)
//   (R-5) Code Review 9baa9d58: a "resolved" outcome's safety from cancelStaleEscalationQuestions sweeping
//        up an ordinary, unrelated M1 question is an UNDOCUMENTED, UNTESTED coupling to
//        attemptManagerOwnershipTransfer's own "questions" step (db.reparentQuestions(M1, M2), which runs
//        BEFORE the resolution marker is filed). Makes that coupling explicit: while still halted
//        (isSupersededByRecycle(M1) === false), M1 files an unrelated pending question after the watch's
//        own unresolved alert; the reattempt then resolves the lineage. The question must stay PENDING,
//        routed to M2 (reparented, never cancelled) — exactly one recycle_fleet_resolved is filed. A
//        positive-control variant stubs `Db.prototype.reparentQuestions` to a no-op: with the reparent
//        disabled, the SAME question is left on M1 and IS (wrongly) cancelled by
//        cancelStaleEscalationQuestions, proving the instrument can fire and that only the reparent step
//        protects an ordinary pending question from it.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: mirrors recycle-reattempt-watch-standdown.mjs's own
// harness exactly (a REAL Db + SessionService + PtyHost driven against the shared fake-pty seam).
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-fleet-resolved-after-halted-settle.mjs
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

const tmpHome = path.join(os.tmpdir(), `loom-rfras-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every settle bound BEFORE importing dist/** (mirrors recycle-reattempt-watch-standdown.mjs
// exactly — TIMEOUT_MS short so the unresolved alert fires quickly, SLOW_POLL_MS long so the watch's own
// stand-down tick in (R-2) can only land long after the short critical sequence that follows it).
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
const { isSupersededByRecycle } = await import("../dist/orchestration/crash-orphaned-workers.js");

const repo = path.join(os.tmpdir(), `loom-rfras-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# recycle-fleet-resolved-after-halted-settle test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rfras@loom -c user.name=rfras");

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

/** Seeds a live worker onto `managerId` (mirrors every sibling recycle test's own identical helper). */
function seedFleet(db, projectId, managerId) {
  const now = new Date().toISOString();
  const workerId = `${managerId}-worker`;
  db.insertTask({ id: `${managerId}-task`, projectId, title: "t", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: workerId, projectId, agentId: `${projectId}-mgr`, engineSessionId: "eng-w", title: null, cwd: repo, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: managerId, taskId: `${managerId}-task` });
  return { workerId };
}

/** Writes a real (empty) engine transcript file so `isDurablyResumable` reads true (mirrors every sibling
 *  recycle test's own identically-named helper) — not needed by every scenario here, kept for parity. */
function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

const eventsOfKind = (db, id, kind) => db.listEventsForSession(id).filter((e) => e.kind === kind);
const hasEvent = (db, id, kind) => eventsOfKind(db, id, kind).length > 0;

/** Forces the "wakes" ownership-transfer step to fail permanently (mirrors every sibling recycle test's
 *  own identically-named helper) so recycleManager halts. Caller restores. */
function stubWakesPermanentFailure() {
  const original = Db.prototype.reparentWakes;
  Db.prototype.reparentWakes = function () { throw new Error("injected PERMANENT failure (recycle-fleet-resolved-after-halted-settle test)"); };
  return () => { Db.prototype.reparentWakes = original; };
}

/** (R-5) Files an ordinary, unrelated PENDING decision question for `sessionId` — mirrors
 *  recycle-manager-ownership-transfer-halt.mjs's own `insertQuestion` shape. Not a recycle-escalation
 *  carve-out ask; just a normal question_ask a halted predecessor is fully entitled to file. */
function insertUnrelatedPendingQuestion(db, id, sessionId, projectId, createdAt) {
  db.insertQuestion({
    id, sessionId, projectId, type: "decision", title: "unrelated q", body: "b",
    options: null, recommendation: null, state: "pending", chosenOption: null,
    note: null, createdAt, answeredAt: null, consumedAt: null,
  });
}

/** (R-5 positive control) Stubs `Db.prototype.reparentQuestions` to a no-op so a question stays put on
 *  `oldSessionId` instead of moving to the successor — proves cancelStaleEscalationQuestions is only kept
 *  away from an ordinary pending question BY that reparent step actually running. Caller restores. */
function stubReparentQuestionsNoOp() {
  const original = Db.prototype.reparentQuestions;
  Db.prototype.reparentQuestions = function () { return 0; };
  return () => { Db.prototype.reparentQuestions = original; };
}

/** Halts M1->M2, capturing recycleManager's own internally-armed watchHaltedRecycleSuccessor promise —
 *  the PRODUCTION watch, not a second manual one racing it (mirrors recycle-reattempt-watch-standdown.mjs's
 *  own identically-named helper). */
async function haltedLineageWithWatch(projectSuffix) {
  const { db, host, sessions } = makeHarness();
  const P = `rfras-${projectSuffix}`;
  seedProject(db, P);
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
  // ==================== (R-1) the WATCH's own ready branch files resolved after its own alert ====================
  {
    const { db, host, m1, m2, watchPromise } = await haltedLineageWithWatch("r1");

    // M2 stays alive (never killed) but doesn't reach ready yet — the loop ticks past its own short
    // TIMEOUT_MS bound and alerts "timeout" (not yet ready, not yet confirmed dead). Waited on the event,
    // not a fixed sleep — entry into the alerted/slow-poll state is an OBSERVED event.
    const alerted = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_unresolved"));
    check("(R-1 setup) the watch's own unresolved alert fired first", alerted);
    check("(R-1 setup) exactly one unresolved alert so far", eventsOfKind(db, m1.id, "recycle_fleet_unresolved").length === 1);
    check("(R-1 setup) M2 is still alive at alert time — never killed", host.isAlive(m2.id) === true);

    // NOW M2 reaches ready — still alive, never killed. The watch's NEXT tick (its slow 2000ms cadence by
    // now) must take the ready branch and, per the fix, see the open unresolved alert and resolve it.
    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    writeFakeTranscript(m2.cwd, engineSessionId);
    check("(R-1 setup) M2 reached real ready via a genuine SessionStart hook", host.hasReachedReady(m2.id) === true);

    await watchPromise; // resolves the instant the loop's own next poll takes the ready branch — no timer

    check("(R-1) FIX db4b778c: the watch's ready branch filed EXACTLY ONE recycle_fleet_resolved", eventsOfKind(db, m1.id, "recycle_fleet_resolved").length === 1);
    const resolved = eventsOfKind(db, m1.id, "recycle_fleet_resolved")[0];
    check("(R-1) the resolved event names M2 as the successor", resolved?.detail?.successorId === m2.id);
    check("(R-1) M1 was never stopped by the watch — it has no stopping authority (f1969787)", host.isAlive(m1.id) === true && !host.stoppedIds.has(m1.id));
  }

  // ==================== (R-2) REATTEMPT after a watch-filed unresolved — settle's own fresh loop must resolve it ====================
  {
    const { db, host, sessions, m1, m2, watchPromise } = await haltedLineageWithWatch("r2");

    const alerted = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_unresolved"));
    check("(R-2 setup) the watch's own unresolved alert fired first", alerted);

    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    writeFakeTranscript(m2.cwd, engineSessionId);
    check("(R-2 setup) M2 reached real ready via a genuine SessionStart hook", host.hasReachedReady(m2.id) === true);

    // recycle_reattempt now resolves the lineage BEFORE the original watch's own (slow-cadence) next tick —
    // mirrors recycle-reattempt-watch-standdown.mjs's own capture technique so we can await the FRESH
    // settleRecycleHandoff instance it fires (unawaited internally).
    let settlePromise;
    const originalSettle = SessionService.prototype.settleRecycleHandoff;
    SessionService.prototype.settleRecycleHandoff = function (...args) {
      settlePromise = originalSettle.apply(this, args);
      return settlePromise;
    };
    const result = await sessions.reattemptManagerOwnershipTransfer(m1.id, "R-2 handoff — resolved after the watch already alerted unresolved");
    check("(R-2) recycle_reattempt RESOLVED", result.outcome === "resolved" && result.successorId === m2.id);
    check("(R-2 setup) settleRecycleHandoff's own fresh-instance promise was captured", !!settlePromise);

    await settlePromise;
    SessionService.prototype.settleRecycleHandoff = originalSettle;
    check("(R-2) settle's fresh instance DID stop M1", host.stoppedIds.has(m1.id));

    // The ORIGINAL watch loop, still alive, must stand down (b59d11f6) on its own next tick without
    // filing a second resolved event.
    await watchPromise;

    check("(R-2) FIX db4b778c: EXACTLY ONE recycle_fleet_resolved exists — filed by settle's fresh instance, reading the watch's earlier alert off the durable log (never the fresh instance's own local `alerted`, which started false)", eventsOfKind(db, m1.id, "recycle_fleet_resolved").length === 1);
    const resolved = eventsOfKind(db, m1.id, "recycle_fleet_resolved")[0];
    check("(R-2) the resolved event names M2 as the successor", resolved?.detail?.successorId === m2.id);
    check("(R-2) the ORIGINAL watch stood down (b59d11f6) rather than reclaiming — no recycle_fleet_recovered was filed, unaffected by this fix", eventsOfKind(db, m1.id, "recycle_fleet_recovered").length === 0);
  }

  // ==================== (R-3)/(R-4) a LATER, SEPARATE episode must never inherit — or need — the prior one's resolution ====================
  {
    const { db, host, sessions, m1, m2: m2a, watchPromise: watchPromiseA } = await haltedLineageWithWatch("r34");

    // Episode A resolves via RECLAIM, never ready: wait past the alert bound, then kill M2a before it
    // ever reaches ready (turnSeq stays 0 — no real context), forcing the unconditional reclaim branch.
    const alertedA = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_unresolved"));
    check("(R-3/4 setup) episode A's own unresolved alert fired first", alertedA);
    host.handles.get(m2a.id).kill();
    await watchPromiseA;
    check("(R-3/4 setup) episode A resolved via RECLAIM (recycle_fleet_recovered), never ready", hasEvent(db, m1.id, "recycle_fleet_recovered") && !hasEvent(db, m1.id, "recycle_fleet_resolved"));
    check("(R-3/4 setup) M1 is live again, with no successor — free to recycle again", db.hasSuccessor(m1.id) === false && host.isAlive(m1.id) === true);

    // Episode B: an ORDINARY (non-halted) clean recycle to a BRAND NEW successor, reaching ready
    // immediately — well inside the alert deadline, so NO recycle_fleet_unresolved is ever filed for it.
    let settlePromiseB;
    const originalSettle = SessionService.prototype.settleRecycleHandoff;
    SessionService.prototype.settleRecycleHandoff = function (...args) {
      settlePromiseB = originalSettle.apply(this, args);
      return settlePromiseB;
    };
    const m2b = await sessions.recycleManager(m1.id, "R-3/4 clean handoff — a later, separate episode");
    check("(R-3/4 setup) episode B minted a BRAND NEW successor, distinct from episode A's", m2b.id !== m2a.id);
    const engineSessionIdB = `eng-${m2b.id}`;
    host.deliverHook(m2b.id, { hook_event_name: "SessionStart", session_id: engineSessionIdB });
    writeFakeTranscript(m2b.cwd, engineSessionIdB);
    check("(R-3/4 setup) M2b reached real ready via a genuine SessionStart hook", host.hasReachedReady(m2b.id) === true);
    await settlePromiseB;
    SessionService.prototype.settleRecycleHandoff = originalSettle;

    const unresolvedNamingB = eventsOfKind(db, m1.id, "recycle_fleet_unresolved").filter((e) => e.detail?.deadSuccessorId === m2b.id);
    const resolvedNamingB = eventsOfKind(db, m1.id, "recycle_fleet_resolved").filter((e) => e.detail?.successorId === m2b.id);
    check("(R-4) NO unresolved alert was ever filed for episode B's new successor — it reached ready inside the deadline", unresolvedNamingB.length === 0);
    check("(R-3) LATER EPISODE: no recycle_fleet_resolved was ever filed for the new successor either — the latest recycle_fleet_* event for m1 is episode A's own \"recovered\" (a KIND mismatch alone is enough here; see R-3b for the successor-id discrimination this check cannot by itself prove)", resolvedNamingB.length === 0);
    check("(R-3/4) episode A's own recycle_fleet_recovered record is untouched by episode B settling cleanly", eventsOfKind(db, m1.id, "recycle_fleet_recovered").length === 1);
    check("(R-3/4) episode B's own settle DID stop M1 (an ordinary, non-halted clean recycle)", host.stoppedIds.has(m1.id));
  }

  // ==================== (R-3b) SUCCESSOR-ID DISCRIMINATION: a decoy unresolved alert naming an UNRELATED successor must never be read as this one's own ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rfras-r3b";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    seedFleet(db, P, m1.id);

    // A decoy whose KIND matches ("unresolved") so the kind check alone cannot reject it — only its
    // `detail.deadSuccessorId` (naming a successor m1 never actually had in this test) can. This is the
    // ONLY recycle_fleet_* event in the log so far, so `.filter().at(-1)` (the "latest" scan both
    // `latestMatchingUnresolvedSettleEvent` and `openUnresolvedRecycleFleetAlert` share) has nothing else
    // to pick but this decoy.
    const decoySuccessorId = `${m1.id}-decoy-successor`;
    db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(), managerSessionId: m1.id,
      kind: "recycle_fleet_unresolved", detail: { deadSuccessorId: decoySuccessorId, oldStillLive: true, reason: "timeout", halted: false },
    });
    check("(R-3b setup) a decoy recycle_fleet_unresolved now exists for m1, naming an unrelated successor id", hasEvent(db, m1.id, "recycle_fleet_unresolved"));

    // An ORDINARY (non-halted) clean recycle to a brand-new, REAL successor, reaching ready immediately.
    let settlePromise;
    const originalSettle = SessionService.prototype.settleRecycleHandoff;
    SessionService.prototype.settleRecycleHandoff = function (...args) {
      settlePromise = originalSettle.apply(this, args);
      return settlePromise;
    };
    const m2 = await sessions.recycleManager(m1.id, "R-3b clean handoff — a decoy unresolved alert for an unrelated successor must never be read as this one's own");
    check("(R-3b setup) the real successor is distinct from the decoy id", m2.id !== decoySuccessorId);
    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    writeFakeTranscript(m2.cwd, engineSessionId);
    check("(R-3b setup) M2 reached real ready via a genuine SessionStart hook", host.hasReachedReady(m2.id) === true);
    await settlePromise;
    SessionService.prototype.settleRecycleHandoff = originalSettle;

    check("(R-3b) SUCCESSOR-ID DISCRIMINATION: no recycle_fleet_resolved was filed for the real successor — the decoy's matching KIND alone was not enough; its unrelated `deadSuccessorId` was correctly rejected", eventsOfKind(db, m1.id, "recycle_fleet_resolved").length === 0);
    check("(R-3b) the decoy event itself is untouched", eventsOfKind(db, m1.id, "recycle_fleet_unresolved").filter((e) => e.detail?.deadSuccessorId === decoySuccessorId).length === 1);
    check("(R-3b) the real successor's own settle still stopped M1 (an ordinary, non-halted clean recycle)", host.stoppedIds.has(m1.id));
  }

  // ==================== (R-5) an ordinary pending M1 question must survive a "resolved" reattempt — reparentQuestions is why ====================
  {
    const { db, host, sessions, m1, m2 } = await haltedLineageWithWatch("r5");

    const alerted = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_unresolved"));
    check("(R-5 setup) the watch's own unresolved alert fired first", alerted);
    check("(R-5) isSupersededByRecycle(M1) is FALSE while halted — M1 remains fully entitled to file an ordinary question, not through any escalation carve-out", isSupersededByRecycle(db, m1.id) === false);

    const unresolvedTs = eventsOfKind(db, m1.id, "recycle_fleet_unresolved")[0].ts;
    const questionId = "r5-unrelated-question";
    insertUnrelatedPendingQuestion(db, questionId, m1.id, "rfras-r5", new Date(Date.parse(unresolvedTs) + 5).toISOString());

    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    writeFakeTranscript(m2.cwd, engineSessionId);
    check("(R-5 setup) M2 reached real ready via a genuine SessionStart hook", host.hasReachedReady(m2.id) === true);

    let settlePromise;
    const originalSettle = SessionService.prototype.settleRecycleHandoff;
    SessionService.prototype.settleRecycleHandoff = function (...args) {
      settlePromise = originalSettle.apply(this, args);
      return settlePromise;
    };
    const result = await sessions.reattemptManagerOwnershipTransfer(m1.id, "R-5 handoff — an unrelated pending question must survive this resolve");
    check("(R-5) recycle_reattempt RESOLVED", result.outcome === "resolved" && result.successorId === m2.id);
    await settlePromise;
    SessionService.prototype.settleRecycleHandoff = originalSettle;

    check("(R-5) FIX db4b778c still holds here: EXACTLY ONE recycle_fleet_resolved was filed", eventsOfKind(db, m1.id, "recycle_fleet_resolved").length === 1);
    const question = db.getQuestion(questionId);
    check("(R-5) the unrelated question stays PENDING — cancelStaleEscalationQuestions never saw it on M1's inbox", question?.state === "pending");
    check("(R-5) the unrelated question was ROUTED TO M2 — attemptManagerOwnershipTransfer's own \"questions\" step (db.reparentQuestions) ran before the resolution marker was filed", question?.sessionId === m2.id);
  }

  // ==================== (R-5 positive control) disable reparentQuestions — the SAME question is now wrongly cancelled ====================
  {
    const { db, host, sessions, m1, m2 } = await haltedLineageWithWatch("r5pc");

    const alerted = await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_unresolved"));
    check("(R-5pc setup) the watch's own unresolved alert fired first", alerted);

    const unresolvedTs = eventsOfKind(db, m1.id, "recycle_fleet_unresolved")[0].ts;
    const questionId = "r5pc-unrelated-question";
    insertUnrelatedPendingQuestion(db, questionId, m1.id, "rfras-r5pc", new Date(Date.parse(unresolvedTs) + 5).toISOString());

    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    writeFakeTranscript(m2.cwd, engineSessionId);
    check("(R-5pc setup) M2 reached real ready via a genuine SessionStart hook", host.hasReachedReady(m2.id) === true);

    let settlePromise;
    const originalSettle = SessionService.prototype.settleRecycleHandoff;
    SessionService.prototype.settleRecycleHandoff = function (...args) {
      settlePromise = originalSettle.apply(this, args);
      return settlePromise;
    };
    const unstubReparentQuestions = stubReparentQuestionsNoOp();
    const result = await sessions.reattemptManagerOwnershipTransfer(m1.id, "R-5pc handoff — reparentQuestions disabled");
    unstubReparentQuestions();
    check("(R-5pc) recycle_reattempt still RESOLVED — the stubbed step just moved nothing, it did not fail", result.outcome === "resolved" && result.successorId === m2.id);
    await settlePromise;
    SessionService.prototype.settleRecycleHandoff = originalSettle;

    check("(R-5pc) the resolved-filing fix is UNAFFECTED by the stub — still exactly one recycle_fleet_resolved", eventsOfKind(db, m1.id, "recycle_fleet_resolved").length === 1);
    const question = db.getQuestion(questionId);
    check("(R-5pc) POSITIVE CONTROL: with reparentQuestions disabled, the question was NEVER moved off M1", question?.sessionId === m1.id);
    check("(R-5pc) POSITIVE CONTROL: the instrument fires — cancelStaleEscalationQuestions wrongly cancelled an ordinary pending question it should never have seen", question?.state === "cancelled");
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — both the halted watch's own ready branch and a reattempt-spawned settle instance file recycle_fleet_resolved exactly once per episode (reading the durable event log, never either loop's own in-memory `alerted` flag), never for a lineage that never alerted, and never bleeding across a later, separate episode's new successor id."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
