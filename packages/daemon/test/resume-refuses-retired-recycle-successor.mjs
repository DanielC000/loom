import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5a56bb0a — resume() checked neither `resumability` nor `archivedAt` for an AUTOMATIC caller, so a
// manager/platform recycle successor that itself never took over the fleet (unlinkAndArchiveDeadRecycleSuccessor
// stamps it resumability:"dead" + archived for a POLICY reason, NOT a genuinely broken transcript/cwd —
// see card 08c81809's own decision record) could be resurrected by ANY automatic caller that doesn't
// independently know about the retirement. This file proves the fix against a REAL open door: a wake-mode
// EventTriggerService fire, driving the REAL SessionService.resume (never a direct resume() call, which
// would not prove reachability — see the card's own DoD).
//
// Code Review B1: the ORIGINAL guard (resumability:"dead" AND archivedAt!=null AND the marker) was
// defeated by the Archive UI's view-only Restore (`restoreSession`'s dead branch clears archivedAt but
// never touches resumability) — the reviewer reproduced M1+M2 both alive after one restore + one trigger
// fire. LEAD RULING: refuse on the marker ALONE. It cannot go stale the way a bare `dead` stamp can (it is
// filed by exactly one chokepoint, for exactly one reason), so nothing else needs to agree with it. This
// also matches `hasSuccessor`'s own sibling guard, which never self-heals either — a human `allowSuperseded`
// revival is a ONE-TIME override, not a permanent lift; the row is refused again on its NEXT exit.
//
// Proves:
//   (1) a retired recycle successor with a GENUINELY EXISTING transcript+cwd (mirrors
//       recycle-settle-lost-to-restart.mjs scenario C's own fixture) is REFUSED by an event-trigger
//       wake-mode fire after the fix, WITH the specific "administratively retired" message (not merely
//       any refusal — a future unrelated throw must not make this pass vacuously).
//   (B1) a view-only Archive Restore (`restoreSession`'s dead branch) does NOT lift the refusal — the
//       marker alone still refuses the next automatic fire, with the same message.
//   (2) POSITIVE CONTROL: an ORDINARY archived exited manager (never recycled, never retired — just a
//       normal session that exited and got auto-archived) is STILL resumed by the SAME door. This is what
//       proves the fix does NOT regress to a bare `archivedAt != null` refusal (rejected during design —
//       archived is the normal state of every stopped session).
//   (3) a human's own allowSuperseded resume of the retired successor SUCCEEDS (the escape hatch) and
//       self-heals resumability back to "resumable" (a latent worktree-GC isLive hazard fix, per Code
//       Review M3) — but the marker itself is NEVER cleared, so on the session's NEXT ordinary exit an
//       automatic caller is REFUSED again: the override is one-time, not a permanent lift.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: mirrors recycle-settle-lost-to-restart.mjs's own harness —
// a REAL Db + SessionService + PtyHost driven against a FAKE low-level pty (the shared createPty() seam).
//
// Run: 1) build (turbo builds shared first), 2) node test/resume-refuses-retired-recycle-successor.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rrrs-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten the recycle-settle bounds BEFORE importing dist/** (mirrors recycle-settle-lost-to-restart.mjs).
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
const { EventTriggerService } = await import("../dist/orchestration/event-triggers.js");
const { reconcileStrandedRecycleSettlesEarly } = await import("../dist/sessions/recycle-settle-reconcile.js");
const { runBootRecoveryPrefix } = await import("../dist/sessions/boot-backstop.js");
const { CLEAN_STALENESS } = await import("./_deploy-staleness-fixture.mjs");
void reconcileStrandedRecycleSettlesEarly; // pulled in transitively via runBootRecoveryPrefix; named for parity with the sibling file

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

function runRealBootSequenceUpToResume(db, host) {
  const { early } = runBootRecoveryPrefix(db);
  const sessions = new SessionService(db, host, new OrchestrationControl());
  const finish = sessions.finishReconcilingRecycleSettles(early);
  return { sessions, finish };
}

function seedProject(db, id) {
  const now = new Date().toISOString();
  const repo = path.join(tmpHome, `repo-${id}`);
  fs.mkdirSync(repo, { recursive: true });
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  return { repo, now };
}

/** Fabricates a fake engine transcript so resume()'s engineTranscriptExists check passes — genuinely
 *  existing, exactly like recycle-settle-lost-to-restart.mjs's own fixture (never a stub/mock). */
function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

const seedWakeTrigger = (db, id, targetSessionId) => {
  db.insertEventTrigger({
    id, eventKind: "worker_report", projectId: null, mode: "wake",
    targetSessionId, agentId: null, enabled: true, lastSeq: db.getMaxEventSeq(), lastFiredAt: null,
    createdAt: new Date().toISOString(),
  });
};
const emitMatchingEvent = (db, managerSessionId) => {
  db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId, workerSessionId: null, taskId: null, kind: "worker_report", detail: { status: "blocked" } });
};

