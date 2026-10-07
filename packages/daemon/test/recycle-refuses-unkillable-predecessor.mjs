import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2897acc4, manager condition 5 — `recycleWorker` must FAIL CLOSED (never spawn a successor into
// the predecessor's worktree) when the predecessor cannot be confirmed dead after a hard stop, instead of
// the old behavior (`console.warn(...); proceeding`) that barrelled ahead regardless.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (mirrors worker-recycle-retry-after-prespawn-failure.mjs's proven recycleWorker harness) and a real
// temp git repo + worktree. `isAlive()` defaults to `true` (the predecessor "never dies") so recycleWorker's
// own ~5s poll runs out and reaches the verify-or-refuse branch; a scenario may override this via
// `isAliveDuringPoll` (see the S1-shape scenario below). `probeRootSurvival` is overridden per scenario to
// control what that verification reports.
//
// Scenarios (header text was already stale re: count before round 4 — now actually five):
//   (A) predecessor confirmed alive + identity-confirmed + the kill doesn't take -> REFUSED. No fresh
//       successor row is minted; the task's active worker stays the predecessor's own id. ALSO proves CR
//       round 2 finding 4: a pending message flushed off the predecessor before the refusal is NOT lost —
//       it's re-queued back onto the (still-live) predecessor, and a terminal `recycle_failed` event
//       fires (so `recycle_begin` is never left unresolved).
//   (B, negative control) predecessor's root is reported CONFIRMED DEAD by the verification (despite
//       isAlive() still lying true) -> the recycle SUCCEEDS exactly as before this card. Proves the new
//       refusal path is reachable but not permanently wedged on — it reports what verifyRootDeadOrForceKill
//       actually found, not a blanket "isAlive() was true so refuse".
//   (C) CR round 2, LEAD RULING finding 8 — "identity-unconfirmed" means the pid is now held by an
//       UNRELATED process (ours is already gone, just not where recycleWorker last looked). This must
//       NOT refuse — only a CONFIRMED same-session survivor or an enumeration failure does.
//   (D) Round 3, M5's own regression — "pid-now-live-session": a respawn now owns the pid under a
//       DIFFERENT live object. Must NOT refuse (see its own comment below for the full mechanism).
//   (S1, round 4, item 1 — the card's own naming OS shape) `isAliveDuringPoll: false` simulates node-pty's
//       own `onExit` having ALREADY fired (a false exit) before recycleWorker's poll even starts — the
//       exact shape that used to skip the verify-or-refuse branch ENTIRELY (it was gated on
//       `if (this.pty.isAlive(...))` AFTER the poll) while the real OS process (per the probe) is still
//       alive and identity-confirmed, and the kill does not take. RED on the pre-round-4 code (recycle
//       proceeded unverified -> `expectRefused:true` would have failed); GREEN after (the fix captures pid
//       + owner BEFORE stop() and ALWAYS runs the verify, regardless of isAlive()).
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-refuses-unkillable-predecessor.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rup-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

const repo = path.join(os.tmpdir(), `loom-rup-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# recycle-refuses-unkillable-predecessor test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rup@loom -c user.name=rup");

const now = new Date().toISOString();

// The predecessor NEVER reports dead via isAlive() — this is what forces recycleWorker's own ~5s poll to
// exhaust and reach the new verify-or-refuse branch. `probeRootSurvival` is set per scenario below.
let probeResultQueue = [];
// CR round 2 finding 4: recycleWorker's `carried` queue is produced by a REAL `this.pty.flushPending(...)`
// call made unconditionally, before the predecessor is even probed (see service.ts's own recycleWorker) —
// so a scenario seeds `pendingToFlush` with fake QueuedMessage stand-ins and this stub hands them back
// exactly once, mirroring the real method's "drain the queue" contract without needing a full real `Live`
// object (constructing one here would mean faking ~20 unrelated fields). `requeueQueuedMessage` is stubbed
// the same way so the refusal path's "put it back" call is directly observable as data, not inferred.
let pendingToFlush = [];
let requeuedCalls = [];
// Round 4 (item 1): defaults to `true` (scenarios A-D's existing "the predecessor never dies" shape,
// forcing the ~5s poll to exhaust). The new S1-shape scenario below sets this `false` to simulate
// node-pty's own `onExit` having already fired (a false exit) BEFORE recycleWorker's poll even starts —
// the exact shape that used to skip the verify-or-refuse branch entirely (see that scenario's own doc).
let isAliveValue = true;
class SeamHost extends createSeamHost(PtyHost) {
  sweepOrphanedDescendants(_rootPid) {}
  stop() {} // the predecessor "ignores" the hard stop entirely
  isAlive() { return isAliveValue; }
  getPid() { return 99999; } // a fixed, fictional pid for this test's predecessor
  async probeRootSurvival(_rootPid, _sessionId) {
    if (probeResultQueue.length === 0) throw new Error("test bug: probeRootSurvival called with no queued result");
    return probeResultQueue.shift();
  }
  killRoot() {} // never actually running a real kill in this hermetic test
  flushPending(id) {
    const out = pendingToFlush;
    pendingToFlush = [];
    return out;
  }
  // Round 3 (M6): a marker of "carried-dropped" simulates `requeueQueuedMessage` genuinely failing to
  // land (e.g. the predecessor turns out dead by the time the requeue actually runs) — every other
  // marker succeeds, mirroring the stub's pre-existing always-"queued" behavior.
  requeueQueuedMessage(id, msg, tail) {
    requeuedCalls.push({ id, msg, tail });
    const dropped = msg?.marker === "carried-dropped";
    return dropped
      ? { delivered: false, reason: "session-dead", queued: false, deliveryState: "dropped" }
      : { delivered: false, reason: "requeued-test-stub", queued: true, deliveryState: "queued" };
  }
}

async function runScenario({ label, queue, expectRefused, pending = [], buildLiveEntries, isAliveDuringPoll = true }) {
  const db = new Db();
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
    onProcessSurvivedKill() {},
  };
  const host = new SeamHost(events);
  const svc = new SessionService(db, host, new OrchestrationControl());

  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projId = `p-${sfx}`, mgrId = `mgr-${sfx}`, agentId = `agent-${sfx}`, taskId = `task-${sfx}`, oldWorkerId = `old-${sfx}`;
  db.insertProject({ id: projId, name: "RUP", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Dev", startupPrompt: "DEV", position: 0, profileId: null });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertTask({ id: taskId, projectId: projId, title: `task ${sfx}`, body: "", columnKey: "in_progress", position: 1, priority: "p2", createdAt: now, updatedAt: now });

  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: oldWorkerId, projectId: projId, agentId, engineSessionId: "eng-old", title: null,
    cwd: worktreePath, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  probeResultQueue = queue;
  pendingToFlush = pending;
  requeuedCalls = [];
  isAliveValue = isAliveDuringPoll;
  // Round 3 (M5 regression coverage): a scenario that wants to exercise the respawn guards
  // (findLiveEntryByPid) populates `host.live` BEFORE calling recycleWorker — `verifyRootDeadOrForceKill`
  // reads `findAnyLive(oldWorkerId)` as its `owner` when recycleWorker (which threads no explicit
  // `expectedOwner`) calls it, so this is the one hook that lets a test drive that path for real.
  // `buildLiveEntries` is a FUNCTION of the (randomly-suffixed) `oldWorkerId`, since that id doesn't exist
  // until this point.
  host.live.clear();
  for (const [sid, entry] of buildLiveEntries?.(oldWorkerId) ?? []) host.live.set(sid, entry);
  let err;
  let fresh;
  try {
    fresh = await svc.recycleWorker(mgrId, oldWorkerId, `${label}: handoff`);
  } catch (e) {
    err = e;
  }

  if (expectRefused) {
    check(`(${label}) recycleWorker THROWS instead of proceeding`, !!err);
    check(`(${label}) the refusal names the predecessor's pid`, !!err && String(err.message).includes("99999"));
    check(`(${label}) the refusal names the predecessor's session id`, !!err && String(err.message).includes(oldWorkerId));
    check(`(${label}) NO fresh successor row was minted (hasSuccessor stays false)`, db.hasSuccessor(oldWorkerId) === false);
    check(`(${label}) the predecessor's own row is untouched (still processState 'live', never force-exited by this path)`,
      db.getSession(oldWorkerId)?.processState === "live");
    // CR round 2 finding 4: the carried (flushed-before-refusal) queue must be ATTEMPTED back onto the
    // still-live predecessor, in order — this is every ATTEMPT, not every success (round 3, M6 below is
    // where success vs. drop is actually counted).
    check(`(${label}) every carried pending message was PASSED to requeueQueuedMessage, in order`,
      requeuedCalls.length === pending.length && requeuedCalls.every((c, i) => c.id === oldWorkerId && c.msg === pending[i]));
    const failedEvents = db.listEventsForSession(oldWorkerId).filter((e) => e.kind === "recycle_failed");
    check(`(${label}) exactly one recycle_failed event was appended, filed under the predecessor`, failedEvents.length === 1);
    check(`(${label}) recycle_failed.detail.recycledFrom names the predecessor`, failedEvents[0]?.detail?.recycledFrom === oldWorkerId);
    // Round 3 (M6): count the ACTUAL result of each requeue (the stub's own "carried-dropped" marker),
    // never just the attempt count — `carriedRequeued` is successes only, `carriedDropped` the rest.
    const expectedDropped = pending.filter((m) => m?.marker === "carried-dropped").length;
    const expectedRequeued = pending.length - expectedDropped;
    check(`(${label}) recycle_failed.detail.carriedRequeued counts only the ACTUAL successful requeues, not attempts`,
      failedEvents[0]?.detail?.carriedRequeued === expectedRequeued);
    check(`(${label}) recycle_failed.detail.carriedDropped counts the genuinely-dropped carried message(s)`,
      failedEvents[0]?.detail?.carriedDropped === expectedDropped);
  } else {
    // Round 4 (item 6, nit): this text used to hardcode "a confirmed-dead predecessor" — accurate for
    // scenario B, but WRONG for scenario D (and the new S1-shape scenario below), where the predecessor
    // is never reported dead at all — `verifyRootDeadOrForceKill` reports a MISMATCH (an unrelated
    // process, or a respawn under a different live object), not `dead:true`. Worded generically so it
    // stays true for every `expectRefused:false` scenario, not just the one it was first written for.
    check(`(${label}) recycleWorker SUCCEEDS (verifyRootDeadOrForceKill did not report a confirmed, still-alive, same-session survivor)`, !err && !!fresh);
    check(`(${label}) a fresh successor row IS minted and live`, fresh?.processState === "live");
    check(`(${label}) hasSuccessor(predecessor) is now true, pointing at the real successor`, db.hasSuccessor(oldWorkerId) === true);
    check(`(${label}) nothing was requeued onto the predecessor (it was never refused)`, requeuedCalls.length === 0);
  }

  try { await removeWorktree(repo, worktreePath); } catch { /* best-effort */ }
  db.close();
}

