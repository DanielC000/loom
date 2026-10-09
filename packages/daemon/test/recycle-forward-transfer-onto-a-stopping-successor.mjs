import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1e5dd7c4 — the FORWARD-transfer half of the same question card fcf8a0f8 answered for the RECLAIM
// half: does a manager recycle's ownership handoff onto a SUCCESSOR whose own `stop()` is in flight ever
// get gated on `isStopping`? fcf8a0f8 ruled "never gate" for the dead-successor RECLAIM branch inside
// `recoverFleetAfterFailedRecycleSuccessor`. THIS card's own end-state comparison comes out the OPPOSITE
// way for ONE specific decision point: `reattemptManagerOwnershipTransfer`'s own pre-check, refusing to
// even BEGIN a forward transfer onto a successor that is alive+ready but also mid-stop. Refusing there
// commits to NOTHING NEW (the predecessor is still the live, untouched owner, and nothing was ever
// reparented onto the doomed successor in the first place) — see docs/decisions/
// 1e5dd7c4-forward-transfer-onto-a-stopping-successor.md for the full comparison, INCLUDING a Code Review
// round (`d2a1fdcf`) that found gating the SHARED `settleRecycleHandoff` chokepoint the same way is
// actively HARMFUL: `isStopping` is a MONOTONIC latch, so gating the "stop the predecessor now" decision
// on it permanently misroutes a successor that was EVER stopped — even one that reached ready and ran
// real turns — into the dead-successor recovery branch, which archives it, marks it resumability "dead",
// and stamps a false "never reached ready" reason, DESTROYING real context instead of leaving it
// stopped-but-resumable. That settle-path gate was reverted; `settleRecycleHandoff` is UNCHANGED from
// main. Do NOT re-add it, and do NOT "fix" this file to match fcf8a0f8, or fcf8a0f8's own file to match
// this one — they are deliberately different answers, and this file itself holds two different answers
// (refuse at the reattempt pre-check; never gate the settle path) for a reason stated in the record.
//
// Proves:
//   (G1) GATE THROWS, NO MUTATION — `reattemptManagerOwnershipTransfer`'s own pre-check: a halted
//        predecessor's successor has reached SessionStart (ready) but its own hard stop is ALREADY in
//        flight (not yet exited) — the call throws "currently stopping", and NOTHING is mutated: the
//        worker stays exactly where the halted setup left it, the predecessor is never touched/stopped,
//        no ownership-transfer/resolution event is filed, no handoff is delivered.
//   (G2) AFTER THE EXIT LANDS WITH NO REAL CONTEXT, THE NEXT REATTEMPT RECLAIMS CLEANLY — continuing from
//        (G1): once the successor's already-in-flight stop actually completes (`isAlive` flips false)
//        and it never completed a turn (`turnSeq === 0` — no real context to lose), the VERY NEXT
//        `reattempt` call takes the pre-existing `!isAlive` branch and reclaims everything back onto the
//        (never-stopped) predecessor — zero downtime end to end.
//   (G2b) THE SAME EXIT, BUT WITH REAL CONTEXT — "self-resolves" is NOT universal: a successor that DID
//        complete a real turn (`turnSeq > 0`) before its already-in-flight stop lands is NOT reclaimed —
//        the pre-existing (`09b14f15`) turnSeq/resumability gate inside the `!isAlive` branch REFUSES
//        with "escalate: a human must resume successor…" instead, exactly as it already does for any
//        other intended-stop death. What stays true regardless of which branch fires: the predecessor is
//        NEVER touched or stopped by the refused forward-transfer call, in either case — zero downtime is
//        about the PREDECESSOR, not a guarantee that recovery is always automatic.
//   (G3) THE SHARED CHOKEPOINT IS **UNCHANGED** AND MUST STAY THAT WAY — `settleRecycleHandoff` (used by
//        the ORDINARY `recycleManager`/`recyclePlatformLead` recycle) still stops the predecessor the
//        instant `hasReachedReady(freshId)` reads true, exactly like before this card, even when that
//        same successor is ALSO concurrently mid-stop: a ready successor that completed a real turn and
//        is then stopped (by anything) is NEVER archived, NEVER marked resumability "dead", and NEVER
//        unlinked/reclaimed once it actually exits — its real context (the fleet it owns) stays with it,
//        preserved exactly like an ordinary intended-stop-after-ready manager (@decision 6cd3ce9e). This
//        is the REGRESSION GUARD for Code Review `d2a1fdcf`'s own finding — it must go RED if anyone
//        re-adds an `isStopping` check to this loop's `hasReachedReady` condition.
//
// RED-ON-MAIN PROOF (G1) — done by hand before this file was committed, not re-run automatically: with
// the `isStopping` pre-check in `reattemptManagerOwnershipTransfer` reverted (the code as it existed
// before card 1e5dd7c4), this file's (G1) block goes RED — the call no longer throws, the worker IS
// reparented onto the stopping successor, and (once that successor's guaranteed exit lands) the
// predecessor ends up archived instead of remaining the live owner. See the worker_report for this card
// for the actual revert/rebuild/retest/restore transcript.
//
// RED-ON-THE-REVERTED-CR-ROUND PROOF (G3) — also done by hand (negative-control.mjs can't isolate one
// condition inside a larger diff): with `settleRecycleHandoff`'s `hasReachedReady(freshId)` condition
// temporarily changed BACK to `hasReachedReady(freshId) && !isStopping(freshId)` (the harmful shape Code
// Review `d2a1fdcf` found and this card's own revert removed), this file's (G3) block goes RED — M2 ends
// up archived with resumability "dead" instead of staying resumable with its real context intact. See the
// worker_report for this card for the actual revert/rebuild/retest/restore transcript.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService + PtyHost driven against a fake
// low-level pty whose kill() deliberately does NOT fire the 'exit' callback itself (mirrors
// recycle-fleet-reclaim-onto-stopping-predecessor.mjs's own makeFakePty) — the shared
// _seam-host-fixture.mjs default pty fires 'exit' SYNCHRONOUSLY inside kill(), which would never leave
// the "ready AND stopping, not yet exited" window open long enough to observe.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-forward-transfer-onto-a-stopping-successor.mjs
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

