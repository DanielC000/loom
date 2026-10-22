import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8d8a3647 — fix for Code Review f643b83a (item 3) of af165ec7
// ("fix(sessions): stop resume and fork minting a second live manager"), reasoned from source, then
// reproduced and ruled on in this same file's own history (see git log for the investigate-first repro).
//
// THE BUG (pre-fix): during an UNRESOLVED halted recycle A->B, nothing stopped the halted SUCCESSOR B from
// itself recycling to C — recycleManager only guarded `hasSuccessor(old)`, and hasSuccessor(B) is false (B
// has no successor of its own yet). currentHaltedSuccessor(A) kept returning B (A's own halt event is
// untouched by B's unrelated recycle), so af165ec7's one-hop `isSanctionedHaltedPartner(A, C)` was false —
// on the next boot, both A (via the halted carve-out, never superseded) and C (an ordinary live manager)
// were captured as resume targets, and whichever resumed SECOND was refused with SecondLiveManagerError.
//
// THE FIX (ruling (a), approved): `recycleManager` now refuses to recycle a session that is ITSELF a
// currently-unresolved halted recycle successor of some other predecessor — closing the hole at its root,
// one hop before it could ever widen, instead of trying to teach `isSanctionedHaltedPartner`/
// `currentHaltedSuccessor` to walk a multi-hop chain (which would reverse af165ec7's own deliberate
// "never a chain walk" decision). The refusal also files a durable, per-episode-deduped event + nudge to
// the PREDECESSOR (A), so a context-pressured B's blocked attempt doesn't depend on A happening to look.
//
// Proves:
//   (1) BLOCKED + DURABLE NUDGE + DEDUPE — B's self-recycle while A's halt is unresolved is refused; B is
//       left completely untouched (no teardown, no successor minted); A gets exactly ONE durable
//       `recycle_self_recycle_blocked` event + ONE `enqueueDurableNudge` call, even across TWO blocked
//       attempts by B (dedupe keyed on the blocked successor's own id — one nudge per episode).
//   (2) THE GUARD LIFTS once A's halt is resolved via `recycle_reattempt` (reattemptManagerOwnershipTransfer)
//       — B can then recycle freely.
//   (3) THE GUARD LIFTS once the halted successor dies and its fleet is reclaimed back onto the
//       predecessor (the existing watchHaltedRecycleSuccessor mechanism) — and, crucially, a BRAND NEW,
//       unrelated recycle lineage from the same predecessor afterward is never wrongly blocked by the
//       stale, already-resolved episode.
//   (4) END TO END — with the fix in place, B's self-recycle is blocked before C is ever minted, so the
//       downstream restart scenario the card describes (SecondLiveManagerError on whichever of {A, C}
//       resumes second) can no longer arise at all: a simulated restart finds the SAME sanctioned A/B
//       coexistence the system already knew how to handle (isSanctionedHaltedPartner(A,B) stays true).
//
// ROUND 2 — Code Review f643b83a of bd1a20e7 (this file's own prior commit) found the (1)-(4) guard above
// has a liveness hole: if the PREDECESSOR (A) dies while A->B is halted, B was TRAPPED forever — refused by
// (1)'s guard, yet unable to ask A for recycle_reattempt (which requires a LIVE predecessor), with no
// exit/stop/archive path ever filing a resolution. Pre-8d8a3647, B could still recycle in exactly this
// shape — so the (1)-(4) guard alone was a REGRESSION for a dead predecessor. Fixed by settling the split
// handoff FORWARD from B's own side (reusing attemptManagerOwnershipTransfer + attemptPendingQueueCarry +
// the recycle_ownership_transfer_resolved marker — the same primitives recycle_reattempt's own
// live-predecessor branch uses) whenever the predecessor isn't live, before deciding whether to proceed.
//
//   (5) PREDECESSOR CRASHES (pty killed) while halted, forward settle comes out CLEAN — B->C succeeds;
//       isSupersededByRecycle(A) flips true; a simulated restart resumes ONLY C — A is never a candidate
//       and nothing throws SecondLiveManagerError.
//   (6) PREDECESSOR HARD-STOPPED (stopSession "hard") while halted, forward settle CLEAN — same shape as
//       (5), proving the fix isn't keyed to one specific death mode (pty.isAlive is the only signal read).
//   (7) PREDECESSOR KILLED THEN ARCHIVED while halted, forward settle STILL SPLIT (the wakes stub stays
//       active) — B's self-recycle is refused with TEXT NAMING A and saying a human must RESUME it (never
//       "hard-stop it", which is what actually caused this hole); a human-visible `[loom:orphaned-fleet]`
//       lastError banner is raised on A (restoreSession un-archives it first, so the banner is actually
//       visible — mirrors this file's own stampStranded-style precedent); dedupes across a second attempt.
//       Also proves (ROUND 3 MINOR) a `recycle_reattempt_failed`/`detail.source:"forward-settle"` audit
//       event is filed on EACH still-split forward-settle attempt (not deduped — a repeat genuinely
//       re-tries the transfer), and that the refusal text's banner claim is truthful on both attempts.
//
// ROUND 3 — Code Review 9555e1ef (narrow re-review of bd1a20e7's round-2 commit) confirmed the round-2
// Critical stayed fixed, but found a MAJOR: the per-episode dedupe (round 2) keyed on `blockedSuccessorId`
// ALONE, so a LIVE-channel notification already on record silently suppressed the DEAD-channel banner the
// first time the same predecessor later died while still split — the refusal text kept unconditionally
// claiming "a banner has been raised" even though nothing had ever been stamped. Fixed by keying the
// dedupe on `(blockedSuccessorId, predecessorLive)` instead, and by making the refusal text's banner claim
// conditional on `notifyPredecessorOfBlockedSelfRecycle`'s own return value (whether a banner is actually
// confirmed present) rather than an unconditional assertion.
//
//   (8) LIVE THEN DEAD — a live blocked attempt (live-channel event + nudge, no banner) is followed by the
//       SAME predecessor dying+archiving while still split; a second (dead-channel) blocked attempt must
//       still stamp the banner — proving the live-channel event never again suppresses it — and the
//       refusal text is truthful on BOTH the first dead attempt (freshly stamped) and a THIRD, dead->dead
//       repeat attempt (already present, correctly not re-stamped, still truthfully claimed).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService against the fake pty seam,
// mirroring resume-halted-partner-exemption.mjs / recycle-manager-halted-successor-dies.mjs's own harnesses.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-halted-successor-self-recycles.mjs
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

