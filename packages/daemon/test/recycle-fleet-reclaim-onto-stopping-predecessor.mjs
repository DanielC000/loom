import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fcf8a0f8. `recoverFleetAfterFailedRecycleSuccessor` (sessions/service.ts) gates "is the predecessor
// still viable" on `pty.isAlive(oldId)` alone. `PtyHost.stop()` sets `live.stopping = true` immediately (both
// modes) and, for a hard stop, `live.killed = true` SYNCHRONOUSLY at `pty.kill()` — but `live.alive` doesn't
// flip to false until the async 'exit' event lands (non-instant on Windows conpty's tree-walk kill path). A
// reclaim decision landing in that window reads the predecessor as alive and reparents the fleet onto it
// while its own kill is still in flight.
//
// A first cut REFUSED the reclaim in that window. Code Review 7c51b622 showed this makes the outcome
// WORSE: the fleet is left stranded on a confirmed-dead, unresumable M2 instead of landing on M1, whose own
// later exit (if the stop genuinely lands) `archiveOnExit`'s `manager_exited_with_live_workers` branch
// (@decision 6cd3ce9e) already makes safe — M1 stays visible, resumable, bannered, with a durable nudge. Lead
// ruling: RECLAIM, don't refuse — see docs/decisions/fcf8a0f8-reclaim-onto-a-stopping-predecessor.md for the
// full comparison. `isStopping` survives only as a diagnostic (`predecessorStopping` on the
// recycle_fleet_recovered event) — never as a gate, anywhere. A round-2 ruling briefly ALSO gated
// `recordUnresolvedRecycleOutcome`'s platform restore on `!isStopping`; round 3 reverted that too —
// `onPtyExit` unconditionally sets processState:"exited" the instant the real exit lands, so a premature
// restore during the stopping window is never a lasting lie, and the reclaim path's own identical restore
// has always been ungated. Gating only this sibling site was a pure asymmetry, and in a `live.stopping`
// latch-misread case it actively WORSENED things (wrongly withholding a correct restore). No gate needed.
//
// Proves:
//   (1) RECLAIM EVEN WHILE STOPPING — M1 is killed (hard stop issued) but its fake pty's 'exit' has NOT
//       fired: calling recoverFleetAfterFailedRecycleSuccessor directly STILL reclaims exactly as it would
//       for a genuinely healthy M1 — worker/wake/question reparented, M2 unlinked+archived,
//       recycle_fleet_recovered fires with detail.predecessorStopping === true. No refusal, no
//       recycle_fleet_unresolved event.
//   (2) CONTROL — M1 genuinely alive (never stopped): the SAME call reclaims identically, with
//       detail.predecessorStopping === false. Proves the diagnostic flag is accurate, not just always-true.
//   (3) CONTROL — M1 confirmed fully dead (the fake's 'exit' is actually fired): the PRE-EXISTING not-alive
//       branch is unchanged — recycle_fleet_unresolved{reason:"successor-died", oldStillLive:false}, nothing
//       reparented, M2 left entirely alone. This is the ONE case that still refuses — a predecessor that is
//       ALSO dead, not merely stopping.
//   (4) recordUnresolvedRecycleOutcome CONVERGENCE — the real invariant, not a gate: a stopping platform
//       predecessor's restoreLiveAfterConfirmedAlive(oldId) still fires (ungated, symmetric with the
//       reclaim path), stamping processState "live" — but once the real exit actually lands, onPtyExit
//       unconditionally overwrites it back to "exited" regardless of that intermediate stamp. The DB
//       always converges to reality; no gate was ever needed to make that true.
//   (5) END-TO-END — the scenario the card actually cares about: a stopping M1 reclaims the fleet, THEN its
//       real 'exit' lands. M1 is NOT archived (archiveOnExit sees the just-reclaimed live worker and
//       refuses), stays resumable (via `archivedAt`, which carries the whole claim), carries the
//       [loom:orphaned-fleet] banner, still owns the fleet, and the durable "fleet is back" nudge record
//       exists. Locks in the recoverable end state — see the mutation check below this file's own header
//       for how this scenario is proven to actually catch a regression.
//
// MUTATION CHECK (not re-run automatically by this file — see git history / the card's own worker_report for
// the actual RED proof): temporarily re-adding an `isStopping`-gated refusal branch to
// recoverFleetAfterFailedRecycleSuccessor (the first cut this card reverted) turns scenario (5) RED — the
// worker never reparents, M1 has zero live workers at exit time, and archiveOnExit archives it outright
// instead of leaving it visible+resumable+bannered. Scenarios (1)/(2) also go RED on their own
// predecessorStopping/reparent assertions. This is the regression guard the Lead asked for "by mutation."
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService + PtyHost, driven against a fake
// low-level pty whose kill() deliberately does NOT fire the 'exit' callback itself (mirrors
// pty-write-after-kill-race.mjs's own makeFakePty — the shared _seam-host-fixture.mjs default pty fires its
// exit callback SYNCHRONOUSLY inside kill(), which would never leave the kill()->'exit' window open at all).
// The onExit wiring mirrors index.ts's real shim (archiveOnExit + reconcileNeverStartedRecycleSuccessor),
// same as recycle-manager-fleet-recovery.mjs's own harness, so scenario (5)'s end-to-end check is genuine.
// recoverFleetAfterFailedRecycleSuccessor/recordUnresolvedRecycleOutcome are called DIRECTLY in (1)-(4)
// (bypassing the full settle-loop poll plumbing, already covered by recycle-manager-fleet-recovery.mjs) —
// this file is about the one read inside them, not the loops that reach them. (5) is the one scenario that
// also exercises the real onExit path, since that's the point being proven.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-fleet-reclaim-onto-stopping-predecessor.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `predicate` until it returns true or `timeoutMs` elapses — anchors a wait to an OBSERVABLE
 *  signal instead of a fixed sleep (mirrors recycle-manager-fleet-recovery.mjs's own helper). Needed only
 *  for enqueueDurableNudge's own async MCP-seen gate (scenario 5) — every other assertion in this file is
 *  synchronous. */
async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-fcf8a0f8-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
// Env-shorten enqueueDurableNudge's own usesOrchestrationMcp gate (waitForMcpSeen) BEFORE importing
// dist/** — read at module-load time, mirrors recycle-manager-fleet-recovery.mjs's own convention.
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// Mirrors pty-write-after-kill-race.mjs's makeFakePty: kill() flips an exposed `isKilled` flag (which
// flows into the real Live.killed/stopping via the real stop()/escalateGracefulStop) but never calls
// `exitCb` itself — the test decides when (or whether) the async 'exit' actually lands, via fireExit().
const fakes = new Map(); // sessionId -> fake low-level pty handle
function makeFakePty(sessionId) {
  let exitCb = null;
  const fake = {
    pid: 4242,
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
  // Same reasoning as _seam-host-fixture.mjs's own overrides: this fixture's fake pty uses a fixed,
  // fictional pid (4242) — never let any of these reach a real OS-wide process-tree operation against it.
  sweepOrphanedDescendants(_rootPid) {}
  reapExitedDescendants(_rootPid) {}
  async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
  killRoot(_pid) {}
  async captureRootCreationRow(_pid) { return null; }
  createPty(opts) { return makeFakePty(opts.sessionId); }
}

function makeHarness() {
  const db = new Db();
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    // Mirrors index.ts's real onExit hook (archiveOnExit then reconcileNeverStartedRecycleSuccessor), the
    // SAME shim recycle-manager-fleet-recovery.mjs uses — load-bearing for scenario (5)'s own assertions.
    onExit(id, code, info) {
      db.setProcessState(id, "exited");
      db.setBusy(id, false);
      const exited = db.getSession(id);
      if (exited) sessions.archiveOnExit(exited);
      if (exited) sessions.reconcileNeverStartedRecycleSuccessor(id, info.intended);
    },
  };
  const host = new TestPtyHost(events);
  const sessions = new SessionService(db, host, new OrchestrationControl());
  return { db, host, sessions };
}

function seedProject(db, id) {
  const now = new Date().toISOString();
  const repo = path.join(tmpHome, `repo-${id}`);
  fs.mkdirSync(repo, { recursive: true });
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: `${id}-lead`, projectId: id, name: "Lead", startupPrompt: "LEAD", position: 1, profileId: null });
}

