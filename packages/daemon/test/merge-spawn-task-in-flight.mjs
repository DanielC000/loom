import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 641cc62c — spawnWorker refuses a same-task respawn while a merge/batch op is in flight for that
// task, closing the two-writer window: confirmWorkerMerge/mergeBatchTracked run for a NON-LIVE worker
// (the ordinary shape — a merge targets a worker that has already exited), so the pre-existing
// liveSessionIdForTask guard (service.ts ~L8302) never fires for it. Without this fix, a concurrent
// worker_spawn for the SAME taskId lands on the IDENTICAL deterministic worktree the in-flight
// confirm/batch op is still reading/writing (createWorktree reuses the dir by taskId) — repro'd
// hermetically in the card's own investigation before this fix existed.
//
// Real git + a REAL SessionService, fake createPty seam (no claude), NO live daemon — mirrors
// merge-spawn-tracked.mjs's/merge-spawn-ownership-attach.mjs's in-process style. The gate command marks
// its own start via a file (polled, never a blind fixed sleep) so every "mid-flight" scenario below is
// deterministic: the concurrent spawnWorker call only ever fires once the gate is PROVABLY still running.
//
// Proves:
//   (1) SOLO: a same-task worker_spawn is REFUSED while confirmWorkerMergeTracked is mid-flight for a
//       NON-LIVE worker, naming the in-flight opId and "re-spawn after it settles" — never silent, never
//       a generic error. The refused call never created a worktree/session (collision avoided).
//   (2) The ORIGINAL confirm still settles successfully once the respawn attempt is refused (the refusal
//       has no side effect on the real merge in progress).
//   (3) SPAWN-AFTER-SETTLE: once that SAME confirm has genuinely settled, a fresh worker_spawn for the
//       SAME taskId now succeeds — proving the claim is released on settle, not leaked.
//   (4) THROW/REJECT RELEASE: a confirm that throws synchronously (a worker with no branch — a genuine,
//       not merely domain-level, rejection) still releases its per-task claim — a spawn for that SAME
//       task right after the rejection succeeds.
//   (5) BATCH: a same-task worker_spawn is refused while mergeBatchTracked is mid-flight for a batch
//       candidate's (non-live) worker, naming the batch's own opId.
//   (6) CAP-QUEUE COMPOSITION: when a cap-queued spawn auto-fires (maybeDrainCapQueue) into THIS refusal,
//       the entry is dropped (never retried forever) but the manager IS notified
//       ([loom:cap-queue-autofire-failed] naming the opId) — never a silent drop (card 6e2c910c concern).
//
// Code Review 78c8505a (round 2) found one BLOCKING leak and two partial-closure gaps, closed by (7)-(9):
//   (7) EVICTION LEAK (BLOCKING): a dead-owner-evicted entry's orphaned run still releases the per-task
//       claim on its OWN completion (chained via `.finally()`, never `onSettle` — which never fires for
//       an evicted entry) — a respawn is refused while the orphan is live, and succeeds once it settles.
//   (8) RECYCLE BYPASS: recycleWorker (reuses the predecessor's worktree IN PLACE, no createWorktree at
//       all) is refused by the SAME shared predicate while a merge for its task is mid-flight, and
//       succeeds once it settles.
//   (9) REVERSE ORDERING: confirmWorkerMerge's own mint refuses when a worker_spawn for the SAME task is
//       already in flight (the mirror image of (1)).
//
// Code Review 78c8505a (round 3) found (7) couldn't actually fail (a dist-strip of the fix left it
// GREEN) and a second atomicity gap in the batch reverse check — closed by fixing (7) and adding (7b)/(10):
//   (7) FIXED: now uses a FAILING gate (task stays non-terminal) and asserts `mergeInFlightOpIdForTask`
//       directly, instead of relying solely on an indirect spawn-refusal signal a DIFFERENT, unrelated
//       guard (the terminal-column check) could satisfy even with the real fix stripped.
//   (7b) BATCH EVICTION: the batch-side equivalent of (7) — `runBatchBody`'s own `.finally()` had no test
//        at all before this.
//   (10) BATCH REVERSE CHECK ATOMICITY (BLOCKING): the pre-assembly `spawnMintConflict` check and the
//        actual per-candidate mark/merge are NOT the same synchronous instant (real awaits sit between
//        them) — a spawn landing in that gap used to pass unnoticed. Fixed by re-running the SAME check
//        synchronously at the top of `runBatchBody`, immediately before marking/assembling each
//        candidate, routing a newly-conflicting one to its own fallback without failing the whole batch.
//
// Run: 1) build (pnpm --filter @loom/daemon build), 2) node packages/daemon/test/merge-spawn-task-in-flight.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const noReap = async () => ({ killedPids: [] });
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Deterministic "the gate is genuinely running" wait — never a blind fixed sleep. Bounded so a genuine
// regression (the gate never starts at all) fails fast instead of hanging the suite.
const waitForMarker = async (marker) => {
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await sleep(20);
  return fs.existsSync(marker);
};