const tmpHome = path.join(os.tmpdir(), `loom-rhssr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every settle bound BEFORE importing dist/** (mirrors every sibling halted-recycle file).
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = "40";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = "15";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = "3600000";
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { currentHaltedSuccessor, isSanctionedHaltedPartner, isSupersededByRecycle } = await import("../dist/orchestration/crash-orphaned-workers.js");

const repo = path.join(os.tmpdir(), `loom-rhssr-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# recycle-halted-successor-self-recycles test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rhssr@loom -c user.name=rhssr");

class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map();
  createPty(opts) {
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    return pty;
  }
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
}

function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

const hasEvent = (db, id, kind) => db.listEventsForSession(id).some((e) => e.kind === kind);

/** Forces the "wakes" ownership-transfer step to fail permanently, so recycleManager halts — mirrors
 *  recycle-manager-halted-successor-dies.mjs's own identical stub. Caller restores. */
function stubWakesPermanentFailure() {
  const original = Db.prototype.reparentWakes;
  Db.prototype.reparentWakes = function () { throw new Error("injected PERMANENT failure (recycle-halted-successor-self-recycles test)"); };
  return () => { Db.prototype.reparentWakes = original; };
}

/** Observes the REAL `enqueueDurableNudge` call arguments directly (mirrors
 *  recycle-manager-halted-successor-dies.mjs's own identical helper) — proves the dedupe at the actual
 *  notification chokepoint, not merely at the durable-event layer. Caller restores. */
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
  // ==================== (1) BLOCKED + DURABLE NUDGE + DEDUPE ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rhssr-1";
    seedProject(db, P);
    const a = sessions.startManager(`${P}-mgr`);
    host.deliverHook(a.id, { hook_event_name: "SessionStart", session_id: "eng-a1" });
    writeFakeTranscript(a.cwd, "eng-a1");

    const unstub = stubWakesPermanentFailure();
    const b = await sessions.recycleManager(a.id, "handoff A->B — forced halt");
    unstub();
    check("(1 pre) the A->B recycle HALTED, naming B", hasEvent(db, b.id, "recycle_ownership_transfer_failed"));
    check("(1 pre) A and B are both alive", host.isAlive(a.id) === true && host.isAlive(b.id) === true);
    check("(1 pre) isSanctionedHaltedPartner(A,B) is true while unresolved", isSanctionedHaltedPartner(db, db.getSession(a.id), db.getSession(b.id)) === true);

    const nudgeSpy = spyOnEnqueueDurableNudge();

    // First blocked attempt.
    let thrown1;
    try { await sessions.recycleManager(b.id, "handoff B->C attempt 1 — should be refused"); } catch (e) { thrown1 = e; }
    check("FIX (1a): recycleManager(B) is REFUSED while A's halt naming B is still unresolved",
      !!thrown1 && /unresolved \(halted\)/.test(thrown1.message));
    check("(1a) B itself is completely untouched — still live, still no successor of its own", host.isAlive(b.id) === true && db.hasSuccessor(b.id) === false);
    check("(1a) A's own halt event is untouched — currentHaltedSuccessor(A) still names B", currentHaltedSuccessor(db, a.id)?.id === b.id);

    const blockedOnA1 = db.listEventsForSession(a.id).filter((e) => e.kind === "recycle_self_recycle_blocked");
    check("FIX (1a): exactly ONE recycle_self_recycle_blocked event filed on A, naming B", blockedOnA1.length === 1 && blockedOnA1[0].detail?.blockedSuccessorId === b.id);
    const nudgesToA1 = nudgeSpy.calls.filter(([id]) => id === a.id);
    check("FIX (1a): exactly ONE durable nudge sent to A (the predecessor) for this episode", nudgesToA1.length === 1);

    // Second blocked attempt — same episode (B's id unchanged) — must dedupe.
    let thrown2;
    try { await sessions.recycleManager(b.id, "handoff B->C attempt 2 — still refused, must NOT re-nudge"); } catch (e) { thrown2 = e; }
    check("FIX (1b): a SECOND attempt by the same B is ALSO refused", !!thrown2 && /unresolved \(halted\)/.test(thrown2.message));
    const blockedOnA2 = db.listEventsForSession(a.id).filter((e) => e.kind === "recycle_self_recycle_blocked");
    check("FIX DEDUPE (1b): still exactly ONE recycle_self_recycle_blocked event (no duplicate filed)", blockedOnA2.length === 1);
    const nudgesToA2 = nudgeSpy.calls.filter(([id]) => id === a.id);
    check("FIX DEDUPE (1b): still exactly ONE durable nudge to A — the repeat attempt did not spam it", nudgesToA2.length === 1);

    nudgeSpy.restore();
  }

  // ==================== (2) THE GUARD LIFTS once A's halt resolves via recycle_reattempt ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rhssr-2";
    seedProject(db, P);
    // startupModeCycles:0 — markReady must run SYNCHRONOUSLY off the hook below (mirrors every sibling
    // halted-recycle scenario's own reasoning) — reattemptManagerOwnershipTransfer's "successor ready"
    // branch needs B durably ready, not merely alive.
    db.setProjectConfig(P, { permission: { startupModeCycles: 0 } });
    const a = sessions.startManager(`${P}-mgr`);

    const unstub = stubWakesPermanentFailure();
    const b = await sessions.recycleManager(a.id, "handoff A->B — forced halt, to be resolved below");
    unstub();
    check("(2 pre) the A->B recycle HALTED, naming B", hasEvent(db, b.id, "recycle_ownership_transfer_failed"));
    host.deliverHook(b.id, { hook_event_name: "SessionStart", session_id: "eng-b2" });
    writeFakeTranscript(b.cwd, "eng-b2");
    check("(2 pre) B reached real ready", host.hasReachedReady(b.id) === true);

    // Sanity: B is blocked before the resolution.
    let preThrown;
    try { await sessions.recycleManager(b.id, "handoff B->C — should still be refused before resolution"); } catch (e) { preThrown = e; }
    check("(2 pre) B's self-recycle is refused BEFORE A's halt is resolved", !!preThrown && /unresolved \(halted\)/.test(preThrown.message));

    // A resolves its own halt via recycle_reattempt — this stops A (the predecessor), leaving B as sole owner.
    const result = await sessions.reattemptManagerOwnershipTransfer(a.id, "fully resolved — everything transferred cleanly");
    check("(2) the reattempt RESOLVED", result?.outcome === "resolved");
    const aStopped = await waitUntil(() => host.isAlive(a.id) === false);
    check("(2) A was stopped by the resolved handoff (settleRecycleHandoff)", aStopped);
    check("(2) currentHaltedSuccessor(A) is now undefined — the episode is over", currentHaltedSuccessor(db, a.id) === undefined);

    // B can now recycle freely.
    let c;
    let postThrown;
    try { c = await sessions.recycleManager(b.id, "handoff B->C — now allowed, A's halt is resolved"); } catch (e) { postThrown = e; }
    check("FIX (2): B's self-recycle is now ALLOWED once A's halt is resolved", !postThrown && !!c);
  }

  // ==================== (3) THE GUARD LIFTS once the halted successor dies + is reclaimed, and a FRESH,
  // unrelated lineage afterward is never wrongly blocked by the stale (now-resolved) episode ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rhssr-3";
    seedProject(db, P);

    const a = sessions.startManager(`${P}-mgr`);

    const unstub = stubWakesPermanentFailure();
    const b = await sessions.recycleManager(a.id, "handoff A->B — forced halt, B will die before ready");
    unstub();
    check("(3 pre) the A->B recycle HALTED, naming B", hasEvent(db, b.id, "recycle_ownership_transfer_failed"));

    // Sanity: B is blocked before it dies.
    let preThrown;
    try { await sessions.recycleManager(b.id, "handoff B->C — should be refused while A's halt is unresolved"); } catch (e) { preThrown = e; }
    check("(3 pre) B's self-recycle is refused while still alive and unresolved", !!preThrown && /unresolved \(halted\)/.test(preThrown.message));

    // B dies before ever reaching ready — the EXISTING watchHaltedRecycleSuccessor reclaim mechanism
    // (armed from recycleManager's own halt branch) fires and reclaims B's fleet back onto A.
    const bPty = host.handles.get(b.id);
    bPty.kill();
    const reclaimed = await waitUntil(() => hasEvent(db, a.id, "recycle_fleet_recovered"));
    check("(3) B's death was reclaimed back onto A", reclaimed);
    check("(3) hasSuccessor(A) is false again after the reclaim", db.hasSuccessor(a.id) === false);
    check("(3) currentHaltedSuccessor(A) is now undefined — the old episode is fully resolved", currentHaltedSuccessor(db, a.id) === undefined);

    // A now starts a BRAND NEW, unrelated recycle lineage (A -> B2) — an ordinary recycle, no stub.
    const b2 = await sessions.recycleManager(a.id, "handoff A->B2 — a fresh, unrelated lineage after the reclaim");
    check("(3) the A->B2 recycle did NOT halt (clean ownership transfer)", !hasEvent(db, b2.id, "recycle_ownership_transfer_failed"));

    // B2 tries to self-recycle to C2 — this must NOT be blocked: A has no outstanding halt naming B2 (A's
    // only halt event ever filed named the now-dead, already-reclaimed B, a fully closed episode).
    let c2;
    let postThrown;
    try { c2 = await sessions.recycleManager(b2.id, "handoff B2->C2 — must be allowed, no outstanding halt"); } catch (e) { postThrown = e; }
    check("FIX (3): a FRESH successor (B2) of a fresh lineage is NOT wrongly blocked by the stale, already-resolved episode (naming the dead B)",
      !postThrown && !!c2);
  }

  // ==================== (4) END TO END — the downstream restart scenario the card describes can no
  // longer arise: B's self-recycle is blocked before C is ever minted ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rhssr-4";
    seedProject(db1, P);
    const a = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(a.id, { hook_event_name: "SessionStart", session_id: "eng-a4" });
    writeFakeTranscript(a.cwd, "eng-a4");

    const unstub = stubWakesPermanentFailure();
    const b = await sessions1.recycleManager(a.id, "handoff A->B — forced halt");
    unstub();
    check("(4 pre) the A->B recycle HALTED, naming B", hasEvent(db1, b.id, "recycle_ownership_transfer_failed"));
    host1.deliverHook(b.id, { hook_event_name: "SessionStart", session_id: "eng-b4" });
    writeFakeTranscript(b.cwd, "eng-b4");

    // The attempt that used to mint C is now refused outright — C never exists.
    let thrown;
    let c;
    try { c = await sessions1.recycleManager(b.id, "handoff B->C — must be refused end to end"); } catch (e) { thrown = e; }
    check("FIX (4): B's self-recycle is refused — C is never minted", !!thrown && !c);

    // Simulate the restart: ONLY A and B exist. isSanctionedHaltedPartner(A,B) is still true, so BOTH can
    // legitimately resume (the sanctioned coexistence window af165ec7 already designed for) — no
    // SecondLiveManagerError anywhere in this lineage.
    db1.close();
    const { db: db2, host: host2 } = makeBoot();
    const sessions2 = new SessionService(db2, host2, new OrchestrationControl());

    const aRow = db2.getSession(a.id), bRow = db2.getSession(b.id);
    check("(4) isSanctionedHaltedPartner(A,B) is still true after the simulated restart", isSanctionedHaltedPartner(db2, aRow, bRow) === true);

    // Wrapped (Code Review f643b83a NITPICK, round 2): on pre-fix code B's self-recycle at line 299 above
    // actually succeeds, minting a real C — so THIS resume(B) throws "session was recycled — a successor
    // exists" (B now has its own successor). An unwrapped call would abort the whole script uncaught,
    // silently skipping every check below instead of recording a clean, named FAIL.
    let bResumeThrew;
    try { sessions2.resume(b.id); } catch (e) { bResumeThrew = e; }
    check("(4) B resumes cleanly", !bResumeThrew && host2.isAlive(b.id) === true);
    if (bResumeThrew) console.log(`    (resume(B) threw: ${bResumeThrew.message})`);

    let aResumeThrew;
    if (!bResumeThrew) {
      try { sessions2.resume(a.id); } catch (e) { aResumeThrew = e; }
    }
    check("FIX (4): resuming A SECOND does NOT throw — the sanctioned A/B pair, not a stray third party, is what's live",
      !bResumeThrew && !aResumeThrew);
    check("(4) both A and B are now live — the genuinely-still-split lineage the system already knows how to handle",
      !bResumeThrew && host2.isAlive(a.id) === true && host2.isAlive(b.id) === true);
  }

  // ==================== (5) ROUND 2 CRITICAL FIX — predecessor CRASHES while halted; forward settle is
  // CLEAN; B->C succeeds; A never comes back alongside C at a later restart ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rhssr-5";
    seedProject(db1, P);
    const a = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(a.id, { hook_event_name: "SessionStart", session_id: "eng-a5" });
    writeFakeTranscript(a.cwd, "eng-a5");

    const unstub = stubWakesPermanentFailure();
    const b = await sessions1.recycleManager(a.id, "handoff A->B — forced halt, A then crashes");
    unstub(); // the wakes stub is OFF again — B's own forward settle (below) must succeed cleanly
    check("(5 pre) the A->B recycle HALTED, naming B", hasEvent(db1, b.id, "recycle_ownership_transfer_failed"));
    host1.deliverHook(b.id, { hook_event_name: "SessionStart", session_id: "eng-b5" });
    writeFakeTranscript(b.cwd, "eng-b5");

    // A CRASHES — the real onExit wiring (makeHarness) marks it exited synchronously, exactly like a real
    // node-pty's dead process would once the daemon's own exit handler runs.
    const aPty = host1.handles.get(a.id);
    aPty.kill();
    check("(5 setup) A is confirmed NOT alive (crashed)", host1.isAlive(a.id) === false);
    check("(5 setup) currentHaltedSuccessor(A) still names B — the crash alone resolves nothing", currentHaltedSuccessor(db1, a.id)?.id === b.id);

    // REGRESSION PROOF: pre-8d8a3647, B could still recycle here (nothing guarded this at all) — this
    // scenario is RED on bd1a20e7's own guard (which refuses UNCONDITIONALLY whenever the predecessor
    // isn't live, trapping B forever) and GREEN once the forward-settle branch is added.
    let c;
    let thrown;
    try { c = await sessions1.recycleManager(b.id, "handoff B->C — A is dead, forward settle should be clean"); } catch (e) { thrown = e; }
    check("FIX (5): B's self-recycle SUCCEEDS — the forward settle (from B's own side) resolved A's dead handoff cleanly", !thrown && !!c);
    if (thrown) console.log(`    (recycleManager(B) threw: ${thrown.message})`);

    if (c) {
      check("(5) the B->C recycle did NOT itself halt (A had nothing left to contribute)", !hasEvent(db1, c.id, "recycle_ownership_transfer_failed"));
      check("FIX (5): the recycle_ownership_transfer_resolved marker was filed for A's dead handoff", hasEvent(db1, a.id, "recycle_ownership_transfer_resolved"));
      check("FIX (5): currentHaltedSuccessor(A) is now undefined — resolved, not stuck naming dead B", currentHaltedSuccessor(db1, a.id) === undefined);
      check("FIX (5): isSupersededByRecycle(A) is now TRUE — no later boot/resume can bring A back next to C", isSupersededByRecycle(db1, a.id) === true);

      host1.deliverHook(c.id, { hook_event_name: "SessionStart", session_id: "eng-c5" });
      writeFakeTranscript(c.cwd, "eng-c5");

      // Simulate a LATER restart: C is resumed, then A is attempted — A must stay excluded and nothing
      // about this throws SecondLiveManagerError (the exact failure mode the card describes).
      db1.close();
      const { db: db2, host: host2 } = makeBoot();
      const sessions2 = new SessionService(db2, host2, new OrchestrationControl());
      check("FIX (5) post-restart: isSupersededByRecycle(A) still reads TRUE", isSupersededByRecycle(db2, a.id) === true);

      sessions2.resume(c.id);
      check("(5) C resumes cleanly", host2.isAlive(c.id) === true);
      // C was resumed FIRST (live) above, so resume(A) hits the ordinary second-live-manager scan before
      // it ever reaches isSupersededByRecycle — it throws SecondLiveManagerError(C) here, which is EXACTLY
      // as correct a refusal as the "superseded" message resume-A-alone would get (both are real, final
      // refusals; which one fires is purely a function of resume ORDER, not of whether the fix works) —
      // the load-bearing fact is isSupersededByRecycle(A)===true above, already proven, which is what
      // guarantees A is excluded NO MATTER which order a restart happens to resume things in.
      let aResumeThrew;
      try { sessions2.resume(a.id); } catch (e) { aResumeThrew = e; }
      check("FIX (5): resuming A is refused either way, and A stays dead", !!aResumeThrew && host2.isAlive(a.id) === false);
    }
  }

  // ==================== (6) ROUND 2 — predecessor HARD-STOPPED while halted; same clean-settle shape as
  // (5), proving the fix reads pty liveness, not one specific death mode ====================
  {
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
    const P = "rhssr-6";
    seedProject(db1, P);
    const a = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(a.id, { hook_event_name: "SessionStart", session_id: "eng-a6" });
    writeFakeTranscript(a.cwd, "eng-a6");

    const unstub = stubWakesPermanentFailure();
    const b = await sessions1.recycleManager(a.id, "handoff A->B — forced halt, A is then hard-stopped");
    unstub();
    check("(6 pre) the A->B recycle HALTED, naming B", hasEvent(db1, b.id, "recycle_ownership_transfer_failed"));
    host1.deliverHook(b.id, { hook_event_name: "SessionStart", session_id: "eng-b6" });
    writeFakeTranscript(b.cwd, "eng-b6");

    sessions1.stopSession(a.id, "hard");
    check("(6 setup) A is confirmed NOT alive (hard-stopped)", host1.isAlive(a.id) === false);

    let c;
    let thrown;
    try { c = await sessions1.recycleManager(b.id, "handoff B->C — A is hard-stopped, forward settle should be clean"); } catch (e) { thrown = e; }
    check("FIX (6): B's self-recycle SUCCEEDS after a hard-stopped (not merely crashed) predecessor", !thrown && !!c);
    if (thrown) console.log(`    (recycleManager(B) threw: ${thrown.message})`);
    if (c) {
      check("FIX (6): the recycle_ownership_transfer_resolved marker was filed", hasEvent(db1, a.id, "recycle_ownership_transfer_resolved"));
      check("FIX (6): isSupersededByRecycle(A) is now TRUE", isSupersededByRecycle(db1, a.id) === true);
    }
  }

  // ==================== (7) ROUND 2 — predecessor KILLED THEN ARCHIVED while halted; forward settle is
  // STILL SPLIT (the wakes stub stays on) — refused with ACCURATE text + a human-visible banner ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rhssr-7";
    seedProject(db, P);
    const a = sessions.startManager(`${P}-mgr`);
    host.deliverHook(a.id, { hook_event_name: "SessionStart", session_id: "eng-a7" });
    writeFakeTranscript(a.cwd, "eng-a7");

    const unstub = stubWakesPermanentFailure();
    const b = await sessions.recycleManager(a.id, "handoff A->B — forced halt, A then dies and is archived");
    check("(7 pre) the A->B recycle HALTED, naming B", hasEvent(db, b.id, "recycle_ownership_transfer_failed"));
    host.deliverHook(b.id, { hook_event_name: "SessionStart", session_id: "eng-b7" });
    writeFakeTranscript(b.cwd, "eng-b7");

    const aPty = host.handles.get(a.id);
    aPty.kill();
    db.archiveSession(a.id);
    check("(7 setup) A is confirmed NOT alive, and archived", host.isAlive(a.id) === false && !!db.getSession(a.id)?.archivedAt);
    // unstub is deliberately NEVER called in this scenario — the forward settle (attemptManagerOwnershipTransfer
    // A->B, inside the guard below) hits the SAME permanent "wakes" failure, so it stays genuinely split.

    let c;
    let thrown;
    try { c = await sessions.recycleManager(b.id, "handoff B->C — A is dead AND still split, must be refused"); } catch (e) { thrown = e; }
    // unstub() is deliberately held until AFTER the dedupe check below — the wakes stub must stay active
    // across BOTH attempts, or the SECOND one's own forward-settle would come out clean this time (a
    // different outcome than the first), making the dedupe check vacuous.
    check("FIX (7): B's self-recycle is REFUSED (still split, dead predecessor) — C is never minted", !!thrown && !c);
    check("FIX (7): the refusal text NAMES A", thrown?.message.includes(a.id.slice(0, 8)));
    check("FIX (7): the refusal text says a human must RESUME A", /human must RESUME/.test(thrown?.message ?? ""));
    check("FIX (7): the refusal text does NOT prescribe hard-stopping A (that is what caused this hole)", !/hard-stop/i.test(thrown?.message ?? ""));
    check("FIX (7): A's halt event is UNCHANGED — still naming B, still unresolved", currentHaltedSuccessor(db, a.id)?.id === b.id);

    const blockedEvents = db.listEventsForSession(a.id).filter((e) => e.kind === "recycle_self_recycle_blocked");
    check("FIX (7): exactly ONE recycle_self_recycle_blocked event, with predecessorLive:false", blockedEvents.length === 1 && blockedEvents[0].detail?.predecessorLive === false);

    const aRow = db.getSession(a.id);
    check("FIX (7): a human-visible [loom:orphaned-fleet] banner was raised on A", (aRow?.lastError ?? "").startsWith("[loom:orphaned-fleet]"));
    check("FIX (7): A was UN-ARCHIVED so the banner is actually visible on the live rail (mirrors stampStranded)", aRow?.archivedAt == null);
    check("(7) the refusal text truthfully claims the banner was raised (it was — first dead attempt)", /banner has been raised/.test(thrown?.message ?? ""));

    // ROUND 3 MINOR fix: the still-split forward settle itself filed its own durable audit trail, same
    // shape as recycle_reattempt_failed's own still-split branch, distinguished by detail.source.
    const forwardSettleEvents = db.listEventsForSession(a.id).filter((e) =>
      e.kind === "recycle_reattempt_failed" && e.detail?.source === "forward-settle");
    check("FIX ROUND 3 (MINOR): a recycle_reattempt_failed/source:'forward-settle' event was filed naming the failed step(s)",
      forwardSettleEvents.length === 1 && Array.isArray(forwardSettleEvents[0].detail?.failedSteps) && forwardSettleEvents[0].detail.failedSteps.includes("wakes"));

    // DEDUPE: a second blocked attempt by the SAME B must not file a second recycle_self_recycle_blocked
    // event. (The wakes stub is STILL active here — see the note above the first attempt.)
    let thrown2;
    try { await sessions.recycleManager(b.id, "handoff B->C attempt 2 — still refused, must NOT re-file"); } catch (e) { thrown2 = e; }
    unstub();
    check("FIX DEDUPE (7): a second attempt is ALSO refused", !!thrown2);
    check("FIX DEDUPE (7): the refusal text STILL truthfully claims the banner was raised (already present)", /banner has been raised/.test(thrown2?.message ?? ""));
    const blockedEvents2 = db.listEventsForSession(a.id).filter((e) => e.kind === "recycle_self_recycle_blocked");
    check("FIX DEDUPE (7): still exactly ONE recycle_self_recycle_blocked event", blockedEvents2.length === 1);
    // The forward-settle attempt itself is NOT deduped (it isn't the notification) — a second still-split
    // attempt genuinely re-tries the transfer and gets its own second audit entry.
    const forwardSettleEvents2 = db.listEventsForSession(a.id).filter((e) =>
      e.kind === "recycle_reattempt_failed" && e.detail?.source === "forward-settle");
    check("(7) a second forward-settle audit event was filed for the second still-split attempt", forwardSettleEvents2.length === 2);
  }

  // ==================== (8) ROUND 3 MAJOR FIX — the dedupe now keys on (blockedSuccessorId,
  // predecessorLive), never blockedSuccessorId alone: a LIVE blocked attempt (files the live-channel
  // event + nudge, no banner) followed by the SAME predecessor dying+archiving while STILL split must
  // NOT suppress the dead-channel banner on the next blocked attempt — the exact regression Code Review
  // 9555e1ef found on round 2's own commit (bd1a20e7's dedupe matched on blockedSuccessorId alone, so the
  // live-channel event already on record made the dead-channel attempt return early with nothing
  // stamped, while the refusal text unconditionally claimed a banner had been raised) ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rhssr-8";
    seedProject(db, P);
    const a = sessions.startManager(`${P}-mgr`);
    host.deliverHook(a.id, { hook_event_name: "SessionStart", session_id: "eng-a8" });
    writeFakeTranscript(a.cwd, "eng-a8");

    const unstub = stubWakesPermanentFailure();
    const b = await sessions.recycleManager(a.id, "handoff A->B — forced halt, A later dies while still split");
    check("(8 pre) the A->B recycle HALTED, naming B", hasEvent(db, b.id, "recycle_ownership_transfer_failed"));
    host.deliverHook(b.id, { hook_event_name: "SessionStart", session_id: "eng-b8" });
    writeFakeTranscript(b.cwd, "eng-b8");
    check("(8 pre) A is alive", host.isAlive(a.id) === true);

    // First blocked attempt — A is still LIVE — hits the live channel: a durable nudge, no banner.
    let thrownLive;
    try { await sessions.recycleManager(b.id, "handoff B->C attempt 1 (A still live) — must be refused"); } catch (e) { thrownLive = e; }
    check("(8a) B's self-recycle is refused while A is still live", !!thrownLive && /unresolved \(halted\)/.test(thrownLive.message));
    const liveEvents = db.listEventsForSession(a.id).filter((e) => e.kind === "recycle_self_recycle_blocked" && e.detail?.predecessorLive === true);
    check("(8a) exactly ONE live-channel recycle_self_recycle_blocked event filed", liveEvents.length === 1);
    check("(8a) no [loom:orphaned-fleet] banner yet — A is still live, nothing was stamped", !(db.getSession(a.id)?.lastError ?? "").startsWith("[loom:orphaned-fleet]"));

    // A now dies and is archived — still split (the wakes stub stays active throughout this scenario, so
    // the forward settle below hits the same permanent failure and never resolves cleanly).
    const aPty = host.handles.get(a.id);
    aPty.kill();
    db.archiveSession(a.id);
    check("(8 setup) A is confirmed NOT alive, and archived", host.isAlive(a.id) === false && !!db.getSession(a.id)?.archivedAt);

    // Second blocked attempt — A is now DEAD — must hit the DEAD channel and actually stamp the banner,
    // NOT be suppressed by the live-channel event already on record (THE REGRESSION this fix closes).
    let thrownDead;
    try { await sessions.recycleManager(b.id, "handoff B->C attempt 2 (A now dead) — must be refused, banner must be stamped"); } catch (e) { thrownDead = e; }
    check("FIX (8b): B's self-recycle is refused (still split, now-dead predecessor)", !!thrownDead);
    check("FIX (8b): the refusal text truthfully claims the banner was raised", /banner has been raised/.test(thrownDead?.message ?? ""));
    check("FIX (8b): the refusal text does NOT claim the banner could not be confirmed", !/could NOT be confirmed/.test(thrownDead?.message ?? ""));

    const aRowAfterDead = db.getSession(a.id);
    check("FIX (8b): a human-visible [loom:orphaned-fleet] banner WAS stamped on A — the prior live-channel event did NOT suppress it (the regression)",
      (aRowAfterDead?.lastError ?? "").startsWith("[loom:orphaned-fleet]"));
    check("FIX (8b): A was UN-ARCHIVED so the banner is visible", aRowAfterDead?.archivedAt == null);

    const deadEvents = db.listEventsForSession(a.id).filter((e) => e.kind === "recycle_self_recycle_blocked" && e.detail?.predecessorLive === false);
    check("FIX (8b): exactly ONE dead-channel recycle_self_recycle_blocked event filed", deadEvents.length === 1);
    const allBlockedEvents = db.listEventsForSession(a.id).filter((e) => e.kind === "recycle_self_recycle_blocked");
    check("(8b) total of TWO recycle_self_recycle_blocked events now (one per channel) — the live one was never discarded", allBlockedEvents.length === 2);

    const forwardSettleEvents = db.listEventsForSession(a.id).filter((e) =>
      e.kind === "recycle_reattempt_failed" && e.detail?.source === "forward-settle");
    check("FIX (MINOR): a recycle_reattempt_failed/source:'forward-settle' event was filed for the still-split attempt",
      forwardSettleEvents.length === 1 && Array.isArray(forwardSettleEvents[0].detail?.failedSteps) && forwardSettleEvents[0].detail.failedSteps.includes("wakes"));

    // DEAD -> DEAD REPEAT must still dedupe — no third recycle_self_recycle_blocked event, banner not
    // re-stamped — but the refusal text must STILL truthfully claim the banner is present (bannerConfirmed
    // via the "already present from a prior dead-channel attempt" branch, not a fresh stamp).
    let thrownDead2;
    try { await sessions.recycleManager(b.id, "handoff B->C attempt 3 (A still dead) — must dedupe"); } catch (e) { thrownDead2 = e; }
    unstub();
    check("FIX DEDUPE (8c): a THIRD attempt (dead->dead repeat) is ALSO refused", !!thrownDead2);
    check("FIX DEDUPE (8c): the refusal text STILL truthfully claims the banner was raised (already present, not re-stamped)",
      /banner has been raised/.test(thrownDead2?.message ?? ""));
    const allBlockedEvents2 = db.listEventsForSession(a.id).filter((e) => e.kind === "recycle_self_recycle_blocked");
    check("FIX DEDUPE (8c): still exactly TWO recycle_self_recycle_blocked events (no third filed)", allBlockedEvents2.length === 2);
  }
} finally {
  // Nothing to clean up beyond the OS temp dirs — each harness closes its own Db implicitly on process exit.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — FIX VERIFIED: a halted recycle successor can no longer itself recycle while its own predecessor's handoff is unresolved (refused, with a durable per-episode-deduped nudge to the predecessor); the guard correctly lifts once that halt resolves (via recycle_reattempt or a death+reclaim) and never wrongly blocks an unrelated fresh lineage; the downstream restart scenario the card described can no longer arise; a dead predecessor's still-split forward settle leaves its own durable audit trail; and the per-channel dedupe fix means a live-channel notification can never again suppress the dead-channel banner, with the refusal text's banner claim always truthful."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
