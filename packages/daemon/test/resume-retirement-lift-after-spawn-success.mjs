import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e7a9a884 — from the 4ee527d1 delta review: resume() used to file `worker_retirement_lifted` as
// soon as it DECIDED an allowSuperseded resume was overriding an active retirement — before `getProject`
// (can throw "project not found") and before `restoreSession`/`pty.spawn` inside the try/catch (can
// throw synchronously). A failed human Resume therefore left the epoch lifted anyway, re-arming every
// automatic resume path (CrashRecoveryWatcher, recoverCrashOrphanedWorkers, webhook/poll/event-trigger
// wakes) for a worker that never actually came back.
//
// The fix (docs/decisions/e7a9a884-resume-files-worker-retirement-lift-only-after-spawn-success.md):
// the BOOLEAN decision (shouldLiftRetirement) is still made early (the refusal check needs it there),
// but the actual `appendEvent` WRITE is deferred to just past the try/catch around pty.spawn — so a
// throw anywhere in that window (getProject, restoreSession, pty.spawn) rethrows before the lift is
// ever filed.
//
// Proves:
//   (1) RED->GREEN: getProject throwing ("project not found") during an allowSuperseded resume leaves
//       the retirement ACTIVE (no worker_retirement_lifted event filed) and a subsequent automatic
//       resume attempt is still refused on the marker.
//   (1b) Same proof via the OTHER named failure point: pty.spawn throwing synchronously.
//   (2) retired -> lifted -> retired again: after a successful allowSuperseded resume lifts the epoch,
//       a FRESH retirement (stopWorker) must read isWorkerRetirementActive() true again, and a real
//       WakeService auto-resume must be refused again — mirroring worker-retired-cancels-wakes.mjs's
//       own (6), one step further (re-retiring after the post-revive wake already succeeded there).
//
// HERMETIC — a REAL PtyHost (fake pty backend, same shape as worker-retired-cancels-wakes.mjs's
// SeamHost) driving a REAL Db + SessionService + a REAL WakeService. No claude, no network, no git.
//
// Run: 1) build (turbo builds shared first), 2) node test/resume-retirement-lift-after-spawn-success.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rrlas-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");

// The one session id whose createPty() call must throw SYNCHRONOUSLY, mirroring a real spawn failure
// (bad binary, OS-level pty creation error) — set per-subtest, cleared afterward.
let failSpawnFor = null;

const exitCbs = new Map();
function makeFakePty(sessionId) {
  const writes = [];
  return {
    pid: 4242,
    write: (d) => { writes.push(d); },
    onData: () => ({ dispose() {} }),
    onExit(cb) { exitCbs.set(sessionId, cb); return { dispose() {} }; },
    kill() { const cb = exitCbs.get(sessionId); if (cb) cb({ exitCode: 0 }); },
    resize: () => {},
    writes,
  };
}
class TestPtyHost extends PtyHost {
  sweepOrphanedDescendants(_rootPid) {}
  createPty(opts) {
    if (opts.sessionId === failSpawnFor) throw new Error("synthetic spawn failure (1b)");
    return makeFakePty(opts.sessionId);
  }
  reapExitedDescendants(_rootPid) {} async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
}

/** Fabricates a fake engine transcript so resume()'s engineTranscriptExists check passes — mirrors
 *  worker-retired-cancels-wakes.mjs's own fixture. */
function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

