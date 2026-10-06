import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card dfc3b014 — `SessionService.reattemptManagerOwnershipTransfer` (the `recycle_reattempt` manager MCP
// tool): a halted predecessor's own remedy for the `f1969787` halt branch, which nothing ever automatically
// retries. Hermetic harness mirrors recycle-manager-halted-successor-dies.mjs's own (a REAL Db +
// SessionService + PtyHost driven against the shared fake-pty seam).
//
// Proves:
//   (R0) REFUSE — a blank `handoffNote` (mirrors recycle_me's own continuationPrompt FAIL SAFE).
//   (R1) REFUSE — a never-recycled (ordinary) manager is not a halted predecessor.
//   (R2) REFUSE — a genuinely halted predecessor whose successor hasn't reached SessionStart yet.
//   (R3a) ROUND 2 (Code Review MAJOR) — REFUSE when the successor is down but DURABLY RESUMABLE (a real
//        engine id + transcript) — it must be left to the live crash-recovery watchdog or a later
//        resumeFleetOnBoot, never reclaimed (which would permanently stamp it dead and discard its context).
//        ROUND 3: when crash recovery IS genuinely eligible (isCrashRecoveryEligible), the refusal text
//        truthfully says "wait for its automatic recovery, then retry".
//   (R3a-ii) ROUND 3 — the SAME resumable-down shape, but crash recovery is DISABLED
//        (crashRecoveryMaxAttempts:0 — the same false isCrashRecoveryEligible returns for an exhausted cap,
//        a human pause, or a restart whose boot reconcile doesn't cover this shape): still refuses, but now
//        says "nothing will recover it automatically — escalate: a human must resume successor <id>".
//   (R3b) RECLAIM — successor down and NOT durably resumable: the worker that DID transfer comes back onto
//        the predecessor, the predecessor is never stopped, hasSuccessor flips false — and, closing the
//        "halted-predecessor-can't-recycle" gap, the predecessor can now recycle() again successfully.
//   (R4) RESOLVED — successor alive + ready, retry now clean (the forced failure lifted): the tool's own
//        PROMISE resolves (handoff delivered, response returned) BEFORE the predecessor is actually
//        stopped (ROUND 2, Code Review MAJOR: the original landing AWAITED the stop, so its response could
//        never reach a caller whose pty that same await had already killed) — M1 is stopped shortly after,
//        asynchronously; `recycle_ownership_transfer_resolved` is filed and `recycled_from` is left INTACT
//        (hasSuccessor stays true) while `isSupersededByRecycle` reads true going forward.
//   (R4b) ROUND 3 — the resolution marker's OWN db.appendEvent throws: the whole call REFUSES
//        synchronously, before the handoff nudge or settle ever fire — the predecessor is never stopped and
//        currentHaltedSuccessor still correctly reports the lineage as unresolved.
//   (R4c) Nit item 3 — the handoff nudge's OWN dispatch fails (enqueueDurableNudge's onOutcome reports
//        dispatched:false): the outcome is still "resolved" (the marker + settle are unaffected), and a new
//        audit-only recycle_reattempt_handoff_undelivered event records the one thing that didn't survive.
//   (R5) STILL-SPLIT — successor alive + ready, but the forced failure is STILL active: the predecessor
//        remains live with nothing changed about what it still owns; `currentHaltedSuccessor` still
//        matches afterward (the retry attempt itself must never resolve or further corrupt the halt).
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-reattempt.mjs
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

const tmpHome = path.join(os.tmpdir(), `loom-rra-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every settle bound BEFORE importing dist/** (mirrors recycle-manager-halted-successor-dies.mjs).
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = "20";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = "10";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = "3600000";
// enqueueDurableNudge gates a manager-role dispatch on waitForMcpSeen (df5e37e7) — nothing in this synthetic
// harness ever calls markMcpSeen, so without shortening this bound the R4 handoff nudge would only dispatch
// after the REAL default timeout elapses.
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { currentHaltedSuccessor, isSupersededByRecycle } = await import("../dist/orchestration/crash-orphaned-workers.js");

const repo = path.join(os.tmpdir(), `loom-rra-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# recycle-reattempt test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rra@loom -c user.name=rra");

class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map(); // sessionId -> the fake low-level pty object
  stoppedIds = new Set();
  enqueued = []; // {id, text, kind} — captures enqueueDurableNudge's own live-delivery path
  createPty(opts) {
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    return pty;
  }
  stop(id, mode) { this.stoppedIds.add(id); return super.stop(id, mode); }
  enqueueStdin(id, text, source, _onDeliver, _opts, kind) {
    this.enqueued.push({ id, text, kind });
    return { delivered: true };
  }
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
  // recycle-manager-halted-successor-dies.mjs's own identical reasoning), so every scenario below that
  // delivers SessionStart can assert `hasReachedReady` immediately, no polling needed for readiness itself.
  db.setProjectConfig(id, { permission: { startupModeCycles: 0 } });
}

/** Seeds a live worker onto `managerId` (mirrors recycle-manager-halted-successor-dies.mjs's own helper,
 *  minus the wake — this file forces the "wakes" step to fail directly via the stub, not via data shape). */
function seedFleet(db, projectId, managerId) {
  const now = new Date().toISOString();
  const workerId = `${managerId}-worker`;
  db.insertTask({ id: `${managerId}-task`, projectId, title: "t", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: workerId, projectId, agentId: `${projectId}-mgr`, engineSessionId: "eng-w", title: null, cwd: repo, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: managerId, taskId: `${managerId}-task` });
  return { workerId };
}

/** Writes a real (empty) engine transcript file so `isDurablyResumable` reads true for a session carrying
 *  this `engineSessionId` (mirrors recycle-manager-halted-successor-dies.mjs's own identically-named helper). */
function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

const hasEvent = (db, id, kind) => db.listEventsForSession(id).some((e) => e.kind === kind);

/** Forces the "wakes" ownership-transfer step to fail permanently (mirrors
 *  recycle-manager-halted-successor-dies.mjs's own identically-named helper). Caller restores. */
function stubWakesPermanentFailure() {
  const original = Db.prototype.reparentWakes;
  Db.prototype.reparentWakes = function () { throw new Error("injected PERMANENT failure (recycle-reattempt test)"); };
  return () => { Db.prototype.reparentWakes = original; };
}

/** Forces ONLY the resolution-marker's own appendEvent call to fail — every other event (recycle_begin,
 *  recycle_complete, etc.) still writes normally, so setup/halt machinery is unaffected. Caller restores. */
function stubResolvedEventFailure() {
  const original = Db.prototype.appendEvent;
  Db.prototype.appendEvent = function (event) {
    if (event.kind === "recycle_ownership_transfer_resolved") {
      throw new Error("injected DB failure filing the resolution marker (recycle-reattempt test)");
    }
    return original.call(this, event);
  };
  return () => { Db.prototype.appendEvent = original; };
}

/** Forces ONLY the handoff nudge's own enqueueDurableMessage call to fail (a plain throw, not a landed
 *  PostEffectPersistError) — simulates enqueueDurableNudge's onOutcome reporting dispatched:false. Caller
 *  restores. */
function stubHandoffNudgeDispatchFailure() {
  const original = SessionService.prototype.enqueueDurableMessage;
  SessionService.prototype.enqueueDurableMessage = function (id, text, opts) {
    if (typeof text === "string" && text.includes("[loom:recycle-reattempt-resolved]")) {
      throw new Error("injected handoff nudge dispatch failure (recycle-reattempt test)");
    }
    return original.call(this, id, text, opts);
  };
  return () => { SessionService.prototype.enqueueDurableMessage = original; };
}

/** Halts a fresh M1->M2 lineage (wakes permanently failing) and returns both ids + the transferred workerId. */
async function haltedLineage(projectSuffix) {
  const { db, host, sessions } = makeHarness();
  const P = `rra-${projectSuffix}`;
  seedProject(db, P);
  const m1 = sessions.startManager(`${P}-mgr`);
  const { workerId } = seedFleet(db, P, m1.id);
  const unstub = stubWakesPermanentFailure();
  const m2 = await sessions.recycleManager(m1.id, `handoff — forcing a halt (${projectSuffix})`);
  unstub();
  if (!hasEvent(db, m2.id, "recycle_ownership_transfer_failed")) throw new Error(`setup failed to halt (${projectSuffix})`);
  return { db, host, sessions, m1, m2, workerId };
}

try {
  // ==================== (R0) REFUSE — a blank handoffNote ====================
  {
    const { sessions, m1 } = await haltedLineage("r0");
    let threw = null;
    try { await sessions.reattemptManagerOwnershipTransfer(m1.id, "   "); } catch (e) { threw = e; }
    check("(R0) refuses a blank handoffNote", threw && /handoffNote must not be blank/.test(threw.message));
  }

  // ==================== (R1) REFUSE — not a halted predecessor at all ====================
  {
    const { db, sessions } = makeHarness();
    const P = "rra-r1";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    let threw = null;
    try { await sessions.reattemptManagerOwnershipTransfer(m1.id, "a real handoff"); } catch (e) { threw = e; }
    check("(R1) refuses a never-recycled manager", threw && /not a halted recycle predecessor/.test(threw.message));
  }

  // ==================== (R2) REFUSE — successor exists but hasn't reached ready yet ====================
  {
    const { sessions, m1 } = await haltedLineage("r2");
    let threw = null;
    try { await sessions.reattemptManagerOwnershipTransfer(m1.id, "a real handoff"); } catch (e) { threw = e; }
    check("(R2) refuses when the named successor hasn't reached SessionStart yet", threw && /hasn't reached SessionStart/.test(threw.message));
  }

  // ==================== (R3a)/(R3b) successor DOWN — resumable vs not, shared setup helper ====================
  // Deliberately NOT "dies before ever reaching ready" — that shape is already covered by the EXISTING
  // f349f5cb onExit backstop + the in-process watchHaltedRecycleSuccessor (see
  // recycle-manager-halted-successor-dies.mjs scenario (A)), which races ahead of a manual call and leaves
  // nothing for recycle_reattempt's own branches to do. The gap these branches close is a successor that
  // reached ready — closing watchHaltedRecycleSuccessor's own watch window (it returns and stops watching
  // the instant hasReachedReady is observed) — and only died LATER, same daemon uptime: nothing automatic
  // is watching for that anymore.
  async function readyThenDiedLater(projectSuffix, { withTranscript, crashRecoveryDisabled = false }) {
    const { db, host, sessions } = makeHarness();
    const P = `rra-${projectSuffix}`;
    seedProject(db, P);
    if (crashRecoveryDisabled) {
      // Overwrite with BOTH keys (setProjectConfig REPLACES the whole override) — disables
      // isCrashRecoveryEligible's own maxAttempts<=0 gate, simulating "nothing will ever recover this
      // successor automatically" (also covers the exhausted-attempts / human-paused / disabled shapes the
      // reviewer named — they all resolve through the SAME predicate to the SAME false).
      db.setProjectConfig(P, { permission: { startupModeCycles: 0 }, orchestration: { crashRecoveryMaxAttempts: 0 } });
    }
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId } = seedFleet(db, P, m1.id);

    // Capture recycleManager's OWN internally-armed watchHaltedRecycleSuccessor call (mirrors
    // recycle-manager-halted-successor-dies.mjs scenario (A2)'s identical technique) — installed BEFORE
    // the halt, so this is the production-triggered call, not a second manual one racing it.
    let watchPromise;
    const originalWatch = SessionService.prototype.watchHaltedRecycleSuccessor;
    SessionService.prototype.watchHaltedRecycleSuccessor = function (...args) {
      watchPromise = originalWatch.apply(this, args);
      return watchPromise;
    };
    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, `handoff — forcing a halt, then the successor reaches ready and dies later (${projectSuffix})`);
    unstub();
    if (!hasEvent(db, m2.id, "recycle_ownership_transfer_failed")) throw new Error(`setup failed to halt (${projectSuffix})`);

    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    if (withTranscript) writeFakeTranscript(m2.cwd, engineSessionId);
    await watchPromise; // resolves the instant this loop's own next poll observes ready and returns — no timer
    SessionService.prototype.watchHaltedRecycleSuccessor = originalWatch;

    const m2Pty = host.handles.get(m2.id);
    m2Pty.kill(); // the successor dies LATER — nothing is watching for this anymore
    await waitUntil(() => host.isAlive(m2.id) === false);
    return { db, host, sessions, m1, m2, workerId };
  }

  // ========= (R3a) ROUND 2 — REFUSE: successor down but DURABLY RESUMABLE, crash recovery ELIGIBLE =========
  {
    const { db, host, sessions, m1, m2 } = await readyThenDiedLater("r3a", { withTranscript: true });
    let threw = null;
    try { await sessions.reattemptManagerOwnershipTransfer(m1.id, "a real handoff"); } catch (e) { threw = e; }
    check("(R3a) FIX dfc3b014 ROUND 2: refuses a resumable-down successor rather than reclaiming it", threw && /down but resumable/.test(threw.message));
    check("(R3a) ROUND 3: crash recovery IS eligible (default config) — says so truthfully", threw && /automatic recovery, then retry/.test(threw.message));
    check("(R3a) ROUND 3: does NOT tell the caller to escalate when recovery is genuinely still pending", threw && !/escalate/.test(threw.message));
    check("(R3a) M1 was NOT touched by a refused call — still live", host.isAlive(m1.id) === true);
    check("(R3a) hasSuccessor(M1) is UNCHANGED — nothing was reclaimed/unlinked", db.hasSuccessor(m1.id) === true);
    check("(R3a) M2 was NOT archived by the refusal", !db.getSession(m2.id)?.archivedAt);
  }

  // === (R3a-ii) ROUND 3 — REFUSE: successor down + resumable, but crash recovery will NEVER attempt it ===
  {
    const { db, host, sessions, m1, m2 } = await readyThenDiedLater("r3a2", { withTranscript: true, crashRecoveryDisabled: true });
    let threw = null;
    try { await sessions.reattemptManagerOwnershipTransfer(m1.id, "a real handoff"); } catch (e) { threw = e; }
    check("(R3a-ii) FIX ROUND 3: still refuses (never reclaims a resumable successor)", threw && /down and resumable/.test(threw.message));
    check("(R3a-ii) ROUND 3: truthfully says nothing will recover it automatically", threw && /nothing will recover it automatically/.test(threw.message));
    check("(R3a-ii) ROUND 3: names the human-escalation remedy, including the successor id", threw && threw.message.includes(`escalate: a human must resume successor ${m2.id.slice(0, 8)}`));
    check("(R3a-ii) ROUND 3: does NOT dangle the dead-end \"wait for its automatic recovery\" promise", threw && !/automatic recovery, then retry/.test(threw.message));
    check("(R3a-ii) M1 was NOT touched by a refused call — still live", host.isAlive(m1.id) === true);
    check("(R3a-ii) hasSuccessor(M1) is UNCHANGED — nothing was reclaimed/unlinked", db.hasSuccessor(m1.id) === true);
    check("(R3a-ii) M2 was NOT archived by the refusal", !db.getSession(m2.id)?.archivedAt);
  }

  // ==================== (R3b) RECLAIM — successor down and NOT durably resumable ====================
  {
    const { db, host, sessions, m1, m2, workerId } = await readyThenDiedLater("r3b", { withTranscript: false });
    check("(R3b pre) hasSuccessor(M1) is STILL true — nothing automatic reclaimed this", db.hasSuccessor(m1.id) === true);

    const result = await sessions.reattemptManagerOwnershipTransfer(m1.id, "a real handoff");
    check("(R3b) outcome is 'reclaimed'", result.outcome === "reclaimed" && result.successorId === m2.id);
    check("(R3b) the worker (which DID transfer) is reclaimed back onto M1", db.getSession(workerId)?.parentSessionId === m1.id);
    check("(R3b) M1 was NEVER stopped — still alive", host.isAlive(m1.id) === true);
    check("(R3b) hasSuccessor(M1) is now false (M2 unlinked)", db.hasSuccessor(m1.id) === false);
    check("(R3b) M2 is archived", !!db.getSession(m2.id)?.archivedAt);

    // Closes the "halted-predecessor-can't-recycle" gap: M1's hasSuccessor guard now reads false, so an
    // ORDINARY recycleManager call (the pre-existing, UNCHANGED guard) succeeds again.
    const m3 = await sessions.recycleManager(m1.id, "M1 can recycle again now that it owns nothing split");
    check("(R3b) FIX: M1 can recycle again — recycleManager no longer throws 'already recycled'", !!m3 && m3.id !== m1.id);
    check("(R3b) the new recycle is a CLEAN one — no halt event fires for it", !hasEvent(db, m3.id, "recycle_ownership_transfer_failed"));
  }

  // ==================== (R4) RESOLVED — successor alive+ready, retry now clean ====================
  {
    const { db, host, sessions, m1, m2, workerId } = await haltedLineage("r4");
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-r4" });
    check("(R4 pre) M2 reached real ready via a genuine SessionStart hook", host.hasReachedReady(m2.id) === true);

    // The forced failure is LIFTED before retrying — this is the "fixed, try again" shape the tool exists for.
    const result = await sessions.reattemptManagerOwnershipTransfer(m1.id, "R4 handoff — ownership is whole now");
    check("(R4) outcome is 'resolved'", result.outcome === "resolved" && result.successorId === m2.id);

    // ROUND 2 (Code Review MAJOR): the response must reach the caller BEFORE the predecessor is actually
    // stopped — proving the implementation no longer AWAITS settleRecycleHandoff. The flush-delay floor
    // (20ms, env-shortened above) hasn't elapsed in the same tick the awaited call above resolved in, so
    // this is a deterministic, not a lucky-timing, assertion.
    check("(R4) FIX ROUND 2: the response reached the caller BEFORE the predecessor was stopped (no longer awaited)", !host.stoppedIds.has(m1.id));

    // The handoff nudge's OWN dispatch is itself gated on `waitForMcpSeen` (enqueueDurableNudge's orchestration-
    // MCP branch) — asynchronous relative to this call's return by construction, so assert its EVENTUAL
    // delivery rather than instantaneous presence; the ordering guarantee under test is "handoff was queued
    // before the irreversible stop was fired" (proven by the code: the nudge call sits textually before the
    // unawaited settle call), not "has already landed in the host by the time we check".
    const handoffDelivered = await waitUntil(() => host.enqueued.some((e) =>
      e.id === m2.id && e.text.includes("[loom:recycle-reattempt-resolved]") && e.text.includes("R4 handoff — ownership is whole now")));
    check("(R4) FIX ROUND 2: the handoff was delivered to the successor", handoffDelivered);

    const stoppedEventually = await waitUntil(() => host.stoppedIds.has(m1.id));
    check("(R4) the predecessor IS eventually stopped (settle still fires, just not awaited)", stoppedEventually);
    check("(R4) recycled_from is left INTACT — hasSuccessor(M1) stays true", db.hasSuccessor(m1.id) === true);
    check("(R4) the resolution marker was filed, naming the successor + gen", db.listEventsForSession(m1.id).some((e) =>
      e.kind === "recycle_ownership_transfer_resolved" && e.managerSessionId === m2.id && e.detail?.successorId === m2.id));
    check("(R4) currentHaltedSuccessor is now undefined — no longer an unresolved halt", currentHaltedSuccessor(db, m1.id) === undefined);
    check("(R4) FIX: isSupersededByRecycle(M1) reads true going forward — ordinary retired-predecessor semantics", isSupersededByRecycle(db, m1.id) === true);
    check("(R4) the worker stays correctly parented to M2", db.getSession(workerId)?.parentSessionId === m2.id);
  }

  // === (R4b) ROUND 3 — the resolution marker FAILS to file: refuse, never stop, never fire settle =======
  {
    const { db, host, sessions, m1, m2, workerId } = await haltedLineage("r4b");
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-r4b" });

    const unstubResolved = stubResolvedEventFailure();
    let threw = null;
    try { await sessions.reattemptManagerOwnershipTransfer(m1.id, "R4b handoff — never actually delivered"); } catch (e) { threw = e; }
    unstubResolved();

    check("(R4b) FIX ROUND 3: the call REFUSES when the resolution marker fails to file", threw && /recording the resolution failed/.test(threw.message));
    // The throw happens synchronously BEFORE the handoff nudge or the settle call — nothing async to race,
    // so these are deterministic, not a timing guess.
    check("(R4b) the predecessor was NOT stopped", !host.stoppedIds.has(m1.id) && host.isAlive(m1.id) === true);
    check("(R4b) settle never fired — no recycle_fleet_resolved/recovered event, M2 untouched (not archived)",
      db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_resolved" || e.kind === "recycle_fleet_recovered").length === 0
      && !db.getSession(m2.id)?.archivedAt);
    check("(R4b) no handoff nudge was delivered to the successor", !host.enqueued.some((e) => e.id === m2.id && e.text.includes("[loom:recycle-reattempt-resolved]")));
    check("(R4b) the worker transfer itself DID succeed (ownership-transfer ran before the marker write)", db.getSession(workerId)?.parentSessionId === m2.id);
    check("(R4b) currentHaltedSuccessor STILL matches — the lineage is still correctly reported as an unresolved halt", currentHaltedSuccessor(db, m1.id)?.id === m2.id);
    check("(R4b) no resolution marker exists at all", !hasEvent(db, m1.id, "recycle_ownership_transfer_resolved"));
  }

  // === (R4c) Nit item 3 — the handoff nudge itself fails to dispatch: outcome is UNAFFECTED, recorded ===
  {
    const { db, host, sessions, m1, m2, workerId } = await haltedLineage("r4c");
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-r4c" });

    const unstubNudge = stubHandoffNudgeDispatchFailure();
    const result = await sessions.reattemptManagerOwnershipTransfer(m1.id, "R4c handoff — dispatch will fail");
    // Do NOT unstub yet: enqueueDurableNudge's own dispatch is gated behind waitForMcpSeen (asynchronous
    // relative to this call's return — see R4's identical note), so the stub must stay installed until
    // that delayed dispatch has actually had its chance to fire and throw.
    check("(R4c) outcome is STILL 'resolved' — the handoff nudge's own dispatch failure never blocks it", result.outcome === "resolved");
    const recorded = await waitUntil(() => db.listEventsForSession(m1.id).some((e) =>
      e.kind === "recycle_reattempt_handoff_undelivered" && e.managerSessionId === m2.id && e.detail?.successorId === m2.id));
    unstubNudge();
    check("(R4c) FIX item 3: a recycle_reattempt_handoff_undelivered event was recorded", recorded);
    check("(R4c) the resolution marker is UNAFFECTED by the nudge failure", hasEvent(db, m1.id, "recycle_ownership_transfer_resolved"));
    const stoppedEventually = await waitUntil(() => host.stoppedIds.has(m1.id));
    check("(R4c) the predecessor is still eventually stopped — settle is UNAFFECTED by the nudge failure", stoppedEventually);
    check("(R4c) the worker stays correctly parented to M2", db.getSession(workerId)?.parentSessionId === m2.id);
  }

  // ==================== (R5) STILL-SPLIT — successor alive+ready, forced failure STILL active ====================
  {
    const { db, host, sessions, m1, m2 } = await haltedLineage("r5");
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-r5" });

    const unstub = stubWakesPermanentFailure(); // the SAME failure is still live for this retry
    const result = await sessions.reattemptManagerOwnershipTransfer(m1.id, "unused — still-split never delivers a handoff");
    unstub();
    check("(R5) outcome is 'still-split', naming the still-failing step", result.outcome === "still-split" && result.failedSteps.includes("wakes"));
    check("(R5) M1 was NOT stopped — still live", host.isAlive(m1.id) === true && !host.stoppedIds.has(m1.id));
    check("(R5) hasSuccessor(M1) stays true", db.hasSuccessor(m1.id) === true);
    check("(R5) currentHaltedSuccessor STILL matches — the retry itself never resolves or corrupts the halt", currentHaltedSuccessor(db, m1.id)?.id === m2.id);
    check("(R5) an audit-only recycle_reattempt_failed event was filed (never the *_failed halt kind again)",
      db.listEventsForSession(m1.id).some((e) => e.kind === "recycle_reattempt_failed" && e.detail?.failedSteps?.includes("wakes")));
    check("(R5) no SECOND recycle_ownership_transfer_failed event was filed by the retry itself",
      db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_ownership_transfer_failed").length === 1);
    check("(R5) no handoff was delivered to the successor — still-split never hands anything off",
      !host.enqueued.some((e) => e.id === m2.id && e.text.includes("[loom:recycle-reattempt-resolved]")));
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recycle_reattempt refuses a blank handoffNote, a non-halted or not-yet-ready caller, and a resumable-down successor (truthfully naming automatic recovery when it's genuinely pending, or a human-escalation remedy naming the successor when it's not); reclaims onto the predecessor only when the successor is confirmed dead AND not durably resumable (closing the halted-predecessor-can't-recycle gap); and — when the successor is alive+ready — either settles forward (resolution marker filed first and never swallowed, handoff delivered, response returned BEFORE the predecessor is actually stopped, a failed handoff dispatch recorded but never blocking) + files the recycle_ownership_transfer_resolved marker, or, if still failing, leaves the predecessor untouched with an audit-only event and no handoff sent."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