/** (M1) Wraps the real SessionService.resume so a fired trigger's refusal (or success) is OBSERVABLE —
 *  EventTriggerService's own per-trigger isolation only console.error()s the thrown error, so without
 *  this capture a test could pass merely because SOMETHING threw, never proving it was the RIGHT throw. */
function capturingResume(sessions, capture) {
  return (id) => {
    try {
      return sessions.resume(id);
    } catch (e) {
      capture.lastError = e;
      throw e;
    }
  };
}
const fireWakeTrigger = async (db, host, sessions, triggerId, targetSessionId, emitUnderManagerId) => {
  const capture = { lastError: undefined };
  const svc = new EventTriggerService({
    db, pty: host, control: new OrchestrationControl(),
    resume: capturingResume(sessions, capture),
    spawn: () => { throw new Error("not used"); },
  });
  seedWakeTrigger(db, triggerId, targetSessionId);
  emitMatchingEvent(db, emitUnderManagerId);
  await svc.tick(new Date());
  return capture;
};
const isRetiredRefusal = (err) => !!err && /administratively retired/.test(err.message);

try {
  // ==================== Build M1 -> recycle to M2 -> M2 never reaches ready, restart, retire M2 ====================
  const { db: db1, host: host1, sessions: sessions1 } = makeHarness();
  const P = "rrrs";
  seedProject(db1, P);
  const m1 = sessions1.startManager(`${P}-mgr`);
  host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1" });
  writeFakeTranscript(m1.cwd, "eng-m1");

  const m2 = await sessions1.recycleManager(m1.id, "handoff — the successor never reaches ready");
  // M2 captures a REAL engine id + a REAL transcript (mirrors recycle-settle-lost-to-restart.mjs scenario
  // C exactly) — never durably reaches ready. This is what makes the retirement below indistinguishable
  // from a stale dead stamp by transcript/cwd alone, which is the exact gap card 5a56bb0a closes.
  host1.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2" });
  writeFakeTranscript(m2.cwd, "eng-m2");
  check("(pre) M2 captured a real engine id but never durably reached ready", db1.getSession(m2.id)?.engineSessionId === "eng-m2" && db1.getSession(m2.id)?.reachedReadyAt == null);

  // A plain, ORDINARY manager (M3) — never recycled, never retired — that simply exits normally and gets
  // auto-archived. This is the POSITIVE CONTROL: archived is the NORMAL state of every stopped session.
  const m3 = sessions1.startManager(`${P}-mgr`);
  host1.deliverHook(m3.id, { hook_event_name: "SessionStart", session_id: "eng-m3" });
  writeFakeTranscript(m3.cwd, "eng-m3");
  host1.handles.get(m3.id).kill(); // real onExit fires -> archiveOnExit
  check("(pre) M3 (control) is an ORDINARY archived exited manager — never dead-stamped, never retired",
    !!db1.getSession(m3.id)?.archivedAt && db1.getSession(m3.id)?.resumability !== "dead");

  const preRestartFleet = sessions1.liveFleetResumeSet();
  db1.close();
  const { db: db2, host: host2 } = makeBoot();
  // PtyHost's real internal exit handling calls events.onExit unconditionally (never `?.()`) — makeBoot()
  // leaves it unset (only makeHarness() wires it), so any later host2.handles.get(id).kill() in THIS boot
  // needs its own minimal wiring (never the recycle-specific archiveOnExit/reconcileNeverStartedRecycleSuccessor
  // makeHarness's onExit does — this boot's own db2.archiveSession(m2.id) call, below, is the deliberate stand-in).
  host2.events.onExit = (id) => { db2.setProcessState(id, "exited"); db2.setBusy(id, false); };
  const { sessions: sessions2, finish } = runRealBootSequenceUpToResume(db2, host2);
  check("(setup) FIX 08c81809: the reconcile recovered M1 and retired M2", finish.recoveredPredecessors.includes(m1.id) && finish.retiredSuccessorIds.includes(m2.id));

  const restartIntent = { reason: "test", managerSessionId: m1.id, resume: preRestartFleet };
  // Card 59bfc939: no `excludeRetiredIds` override passed — that option has no production caller
  // (`this.retiredRecycleSuccessorIds`, populated by `finalizeRecovery`, is consulted unconditionally), so
  // this exercises the real production path.
  await sessions2.resumeFleetOnBoot(restartIntent, { deployStaleness: CLEAN_STALENESS });

  check("(setup) M2 is dead+archived (unlinkAndArchiveDeadRecycleSuccessor's own effect), transcript+cwd genuinely intact", db2.getSession(m2.id)?.resumability === "dead" && !!db2.getSession(m2.id)?.archivedAt);
  check("(setup) card 5a56bb0a's own marker: recycle_successor_retired event exists for M2", db2.hasWorkerEventKind(m2.id, "recycle_successor_retired"));
  check("(setup) M2 is NOT alive", host2.isAlive(m2.id) === false);
  check("(setup) M3 (control) survived the restart untouched — ordinary archived, not dead-stamped", !!db2.getSession(m3.id)?.archivedAt && db2.getSession(m3.id)?.resumability !== "dead");

  // ==================== (1) THE OPEN DOOR: a wake-mode event trigger targeting the retired M2 ====================
  {
    const capture = await fireWakeTrigger(db2, host2, sessions2, "trig-m2", m2.id, m1.id);
    check("(1) FIX: the retired M2 is NOT resumed by the event-trigger wake door (refused, absorbed by per-trigger isolation)", host2.isAlive(m2.id) === false);
    check("(1) FIX: the refusal is SPECIFICALLY the administratively-retired one (M1) — not merely some throw", isRetiredRefusal(capture.lastError));
    check("(1) FIX: nothing was enqueued to M2", host2.getPending(m2.id).length === 0);
  }

  // ==================== (B1) A VIEW-ONLY ARCHIVE RESTORE DOES NOT LIFT THE REFUSAL ====================
  {
    const restored = sessions2.restoreSession(m2.id); // resumability:"dead" -> the dead branch -> view-only, clears archivedAt ONLY
    check("(B1 pre) view-only restore succeeded and cleared archivedAt", restored?.restored === m2.id && db2.getSession(m2.id)?.archivedAt == null);
    check("(B1 pre) resumability is UNCHANGED by a view-only restore (still \"dead\")", db2.getSession(m2.id)?.resumability === "dead");

    const capture = await fireWakeTrigger(db2, host2, sessions2, "trig-m2-restored", m2.id, m1.id);
    check("(B1) FIX: the marker ALONE still refuses M2 even after archivedAt is cleared (the exact bypass Code Review reproduced)", host2.isAlive(m2.id) === false);
    check("(B1) FIX: the refusal is still the administratively-retired one", isRetiredRefusal(capture.lastError));
  }

  // ==================== (2) POSITIVE CONTROL: the SAME door still resumes an ordinary archived manager ====================
  {
    const capture = await fireWakeTrigger(db2, host2, sessions2, "trig-m3", m3.id, m1.id);
    check("(2) CONTROL: an ordinary archived exited manager IS still resumed by the same door — the fix did not reintroduce a bare archivedAt refusal", host2.isAlive(m3.id) === true);
    check("(2) CONTROL: no refusal was thrown for the ordinary case", capture.lastError === undefined);
    check("(2) CONTROL: M3's own archivedAt is cleared by the successful resume (ordinary resume() behavior, unchanged)", db2.getSession(m3.id)?.archivedAt == null);
  }

  // ==================== (3) HUMAN OVERRIDE IS ONE-TIME: allowSuperseded succeeds + self-heals, but the marker is never cleared, so the NEXT ordinary exit is refused again ====================
  {
    const resumed = sessions2.resume(m2.id, { allowSuperseded: true });
    check("(3) FIX: a human's allowSuperseded resume of the retired M2 succeeds", !!resumed && host2.isAlive(m2.id) === true);
    check("(3) FIX: M2's resumability self-heals to \"resumable\" on the successful resume (M3: fixes a latent worktree-GC isLive hazard)", db2.getSession(m2.id)?.resumability === "resumable");
    check("(3) FIX: M2's archivedAt is cleared", db2.getSession(m2.id)?.archivedAt == null);
    check("(3) FIX: the recycle_successor_retired marker is STILL present — a human revival never clears it", db2.hasWorkerEventKind(m2.id, "recycle_successor_retired"));

    // M2 now exits normally (an ORDINARY exit, nothing recycle-related this time).
    host2.handles.get(m2.id).kill();
    db2.archiveSession(m2.id); // mirrors archiveOnExit's core effect (this harness has no onExit wired on boot 2)
    check("(3 pre) M2 is archived again after its next ordinary exit", !!db2.getSession(m2.id)?.archivedAt);

    const capture = await fireWakeTrigger(db2, host2, sessions2, "trig-m2-again", m2.id, m1.id);
    check("(3) FIX: M2 is REFUSED again by the SAME automatic door on its next exit — the allowSuperseded override was ONE-TIME, never a permanent lift (mirrors hasSuccessor's own sibling guard)", host2.isAlive(m2.id) === false);
    check("(3) FIX: the refusal is still the administratively-retired one, even though resumability is now \"resumable\" — the guard is marker-only", isRetiredRefusal(capture.lastError));
  }
} catch (e) {
  console.error("UNCAUGHT:", e);
  failures++;
} finally {
  console.log(failures === 0
    ? "\n✅ ALL PASS — resume() refuses an automatic caller (a real EventTriggerService wake-mode fire) on a recycle successor retired by policy, on the recycle_successor_retired marker ALONE (never a bare resumability/archivedAt leg, which a view-only Archive Restore defeats — Code Review B1); an ORDINARY archived exited session is still resumed by the same door (no regression to a bare archivedAt refusal); and a human's allowSuperseded override is a ONE-TIME escape hatch that self-heals resumability but never clears the marker, so the session is refused again by every automatic caller on its NEXT ordinary exit."
    : `\n❌ ${failures} FAILURE(S).`);
  process.exit(failures === 0 ? 0 : 1);
}