let n = 0;
function makeHarness() {
  const tag = `h${++n}`;
  const dbFile = path.join(tmpHome, `${tag}.db`);
  const db = new Db(dbFile);
  let sessions;
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onContextStats() {}, onRateLimited() {}, onBusy(id, busy) { db.setBusy(id, busy); },
    onExit(id) {
      db.setProcessState(id, "exited");
      db.setBusy(id, false);
      const exited = db.getSession(id);
      if (exited) sessions.archiveOnExit(exited);
    },
  };
  const host = new TestPtyHost(events);
  sessions = new SessionService(db, host, new OrchestrationControl());
  const wakes = new WakeService({
    db, pty: host, resume: (id) => sessions.resume(id),
    enqueueDurable: (id, text, ctx) => sessions.enqueueSystemNudge(id, text, ctx),
  });

  const now = new Date().toISOString();
  const P = `rrlas-${tag}`;
  const repoDir = path.join(tmpHome, `repo-${tag}`);
  fs.mkdirSync(repoDir, { recursive: true });
  db.insertProject({ id: P, name: P, repoPath: repoDir, vaultPath: repoDir, config: {}, createdAt: now, archivedAt: null });
  const agentId = `${P}-agent`;
  db.insertAgent({ id: agentId, projectId: P, name: "Worker", startupPrompt: "", position: 0 });
  db.setProjectConfig(P, { permission: { startupModeCycles: 0 } }); // SessionStart marks ready synchronously

  const insertManager = (id) => db.insertSession({
    id, projectId: P, agentId, engineSessionId: `eng-${id}`, title: null, cwd: repoDir,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  const insertWorker = (id, parentId, extra = {}) => db.insertSession({
    id, projectId: P, agentId, engineSessionId: null, title: null, cwd: repoDir,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: parentId, ...extra,
  });
  const spawnReady = (id) => {
    host.spawn({ sessionId: id, cwd: repoDir, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
    host.deliverHook(id, { hook_event_name: "SessionStart", session_id: `eng-${id}` });
  };
  /** A worker that is live + resumable (engine id + real transcript + real cwd) — the shape resume() needs
   *  to get PAST its own precondition checks and reach the retirement-marker guard this card touches. */
  const makeResumableWorker = (id, parentId, extra = {}) => {
    insertWorker(id, parentId, extra);
    spawnReady(id);
    writeFakeTranscript(repoDir, `eng-${id}`);
    return id;
  };

  return { db, host, sessions, wakes, P, repoDir, agentId, now, insertManager, insertWorker, spawnReady, makeResumableWorker };
}

try {
  // ==================== (1) RED->GREEN: getProject throws -> retirement must stay ACTIVE ====================
  {
    const h = makeHarness();
    const mgr = "p1-mgr", wkr = "p1-wkr";
    h.insertManager(mgr);
    h.makeResumableWorker(wkr, mgr);

    // Deliberately retire it (stopWorker: hard kill fires the fake pty's onExit synchronously).
    await h.sessions.stopWorker(mgr, wkr, "hard");
    check("(1 pre) the worker is retired", h.db.isWorkerRetirementActive(wkr) === true);

    // Make getProject() throw "project not found" for THIS project id — reached AFTER the retirement
    // boolean is decided but BEFORE pty.spawn ever runs (the first of the card's two named failure
    // points). A real `deleteProject` cascades the session row away too (it would delete the very
    // worker we're testing), so a scoped monkey-patch of the live db instance is the honest way to
    // simulate "getProject returned nothing" without corrupting FK-enforced table state.
    const origGetProject = h.db.getProject.bind(h.db);
    h.db.getProject = (id) => (id === h.P ? undefined : origGetProject(id));

    let threw = null;
    try { h.sessions.resume(wkr, { allowSuperseded: true }); } catch (e) { threw = e; }
    h.db.getProject = origGetProject;
    check("(1) the allowSuperseded resume genuinely throws (project not found)", !!threw && /project not found/i.test(String(threw.message)));
    check("(1) THE FIX: worker_retirement_lifted is NOT filed by a resume that fails before spawn", !h.db.hasWorkerEventKind(wkr, "worker_retirement_lifted"));
    check("(1) THE FIX: the retirement epoch is still ACTIVE after the failed resume", h.db.isWorkerRetirementActive(wkr) === true);

    // And the structural consequence: a later AUTOMATIC resume attempt (the real door, not a direct call)
    // must still be refused on the marker — never silently re-armed by the failed attempt above.
    const t0 = new Date();
    h.db.insertWake({ id: "p1-late-wake", sessionId: wkr, wakeAt: new Date(t0.getTime() - 1000).toISOString(), note: "must not fire", createdAt: t0.toISOString() });
    await h.wakes.tick(t0);
    check("(1) a real automatic-resume door (WakeService.tick) is STILL refused after the failed resume", h.host.isAlive(wkr) === false);
    const dropped = h.db.listEvents(wkr).find((e) => e.kind === "wake_dropped");
    check("(1) refused with the specific administratively-retired reason", !!dropped && /administratively retired/.test(dropped.detail?.reason ?? ""));
  }

  // ==================== (1b) Same proof, the OTHER named failure point: pty.spawn throws ====================
  {
    const h = makeHarness();
    const mgr = "p1b-mgr", wkr = "p1b-wkr";
    h.insertManager(mgr);
    h.makeResumableWorker(wkr, mgr);
    await h.sessions.stopWorker(mgr, wkr, "hard");
    check("(1b pre) the worker is retired", h.db.isWorkerRetirementActive(wkr) === true);

    failSpawnFor = wkr; // createPty() throws synchronously for this session on its next spawn
    let threw = null;
    try { h.sessions.resume(wkr, { allowSuperseded: true }); } catch (e) { threw = e; }
    failSpawnFor = null;
    check("(1b) the allowSuperseded resume genuinely throws (synthetic spawn failure)", !!threw && /synthetic spawn failure/.test(String(threw.message)));
    check("(1b) THE FIX: worker_retirement_lifted is NOT filed by a resume whose pty.spawn throws", !h.db.hasWorkerEventKind(wkr, "worker_retirement_lifted"));
    check("(1b) THE FIX: the retirement epoch is still ACTIVE after the failed resume", h.db.isWorkerRetirementActive(wkr) === true);
    // @decision 819407e4's own archive-restore-on-throw runs in the SAME catch block — confirm the two
    // fixes coexist correctly: the row was archived by stopWorker's hard kill (archiveOnExit), so a
    // failed resume must restore that archived state, not leave it phantom-live-but-unarchived.
    check("(1b) 819407e4's archive-restore still fires on this same throw (coexists with the deferred lift)", !!h.db.getSession(wkr)?.archivedAt);

    // Repair for the automatic-resume check: resume() never got far enough to flip processState to
    // "live" (M5 happens AFTER getProject, which succeeded here) but DID flip it before pty.spawn threw
    // — reconcileFailedSpawn already reconciled that back to "exited", so the row is in a normal
    // post-failure state and the automatic door below is exercised honestly.
    const t0 = new Date();
    h.db.insertWake({ id: "p1b-late-wake", sessionId: wkr, wakeAt: new Date(t0.getTime() - 1000).toISOString(), note: "must not fire", createdAt: t0.toISOString() });
    await h.wakes.tick(t0);
    check("(1b) a real automatic-resume door is STILL refused after the failed resume", h.host.isAlive(wkr) === false);
  }

  // ==================== (2) retired -> lifted -> retired AGAIN must read active again ====================
  {
    const h = makeHarness();
    const mgr = "p2-mgr", wkr = "p2-wkr";
    h.insertManager(mgr);
    h.makeResumableWorker(wkr, mgr);

    await h.sessions.stopWorker(mgr, wkr, "hard");
    check("(2 pre) retired", h.db.isWorkerRetirementActive(wkr) === true);

    const resumed = h.sessions.resume(wkr, { allowSuperseded: true });
    check("(2) a human allowSuperseded resume succeeds", !!resumed && h.host.isAlive(wkr) === true);
    check("(2) THE FIX: worker_retirement_lifted IS filed once the spawn actually succeeded", h.db.hasWorkerEventKind(wkr, "worker_retirement_lifted"));
    check("(2) lifted: the epoch now reads NOT active", h.db.isWorkerRetirementActive(wkr) === false);

    // Automatic resume succeeds post-lift (mirrors worker-retired-cancels-wakes.mjs's own (6)).
    const { wakeId: postLiftWake } = h.wakes.schedule(wkr, { delaySeconds: 60, note: "post-lift wake" });
    await h.wakes.tick(new Date(Date.now() + 61_000));
    check("(2) a post-lift automatic wake succeeds (un-refused)", h.host.isAlive(wkr) === true);
    check("(2) that wake fired normally, never dropped", h.db.listEvents(wkr).some((e) => e.kind === "wake_fired" && e.detail?.wakeId === postLiftWake)
      && !h.db.listEvents(wkr).some((e) => e.kind === "wake_dropped" && e.detail?.wakeId === postLiftWake));

    // Now retire it AGAIN (a fresh deliberate stop, same as any routine respawn-on-same-worktree cycle).
    const res2 = await h.sessions.stopWorker(mgr, wkr, "hard");
    check("(2) a second stopWorker succeeds on the revived worker", res2.stopped === true);
    check("(2) a SECOND worker_retired event is filed", h.db.listEventsForWorker(wkr).filter((e) => e.kind === "worker_retired").length === 2);
    check("(2) THE RE-ARM: isWorkerRetirementActive reads ACTIVE again (seq-ordered past the earlier lift)", h.db.isWorkerRetirementActive(wkr) === true);

    // And the real automatic door refuses again — the earlier lift must not leak forward past this
    // fresh retirement.
    const t1 = new Date();
    h.db.insertWake({ id: "p2-late-wake", sessionId: wkr, wakeAt: new Date(t1.getTime() - 1000).toISOString(), note: "must not fire post re-retire", createdAt: t1.toISOString() });
    await h.wakes.tick(t1);
    check("(2) a real automatic-resume attempt is REFUSED again after the re-retirement", h.host.isAlive(wkr) === false);
    const dropped2 = h.db.listEvents(wkr).find((e) => e.kind === "wake_dropped" && e.detail?.wakeId === "p2-late-wake");
    check("(2) refused with the specific administratively-retired reason, the second time too", !!dropped2 && /administratively retired/.test(dropped2.detail?.reason ?? ""));

    // A direct resume() call WITHOUT allowSuperseded (the automatic-caller shape) must also refuse.
    let threw2 = null;
    try { h.sessions.resume(wkr); } catch (e) { threw2 = e; }
    check("(2) a bare resume() (no allowSuperseded) is refused on the re-armed marker", !!threw2 && /administratively retired/.test(String(threw2.message)));
  }
} catch (e) {
  console.error("UNCAUGHT:", e);
  failures++;
} finally {
  console.log(failures === 0
    ? "\n✅ ALL PASS — resume() files worker_retirement_lifted only once the spawn has actually succeeded: a resume that fails (getProject throwing OR pty.spawn throwing synchronously) leaves the retirement epoch genuinely ACTIVE (no lift event, automatic resume still refused), a successful allowSuperseded resume still lifts it as before, and a FRESH retirement after a lift correctly re-arms isWorkerRetirementActive (seq-ordered past the earlier lift) and refuses automatic resume again."
    : `\n❌ ${failures} FAILURE(S).`);
  process.exit(failures === 0 ? 0 : 1);
}