try {
  // (A) confirmed alive, identity-confirmed, kill doesn't take -> REFUSED. Also carries THREE fake pending
  // messages through flushPending: two requeue cleanly (finding 4's original coverage), one is reported
  // DROPPED by the stub (round 3, M6 — proves carriedRequeued/carriedDropped count actual results, not
  // attempts).
  await runScenario({
    label: "A: unkillable predecessor",
    queue: [
      { foundAlive: true, identityConfirmed: true, enumerationFailed: false }, // first probe inside verifyRootDeadOrForceKill
      { foundAlive: true, identityConfirmed: true, enumerationFailed: false }, // re-check after killRoot: STILL alive
    ],
    expectRefused: true,
    pending: [{ marker: "carried-1" }, { marker: "carried-dropped" }, { marker: "carried-2" }],
  });

  // (B, negative control) the verification reports the predecessor genuinely dead -> recycle proceeds.
  await runScenario({
    label: "B (negative control): predecessor confirmed dead",
    queue: [
      { foundAlive: false, identityConfirmed: false, enumerationFailed: false },
    ],
    expectRefused: false,
  });

  // (C) CR round 2, LEAD RULING finding 8 — "identity-unconfirmed" (the pid is alive but held by an
  // UNRELATED process; ours is already gone) must NOT refuse. Only a single probe is ever consumed:
  // verifyRootDeadOrForceKill returns as soon as `!check.identityConfirmed`, never reaching killRoot or a
  // re-check — a second queued entry here would mean the test itself is wrong about that short-circuit.
  await runScenario({
    label: "C: identity-unconfirmed (pid reused by an unrelated process)",
    queue: [
      { foundAlive: true, identityConfirmed: false, enumerationFailed: false },
    ],
    expectRefused: false,
  });

  // (D) Round 3, M5's own regression — "pid-now-live-session": a RESPAWN now owns pid 99999 under a
  // DIFFERENT live object than the predecessor's own tracked entry. A prior round's recycleWorker gate
  // read this as a "confirmed same-session survivor" and wrongly REFUSED; the fix (verifyRootDeadOrForceKill's
  // `identity` field, gated on directly rather than re-derived) must PROCEED instead — the predecessor's
  // OWN tracked instance is gone, even though the pid itself is occupied by something else. Only ONE
  // probe is consumed: guard 1 refuses the KILL before any re-check, so `verifyRootDeadOrForceKill`
  // returns immediately after the first probe.
  await runScenario({
    label: "D: pid-now-live-session (a respawn owns the pid, not our tracked predecessor)",
    queue: [
      { foundAlive: true, identityConfirmed: true, enumerationFailed: false, creationTime: null },
    ],
    expectRefused: false,
    buildLiveEntries: (oldWorkerId) => [
      [oldWorkerId, { pid: 12345, startedAt: Date.now() - 10_000, alive: true }], // the predecessor's OWN tracked entry — a DIFFERENT pid number entirely; only its OBJECT IDENTITY matters to findLiveEntryByPid, not this field
      ["some-other-live-session", { pid: 99999, startedAt: Date.now(), alive: true }], // a DIFFERENT live object now owns pid 99999 — the respawn
    ],
  });

  // (S1) Round 4, item 1 — the card's own named shape: node-pty's onExit already fired a FALSE exit
  // (isAlive() reads false from the very first poll check, so the poll runs ZERO iterations) while the
  // real OS process is still alive and identity-confirmed, and the force-kill does not take. The
  // pre-round-4 code gated the whole verify-or-refuse branch on `if (this.pty.isAlive(workerSessionId))`
  // AFTER the poll — false here would have skipped it ENTIRELY, proceeding to spawn the fresh successor
  // into the predecessor's own still-live worktree. See this file's header for the RED/GREEN framing.
  await runScenario({
    label: "S1: false onExit (isAlive reads false immediately) but the OS process is still alive and confirmed",
    isAliveDuringPoll: false,
    queue: [
      { foundAlive: true, identityConfirmed: true, enumerationFailed: false }, // first probe inside verifyRootDeadOrForceKill
      { foundAlive: true, identityConfirmed: true, enumerationFailed: false }, // re-check after killRoot: STILL alive
    ],
    expectRefused: true,
  });
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recycleWorker refuses to spawn a successor when its predecessor cannot be confirmed dead, and still proceeds normally once it can."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
