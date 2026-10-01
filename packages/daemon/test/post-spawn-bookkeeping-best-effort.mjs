// Card 2fd55955 (Code Review of 40738f24, reviewer 5d6b0561) — post-spawn-success bookkeeping in
// spawnWorker/recycleWorker/recycleManager must be best-effort: a DB error AFTER a successful pty.spawn
// must never make worker_spawn/recycle report FAILURE over a LIVE session (the manager could then
// double-dispatch — a second worker on the same task, or a second recycle successor).
//
// THE BUG (pre-fix): several steps ran unguarded after the live-flip + pty.spawn try/catch already
// closed successfully — spawnWorker's active-lane move, its appendEvent(spawn_worker), its revive
// appendEvent(worker_revived), its wasted-dispatch advisory (resolveRepo/findShippedCardMatch);
// recycleWorker's appendEvent(recycle_complete); recycleManager's appendEvent(recycle_complete) and its
// own reparent/carry steps. A throw from any of these propagated straight out of the async method, even
// though the session/successor was already fully live.
//
// THE FIX: each of these now runs through one of three shared best-effort helpers
// (bestEffortPostSpawn/bestEffortPostSpawnResult/bestEffortPostSpawnResultSync, sessions/service.ts) — log
// on throw, never rethrow; a result-producing step falls back to a safe default (null) instead of
// swallowing into nothing.
//
// CORRECTION (Code Review of 9a0d06a6, reviewer 6252dfd0) — recycleManager's OWNERSHIP-TRANSFER steps
// (reparentLiveWorkers/Wakes/Questions/EventTriggerTargets/PollJobTargets/WebhookTargets/
// PendingOwnerMessage, capQueue.reparent, the carry block) are DELIBERATELY NOT swallowed-silently: unlike
// spawnWorker/recycleWorker, recycleManager's predecessor is stopped LATER, asynchronously, by
// settleRecycleHandoff — independently of whether ownership transferred. A swallowed reparent failure
// there would let that stop proceed anyway and silently strand live workers under a dead manager.
//
// SECOND CORRECTION (card f1969787, Code Review of 2fd55955 landed as 82b68e28) — "throw straight out of
// recycleManager" (this file's OWN prior behavior, until this card) turned out to be the wrong fix for the
// wrong reason: the successor was ALREADY live by the time any of these steps run, so a bare throw left
// BOTH managers live with no structured signal of what transferred — the caller just saw a raw error. The
// steps now retry ONCE (attemptManagerOwnershipTransfer); if still failing after that retry, recycleManager
// HALTS instead of either swallowing OR throwing: it does NOT call settleRecycleHandoff (so the predecessor
// is never retired — nothing it still owns gets stranded), appends a dedicated `recycle_ownership_transfer_failed`
// event naming exactly which step(s) failed plus the real stranded worker/question/wake ids, and durably
// nudges BOTH managers with who owns what. See case G below (recycleManager halts, never throws, nothing
// stranded) and docs/decisions/f1969787-*.md for the full rationale.
//
// recycleWorker's own reparent/carry steps DO stay best-effort (its predecessor is already hard-stopped
// BEFORE these run, so there's no later stop to race) — but a failed carryPendingToSuccessor no longer
// goes fully silent: it also notifies the manager via a durable nudge (case H).
//
// spawnWorker's capacity-read fallback is `null`, never an all-zero object (case I) — an all-zero capacity
// is indistinguishable from "the fleet is genuinely full" and would be false data on a transient DB error.
//
// EACH CASE BELOW follows the same shape: monkeypatch ONE specific DB write to throw exactly once (a
// consumed-once latch, so an unrelated call of the same method elsewhere never gets caught by surprise),
// call the method under test, and assert (a) the injected throw was actually consumed — proving the probe
// really exercised the target line, not a no-op — and (b) the call still returned successfully with a
// genuinely live session/successor, never a propagated exception (cases A-F, H) OR (b') the call still
// returns successfully (never throws) but HALTS instead of retiring the predecessor, naming the real
// failure structurally (case G, card f1969787).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against the
// shared fake-pty seam (_seam-host-fixture.mjs) + a real temp git repo (spawnWorker's own createWorktree,
// and recycleWorker/recycleManager's reused worktree/cwd).
//
// Run: 1) build (turbo builds shared first), 2) node test/post-spawn-bookkeeping-best-effort.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-psbe-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