const tmpHome = path.join(os.tmpdir(), `loom-1e5dd7c4-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every settle bound BEFORE importing dist/** (mirrors recycle-reattempt.mjs's own convention).
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = "20";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = "10";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = "3600000";
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25"; // enqueueDurableNudge's usesOrchestrationMcp gate (waitForMcpSeen)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { currentHaltedSuccessor } = await import("../dist/orchestration/crash-orphaned-workers.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");

/** Writes a real (empty) engine transcript file so `isDurablyResumable` reads true for a session carrying
 *  this `engineSessionId` (mirrors recycle-reattempt.mjs's own identically-named helper). */
function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

// Mirrors recycle-fleet-reclaim-onto-stopping-predecessor.mjs's own makeFakePty: kill() flips an exposed
// `isKilled` flag (which flows into the real Live.killed/stopping via the real stop()/
// escalateGracefulStop) but never calls `exitCb` itself — the test decides when the async 'exit' lands.
const fakes = new Map(); // sessionId -> fake low-level pty handle
function makeFakePty(sessionId) {
  let exitCb = null;
  const fake = {
    pid: 4242 + fakes.size,
    isKilled: false,
    write: () => {},
    onData: () => ({ dispose() {} }),
    onExit: (cb) => { exitCb = cb; return { dispose() {} }; },
    kill: () => { fake.isKilled = true; },
    resize: () => {},
    fireExit: (code) => { if (exitCb) exitCb({ exitCode: code ?? 0 }); },
  };
  fakes.set(sessionId, fake);
  return fake;
}

class TestPtyHost extends PtyHost {
  // Same reasoning as recycle-fleet-reclaim-onto-stopping-predecessor.mjs's own overrides: this fixture's
  // fake pty uses fictional pids — never let any of these reach a real OS-wide process-tree operation.
  sweepOrphanedDescendants(_rootPid) {}
  reapExitedDescendants(_rootPid) {}
  async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
  killRoot(_pid) {}
  async captureRootCreationRow(_pid) { return null; }
  createPty(opts) { return makeFakePty(opts.sessionId); }

  stoppedIds = new Set(); // mirrors recycle-reattempt.mjs's own SeamHost — records every stop() CALL, independent of isAlive timing
  stop(id, mode) { this.stoppedIds.add(id); return super.stop(id, mode); }

  enqueued = []; // mirrors recycle-reattempt.mjs's own SeamHost — captures enqueueDurableNudge's live-delivery path
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
  const host = new TestPtyHost(events);
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
  const repo = path.join(tmpHome, `repo-${id}`);
  fs.mkdirSync(repo, { recursive: true });
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  // markReady must run SYNCHRONOUSLY off a single SessionStart hook delivery (mirrors
  // recycle-reattempt.mjs/recycle-manager-fleet-recovery.mjs's own identical reasoning).
  db.setProjectConfig(id, { permission: { startupModeCycles: 0 } });
}

function seedFleet(db, projectId, managerId) {
  const now = new Date().toISOString();
  const workerId = `${managerId}-worker`;
  db.insertTask({ id: `${managerId}-task`, projectId, title: "t", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: workerId, projectId, agentId: `${projectId}-mgr`, engineSessionId: "eng-w", title: null, cwd: db.getProject(projectId).repoPath, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: managerId, taskId: `${managerId}-task` });
  return { workerId };
}

const hasEvent = (db, id, kind) => db.listEventsForSession(id).some((e) => e.kind === kind);

/** Forces the "wakes" ownership-transfer step to fail permanently (mirrors recycle-reattempt.mjs's own
 *  identically-named helper) — the cheapest way to force a genuinely halted lineage. Caller restores. */
function stubWakesPermanentFailure() {
  const original = Db.prototype.reparentWakes;
  Db.prototype.reparentWakes = function () { throw new Error("injected PERMANENT failure (1e5dd7c4 test)"); };
  return () => { Db.prototype.reparentWakes = original; };
}

try {
  // ============ (G1)/(G2) reattemptManagerOwnershipTransfer's own pre-check =================
  let db, host, sessions, m1, m2, workerId;
  {
    ({ db, host, sessions } = makeHarness());
    const P = "1e5dd7c4-g";
    seedProject(db, P);
    m1 = sessions.startManager(`${P}-mgr`);
    ({ workerId } = seedFleet(db, P, m1.id));

    const unstub = stubWakesPermanentFailure();
    m2 = await sessions.recycleManager(m1.id, "handoff — forcing a halt so the forward branch is reachable");
    unstub();
    if (!hasEvent(db, m2.id, "recycle_ownership_transfer_failed")) throw new Error("setup failed to halt the lineage");
    check("(G setup) the worker DID transfer onto M2 (the halted step was only 'wakes')", db.getSession(workerId)?.parentSessionId === m2.id);

    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: `eng-${m2.id}` });
    check("(G setup) M2 has reached SessionStart (ready)", host.hasReachedReady(m2.id) === true);

    host.stop(m2.id, "hard"); // M2's own stop is now in flight — kill() called, but the fake never fires 'exit' on its own
    check("(G setup) M2 is alive+ready+STOPPING — the exact window under test", host.isAlive(m2.id) === true && host.isStopping(m2.id) === true && host.hasReachedReady(m2.id) === true);

    // ---- (G1) GATE THROWS, NO MUTATION ----
    let threw = null;
    try { await sessions.reattemptManagerOwnershipTransfer(m1.id, "a real handoff"); } catch (e) { threw = e; }
    check("(G1) FIX 1e5dd7c4: refuses with 'currently stopping', never proceeds", threw && /currently stopping/.test(threw.message));
    check("(G1) NO MUTATION: the worker is untouched — still on M2, not re-reparented anywhere", db.getSession(workerId)?.parentSessionId === m2.id);
    check("(G1) NO MUTATION: M1 was never touched by the refused call — still live, never stopped", host.isAlive(m1.id) === true && !host.stoppedIds.has(m1.id));
    check("(G1) NO MUTATION: no recycle_ownership_transfer_resolved event was filed", !hasEvent(db, m1.id, "recycle_ownership_transfer_resolved"));
    check("(G1) NO MUTATION: no recycle_reattempt_failed event was filed (this isn't a still-split retry)", !hasEvent(db, m1.id, "recycle_reattempt_failed"));
    check("(G1) NO MUTATION: no handoff was delivered to the successor", !host.enqueued.some((e) => e.id === m2.id && e.text.includes("[loom:recycle-reattempt-resolved]")));
    check("(G1) NO MUTATION: the lineage is still correctly reported as an unresolved halt", currentHaltedSuccessor(db, m1.id)?.id === m2.id);
  }

  // ---- (G2) NO REAL CONTEXT (turnSeq===0) — THE NEXT REATTEMPT RECLAIMS CLEANLY ----
  {
    fakes.get(m2.id).fireExit(0); // the successor's already-in-flight stop finally lands
    await waitUntil(() => host.isAlive(m2.id) === false);
    check("(G2 setup) M2 is now confirmed dead", host.isAlive(m2.id) === false);
    check("(G2 setup) M2 never completed a turn — turnSeq is 0", (db.getSession(m2.id)?.turnSeq ?? 0) === 0);

    const result = await sessions.reattemptManagerOwnershipTransfer(m1.id, "a real handoff — retried after the successor finally died");
    check("(G2) RECLAIMS cleanly on the very next attempt (no real context to lose)", result.outcome === "reclaimed" && result.successorId === m2.id);
    check("(G2) the worker (which transferred at recycle time) is reclaimed back onto M1", db.getSession(workerId)?.parentSessionId === m1.id);
    check("(G2) M1 was NEVER stopped, end to end — zero downtime", host.isAlive(m1.id) === true && !host.stoppedIds.has(m1.id));
    check("(G2) hasSuccessor(M1) is now false (M2 unlinked)", db.hasSuccessor(m1.id) === false);
    check("(G2) M2 is archived", !!db.getSession(m2.id)?.archivedAt);
  }

  // ======= (G2b) WITH REAL CONTEXT (turnSeq>0) — "self-resolves" is NOT universal =======
  // A SEPARATE lineage: the successor DOES complete a real turn before dying, so the pre-existing
  // (card 09b14f15) turnSeq/resumability gate inside the SAME `!isAlive` branch REFUSES with "escalate"
  // instead of reclaiming — mirrors recycle-reattempt.mjs's own (R3a-iv): an intended stop (no crash
  // trigger ever recorded) with real context must escalate to a human, never reclaim (discarding it) and
  // never promise an automatic "wait" that nothing will ever honor.
  {
    const { db, host, sessions } = makeHarness();
    const P = "1e5dd7c4-g2b";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId } = seedFleet(db, P, m1.id);

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — forcing a halt, successor will complete a real turn then die");
    unstub();
    if (!hasEvent(db, m2.id, "recycle_ownership_transfer_failed")) throw new Error("(G2b) setup failed to halt the lineage");

    const engineSessionId = `eng-${m2.id}`;
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: engineSessionId });
    // A real engine id (already captured via deliverHook -> onEngineSessionId above) + a transcript file
    // (isDurablyResumable) + a completed turn (turnSeq>0) — real, worth-preserving context, unlike (G2)'s
    // m2 above.
    writeFakeTranscript(m2.cwd, engineSessionId);
    db.incrementTurnSeq(m2.id);
    check("(G2b setup) M2 completed a real turn — turnSeq > 0", (db.getSession(m2.id)?.turnSeq ?? 0) > 0);

    host.stop(m2.id, "hard"); // an intended stop — no crash trigger is ever recorded for it
    fakes.get(m2.id).fireExit(0);
    await waitUntil(() => host.isAlive(m2.id) === false);
    check("(G2b setup) M2 is now confirmed dead, with real context", host.isAlive(m2.id) === false);

    let threw = null;
    try { await sessions.reattemptManagerOwnershipTransfer(m1.id, "a real handoff — should never be delivered"); } catch (e) { threw = e; }
    check("(G2b) does NOT reclaim — refuses, escalating to a human instead of discarding real context", threw && /escalate: a human must resume successor/.test(threw.message));
    check("(G2b) the worker stays where it was (not reclaimed back onto M1 — nothing resolved yet)", db.getSession(workerId)?.parentSessionId === m2.id);
    check("(G2b) M1 was NEVER stopped — still the zero-downtime invariant, even though recovery here isn't automatic", host.isAlive(m1.id) === true && !host.stoppedIds.has(m1.id));
    check("(G2b) hasSuccessor(M1) is UNCHANGED — nothing was reclaimed/unlinked by the refusal", db.hasSuccessor(m1.id) === true);
    check("(G2b) M2 was NOT archived by the refusal — its real context is left exactly where a human can find it", !db.getSession(m2.id)?.archivedAt);
  }

  // === (G3) THE SHARED CHOKEPOINT IS UNCHANGED — settleRecycleHandoff never gates on isStopping ===
  {
    const { db, host, sessions } = makeHarness();
    const P = "1e5dd7c4-g3";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const { workerId } = seedFleet(db, P, m1.id);

    // A CLEAN (non-halted) recycle — attemptManagerOwnershipTransfer runs unconditionally right after
    // spawn, so the worker is already on M2 before this line returns.
    const m2 = await sessions.recycleManager(m1.id, "handoff — a clean recycle, then the successor completes a turn and is stopped by something unrelated");
    check("(G3 setup) recycleManager succeeded cleanly (no halt)", !hasEvent(db, m2.id, "recycle_ownership_transfer_failed"));
    check("(G3 setup) the worker transferred onto M2 at recycle time", db.getSession(workerId)?.parentSessionId === m2.id);

    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: `eng-${m2.id}` });
    db.incrementTurnSeq(m2.id); // M2 has REAL, completed-turn context by the time it's stopped below
    check("(G3 setup) M2 completed a real turn before being stopped", (db.getSession(m2.id)?.turnSeq ?? 0) > 0);

    host.stop(m2.id, "hard"); // simulates an UNRELATED stop landing on M2 right as it becomes ready
    check("(G3 setup) M2 is alive+ready+STOPPING, with real context, before settleRecycleHandoff's own background loop can act", host.isAlive(m2.id) === true && host.isStopping(m2.id) === true && host.hasReachedReady(m2.id) === true);

    // REGRESSION GUARD for Code Review d2a1fdcf: settleRecycleHandoff's background loop (armed internally
    // by recycleManager above) must stop M1 the INSTANT it observes M2 is ready — completely unaffected
    // by M2 also being mid-stop. If anyone re-adds an isStopping gate here, M1 is never stopped and this
    // assertion goes RED first.
    const stopped = await waitUntil(() => host.stoppedIds.has(m1.id));
    check("(G3) UNCHANGED FROM MAIN: M1 is stopped once M2 reaches ready, regardless of M2 also being mid-stop", stopped);

    // Now let M2's own guaranteed exit actually land.
    fakes.get(m2.id).fireExit(0);
    await waitUntil(() => host.isAlive(m2.id) === false);
    check("(G3) M2 is now confirmed dead too", host.isAlive(m2.id) === false);

    // Give the settle loop (if the harmful gate above ever made it still background-poll past this point
    // — under the FIX it already returned the instant `stopped` above resolved true, so this is a no-op
    // wait against nothing) its own poll interval (10ms) several times over to reach the dead-successor
    // branch and mutate M2, BEFORE asserting the mutation never happened — a positive, observable signal
    // (the recovery branch's own event), not a silent negative-only sleep: if the harmful gate is ever
    // re-added, this resolves true well inside the bound and the PRESERVED checks below correctly fail.
    await waitUntil(() => hasEvent(db, m1.id, "recycle_fleet_recovered") || hasEvent(db, m1.id, "recycle_fleet_unresolved"), { timeoutMs: 300 });

    // THE ACTUAL REGRESSION GUARD: M2's real, completed-turn context must survive — never archived, never
    // marked "dead", never unlinked/reclaimed. Reverting to the harmful isStopping-gated shape would route
    // this exact M2 into the dead-successor recovery branch instead, failing every check below.
    check("(G3) PRESERVED: M2 is NOT archived despite being stopped right after reaching ready with real context", !db.getSession(m2.id)?.archivedAt);
    check("(G3) PRESERVED: M2's resumability is NOT stamped 'dead'", db.getSession(m2.id)?.resumability !== "dead");
    check("(G3) PRESERVED: M2 keeps the fleet it owns — the worker stays parented to it, never reclaimed away", db.getSession(workerId)?.parentSessionId === m2.id);
    check("(G3) PRESERVED: hasSuccessor(M1) stays true — M2 was never unlinked", db.hasSuccessor(m1.id) === true);
    check("(G3) PRESERVED: no recycle_fleet_recovered/unresolved event fabricated for a genuinely-ready, context-bearing successor",
      db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered" || e.kind === "recycle_fleet_unresolved").length === 0);
    check("(G3) PRESERVED: M2's lastError carries the real orphaned-fleet banner (archiveOnExit's own live-worker skip), never a false 'recycle-failed'/'never reached SessionStart' reason",
      (db.getSession(m2.id)?.lastError ?? "").includes("[loom:orphaned-fleet]") && !(db.getSession(m2.id)?.lastError ?? "").includes("recycle-failed"));
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a forward transfer onto a successor whose own stop() is in flight is refused with no mutation at reattemptManagerOwnershipTransfer's own pre-check, self-resolving into a clean reclaim only when the successor never completed a real turn (escalating to a human instead when it did, never discarding real context) — while the SHARED settleRecycleHandoff chokepoint stays completely UNCHANGED from main, never gating on isStopping, so a ready successor's real context always survives being stopped, exactly as it always has."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
