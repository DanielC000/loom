import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4ee527d1 — a deliberately-retired worker's pending `wake_me` wakes used to survive the retirement:
// WakeService.tick auto-resumes ANY not-alive target unconditionally, so a worker stopped to free a
// concurrency slot (the routine case: a manager worker_stops a finished worker, then respawns a new one
// on the same task/worktree) could be resurrected by its own due wake, possibly alongside its replacement
// on the same kept worktree.
//
// The fix: ONE helper, `retireWorkerSession` (sessions/service.ts), cancels the worker's pending wakes and
// files a durable `worker_retired` marker; `SessionService.resume()` refuses an automatic caller on that
// marker, mirroring `recycle_successor_retired`'s own refusal shape exactly (see
// docs/decisions/4ee527d1-worker-retired-marker-cancels-wakes-and-blocks-auto-resume.md).
//
// This file covers the NON-GIT retirement sites + the resume() defense-in-depth layer + the crash-path
// control, driving the REAL WakeService.tick (never a direct `sessions.resume()` call for the refusal
// proof — mirrors resume-refuses-retired-recycle-successor.mjs's own reasoning: a direct call wouldn't
// prove reachability through the real auto-resume door). The two GIT-dependent sites (confirmWorkerMerge's
// hard-stop, finishAlreadyMerged, and the noChanges/noCommit auto-retire — all three need a real git
// worktree for precheckWorkerDone's zeroAhead check) are covered by worker-retired-merge-confirm.mjs.
//
// Proves:
//   (1) stopWorker cancels the worker's pending wakes and files worker_retired(reason:"worker_stop").
//   (2) killAllWorkers does the same for every live worker it hard-stops.
//   (3) retireSiblingSessionsForTask (recycleWorker's zombie-sibling sweep) cancels the STRAY sibling's
//       wakes and marks IT retired — while the recycle PREDECESSOR's own wakes are REPARENTED onto the
//       live successor (unchanged, pre-existing behavior) and the predecessor is NEVER marked retired.
//   (4) CRASH CONTROL: a worker that exits unexpectedly (no retirement call) keeps its wakes untouched,
//       is never marked worker_retired, and its due wake still successfully auto-resumes it — proving the
//       fix does not regress legitimate crash recovery.
//   (5) DEFENSE IN DEPTH: even if a wake somehow still exists against an already-retired worker (the
//       marker, not cancellation, is what resume() actually checks), WakeService.tick's real auto-resume
//       door is REFUSED with the specific "administratively retired" message, recorded in the wake's own
//       wake_dropped event — never a vacuous "something threw".
//   (6) The human-only allowSuperseded override still works: a direct resume() with it succeeds despite
//       the marker (the marker itself is never cleared), AND it is EPOCH-scoped, not one-time: it files a
//       worker_retirement_lifted event that re-arms every automatic resume path (wake/crash-recovery/
//       boot-resume) for this epoch — reproducing the Code Review finding (stopWorker -> resume
//       (allowSuperseded) -> wake_me -> crash -> wakes.tick used to wrongly wake_drop "administratively
//       retired" forever; it must now succeed) until a FRESH deliberate retirement re-arms the refusal.
//
// HERMETIC — a REAL PtyHost (fake pty backend whose kill() synchronously fires the REAL captured onExit
// callback, mirrors idle-nudge-recycle-purge.mjs's SeamHost) driving a REAL Db + SessionService + a REAL
// WakeService. No claude, no network, no git (git-dependent sites live in the sibling file).
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-retired-cancels-wakes.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wrcw-${Date.now()}-${process.pid}`);
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

// Fake pty whose kill() synchronously fires the REAL captured onExit callback (mirrors
// idle-nudge-recycle-purge.mjs) — so a hard/graceful stop makes PtyHost's own internal exit handling run
// deterministically, and recycleWorker's hard-stop-then-poll wait loop settles immediately.
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
class TestPtyHost extends PtyHost { sweepOrphanedDescendants(_rootPid) {}
createPty(opts) { return makeFakePty(opts.sessionId); } reapExitedDescendants(_rootPid) {} async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; } }

/** Fabricates a fake engine transcript so resume()'s engineTranscriptExists check passes — genuinely
 *  existing, mirrors resume-refuses-retired-recycle-successor.mjs's own fixture. */
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
  const P = `wrcw-${tag}`;
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
   *  to get PAST its own precondition checks and reach the retirement-marker guard this card adds. */
  const makeResumableWorker = (id, parentId, extra = {}) => {
    insertWorker(id, parentId, extra);
    spawnReady(id);
    writeFakeTranscript(repoDir, `eng-${id}`);
    return id;
  };

  return { db, host, sessions, wakes, P, repoDir, agentId, now, insertManager, insertWorker, spawnReady, makeResumableWorker };
}

const retiredRefusal = (msg) => typeof msg === "string" && /administratively retired/.test(msg);

try {
  // ==================== (1) stopWorker cancels wakes + files worker_retired ====================
  {
    const h = makeHarness();
    const mgr = "s1-mgr", wkr = "s1-wkr";
    h.insertManager(mgr);
    h.makeResumableWorker(wkr, mgr);
    const { wakeId } = h.wakes.schedule(wkr, { delaySeconds: 60, note: "check back" });
    check("(1 pre) wake scheduled", !!h.db.getWake(wakeId));

    const res = await h.sessions.stopWorker(mgr, wkr, "hard"); // hard: the fake pty's kill() fires onExit synchronously
    check("(1) stopWorker reports it stopped a live pty", res.stopped === true);
    check("(1) the worker's wake is CANCELLED", h.db.listWakesForSession(wkr).length === 0);
    const retired = h.db.listEventsForWorker(wkr).find((e) => e.kind === "worker_retired");
    check("(1) a worker_retired event is filed", !!retired && retired.detail?.reason === "worker_stop");
    check("(1) the event records how many wakes it cancelled", retired?.detail?.cancelledWakes === 1);

    // (5) DEFENSE IN DEPTH on THIS same retired worker: even a wake inserted AFTER retirement (bypassing
    // the eager cancel above) is refused by the REAL auto-resume door, not silently resumed.
    const t0 = new Date();
    h.db.insertWake({ id: "s1-late-wake", sessionId: wkr, wakeAt: new Date(t0.getTime() - 1000).toISOString(), note: "should never fire", createdAt: t0.toISOString() });
    await h.wakes.tick(t0);
    check("(5) the retired worker is NOT resumed by the real WakeService auto-resume door", h.host.isAlive(wkr) === false);
    // wake_fired/wake_dropped are filed under managerSessionId = the WAKE'S OWN session id (wake.ts), never
    // workerSessionId — read via listEvents, not listEventsForWorker (mirrors wake.mjs's own `events()` helper).
    const dropped = h.db.listEvents(wkr).find((e) => e.kind === "wake_dropped");
    check("(5) the wake is dropped with the SPECIFIC administratively-retired reason (not merely some throw)", !!dropped && retiredRefusal(dropped.detail?.reason));

    // (6) allowSuperseded is a human escape hatch — succeeds despite the marker — AND it LIFTS the
    // retirement for this epoch (the Code Review fix): the marker itself is never erased, but a newer
    // worker_retirement_lifted event re-arms automatic resume going forward.
    const resumed = h.sessions.resume(wkr, { allowSuperseded: true });
    check("(6) a human allowSuperseded resume of a worker_retired worker SUCCEEDS", !!resumed && h.host.isAlive(wkr) === true);
    check("(6) the worker_retired marker is NEVER cleared by a human override", h.db.hasWorkerEventKind(wkr, "worker_retired"));
    check("(6) a worker_retirement_lifted event is filed by the revive", h.db.hasWorkerEventKind(wkr, "worker_retirement_lifted"));
    check("(6) the retirement is no longer ACTIVE post-revive (epoch lifted)", h.db.isWorkerRetirementActive(wkr) === false);

    // Reviewer's exact repro: stopWorker -> resume(allowSuperseded) -> wake_me -> crash -> wakes.tick.
    // Pre-fix this wrongly wake_dropped "administratively retired" forever, even after the human revive.
    exitCbs.get(wkr)?.({ exitCode: 1 }); // a genuine crash of the just-revived worker — never a retirement call
    check("(6 post-revive) the revived-then-crashed worker is archived normally", !!h.db.getSession(wkr)?.archivedAt);
    const { wakeId: wakeId2 } = h.wakes.schedule(wkr, { delaySeconds: 60, note: "post-revive wake" });
    await h.wakes.tick(new Date(Date.now() + 61_000));
    check("(6) the post-revive wake SUCCEEDS — automatic resume is un-refused after the human revive", h.host.isAlive(wkr) === true);
    const postReviveFired = h.db.listEvents(wkr).find((e) => e.kind === "wake_fired" && e.detail?.wakeId === wakeId2);
    const postReviveDropped = h.db.listEvents(wkr).find((e) => e.kind === "wake_dropped" && e.detail?.wakeId === wakeId2);
    check("(6) the post-revive wake fired normally (wake_fired, never wake_dropped) — the epoch lift actually re-armed automatic resume", !!postReviveFired && !postReviveDropped);
  }

  // ==================== (2) killAllWorkers cancels every live worker's wakes ====================
  {
    const h = makeHarness();
    const mgr = "s2-mgr", wkrA = "s2-wkr-a", wkrB = "s2-wkr-b";
    h.insertManager(mgr);
    h.makeResumableWorker(wkrA, mgr);
    h.makeResumableWorker(wkrB, mgr);
    h.wakes.schedule(wkrA, { delaySeconds: 60, note: "a" });
    h.wakes.schedule(wkrB, { delaySeconds: 60, note: "b" });

    const n = await h.sessions.killAllWorkers();
    check("(2) killAllWorkers reports it stopped 2 live workers", n === 2);
    check("(2) BOTH workers' wakes are cancelled", h.db.listWakesForSession(wkrA).length === 0 && h.db.listWakesForSession(wkrB).length === 0);
    check("(2) BOTH workers are marked worker_retired with reason kill_all_workers",
      h.db.listEventsForWorker(wkrA).some((e) => e.kind === "worker_retired" && e.detail?.reason === "kill_all_workers")
      && h.db.listEventsForWorker(wkrB).some((e) => e.kind === "worker_retired" && e.detail?.reason === "kill_all_workers"));
  }

  // ==================== (3) retireSiblingSessionsForTask (via recycleWorker) ====================
  {
    const h = makeHarness();
    const mgr = "s3-mgr", keep = "s3-wkr-keep", sib = "s3-wkr-sib", taskId = "s3-task";
    h.insertManager(mgr);
    h.db.insertTask({ id: taskId, projectId: h.P, title: "S3 task", body: "", columnKey: "in_progress", position: 0, createdAt: h.now, updatedAt: h.now });
    h.makeResumableWorker(keep, mgr, { taskId, worktreePath: h.repoDir, branch: "loom/s3" });
    h.makeResumableWorker(sib, mgr, { taskId, worktreePath: h.repoDir, branch: "loom/s3" });
    h.wakes.schedule(keep, { delaySeconds: 60, note: "keep's own wake" });
    h.wakes.schedule(sib, { delaySeconds: 60, note: "sibling's own wake" });

    const successor = await h.sessions.recycleWorker(mgr, keep, "handoff: continuing");
    check("(3 pre) a fresh successor was minted for the recycled worker", !!successor && successor.id !== keep);

    check("(3) the STRAY SIBLING's wake is cancelled", h.db.listWakesForSession(sib).length === 0);
    const sibRetired = h.db.listEventsForWorker(sib).find((e) => e.kind === "worker_retired");
    check("(3) the stray sibling is marked worker_retired(reason:sibling_sweep)", !!sibRetired && sibRetired.detail?.reason === "sibling_sweep");

    check("(3) the recycle PREDECESSOR's own wake is REPARENTED onto the successor, not cancelled",
      h.db.listWakesForSession(keep).length === 0 && h.db.listWakesForSession(successor.id).length === 1);
    check("(3) the recycle PREDECESSOR is NEVER marked worker_retired (it has a live successor; wakes are reparented, not cancelled)",
      !h.db.listEventsForWorker(keep).some((e) => e.kind === "worker_retired"));
  }

  // ==================== (4) CRASH CONTROL: an unexpected exit must NOT cancel wakes or auto-resume-refuse ====================
  {
    const h = makeHarness();
    const mgr = "s4-mgr", wkr = "s4-wkr";
    h.insertManager(mgr);
    h.makeResumableWorker(wkr, mgr);
    const { wakeId } = h.wakes.schedule(wkr, { delaySeconds: 60, note: "resurrect me" });

    // A genuine crash: the pty just dies (onExit -> archiveOnExit), NEVER through stopWorker/
    // killAllWorkers/recycleWorker/confirmWorkerMerge/retireSiblingSessionsForTask.
    exitCbs.get(wkr)?.({ exitCode: 1 });
    check("(4 pre) the worker is archived by the ordinary archiveOnExit path", !!h.db.getSession(wkr)?.archivedAt);
    check("(4) a crash does NOT cancel the worker's wake", h.db.listWakesForSession(wkr).length === 1 && !!h.db.getWake(wakeId));
    check("(4) a crash never files worker_retired", !h.db.listEventsForWorker(wkr).some((e) => e.kind === "worker_retired"));

    const t0 = new Date();
    await h.wakes.tick(new Date(t0.getTime() + 61_000));
    check("(4) the crashed worker's due wake SUCCEEDS in auto-resuming it — no regression to legitimate crash recovery", h.host.isAlive(wkr) === true);
    check("(4) the wake fired normally (wake_fired, not wake_dropped)", h.db.listEvents(wkr).some((e) => e.kind === "wake_fired") && !h.db.listEvents(wkr).some((e) => e.kind === "wake_dropped"));
  }
} catch (e) {
  console.error("UNCAUGHT:", e);
  failures++;
} finally {
  console.log(failures === 0
    ? "\n✅ ALL PASS — retireWorkerSession cancels a deliberately-retired worker's pending wakes and files the durable worker_retired marker at every non-git retirement site (stopWorker, killAllWorkers, retireSiblingSessionsForTask), leaves a recycle predecessor's wakes correctly REPARENTED (never cancelled, never marked retired), never touches a crashed worker's wake (legitimate auto-resume still works), resume()'s defense-in-depth layer refuses the real WakeService auto-resume door on the marker alone (not merely some throw), and a human allowSuperseded override LIFTS the retirement for that epoch — re-arming every automatic resume path (wake/crash-recovery/boot-resume) until a fresh deliberate retirement closes it again."
    : `\n❌ ${failures} FAILURE(S).`);
  process.exit(failures === 0 ? 0 : 1);
}