/** Seeds a DB-only (never spawned) dead recycle successor row, linked FROM managerId — the shape
 *  recoverFleetAfterFailedRecycleSuccessor expects a confirmed-dead M2 row to already be in. */
function seedDeadSuccessor(db, projectId, managerId, freshId) {
  const now = new Date().toISOString();
  db.insertSession({
    id: freshId, projectId, agentId: `${projectId}-mgr`, engineSessionId: null, title: null,
    cwd: db.getProject(projectId).repoPath, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null, taskId: null,
    recycledFrom: managerId,
  });
}

/** Seeds a live worker + wake + question OWNED BY freshId — mirrors the post-recycle state where the
 *  fleet already moved forward onto the (now dead) successor, before any reclaim runs. */
function seedFleetOnSuccessor(db, projectId, freshId) {
  const now = new Date().toISOString();
  const workerId = `${freshId}-worker`;
  db.insertTask({ id: `${freshId}-task`, projectId, title: "t", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({
    id: workerId, projectId, agentId: `${projectId}-mgr`, engineSessionId: "eng-w", title: null,
    cwd: db.getProject(projectId).repoPath, processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: freshId, taskId: `${freshId}-task`,
  });
  db.insertWake({ id: `${freshId}-wake`, sessionId: freshId, wakeAt: new Date(Date.now() + 3_600_000).toISOString(), note: "test wake", createdAt: now, route: null });
  db.insertQuestion({ id: `${freshId}-q`, sessionId: freshId, projectId, title: "q", body: "b", state: "pending", createdAt: now });
  return { workerId };
}

try {
  // ==================== (1) RECLAIM EVEN WHILE STOPPING ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "fcf8a0f8-1";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    check("(1 pre) M1 really alive", host.isAlive(m1.id) === true);
    const m2Id = `${m1.id}-m2`;
    seedDeadSuccessor(db, P, m1.id, m2Id);
    const { workerId } = seedFleetOnSuccessor(db, P, m2Id);

    host.stop(m1.id, "hard"); // Live.stopping/killed=true, kill() called — the fake never fires 'exit' on its own
    check("(1 setup) M1 stopping but NOT exited — the window under test is open", host.isAlive(m1.id) === true && host.isStopping(m1.id) === true);

    sessions.recoverFleetAfterFailedRecycleSuccessor(m1.id, m2Id, "manager");

    check("(1) RECLAIM: the worker WAS reparented onto M1 despite the stopping window", db.getSession(workerId)?.parentSessionId === m1.id);
    check("(1) RECLAIM: the wake WAS reparented onto M1", db.listWakesForSession(m1.id).some((w) => w.id === `${m2Id}-wake`));
    check("(1) RECLAIM: the question WAS reparented onto M1", db.listQuestionsForSession(m1.id).some((q) => q.id === `${m2Id}-q`));
    check("(1) RECLAIM: M2 WAS unlinked", db.getSession(m2Id)?.recycledFrom === null);
    check("(1) RECLAIM: M2 WAS archived", !!db.getSession(m2Id)?.archivedAt);
    const recovered = db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered");
    check("(1) RECLAIM: exactly one recycle_fleet_recovered event, predecessorStopping true",
      recovered.length === 1 && recovered[0].detail?.oldStillLive === true && recovered[0].detail?.predecessorStopping === true &&
      recovered[0].detail?.deadSuccessorId === m2Id);
    check("(1) no recycle_fleet_unresolved event fabricated — not a refusal", db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_unresolved").length === 0);

    fakes.get(m1.id).fireExit(0); // close the window cleanly so nothing lingers past this scenario
  }

  // ==================== (2) CONTROL — M1 genuinely alive (never stopped) ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "fcf8a0f8-2";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    check("(2 pre) M1 really alive", host.isAlive(m1.id) === true);
    const m2Id = `${m1.id}-m2`;
    seedDeadSuccessor(db, P, m1.id, m2Id);
    const { workerId } = seedFleetOnSuccessor(db, P, m2Id);

    check("(2 pre) M1 is NOT stopping", host.isStopping(m1.id) === false);
    sessions.recoverFleetAfterFailedRecycleSuccessor(m1.id, m2Id, "manager");

    check("(2) unaffected: the worker WAS reparented onto M1", db.getSession(workerId)?.parentSessionId === m1.id);
    check("(2) unaffected: M2 WAS unlinked+archived", db.getSession(m2Id)?.recycledFrom === null && !!db.getSession(m2Id)?.archivedAt);
    const recovered = db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_recovered");
    check("(2) accurate diagnostic: exactly one recycle_fleet_recovered event, predecessorStopping FALSE",
      recovered.length === 1 && recovered[0].detail?.oldStillLive === true && recovered[0].detail?.predecessorStopping === false);
  }

  // ==================== (3) CONTROL — M1 confirmed fully dead (the one case that still refuses) ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "fcf8a0f8-3";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const m2Id = `${m1.id}-m2`;
    seedDeadSuccessor(db, P, m1.id, m2Id);
    const { workerId } = seedFleetOnSuccessor(db, P, m2Id);

    host.stop(m1.id, "hard");
    fakes.get(m1.id).fireExit(0); // let the window close for real — M1 is now genuinely dead
    // NOT also asserting isStopping()===false here: `live.stopping` is a monotonic latch (never cleared
    // on this Live object, per its own doc) — it stays true forever once stop() was ever called, even
    // long after the real exit. isAlive alone is the correct "confirmed dead" signal.
    check("(3 setup) M1 is confirmed dead", host.isAlive(m1.id) === false);

    sessions.recoverFleetAfterFailedRecycleSuccessor(m1.id, m2Id, "manager");

    check("(3) unchanged: the worker stayed on M2 (not reparented)", db.getSession(workerId)?.parentSessionId === m2Id);
    check("(3) unchanged: M2 left entirely alone (not unlinked)", db.getSession(m2Id)?.recycledFrom === m1.id);
    check("(3) unchanged: M2 left entirely alone (not archived)", db.getSession(m2Id)?.archivedAt == null);
    const unresolved = db.listEventsForSession(m1.id).filter((e) => e.kind === "recycle_fleet_unresolved");
    check("(3) unchanged: exactly one recycle_fleet_unresolved event, reason successor-died",
      unresolved.length === 1 && unresolved[0].detail?.reason === "successor-died" && unresolved[0].detail?.oldStillLive === false);
  }

  // ==================== (4) recordUnresolvedRecycleOutcome CONVERGENCE — no gate needed ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "fcf8a0f8-4";
    seedProject(db, P);

    const l1 = sessions.startPlatformLead(`${P}-lead`);
    db.setProcessState(l1.id, "exited"); // mirrors recyclePlatformLead's own atomic handoff flip
    host.stop(l1.id, "hard");
    check("(4 setup) L1 stopping but not exited", host.isAlive(l1.id) === true && host.isStopping(l1.id) === true);

    sessions.recordUnresolvedRecycleOutcome(l1.id, "fcf8a0f8-fake-fresh-1", "platform", "timeout");
    check("(4) the restore fires UNGATED, same as the reclaim path — processState is now live despite the stopping window",
      db.getSession(l1.id)?.processState === "live");
    const unresolved = db.listEventsForSession(l1.id).filter((e) => e.kind === "recycle_fleet_unresolved");
    check("(4) the unresolved event still fired, oldStillLive true", unresolved.length === 1 && unresolved[0].detail?.oldStillLive === true);

    // THE REAL INVARIANT: once the stop actually lands, onPtyExit unconditionally owns convergence —
    // the intermediate "live" stamp above is overwritten regardless, with no gate required anywhere.
    fakes.get(l1.id).fireExit(0);
    check("(4) CONVERGENCE: processState is exited once the real exit lands, regardless of the restore above",
      db.getSession(l1.id)?.processState === "exited");
  }

  // ==================== (5) END-TO-END — the scenario the card actually cares about ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "fcf8a0f8-5";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const m2Id = `${m1.id}-m2`;
    seedDeadSuccessor(db, P, m1.id, m2Id);
    const { workerId } = seedFleetOnSuccessor(db, P, m2Id);

    host.stop(m1.id, "hard");
    check("(5 setup) M1 stopping, exit not yet landed", host.isAlive(m1.id) === true && host.isStopping(m1.id) === true);

    sessions.recoverFleetAfterFailedRecycleSuccessor(m1.id, m2Id, "manager");
    check("(5) reclaim happened: worker now on M1", db.getSession(workerId)?.parentSessionId === m1.id);

    // enqueueDurableNudge's own MCP-seen wait is async (a `.then()`, deferred to a later microtask even
    // when already-settled) — wait for the observable DB row rather than asserting synchronously right
    // after the call (mirrors recycle-manager-fleet-recovery.mjs scenario (A)'s own identical wait).
    const isRecycleFailedNudge = (rec) => typeof rec.detail?.text === "string" && rec.detail.text.includes("[loom:recycle-failed]") && rec.detail.text.includes("worker_list");
    const nudged = await waitUntil(() => db.listUnresolvedQueuedMessagesForWorker(m1.id).some(isRecycleFailedNudge));
    check("(5) the reclaim's nudge became durable", nudged);

    // Now let the stop actually land — this is the real-world continuation the card is about.
    fakes.get(m1.id).fireExit(0);
    check("(5) M1 is now confirmed dead at the pty level", host.isAlive(m1.id) === false);

    // archivedAt alone carries the "stays resumable" claim — archiveOnExit's only two outcomes for a
    // manager/platform are archive or don't; a separate resumability check adds nothing discriminating
    // (nothing in this flow ever sets M1's own resumability to "dead" either way).
    check("(5) END STATE: M1 is NOT archived — archiveOnExit saw the just-reclaimed live worker", db.getSession(m1.id)?.archivedAt == null);
    check("(5) END STATE: M1 carries the orphaned-fleet banner", (db.getSession(m1.id)?.lastError ?? "").includes("[loom:orphaned-fleet]"));
    check("(5) END STATE: M1 still owns the fleet (worker parentSessionId)", db.getSession(workerId)?.parentSessionId === m1.id);
    check("(5) END STATE: M1 still owns the wake/question", db.listWakesForSession(m1.id).length === 1 && db.listQuestionsForSession(m1.id).length === 1);
    check("(5) END STATE: the durable 'fleet is back' nudge record STILL exists after exit", db.listUnresolvedQueuedMessagesForWorker(m1.id).some(isRecycleFailedNudge));
    const managerExitedEvents = db.listEventsForWorker(m1.id).filter((e) => e.kind === "manager_exited_with_live_workers");
    check("(5) END STATE: archiveOnExit's own manager_exited_with_live_workers event fired, naming 1 worker",
      managerExitedEvents.length === 1 && managerExitedEvents[0].detail?.count === 1 && managerExitedEvents[0].detail?.workerIds?.includes(workerId));
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