const tmpHome = path.join(os.tmpdir(), `loom-mstif-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mstif@loom -c user.name=mstif";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

// LOCAL seam host (mirrors worker-spawn-cap-queue.mjs's own local override): captures every enqueueStdin
// call so scenario (6) can assert the autofire-failure notification actually reached the manager.
class SeamHost extends PtyHost {
  sweepOrphanedDescendants(_rootPid) {}
  reapExitedDescendants(_rootPid) {}
  async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
  async captureRootCreationRow(_pid) { return null; }
  enqueueLog = [];
  createPty() {
    let exitCb = null;
    return {
      pid: 4242, write() {}, onData() { return { dispose() {} }; },
      onExit(cb) { exitCb = cb; return { dispose() {} }; },
      kill() { const cb = exitCb; exitCb = null; cb?.({ exitCode: 0 }); },
      resize() {},
    };
  }
  enqueueStdin(sessionId, text, ...rest) { this.enqueueLog.push({ sessionId, text }); return super.enqueueStdin(sessionId, text, ...rest); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const db = new Db();
const host = new SeamHost(events);
const GENEROUS_SYNC_BUDGET_MS = 60_000;
const svc = new SessionService(db, host, new OrchestrationControl(), { reapWorktreeProcesses: noReap, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });

function makeRepo(prefix) {
  const repo = path.join(os.tmpdir(), `loom-mstif-repo-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# mstif-${prefix}\n`);
  execSync(`git init -q && git config user.email mstif@loom && git config user.name mstif`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
function seedProject(projId, repo, gateCommand) {
  db.insertProject({ id: projId, name: "MSTIF", repoPath: repo, vaultPath: repo, config: gateCommand ? { orchestration: { gateCommand } } : {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${projId}-mgr`, projectId: projId, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: `${projId}-dev`, projectId: projId, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
  db.insertSession({ id: `${projId}-mgr1`, projectId: projId, agentId: `${projId}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}
function stopSeamPty(sessionId) { try { host.stop(sessionId, "hard"); } catch { /* best-effort cleanup */ } }
function slowGateCommand(marker) {
  return `node -e "require('fs').appendFileSync('${marker.replace(/\\/g, "/")}', 'x'); setTimeout(()=>process.exit(0), 2500)"`;
}
// A gate that marks its own start, sleeps, then FAILS (exit 1) — the merge genuinely REJECTS (ok:true,
// value.merged:false; worktree RETAINED, task never reaches its terminal column) rather than landing, so
// a later respawn attempt can be asserted a genuine, unqualified SUCCESS.
function failingGateCommand(marker) {
  return `node -e "require('fs').appendFileSync('${marker.replace(/\\/g, "/")}', 'x'); setTimeout(()=>process.exit(1), 2500)"`;
}

try {
  // =============================================================================================
  // (1)/(2)/(3): SOLO two-writer collision refused; spawn-after-settle succeeds
  // =============================================================================================
  {
    const P = "mstif-solo", repo = makeRepo("solo");
    const taskId = "mstif-solo-task";
    const marker = path.join(os.tmpdir(), `loom-mstif-marker-solo-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2,7)}.log`);
    seedProject(P, repo, slowGateCommand(marker));
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "worker-a-work\n");
    commitAll(worktreePath, "feat: worker A's real work", GIT_ID);
    db.insertTask({ id: taskId, projectId: P, title: "solo task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerAId = `${P}-wkrA`;
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId, worktreePath, branch });

    const confirmPromise = svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerAId);
    check("(1 setup) the gate genuinely started before the concurrent spawn attempt", await waitForMarker(marker));
    check("(1 precondition) liveSessionIdForTask is undefined for a non-live merging worker (the gap the OLD guard alone left open)", db.liveSessionIdForTask(taskId) === undefined);

    let spawnErr = null;
    try {
      await svc.spawnWorker(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    } catch (e) { spawnErr = e; }
    check("(1) a same-task spawn is REFUSED while the solo confirm is mid-flight", spawnErr !== null);
    check("(1) the refusal names 'merge for this task in flight' + 're-spawn after it settles' (never a generic error)",
      /merge for this task in flight/.test(spawnErr?.message ?? "") && /re-spawn after it settles/.test(spawnErr?.message ?? ""));
    check("(1) the refusal names the actual in-flight opId (format `[op <uuid>]`)", /\[op [0-9a-f-]{36}\]/.test(spawnErr?.message ?? ""));
    check("(1) no second session was created for this task while refused (collision avoided)", db.listWorktreeSessionsForTask(taskId).length === 1);

    const confirmResult = await confirmPromise;
    check("(2) the ORIGINAL confirm still settles successfully — the refusal had no side effect on it", confirmResult.settled === true && confirmResult.ok === true && confirmResult.value?.merged === true);

    // (3) SPAWN-AFTER-SETTLE: the claim must be gone now. The merge actually LANDED (merged:true above),
    // so the task is correctly now in its terminal column — a fresh spawn is legitimately refused for
    // THAT reason, which is a DIFFERENT guard than the one this card adds. What this assertion isolates is
    // that it is NEVER refused for "merge for this task in flight" any more — that is the signal the claim
    // was actually released rather than leaked; a leaked claim would misreport this exact message forever.
    let workerB = null, spawnErr2 = null;
    try {
      workerB = await svc.spawnWorker(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO AGAIN" });
    } catch (e) { spawnErr2 = e; }
    check("(3) a fresh spawn for the SAME task is NEVER refused for 'merge for this task in flight' once the confirm has genuinely settled (claim released, not leaked)",
      !/merge for this task in flight/.test(spawnErr2?.message ?? ""));
    if (workerB) stopSeamPty(workerB.id);
  }

  // =============================================================================================
  // (3b): a genuine, UNQUALIFIED success — a merge that settles via an ordinary REJECTION (gate failed,
  // ok:true/merged:false — not a thrown error; distinct from scenario (4)'s synchronous-throw case) still
  // releases the claim, and the task stays non-terminal (worktree RETAINED), so the respawn is a clean,
  // genuine success with no other guard in the way either — exactly the "re-spawn after rejected merge"
  // recovery flow this guard must never block once the merge op is actually done.
  // =============================================================================================
  {
    const P = "mstif-reject-settle", repo = makeRepo("reject-settle");
    const taskId = "mstif-reject-settle-task";
    const marker = path.join(os.tmpdir(), `loom-mstif-marker-reject-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2,7)}.log`);
    seedProject(P, repo, failingGateCommand(marker));
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "worker-a-work\n");
    commitAll(worktreePath, "feat: worker A's real work", GIT_ID);
    db.insertTask({ id: taskId, projectId: P, title: "reject-settle task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerAId = `${P}-wkrA`;
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId, worktreePath, branch });

    const confirmPromise = svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerAId);
    check("(3b setup) the gate genuinely started", await waitForMarker(marker));
    let midFlightErr = null;
    try { await svc.spawnWorker(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" }); } catch (e) { midFlightErr = e; }
    check("(3b setup) the mid-flight respawn is refused (same guard as scenario 1)", /merge for this task in flight/.test(midFlightErr?.message ?? ""));

    const confirmResult = await confirmPromise;
    check("(3b setup) the merge genuinely REJECTS (ok:true, merged:false — a real gate failure, not a throw)", confirmResult.settled === true && confirmResult.ok === true && confirmResult.value?.merged === false);
    const task = db.getTask(taskId);
    check("(3b setup) the task stays NON-terminal (a rejected merge retains the worktree/branch for recovery)", task.columnKey !== "done");

    let workerB = null, spawnErr = null;
    try {
      workerB = await svc.spawnWorker(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "RETRY" });
    } catch (e) { spawnErr = e; }
    check("(3b) a respawn for the SAME task GENUINELY SUCCEEDS once the rejected merge has settled — no lingering lock", spawnErr === null && !!workerB);
    if (workerB) stopSeamPty(workerB.id);
  }

  // =============================================================================================
  // (4): a confirm that THROWS (genuine rejection, not a domain-level merged:false) still releases
  // =============================================================================================
  {
    const P = "mstif-throw", repo = makeRepo("throw");
    const taskId = "mstif-throw-task";
    seedProject(P, repo);
    db.insertTask({ id: taskId, projectId: P, title: "throw task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerId = `${P}-wkr`;
    // worker.branch === null ⇒ confirmWorkerMerge's own `if (!worker.branch) throw` — a genuine, synchronous
    // rejection reached from INSIDE the attach() callback, past onOpMinted (mirrors MERGE (5b) in
    // merge-spawn-tracked.mjs).
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId, worktreePath: repo, branch: null });

    const r = await svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerId);
    check("(4 setup) the confirm genuinely rejected (settled, ok:false)", r.settled === true && r.ok === false);

    let spawnErr = null;
    try {
      await svc.spawnWorker(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    } catch (e) { spawnErr = e; }
    check("(4) a spawn for the SAME task right after a THROWN/rejected confirm succeeds — the claim was released, not leaked", spawnErr === null);
  }

  // =============================================================================================
  // (5): BATCH — a same-task spawn is refused while mergeBatchTracked is mid-flight for that candidate
  // =============================================================================================
  {
    const P = "mstif-batch", repo = makeRepo("batch");
    const marker = path.join(os.tmpdir(), `loom-mstif-marker-batch-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2,7)}.log`);
    seedProject(P, repo, slowGateCommand(marker));
    const taskId1 = "mstif-batch-task1", taskId2 = "mstif-batch-task2";
    const { worktreePath: wt1, branch: br1 } = await createWorktree(repo, P, taskId1);
    fs.writeFileSync(path.join(wt1, "feat1.txt"), "candidate-1-work\n");
    commitAll(wt1, "feat: candidate 1", GIT_ID);
    const { worktreePath: wt2, branch: br2 } = await createWorktree(repo, P, taskId2);
    fs.writeFileSync(path.join(wt2, "feat2.txt"), "candidate-2-work\n");
    commitAll(wt2, "feat: candidate 2", GIT_ID);
    db.insertTask({ id: taskId1, projectId: P, title: "batch task 1", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertTask({ id: taskId2, projectId: P, title: "batch task 2", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });
    const w1 = `${P}-wkr1`, w2 = `${P}-wkr2`;
    db.insertSession({ id: w1, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: wt1, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId: taskId1, worktreePath: wt1, branch: br1 });
    db.insertSession({ id: w2, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: wt2, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId: taskId2, worktreePath: wt2, branch: br2 });

    const batchPromise = svc.mergeBatchTracked(`${P}-mgr1`, [w1, w2]);
    check("(5 setup) the batch gate genuinely started before the concurrent spawn attempt", await waitForMarker(marker));

    let spawnErr = null;
    try {
      await svc.spawnWorker(`${P}-mgr1`, { taskId: taskId1, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    } catch (e) { spawnErr = e; }
    check("(5) a same-task spawn is REFUSED while a BATCH merge is mid-flight for that candidate", spawnErr !== null && /merge for this task in flight/.test(spawnErr?.message ?? ""));

    const batchResult = await batchPromise;
    check("(5) the batch itself still settles (the refused respawn had no side effect on it)", batchResult.settled === true && batchResult.ok === true);

    // Claim must be released for BOTH candidate tasks once the batch settles. The batch actually LANDED
    // (ok:true above), so candidate 1's task is correctly now terminal — a fresh spawn is legitimately
    // refused for THAT reason (a different, pre-existing guard); scenario (3b) above already proves a
    // genuine unqualified success once a merge op settles via rejection, so this isolates the same signal
    // scenario (3) does: never refused for "merge for this task in flight" once settled (not leaked).
    let spawnErr2 = null, workerAgain = null;
    try {
      workerAgain = await svc.spawnWorker(`${P}-mgr1`, { taskId: taskId1, agentId: `${P}-dev`, kickoffPrompt: "GO AGAIN" });
    } catch (e) { spawnErr2 = e; }
    check("(5) a fresh spawn for the batch candidate's task is NEVER refused for 'merge for this task in flight' once the batch has settled (released, not leaked)",
      !/merge for this task in flight/.test(spawnErr2?.message ?? ""));
    if (workerAgain) stopSeamPty(workerAgain.id);
  }

  // =============================================================================================
  // (6): CAP-QUEUE COMPOSITION — an auto-fired replay that hits this refusal is dropped WITH a named
  // notification, never silently lost (card 6e2c910c concern).
  // =============================================================================================
  {
    const P = "mstif-capq", repo = makeRepo("capq");
    const marker = path.join(os.tmpdir(), `loom-mstif-marker-capq-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2,7)}.log`);
    db.insertProject({ id: P, name: "MSTIF-CAPQ", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 1, gateCommand: slowGateCommand(marker) } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertSession({ id: `${P}-mgr1`, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const taskOccupy = "mstif-capq-occupy", taskMerging = "mstif-capq-merging";
    db.insertTask({ id: taskOccupy, projectId: P, title: "occupies the sole slot", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    db.insertTask({ id: taskMerging, projectId: P, title: "has a merge in flight at drain time", body: "", columnKey: "in_progress", position: 2, priority: "p2", createdAt: now, updatedAt: now });

    // Fill the sole slot (cap=1) so the NEXT spawn attempt (for taskMerging) cap-queues rather than
    // reaching my new guard immediately — my guard is checked BEFORE the cap-admit, so it would otherwise
    // throw synchronously instead of ever sitting in the queue.
    const occupier = await svc.spawnWorker(`${P}-mgr1`, { taskId: taskOccupy, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    check("(6 setup) the occupying spawn fills the sole slot", !!occupier);

    // Give taskMerging a real, non-live worker with committed work, cut BEFORE the cap-queue attempt so
    // its worktree already exists.
    const { worktreePath: wtM, branch: brM } = await createWorktree(repo, P, taskMerging);
    fs.writeFileSync(path.join(wtM, "feat.txt"), "merging-candidate-work\n");
    commitAll(wtM, "feat: merging candidate", GIT_ID);
    const workerM = `${P}-wkrM`;
    db.insertSession({ id: workerM, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: wtM, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId: taskMerging, worktreePath: wtM, branch: brM });

    // Queue a respawn attempt for taskMerging — cap is full, so this records a cap-queued intent rather
    // than throwing (my new guard hasn't tripped yet; no merge is in flight for taskMerging at THIS point).
    let capQueuedErr = null;
    try {
      await svc.spawnWorker(`${P}-mgr1`, { taskId: taskMerging, agentId: `${P}-dev`, kickoffPrompt: "GO WHEN FREE" });
    } catch (e) { capQueuedErr = e; }
    check("(6 setup) the respawn for taskMerging cap-queues (not my new guard yet — nothing is merging yet)", capQueuedErr?.capQueued?.taskId === taskMerging || /concurrency cap reached/.test(capQueuedErr?.message ?? ""));

    // NOW start a real merge for taskMerging's existing worker — this is what the cap-queued entry will
    // collide with once it auto-fires.
    const confirmPromise = svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerM);
    check("(6 setup) the merge for taskMerging genuinely started", await waitForMarker(marker));

    // Free the sole slot and drain — the queued entry replays spawnWorker for taskMerging, which NOW hits
    // my new guard and throws a plain Error (not CapQueueRejectedError/UsageLimitError).
    host.enqueueLog.length = 0; // clean slate — only this drain's own notification should show up below
    db.setProcessState(occupier.id, "exited");
    await svc.maybeDrainCapQueue(`${P}-mgr1`);

    check("(6) the manager IS notified — [loom:cap-queue-autofire-failed] naming the in-flight-merge reason, never a silent drop",
      host.enqueueLog.some((e) => e.sessionId === `${P}-mgr1` && e.text.includes("[loom:cap-queue-autofire-failed]") && e.text.includes("merge for this task in flight")));
    check("(6) the entry is NOT retried forever — nothing cap-queued remains for taskMerging after one failed drain",
      !(svc.listCapQueuedSpawns?.(`${P}-mgr1`) ?? []).some((e) => e.taskId === taskMerging));

    await confirmPromise;
  }

  // =============================================================================================
  // (7): EVICTION LEAK (Code Review 78c8505a round 2, BLOCKING) — a dead-owner-evicted entry's orphaned
  // RUN must still release the per-task claim on its OWN completion; `onSettle` never fires for it (its
  // late settle finds a different object under `key` — pending-ops.ts's class doc), so before this fix
  // the claim leaked FOREVER (until a daemon restart) once an op was evicted.
  //
  // CR round 2 found this scenario couldn't actually fail: it used a PASSING gate, so the orphan's merge
  // genuinely LANDS, the task goes to its terminal column, and the final respawn is then refused by the
  // (unrelated, pre-existing) TERMINAL-COLUMN guard in spawnWorker BEFORE the claim check is ever reached
  // — a dist-strip of the solo `.finally()` fix left this scenario GREEN even though a direct probe showed
  // the claim genuinely leaked. Fixed by (a) a FAILING gate, so the orphan settles via REJECTION and the
  // task stays non-terminal, and (b) asserting `mergeInFlightOpIdForTask` directly (white-box — JS has no
  // real `private`, so this is callable from compiled test code exactly like `peekPendingMerge` elsewhere
  // in this suite), not only the indirect spawn-refusal signal.
  // =============================================================================================
  {
    const P = "mstif-evict", repo = makeRepo("evict");
    const taskId = "mstif-evict-task";
    const marker = path.join(os.tmpdir(), `loom-mstif-marker-evict-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}.log`);
    seedProject(P, repo, failingGateCommand(marker));
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "worker-a-work\n");
    commitAll(worktreePath, "feat: worker A's real work", GIT_ID);
    db.insertTask({ id: taskId, projectId: P, title: "evict task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerAId = `${P}-wkrA`;
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId, worktreePath, branch });
    // Make this project's manager's OWN lineage genuinely dead (no live member anywhere in the chain —
    // isManagerLineageDead walks the recycle chain and finds none) — simplest hermetic shape: the
    // manager itself is non-live, with no successor row at all.
    db.setProcessState(`${P}-mgr1`, "exited");

    // A SECOND SessionService instance sharing the SAME db/host, with deadOwnerEvictionCeilingMs
    // overridden to ~0 — per docs/decisions/47a22d40's own "Do not", never override this when proving
    // the PRODUCTION formula; here we're proving a DIFFERENT thing (the release-on-eviction fix) and
    // deliberately decouple it from waiting out the real ceiling.
    const svcTinyCeiling = new SessionService(db, host, new OrchestrationControl(), { reapWorktreeProcesses: noReap, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS, deadOwnerEvictionCeilingMs: 1 });

    const confirmPromise = svcTinyCeiling.confirmWorkerMergeTracked(`${P}-mgr1`, workerAId);
    check("(7 setup) the gate genuinely started (orphan run is live)", await waitForMarker(marker));
    check("(7 setup) the claim is marked while minted", svcTinyCeiling.mergeInFlightOpIdForTask(taskId) !== undefined);
    await sleep(20); // past the 1ms ceiling — isDeadOwnerOpStuck now reads true

    const clearedCount = svcTinyCeiling.reconcileDeadOwnerMergeOps();
    check("(7) reconcileDeadOwnerMergeOps evicted the dead-owner entry", clearedCount === 1);

    // The orphaned run() is STILL EXECUTING (the gate is still sleeping) — the per-task claim must
    // still refuse a respawn, since eviction only removed the REGISTRY's own bookkeeping, never the
    // real operation in flight. Asserted BOTH indirectly (spawn refused) AND directly (white-box).
    check("(7) DIRECT: mergeInFlightOpIdForTask still reports the claim WHILE the evicted orphan run is live", svcTinyCeiling.mergeInFlightOpIdForTask(taskId) !== undefined);
    let midEvictErr = null;
    try { await svcTinyCeiling.spawnWorker(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" }); } catch (e) { midEvictErr = e; }
    check("(7) a same-task spawn is STILL refused WHILE the evicted orphan run is live", /merge for this task in flight/.test(midEvictErr?.message ?? ""));

    // Let the orphan settle for real (gate fails for real) — THIS is the fix under test: release must
    // fire on the real run's own completion, not from onSettle (which never runs for an evicted entry).
    const orphanResult = await confirmPromise;
    check("(7) the orphaned run itself still settles, via a genuine REJECTION (not a throw)", orphanResult.settled === true && orphanResult.ok === true && orphanResult.value?.merged === false);
    const taskAfter = db.getTask(taskId);
    check("(7 setup) the task stays NON-terminal (gate failed — nothing landed, not the terminal-column false-positive CR found)", taskAfter.columnKey !== "done");

    check("(7) DIRECT: mergeInFlightOpIdForTask is EMPTY once the orphan has genuinely settled — the claim did not leak past a daemon restart's worth of time",
      svcTinyCeiling.mergeInFlightOpIdForTask(taskId) === undefined);
    let spawnErr = null, workerB = null;
    try { workerB = await svcTinyCeiling.spawnWorker(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO AGAIN" }); } catch (e) { spawnErr = e; }
    check("(7) THE FIX: a same-task spawn now GENUINELY SUCCEEDS once the orphan run has finished (no lingering terminal-column shortcut to hide behind here)",
      spawnErr === null && !!workerB);
    if (workerB) stopSeamPty(workerB.id);
  }

  // =============================================================================================
  // (7b): BATCH EVICTION (Code Review 78c8505a round 2) — the batch-side equivalent of (7): the
  // `runBatchBody` `.finally()` wrapper had NO test at all before this. Same shape as (7): a FAILING
  // batch gate (so the batch genuinely settles via rejection, candidates stay non-terminal), a dead
  // owner, a tiny ceiling override, eviction mid-flight, and direct `mergeInFlightOpIdForTask` checks
  // for BOTH candidate tasks.
  // =============================================================================================
  {
    const P = "mstif-batch-evict", repo = makeRepo("batch-evict");
    const marker = path.join(os.tmpdir(), `loom-mstif-marker-batchevict-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}.log`);
    seedProject(P, repo, failingGateCommand(marker));
    const taskId1 = "mstif-batch-evict-task1", taskId2 = "mstif-batch-evict-task2";
    const { worktreePath: wt1, branch: br1 } = await createWorktree(repo, P, taskId1);
    fs.writeFileSync(path.join(wt1, "feat1.txt"), "candidate-1-work\n");
    commitAll(wt1, "feat: candidate 1", GIT_ID);
    const { worktreePath: wt2, branch: br2 } = await createWorktree(repo, P, taskId2);
    fs.writeFileSync(path.join(wt2, "feat2.txt"), "candidate-2-work\n");
    commitAll(wt2, "feat: candidate 2", GIT_ID);
    db.insertTask({ id: taskId1, projectId: P, title: "batch evict task 1", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertTask({ id: taskId2, projectId: P, title: "batch evict task 2", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });
    const w1 = `${P}-wkr1`, w2 = `${P}-wkr2`;
    db.insertSession({ id: w1, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: wt1, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId: taskId1, worktreePath: wt1, branch: br1 });
    db.insertSession({ id: w2, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: wt2, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId: taskId2, worktreePath: wt2, branch: br2 });
    db.setProcessState(`${P}-mgr1`, "exited"); // dead owner, same shape as (7)

    const svcTinyCeiling = new SessionService(db, host, new OrchestrationControl(), { reapWorktreeProcesses: noReap, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS, deadOwnerEvictionCeilingMs: 1 });

    const batchPromise = svcTinyCeiling.mergeBatchTracked(`${P}-mgr1`, [w1, w2]);
    check("(7b setup) the batch gate genuinely started (orphan run is live)", await waitForMarker(marker));
    check("(7b setup) both candidate tasks are marked while minted", svcTinyCeiling.mergeInFlightOpIdForTask(taskId1) !== undefined && svcTinyCeiling.mergeInFlightOpIdForTask(taskId2) !== undefined);
    await sleep(20); // past the 1ms ceiling

    const clearedCount = svcTinyCeiling.reconcileDeadOwnerMergeOps();
    check("(7b) reconcileDeadOwnerMergeOps evicted the dead-owner BATCH entry", clearedCount === 1);

    check("(7b) DIRECT: both tasks still report the claim WHILE the evicted orphan batch run is live",
      svcTinyCeiling.mergeInFlightOpIdForTask(taskId1) !== undefined && svcTinyCeiling.mergeInFlightOpIdForTask(taskId2) !== undefined);
    let midEvictErr1 = null;
    try { await svcTinyCeiling.spawnWorker(`${P}-mgr1`, { taskId: taskId1, agentId: `${P}-dev`, kickoffPrompt: "GO" }); } catch (e) { midEvictErr1 = e; }
    check("(7b) a spawn for EITHER candidate's task is STILL refused while the evicted orphan batch run is live", /merge for this task in flight/.test(midEvictErr1?.message ?? ""));

    const batchResult = await batchPromise;
    check("(7b) the orphaned batch run itself still settles, via a genuine rejection", batchResult.settled === true && batchResult.ok === true && batchResult.value?.ok === false);

    check("(7b) DIRECT: both tasks' claims are EMPTY once the orphan batch has genuinely settled",
      svcTinyCeiling.mergeInFlightOpIdForTask(taskId1) === undefined && svcTinyCeiling.mergeInFlightOpIdForTask(taskId2) === undefined);
    let spawnErr1 = null, workerB1 = null;
    try { workerB1 = await svcTinyCeiling.spawnWorker(`${P}-mgr1`, { taskId: taskId1, agentId: `${P}-dev`, kickoffPrompt: "GO AGAIN" }); } catch (e) { spawnErr1 = e; }
    check("(7b) THE FIX: a spawn for candidate 1's task now GENUINELY SUCCEEDS once the orphan batch has finished", spawnErr1 === null && !!workerB1);
    if (workerB1) stopSeamPty(workerB1.id);
  }

  // =============================================================================================
  // (8): RECYCLE BYPASS (Code Review 78c8505a) — recycleWorker reuses the predecessor's worktree IN
  // PLACE (no createWorktree call at all) and never went through spawnWorker's own guard, so recycling
  // an EXITED worker whose confirm is in flight used to reproduce the exact same collision.
  // =============================================================================================
  {
    const P = "mstif-recycle", repo = makeRepo("recycle");
    const taskId = "mstif-recycle-task";
    const marker = path.join(os.tmpdir(), `loom-mstif-marker-recycle-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}.log`);
    seedProject(P, repo, slowGateCommand(marker));
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "worker-a-work\n");
    commitAll(worktreePath, "feat: worker A's real work", GIT_ID);
    db.insertTask({ id: taskId, projectId: P, title: "recycle task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerAId = `${P}-wkrA`;
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId, worktreePath, branch });

    const confirmPromise = svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerAId);
    check("(8 setup) the gate genuinely started", await waitForMarker(marker));

    let recycleErr = null;
    try {
      await svc.recycleWorker(`${P}-mgr1`, workerAId, "handoff: continuing while a merge for this task happens to be in flight");
    } catch (e) { recycleErr = e; }
    check("(8) recycleWorker is REFUSED while a merge for this task is mid-flight (same shared predicate as spawnWorker)",
      /merge for this task in flight/.test(recycleErr?.message ?? ""));

    const confirmResult = await confirmPromise;
    check("(8) the confirm itself still settles successfully (the refused recycle had no side effect on it)", confirmResult.settled === true && confirmResult.ok === true);

    const workerB = await svc.recycleWorker(`${P}-mgr1`, workerAId, "handoff: the merge has settled now, continuing for real");
    check("(8) recycleWorker SUCCEEDS once the merge has genuinely settled (claim released, not leaked)", !!workerB && workerB.id !== workerAId);
    stopSeamPty(workerB.id);
  }

  // =============================================================================================
  // (9): REVERSE ORDERING (Code Review 78c8505a) — confirmWorkerMerge's own mint must ALSO refuse when
  // a worker_spawn for the SAME task is already in flight (checked via the SAME synchronous
  // inFlightSpawnTaskIds claim spawnWorker itself sets before its first await) — the mirror image of
  // scenario (1) above.
  // =============================================================================================
  {
    const P = "mstif-reverse", repo = makeRepo("reverse");
    const taskId = "mstif-reverse-task";
    seedProject(P, repo);
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "worker-a-work\n");
    commitAll(worktreePath, "feat: worker A's real work", GIT_ID);
    db.insertTask({ id: taskId, projectId: P, title: "reverse task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerAId = `${P}-wkrA`;
    db.insertSession({ id: workerAId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId, worktreePath, branch });

    // No await between these two calls — spawnWorker's own synchronous prefix (through
    // inFlightSpawnTaskIds.add(taskId), well before its first real await at createWorktree) has already
    // run by the time the next line executes, exactly mirroring worker-spawn-toctou-race.mjs's own
    // "no await between the two calls" technique.
    const spawnPromise = svc.spawnWorker(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    const confirmPromise = svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerAId);
    const [spawnSettled, confirmSettled] = await Promise.allSettled([spawnPromise, confirmPromise]);

    check("(9) the spawn (already claiming the task when confirm minted) succeeds", spawnSettled.status === "fulfilled");
    // A throwing `onOpMinted` is rolled back + RETHROWN by PendingOpRegistry.attach() itself (see
    // docs/decisions/396d6602-*.md's own "Do not" — this is NOT caught into a clean {settled,ok:false}
    // AttachResult the way a throw from inside the real run() callback is, e.g. scenario (4)'s "worker has
    // no branch" case) — confirmWorkerMergeTracked's own call REJECTS directly, a real exception the
    // caller (the MCP layer in production) sees and can retry against a clear, named reason.
    check("(9) confirmWorkerMerge REJECTS because a worker_spawn for this task was already in flight at mint time",
      confirmSettled.status === "rejected" && /worker_spawn for this task is already in flight/.test(confirmSettled.reason?.message ?? ""));
    if (spawnSettled.status === "fulfilled" && spawnSettled.value) stopSeamPty(spawnSettled.value.id);
  }

  // =============================================================================================
  // (10): BATCH REVERSE CHECK ISN'T ATOMIC WITH ITS MARK (Code Review 78c8505a round 2, BLOCKING) —
  // the pre-assembly `spawnMintConflict` check (service.ts, in the candidates-building loop) runs well
  // BEFORE this op's real mint, with real awaits in between (`detectStrandedWork`, the
  // `reviewedTipVerdict` loop) — a worker_spawn landing in that window would pass the early check, then
  // get marked and merged anyway. Deterministically simulated (no real-timing race needed, matching this
  // codebase's established white-box test-poke convention — e.g. `sessions.claimedWorktreePaths.add(...)`
  // elsewhere in this suite) by monkey-patching `spawnMintConflict` to poke `inFlightSpawnTaskIds` for
  // candidate 1's task RIGHT AFTER its own first (pre-amble) call returns clean — exactly placing a
  // conflict in the gap between that check and the real, later, synchronous re-check this card adds at
  // the top of `runBatchBody`. Proves the LATE re-check — not just the pre-amble one — is load-bearing:
  // without it, candidate 1 would be marked and merged anyway despite the poked conflict.
  // =============================================================================================
  {
    const P = "mstif-batch-reverse-atomic", repo = makeRepo("batch-reverse-atomic");
    seedProject(P, repo, `node -e "process.exit(0)"`); // trivial PASSING gate — must reach the real mint (runBatchBody), not the no-gate early return
    const taskId1 = "mstif-bra-task1", taskId2 = "mstif-bra-task2";
    const { worktreePath: wt1, branch: br1 } = await createWorktree(repo, P, taskId1);
    fs.writeFileSync(path.join(wt1, "feat1.txt"), "candidate-1-work\n");
    commitAll(wt1, "feat: candidate 1", GIT_ID);
    const { worktreePath: wt2, branch: br2 } = await createWorktree(repo, P, taskId2);
    fs.writeFileSync(path.join(wt2, "feat2.txt"), "candidate-2-work\n");
    commitAll(wt2, "feat: candidate 2", GIT_ID);
    db.insertTask({ id: taskId1, projectId: P, title: "bra task 1", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertTask({ id: taskId2, projectId: P, title: "bra task 2", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });
    const w1 = `${P}-wkr1`, w2 = `${P}-wkr2`;
    db.insertSession({ id: w1, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: wt1, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId: taskId1, worktreePath: wt1, branch: br1 });
    db.insertSession({ id: w2, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: wt2, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId: taskId2, worktreePath: wt2, branch: br2 });

    const callsForTask1 = { count: 0 };
    const originalSpawnMintConflict = svc.spawnMintConflict.bind(svc);
    svc.spawnMintConflict = (taskId, worktreePath, excludeSessionId) => {
      const result = originalSpawnMintConflict(taskId, worktreePath, excludeSessionId);
      if (taskId === taskId1) {
        callsForTask1.count++;
        if (callsForTask1.count === 1) {
          // This IS the pre-amble's own check for candidate 1, reading clean (no conflict exists yet).
          // Simulate a real worker_spawn landing RIGHT NOW, in the gap this call is about to leave open.
          svc.inFlightSpawnTaskIds.add(taskId1);
        }
      }
      return result;
    };

    let batchResult;
    try {
      batchResult = await svc.mergeBatchTracked(`${P}-mgr1`, [w1, w2]);
    } finally {
      svc.spawnMintConflict = originalSpawnMintConflict;
      svc.inFlightSpawnTaskIds.delete(taskId1); // simulated poke cleanup — never a real spawn to release it
    }

    check("(10 setup) spawnMintConflict was actually called more than once for candidate 1's task (pre-amble, then the late re-check)", callsForTask1.count >= 2);
    check("(10) the batch itself settles successfully (candidate 2 unaffected)", batchResult.settled === true && batchResult.ok === true);
    const fallbackEntry = batchResult.value?.fallback?.find((f) => f.workerSessionId === w1);
    check("(10) THE FIX: candidate 1 — conflicting ONLY in the gap between the pre-amble check and the real mint — is pulled to fallback by the LATE re-check, never merged",
      !!fallbackEntry && /worker_spawn for this task is already in flight/.test(fallbackEntry.reason ?? "") && fallbackEntry.started === false);
    // NOTE: deliberately NOT asserting mergeInFlightOpIdForTask(taskId1) post-settle as proof candidate 1
    // was "never marked" — the batch's own release clears EVERY liveChosen taskId (including an excluded
    // one, harmlessly, via Set.delete's no-op-if-absent) once the WHOLE batch settles, so an absent claim
    // here is equally consistent with "never marked" and "marked, then released at settle" — it would
    // pass either way and prove nothing. The fallback-entry + landed checks above are what actually
    // discriminate correct behavior from the stripped (negative-control-proven RED) one.
    check("(10) candidate 2 landed normally — a late conflict for ONE candidate never fails the whole batch", (batchResult.value?.landed ?? []).some((l) => l.workerSessionId === w2));
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
} finally {
  // best-effort: nothing else durable to clean beyond the registered temp dirs (_tmp-fixture.mjs's own
  // process-exit hook removes them).
}