const repo = path.join(os.tmpdir(), `loom-psbe-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# post-spawn-bookkeeping-best-effort test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=psbe@loom -c user.name=psbe");

const INJECTED = "injected post-spawn-success throw (post-spawn-bookkeeping-best-effort test)";

// isAlive() reflects stop() immediately — mirrors worker-recycle-prespawn-throw-marks-exited.mjs's proven
// recycleWorker harness, so the hard-stop poll inside recycleWorker returns on its first check.
class SeamHost extends createSeamHost(PtyHost) {
  stoppedIds = new Set();
  stop(id) { this.stoppedIds.add(id); }
  isAlive(id) { return this.spawnedIds?.has(id) && !this.stoppedIds.has(id); }
  spawn(opts) { (this.spawnedIds ??= new Set()).add(opts.sessionId); return super.spawn(opts); }
}

const now = new Date().toISOString();
const db = new Db();
const host = new SeamHost({
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
});
const svc = new SessionService(db, host, new OrchestrationControl());

// A generous cap: this file runs 9 cases against one manager, several of which (E/H) leave a
// never-torn-down predecessor worker row "live" (the fake SeamHost's own stop()/isAlive() override
// doesn't fire a real onExit, so processState never flips to "exited") — nothing to do with the fix under
// test, so the cap is sized well above the cumulative count rather than tightly matching real usage.
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 50 } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

// --- selective-throw monkeypatches on the real Db instance (instance property shadows the prototype
// method) — each is a consumed-once latch so it never catches an unrelated call of the same method. ---
const realAppendEvent = db.appendEvent.bind(db);
let throwOnNextEventKind = null;
let eventThrowConsumed = false;
db.appendEvent = (ev) => {
  if (throwOnNextEventKind && ev.kind === throwOnNextEventKind) {
    throwOnNextEventKind = null;
    eventThrowConsumed = true;
    throw new Error(INJECTED);
  }
  return realAppendEvent(ev);
};

const realUpdateTask = db.updateTask.bind(db);
let throwOnNextUpdateTask = false;
let updateTaskThrowConsumed = false;
db.updateTask = (id, patch) => {
  if (throwOnNextUpdateTask) {
    throwOnNextUpdateTask = false;
    updateTaskThrowConsumed = true;
    throw new Error(INJECTED);
  }
  return realUpdateTask(id, patch);
};

const realGetTask = db.getTask.bind(db);
let throwOnNthGetTaskCallForId = null; // { id, n }
let getTaskCallCountForId = 0;
let getTaskThrowConsumed = false;
db.getTask = (id) => {
  if (throwOnNthGetTaskCallForId && id === throwOnNthGetTaskCallForId.id) {
    getTaskCallCountForId++;
    if (getTaskCallCountForId === throwOnNthGetTaskCallForId.n) {
      throwOnNthGetTaskCallForId = null;
      getTaskThrowConsumed = true;
      throw new Error(INJECTED);
    }
  }
  return realGetTask(id);
};

const worktrees = [];
try {
  // ===================== A) spawnWorker — appendEvent(kind:"spawn_worker") throws =====================
  {
    const taskId = "taskA";
    db.insertTask({ id: taskId, projectId: "pP", title: "task A", body: "", columnKey: "todo", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    eventThrowConsumed = false;
    throwOnNextEventKind = "spawn_worker";
    let err, result;
    try { result = await svc.spawnWorker("mgr1", { taskId, agentId: "agentDev", kickoffPrompt: "GO" }); } catch (e) { err = e; }
    if (result?.worktreePath) worktrees.push(result.worktreePath);
    check("(A) the injected appendEvent(spawn_worker) throw actually fired", eventThrowConsumed === true);
    check("(A) spawnWorker does NOT throw despite the appendEvent(spawn_worker) failure", !err);
    check("(A) spawnWorker still returns the worker as live", result?.processState === "live");
    check("(A) the session row is genuinely live in the DB", db.getSession(result?.id)?.processState === "live");
    check("(A) the pty is genuinely alive (never killed/rolled back)", host.isAlive(result?.id) === true);
  }

  // ===================== B) spawnWorker — updateTask (active-lane move) throws =====================
  {
    const taskId = "taskB";
    db.insertTask({ id: taskId, projectId: "pP", title: "task B", body: "", columnKey: "todo", position: 2, priority: "p2", createdAt: now, updatedAt: now });
    updateTaskThrowConsumed = false;
    throwOnNextUpdateTask = true;
    let err, result;
    try { result = await svc.spawnWorker("mgr1", { taskId, agentId: "agentDev", kickoffPrompt: "GO" }); } catch (e) { err = e; }
    if (result?.worktreePath) worktrees.push(result.worktreePath);
    check("(B) the injected updateTask throw actually fired", updateTaskThrowConsumed === true);
    check("(B) spawnWorker does NOT throw despite the lane-move failure", !err);
    check("(B) spawnWorker still returns the worker as live", result?.processState === "live");
    check("(B) the pty is genuinely alive (never killed/rolled back)", host.isAlive(result?.id) === true);
    check("(B) the task's column was LEFT UNCHANGED (best-effort — never silently retried elsewhere)",
      db.getTask(taskId)?.columnKey === "todo");
    check("(B) the structural double-dispatch guard still works despite the lane never moving",
      db.liveSessionIdForTask(taskId) === result?.id);
  }

  // ===================== C) spawnWorker (internal revive path) — appendEvent(kind:"worker_revived") throws
  {
    const taskId = "taskC";
    db.insertTask({ id: taskId, projectId: "pP", title: "task C", body: "", columnKey: "todo", position: 3, priority: "p2", createdAt: now, updatedAt: now });
    eventThrowConsumed = false;
    throwOnNextEventKind = "worker_revived";
    let err, result;
    try {
      result = await svc.spawnWorker(
        "mgr1", { taskId, agentId: "agentDev", kickoffPrompt: "GO (revive)" },
        { revive: { sourceSessionId: "src1", sourceHarness: "claude", sourceEngineSessionId: "eng1", forkEngineSessionId: "fork1", originalTaskId: "origTask", commitSha: "deadbeef" } },
      );
    } catch (e) { err = e; }
    if (result?.worktreePath) worktrees.push(result.worktreePath);
    check("(C) the injected appendEvent(worker_revived) throw actually fired", eventThrowConsumed === true);
    check("(C) spawnWorker does NOT throw despite the worker_revived event failure", !err);
    check("(C) spawnWorker still returns the (revived) worker as live", result?.processState === "live");
    check("(C) the pty is genuinely alive (never killed/rolled back)", host.isAlive(result?.id) === true);
  }

  // ===================== D) spawnWorker — the wasted-dispatch advisory (resolveRepo via db.getTask) throws
  {
    const taskId = "taskD";
    db.insertTask({ id: taskId, projectId: "pP", title: "task D", body: "", columnKey: "todo", position: 4, priority: "p2", createdAt: now, updatedAt: now });
    // Within spawnWorker, this exact taskId value is passed to db.getTask THREE times: (1) resolving
    // taskRef -> exactTask at the top (same string value as taskId here), (2) resolving targetRepo BEFORE
    // the live-flip, (3) inside the wasted-dispatch advisory AFTER the live-flip/pty.spawn succeeded.
    // Throwing on the 3rd hits exactly the post-spawn advisory step this case targets.
    getTaskCallCountForId = 0;
    getTaskThrowConsumed = false;
    throwOnNthGetTaskCallForId = { id: taskId, n: 3 };
    let err, result;
    try { result = await svc.spawnWorker("mgr1", { taskId, agentId: "agentDev", kickoffPrompt: "GO" }); } catch (e) { err = e; }
    if (result?.worktreePath) worktrees.push(result.worktreePath);
    check("(D) the injected db.getTask throw inside the advisory actually fired", getTaskThrowConsumed === true);
    check("(D) spawnWorker does NOT throw despite the advisory failure", !err);
    check("(D) spawnWorker still returns the worker as live", result?.processState === "live");
    check("(D) the pty is genuinely alive (never killed/rolled back)", host.isAlive(result?.id) === true);
    check("(D) shippedMatch falls back to null on the advisory failure (never undefined, never a stale value)", result?.shippedMatch === null);
  }

  // ===================== E) recycleWorker — appendEvent(kind:"recycle_complete") throws =====================
  {
    const taskId = "taskE";
    db.insertTask({ id: taskId, projectId: "pP", title: "task E", body: "", columnKey: "in_progress", position: 5, priority: "p2", createdAt: now, updatedAt: now });
    const { worktreePath } = await createWorktree(repo, "pP", taskId);
    worktrees.push(worktreePath);
    const oldId = "oldWorkerE";
    db.insertSession({ id: oldId, projectId: "pP", agentId: "agentDev", engineSessionId: null, title: null,
      cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
      role: "worker", parentSessionId: "mgr1", taskId, worktreePath, branch: "loom/taskE" });
    host.spawnedIds?.add(oldId); // mark the fabricated predecessor "alive" for isAlive()/stop() bookkeeping
    eventThrowConsumed = false;
    throwOnNextEventKind = "recycle_complete";
    let err, result;
    try { result = await svc.recycleWorker("mgr1", oldId, "handoff — forcing a post-spawn throw"); } catch (e) { err = e; }
    check("(E) the injected appendEvent(recycle_complete) throw actually fired", eventThrowConsumed === true);
    check("(E) recycleWorker does NOT throw despite the recycle_complete event failure", !err);
    check("(E) recycleWorker still returns the successor as live", result?.processState === "live");
    check("(E) the successor row is genuinely live in the DB", db.getSession(result?.id)?.processState === "live");
    check("(E) the successor's pty is genuinely alive (never killed/rolled back)", host.isAlive(result?.id) === true);
  }

  // ===================== F) recycleManager — appendEvent(kind:"recycle_complete") throws =====================
  {
    db.insertSession({ id: "oldMgrF", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
      cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    host.spawnedIds?.add("oldMgrF");
    eventThrowConsumed = false;
    throwOnNextEventKind = "recycle_complete";
    let err, result;
    try { result = await svc.recycleManager("oldMgrF", "continuation — forcing a post-spawn throw"); } catch (e) { err = e; }
    check("(F) the injected appendEvent(recycle_complete) throw actually fired", eventThrowConsumed === true);
    check("(F) recycleManager does NOT throw despite the recycle_complete event failure", !err);
    check("(F) recycleManager still returns the successor as live", result?.processState === "live");
    check("(F) the successor row is genuinely live in the DB", db.getSession(result?.id)?.processState === "live");
    check("(F) the successor's pty is genuinely alive (never killed/rolled back)", host.isAlive(result?.id) === true);
  }

  // ===================== G) recycleManager — reparentLiveWorkers throws (every attempt, surviving the
  // one retry) ⇒ recycleManager does NOT throw, HALTS instead of retiring the predecessor, predecessor
  // untouched, worker stays parented to it, and the failure is named structurally (card f1969787) ========
  {
    const taskId = "taskG";
    db.insertTask({ id: taskId, projectId: "pP", title: "task G", body: "", columnKey: "in_progress", position: 7, priority: "p2", createdAt: now, updatedAt: now });
    const oldMgrId = "oldMgrG";
    db.insertSession({ id: oldMgrId, projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
      cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    host.spawnedIds?.add(oldMgrId);
    const workerId = "workerUnderG";
    db.insertSession({ id: workerId, projectId: "pP", agentId: "agentDev", engineSessionId: null, title: null,
      cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
      role: "worker", parentSessionId: oldMgrId, taskId });
    host.spawnedIds?.add(workerId);

    const realReparentLiveWorkers = db.reparentLiveWorkers.bind(db);
    let reparentThrowConsumed = false;
    db.reparentLiveWorkers = (oldId, newId) => {
      reparentThrowConsumed = true;
      throw new Error(INJECTED);
    };
    let err, result;
    try { result = await svc.recycleManager(oldMgrId, "continuation — forcing a reparentLiveWorkers throw"); } catch (e) { err = e; }
    db.reparentLiveWorkers = realReparentLiveWorkers;

    check("(G) the injected reparentLiveWorkers throw actually fired", reparentThrowConsumed === true);
    check("(G) recycleManager does NOT throw — it HALTS instead (card f1969787)", !err && !!result);
    check("(G) recycleManager still returns the successor as live", result?.processState === "live");
    check("(G) the predecessor manager row is STILL live, not stopped (nothing stranded)", db.getSession(oldMgrId)?.processState === "live");
    check("(G) the predecessor's pty was NEVER stopped (settleRecycleHandoff never ran)", host.isAlive(oldMgrId) === true);
    check("(G) the worker is STILL parented to the (still-alive) predecessor, not silently orphaned under a dead one",
      db.getSession(workerId)?.parentSessionId === oldMgrId);

    const failedEvent = db.listEventsForSession(result?.id).find((e) => e.kind === "recycle_ownership_transfer_failed");
    check("(G) a recycle_ownership_transfer_failed event names the real failed step", !!failedEvent && Array.isArray(failedEvent.detail?.failedSteps) && failedEvent.detail.failedSteps.includes("workers"));
    check("(G) it names the real stranded worker id", Array.isArray(failedEvent?.detail?.strandedWorkerIds) && failedEvent.detail.strandedWorkerIds.includes(workerId));
    const completeEvent = db.listEventsForSession(result?.id).find((e) => e.kind === "recycle_complete");
    check("(G) recycle_complete.detail.failedSteps is set too — never an ambiguous bare 0", Array.isArray(completeEvent?.detail?.failedSteps) && completeEvent.detail.failedSteps.includes("workers"));
  }

  // ===================== H) recycleWorker — carryPendingToSuccessor throws ⇒ still best-effort (does NOT
  // throw, successor stays live) BUT the manager is notified via a durable nudge naming the counts =======
  {
    const taskId = "taskH";
    db.insertTask({ id: taskId, projectId: "pP", title: "task H", body: "", columnKey: "in_progress", position: 8, priority: "p2", createdAt: now, updatedAt: now });
    const { worktreePath } = await createWorktree(repo, "pP", taskId);
    worktrees.push(worktreePath);
    const oldId = "oldWorkerH";
    db.insertSession({ id: oldId, projectId: "pP", agentId: "agentDev", engineSessionId: null, title: null,
      cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
      role: "worker", parentSessionId: "mgr1", taskId, worktreePath, branch: "loom/taskH" });
    host.spawnedIds?.add(oldId);

    const realCarryPendingToSuccessor = SessionService.prototype.carryPendingToSuccessor;
    SessionService.prototype.carryPendingToSuccessor = function () { throw new Error(INJECTED); };
    const realEnqueueDurableNudge = SessionService.prototype.enqueueDurableNudge;
    let nudgeCall = null;
    SessionService.prototype.enqueueDurableNudge = function (id, role, text, nTaskId) { nudgeCall = { id, role, text, taskId: nTaskId }; };
    let err, result;
    try { result = await svc.recycleWorker("mgr1", oldId, "handoff — forcing a carryPendingToSuccessor throw"); } catch (e) { err = e; }
    SessionService.prototype.carryPendingToSuccessor = realCarryPendingToSuccessor;
    SessionService.prototype.enqueueDurableNudge = realEnqueueDurableNudge;

    check("(H) recycleWorker does NOT throw despite the carry failure (still best-effort)", !err);
    check("(H) recycleWorker still returns the successor as live", result?.processState === "live");
    check("(H) the successor's pty is genuinely alive", host.isAlive(result?.id) === true);
    check("(H) the manager WAS notified via a durable nudge (unlike the other best-effort steps, a failed carry must not go silent)", !!nudgeCall);
    check("(H) the nudge was addressed to the manager", nudgeCall?.id === "mgr1");
    check("(H) the nudge names the predecessor and successor worker ids", nudgeCall?.text.includes(oldId.slice(0, 8)) && nudgeCall?.text.includes(result?.id.slice(0, 8)));
    check("(H) the nudge is scoped to this task", nudgeCall?.taskId === taskId);
  }

  // ===================== I) spawnWorker — getWorkerCapacity throws ⇒ capacity falls back to NULL, never a
  // misleading all-zero object (an all-zero capacity would read as \"fleet is full\", which is false) ====
  {
    const taskId = "taskI";
    db.insertTask({ id: taskId, projectId: "pP", title: "task I", body: "", columnKey: "todo", position: 9, priority: "p2", createdAt: now, updatedAt: now });
    const realGetWorkerCapacity = SessionService.prototype.getWorkerCapacity;
    let capacityThrowConsumed = false;
    SessionService.prototype.getWorkerCapacity = function () { capacityThrowConsumed = true; throw new Error(INJECTED); };
    let err, result;
    try { result = await svc.spawnWorker("mgr1", { taskId, agentId: "agentDev", kickoffPrompt: "GO" }); } catch (e) { err = e; }
    SessionService.prototype.getWorkerCapacity = realGetWorkerCapacity;
    if (result?.worktreePath) worktrees.push(result.worktreePath);

    check("(I) the injected getWorkerCapacity throw actually fired", capacityThrowConsumed === true);
    check("(I) spawnWorker does NOT throw despite the capacity-read failure", !err);
    check("(I) spawnWorker still returns the worker as live", result?.processState === "live");
    check("(I) capacity falls back to NULL, never an all-zero object (false data)", result?.capacity === null);
  }

  // ===================== NEGATIVE CONTROL — the probes themselves can fail a call when unpatched methods
  // genuinely throw unguarded (proves the latches are wired to something real, not vacuously inert) =====
  {
    const taskId = "taskNegControl";
    db.insertTask({ id: taskId, projectId: "pP", title: "task NC", body: "", columnKey: "todo", position: 6, priority: "p2", createdAt: now, updatedAt: now });
    const realInsertSession = db.insertSession.bind(db);
    let threw = false;
    db.insertSession = () => { throw new Error("deliberately broken pre-spawn step — must still propagate"); };
    try { await svc.spawnWorker("mgr1", { taskId, agentId: "agentDev", kickoffPrompt: "GO" }); } catch { threw = true; }
    db.insertSession = realInsertSession;
    check("(negative control) a genuinely pre-live-flip failure (insertSession) STILL propagates — this suite isn't vacuously green", threw === true);
  }
} finally {
  for (const wt of worktrees.filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — spawnWorker/recycleWorker's post-spawn bookkeeping is best-effort (a DB error is logged, never propagated); recycleManager's OWNERSHIP-TRANSFER steps retry once and, if still failing, HALT instead of throwing OR silently stranding live workers under a dead predecessor (card f1969787), naming the real failure structurally; a failed carry is surfaced to the manager, never silent; and spawnWorker's capacity fallback is null, never false all-zero data."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
