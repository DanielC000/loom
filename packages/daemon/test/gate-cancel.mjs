import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression tests for card 8d585277 — a manager cancel/supersede affordance for a worker's queued or
// running `run_gate` self-check, plus the structural per-worktree exclusivity guard in GateSemaphore that
// makes the double-op-per-worktree EPERM class impossible regardless of whether cancel ever fires.
//
// Covers the DoD's four hard properties:
//  (1) queued self-check + worker_merge_confirm on the SAME worktree -> single admission (the merge gate
//      runs; the self-check settles cancelled, never runs for real).
//  (2) gate_cancel on another project's opId -> refused.
//  (3) the never-settling kill case: a RUNNING self-check whose underlying run never actually settles even
//      after cancellation is requested -> reported NOT cancelled, and the slot stays held (asserted via
//      observed semaphore state, never elapsed wall-clock).
//  (4) the null-worktree-grouping fix a Code Review pass flagged: two worktree-less ops (e.g. two deploy
//      gates) must co-run at cap headroom, never serialized against each other just because neither names
//      a worktree.
//
// Run: 1) build daemon (pnpm build), 2) node test/gate-cancel.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gc-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GateSemaphore, GateCancelledError } = await import("../dist/orchestration/gate-semaphore.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll instead of a blind fixed sleep for "has this op reached the live registry yet" — a blind sleep is
// exactly the wall-clock-coincidence flake this file's own DoD explicitly rejects (never assert on elapsed
// wall-clock), and it's genuinely too fragile here: a block running right after a real squash-merge/
// worktree-removal can see its OWN git subprocess prep take longer than a fixed short sleep under host
// load. Bounded generously (8s) so a real bug still fails fast rather than hanging.
async function waitUntil(predicate, { intervalMs = 15, timeoutMs = 8000 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return predicate(); // one last try, then give up honestly
    await sleep(intervalMs);
  }
}
const GIT_ID = "-c user.email=gc@loom -c user.name=gc";
const now = new Date().toISOString();

const dbs = [];
const worktrees = [];

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# gc\n");
  execSync(`git init -q && git config user.email gc@loom && git config user.name gc && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

// ── (4) Pure unit check: the per-worktree exclusivity guard, at the GateSemaphore level ────────────────
{
  const sem = new GateSemaphore();

  // Two ops bound to the SAME worktree must never both be RUNNING, even with cap headroom (cap 2).
  let active = 0, maxActive = 0;
  let releaseA;
  const holdA = new Promise((res) => { releaseA = res; });
  const taskA = async () => { active++; maxActive = Math.max(maxActive, active); await holdA; active--; return "a"; };
  const taskB = async () => { active++; maxActive = Math.max(maxActive, active); await sleep(20); active--; return "b"; };
  const descA = { gateType: "worker", projectId: "p", sessionId: "s1", worktreePath: "/wt/shared" };
  const descB = { gateType: "merge", projectId: "p", sessionId: "s2", worktreePath: "/wt/shared" };
  const pA = sem.runExclusive(2, descA, taskA);
  await sleep(10); // ensure A has genuinely acquired before B tries
  const pB = sem.runExclusive(2, descB, taskB);
  await sleep(10); // give B a chance to (wrongly) run concurrently if the guard were broken
  check("(guard) cap 2 but SAME worktree — B has not run yet while A holds it", maxActive === 1);
  releaseA("go");
  const [rA, rB] = await Promise.all([pA, pB]);
  check("(guard) both eventually complete", rA === "a" && rB === "b");
  check("(guard) same-worktree ops NEVER ran concurrently despite cap 2", maxActive === 1);

  // (4) Two ops with NO worktreePath at all (e.g. two deploy gates) must NOT be serialized against each
  // other — undefined must never behave like one shared group.
  {
    const sem2 = new GateSemaphore();
    let active2 = 0, maxActive2 = 0;
    let arrived = 0, releaseBarrier;
    const barrier = new Promise((res) => { releaseBarrier = res; });
    const task = async () => {
      active2++; maxActive2 = Math.max(maxActive2, active2);
      if (++arrived === 2) releaseBarrier();
      await Promise.race([barrier, sleep(2000)]);
      active2--;
      return "ok";
    };
    const dNone1 = { gateType: "deploy", projectId: "p1", sessionId: "s1" }; // no worktreePath at all
    const dNone2 = { gateType: "deploy", projectId: "p2", sessionId: "s2" }; // no worktreePath at all
    const results = await Promise.all([sem2.runExclusive(2, dNone1, task), sem2.runExclusive(2, dNone2, task)]);
    check("(null-grouping) two worktree-less ops both resolve", results.every((r) => r === "ok"));
    check("(null-grouping) two worktree-less ops co-ran at cap headroom — undefined is NOT a shared group", maxActive2 === 2);
  }

  // Sanity: a worktree-bound op and a worktree-LESS op never block each other.
  {
    const sem3 = new GateSemaphore();
    let active3 = 0, maxActive3 = 0;
    const task = async () => { active3++; maxActive3 = Math.max(maxActive3, active3); await sleep(30); active3--; return "ok"; };
    const bound = { gateType: "worker", projectId: "p", sessionId: "s1", worktreePath: "/wt/only-this-one" };
    const unbound = { gateType: "deploy", projectId: "p", sessionId: "s2" };
    const results = await Promise.all([sem3.runExclusive(2, bound, task), sem3.runExclusive(2, unbound, task)]);
    check("(null-grouping) a bound + an unbound op both resolve", results.every((r) => r === "ok"));
    check("(null-grouping) a worktree-less op is never blocked by an unrelated worktree-bound one", maxActive3 === 2);
  }
}

// ── (1) Queued self-check cancellation, at the GateSemaphore level: cancelQueued / cancelQueuedForSession
{
  const sem = new GateSemaphore();
  let releaseHolder;
  const holder = new Promise((res) => { releaseHolder = res; });
  // Saturate cap 1 so the second call genuinely queues (never admitted).
  const pHolder = sem.runExclusive(1, { gateType: "merge", projectId: "p", sessionId: "mgr", worktreePath: "/wt/x" }, async () => { await holder; return "holder"; });
  await sleep(10);
  let selfCheckSpawned = false;
  const pSelfCheck = sem.runExclusive(
    1, { gateType: "worker", projectId: "p", sessionId: "worker-1", worktreePath: "/wt/x" },
    async () => { selfCheckSpawned = true; return "should never run"; },
    "low",
  );
  await sleep(10); // let it genuinely queue
  check("(auto-supersede) the self-check is QUEUED, not yet admitted (nothing spawned)", !selfCheckSpawned);
  // Code Review finding B2-1: a WRONG projectId must never cancel it — the guard closing the cross-project
  // supersede hole, exercised directly at the semaphore level.
  const wrongProjectOutcome = sem.cancelQueuedForSession("worker-1", "worker", "some-other-project", "superseded-by-merge", "should not match");
  check("(auto-supersede) cancelQueuedForSession with the WRONG projectId cancels nothing", wrongProjectOutcome.cancelled === false);
  check("(auto-supersede) the self-check is STILL queued after the wrong-project attempt", !selfCheckSpawned);
  const outcome = sem.cancelQueuedForSession("worker-1", "worker", "p", "superseded-by-merge", "manager decided to merge");
  check("(auto-supersede) cancelQueuedForSession finds and cancels the queued self-check", outcome.cancelled === true);
  let caught;
  try { await pSelfCheck; } catch (e) { caught = e; }
  check("(auto-supersede) the cancelled self-check REJECTS with GateCancelledError (never a runner exception)", caught instanceof GateCancelledError);
  check("(auto-supersede) the cancelled self-check's fn was NEVER invoked — zero process risk", !selfCheckSpawned);
  check("(auto-supersede) GateCancelledError carries the supersede kind", caught?.kind === "superseded-by-merge");
  releaseHolder("go");
  const holderResult = await pHolder;
  check("(auto-supersede) the holder (merge gate) still completes normally", holderResult === "holder");
  check("(auto-supersede) registry empty after both settle", sem.snapshot().entries.length === 0);
}

// ── (1) End-to-end via SessionService: queued self-check + worker_merge_confirm on the SAME worktree ────
// -> single admission (only the merge gate actually runs the fake gate); the self-check settles cancelled.
{
  const sfx = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-repos-${sfx}`);
  const db = new Db();
  dbs.push(db);
  db.setPlatformConfig({ maxConcurrentGates: 1 }); // saturate with an unrelated op so the self-check queues

  // Manager and worker are in the SAME project (a real Loom manager/worker pair — supersedeQueuedSelfCheck
  // is now project-scoped per Code Review finding B2-1, so a synthetic cross-project mgr/worker pairing
  // here would make the supersede this test exists to prove correctly refuse to fire).
  const agentId = `gc-agent-${sfx}`, mgrId = `gc-mgr-${sfx}`;
  const projId = `gc-proj-${sfx}`, taskId = `gc-task-${sfx}`, workerId = `gc-wkr-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "GC-W", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `${agentId}-w`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "GC-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  worktrees.push(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt"`, { cwd: worktreePath });
  db.insertSession({ id: workerId, projectId: projId, agentId: `${agentId}-w`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  // Saturate the cap-1 slot with a SECOND, unrelated worker's OWN run_gate so this worker's own run_gate
  // genuinely queues instead of being admitted immediately (which would make this test vacuous). BOTH
  // calls MUST go through the SAME SessionService instance — GateSemaphore is a per-instance in-memory
  // limiter (exactly one per real daemon process), so two separate SessionService objects would each get
  // their OWN independent semaphore and never actually contend for one shared cap.
  let releaseUnrelated;
  const unrelatedHold = new Promise((res) => { releaseUnrelated = res; });
  const projId2 = `gc-proj2-${sfx}`, taskId2 = `gc-task2-${sfx}`, workerId2 = `gc-wkr2-${sfx}`;
  const repo2 = path.join(reposDir, "worker2");
  makeRepo(repo2);
  db.insertProject({ id: projId2, name: "GC-W2", repoPath: repo2, vaultPath: repo2, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${agentId}-w2`, projectId: projId2, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId2, projectId: projId2, title: "GC-TASK-2", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt2 = await createWorktree(repo2, projId2, taskId2);
  worktrees.push(wt2.worktreePath);
  db.insertSession({ id: workerId2, projectId: projId2, agentId: `${agentId}-w2`, engineSessionId: null, title: null, cwd: wt2.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskId2, worktreePath: wt2.worktreePath, branch: wt2.branch });

  let gateCalls = 0;
  // Distinguishes the two workers by their OWN cwd (the only identifying arg a GateStepRunner receives) —
  // the holder (worker2's worktree) hangs until released; the real worker's own gate resolves quickly.
  const sharedFakeGate = async (_gate, cwd) => {
    if (cwd === wt2.worktreePath) { await unrelatedHold; return { passed: true }; }
    gateCalls++;
    await sleep(30);
    return { passed: true };
  };
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedFakeGate });

  const pHolderRun = sessions.runWorkerGate(workerId2); // occupies the ONE cap-1 slot

  // Poll (never a blind sleep — see waitUntil's own doc) until the holder has genuinely acquired the slot.
  await waitUntil(() => sessions.gateQueueForManager(projId2).activeCount === 1);

  // Now the worker's own run_gate queues (cap is saturated by the holder above).
  const pSelfCheck = sessions.runWorkerGate(workerId);
  await waitUntil(() => sessions.gateQueueForManager(projId).queued.length === 1);

  check("(e2e single-admission) the self-check has not run the real gate yet (still queued)", gateCalls === 0);

  // The manager decides to merge WHILE the self-check is STILL queued — confirmWorkerMergeTracked runs
  // supersedeQueuedSelfCheck as its own first (synchronous, pre-any-await) statement, so simply INITIATING
  // this call cancels the queued self-check before the merge's own union-merge/gate logic ever starts.
  // Deliberately NOT awaited yet: the merge's own gate call will itself queue behind the still-held
  // unrelated holder below, so awaiting here first would deadlock this test.
  // (supersedeQueuedSelfCheck already ran synchronously the instant the call above was MADE — an async
  // function's body runs up to its first `await` immediately, before control returns to this line.)
  const pMerge = sessions.confirmWorkerMergeTracked(mgrId, workerId);

  releaseUnrelated("go"); // free the slot the holder occupied, so the merge's own gate can now proceed
  await pHolderRun.catch(() => {});

  const mergeResult = await pMerge;
  const selfCheckSettled = await pSelfCheck;

  check("(e2e single-admission) the merge gate actually ran the real gate", gateCalls === 1);
  check("(e2e single-admission) the merge itself succeeded", mergeResult?.ok === true && mergeResult.value?.merged === true);
  check("(e2e single-admission) the self-check settled ok (never a thrown error surfaced to the caller)", selfCheckSettled.settled === true && selfCheckSettled.ok === true);
  check("(e2e single-admission) the self-check's OWN value reports cancelled, never a real pass/fail",
    selfCheckSettled.ok && selfCheckSettled.value?.cancelled === true && selfCheckSettled.value?.passed === undefined);
  check("(e2e single-admission) the cancel is tagged superseded-by-merge",
    selfCheckSettled.ok && selfCheckSettled.value?.cancelKind === "superseded-by-merge");
  // Single admission: the fake gate command only ever ran ONCE (the merge's own gate) — the self-check
  // never spawned a second, redundant run.
  check("(e2e single-admission) exactly ONE real gate invocation total (the self-check never double-ran)", gateCalls === 1);
}

// ── (2) gate_cancel refuses an op belonging to a DIFFERENT project ──────────────────────────────────────
{
  const sfx = `refuse-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-refuse-${sfx}`);
  const db = new Db();
  dbs.push(db);

  // Project A: a manager who will attempt the cancel.
  const projA = `gc-a-${sfx}`, mgrA = `gc-mgr-a-${sfx}`;
  const repoA = path.join(reposDir, "a");
  makeRepo(repoA);
  db.insertProject({ id: projA, name: "A", repoPath: repoA, vaultPath: repoA, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-a-${sfx}`, projectId: projA, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrA, projectId: projA, agentId: `agent-a-${sfx}`, engineSessionId: null, title: null, cwd: repoA, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  // Project B: owns the live gate op.
  const projB = `gc-b-${sfx}`, workerB = `gc-wkr-b-${sfx}`, taskB = `gc-task-b-${sfx}`;
  const repoB = path.join(reposDir, "b");
  makeRepo(repoB);
  db.insertProject({ id: projB, name: "B", repoPath: repoB, vaultPath: repoB, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-b-${sfx}`, projectId: projB, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskB, projectId: projB, title: "B-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wtB = await createWorktree(repoB, projB, taskB);
  worktrees.push(wtB.worktreePath);
  db.insertSession({ id: workerB, projectId: projB, agentId: `agent-b-${sfx}`, engineSessionId: null, title: null, cwd: wtB.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: null, taskId: taskB, worktreePath: wtB.worktreePath, branch: wtB.branch });

  let releaseB;
  const holdB = new Promise((res) => { releaseB = res; });
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => { await holdB; return { passed: true }; } });

  const pRun = sessions.runWorkerGate(workerB); // admits immediately (fresh semaphore, cap default)
  pRun.catch(() => {}); // observed via gateQueueForManager below, not its own settle

  // Find the live opId via gate_queue-equivalent read (gateQueueForManager scoped to project B) — polled,
  // never a blind sleep (see waitUntil's own doc).
  const liveEntry = await waitUntil(() => {
    const snapB = sessions.gateQueueForManager(projB);
    return snapB.running[0] ?? snapB.queued[0];
  });
  check("(refuse) found project B's live gate op", !!liveEntry);

  const cancelFromA = await sessions.cancelGateOp(mgrA, liveEntry.opId);
  check("(refuse) a DIFFERENT project's manager is REFUSED", cancelFromA.outcome === "refused");
  // The actual same-project running-op cancel path (accept + verify) is covered by the never-settling
  // test below, which also exercises cancelGateOp's RUNNING branch end to end.

  releaseB("go");
  await pRun.catch(() => {});
}

// ── Code Review finding B2-1: a manager who does NOT own a worker must not be able to cancel that
//    worker's queued self-check as a SIDE EFFECT of a refused worker_merge_confirm call. The ownership
//    ("not your worker") check lives deep inside confirmWorkerMerge, reached only via attach()'s factory;
//    supersedeQueuedSelfCheck fires as the FIRST statement of confirmWorkerMergeTracked, unconditionally,
//    before that check ever runs. RED-first: this block is written to demonstrate the bug against
//    UNFIXED code — run it before applying the projectId-scoping fix to confirm it fails, then again after
//    to confirm it passes.
{
  const sfx = `b2-1-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-b21-${sfx}`);
  const db = new Db();
  dbs.push(db);
  db.setPlatformConfig({ maxConcurrentGates: 1 });

  // Project A: an UNRELATED manager who does not own workerB at all.
  const projA = `gc-b21-a-${sfx}`, mgrA = `gc-b21-mgra-${sfx}`;
  const repoA = path.join(reposDir, "a");
  makeRepo(repoA);
  db.insertProject({ id: projA, name: "B21-A", repoPath: repoA, vaultPath: repoA, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-b21-a-${sfx}`, projectId: projA, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrA, projectId: projA, agentId: `agent-b21-a-${sfx}`, engineSessionId: null, title: null, cwd: repoA, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  // Project B: workerB's REAL manager (mgrB) and workerB itself.
  const projB = `gc-b21-b-${sfx}`, mgrB = `gc-b21-mgrb-${sfx}`, workerB = `gc-b21-wkr-${sfx}`, taskB = `gc-b21-task-${sfx}`;
  const repoB = path.join(reposDir, "b");
  makeRepo(repoB);
  db.insertProject({ id: projB, name: "B21-B", repoPath: repoB, vaultPath: repoB, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-b21-b-${sfx}`, projectId: projB, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrB, projectId: projB, agentId: `agent-b21-b-${sfx}`, engineSessionId: null, title: null, cwd: repoB, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertTask({ id: taskB, projectId: projB, title: "B21-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wtB = await createWorktree(repoB, projB, taskB);
  worktrees.push(wtB.worktreePath);
  fs.writeFileSync(path.join(wtB.worktreePath, "feature.txt"), "work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt"`, { cwd: wtB.worktreePath });
  db.insertSession({ id: workerB, projectId: projB, agentId: `agent-b21-b-${sfx}`, engineSessionId: null, title: null, cwd: wtB.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrB, taskId: taskB, worktreePath: wtB.worktreePath, branch: wtB.branch });

  // A second, unrelated worker (same project as workerB) whose run_gate saturates cap 1, so workerB's own
  // run_gate genuinely queues instead of running immediately.
  const projHolder = `gc-b21-h-${sfx}`, workerHolder = `gc-b21-hwkr-${sfx}`, taskHolder = `gc-b21-htask-${sfx}`;
  const repoHolder = path.join(reposDir, "holder");
  makeRepo(repoHolder);
  db.insertProject({ id: projHolder, name: "B21-H", repoPath: repoHolder, vaultPath: repoHolder, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-b21-h-${sfx}`, projectId: projHolder, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskHolder, projectId: projHolder, title: "B21-HTASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wtHolder = await createWorktree(repoHolder, projHolder, taskHolder);
  worktrees.push(wtHolder.worktreePath);
  db.insertSession({ id: workerHolder, projectId: projHolder, agentId: `agent-b21-h-${sfx}`, engineSessionId: null, title: null, cwd: wtHolder.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: null, taskId: taskHolder, worktreePath: wtHolder.worktreePath, branch: wtHolder.branch });

  let releaseHolder;
  const holderHold = new Promise((res) => { releaseHolder = res; });
  const sharedGate = async (_gate, cwd) => {
    if (cwd === wtHolder.worktreePath) { await holderHold; return { passed: true }; }
    return { passed: true };
  };
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate });

  const pHolderRun = sessions.runWorkerGate(workerHolder);
  await waitUntil(() => sessions.gateQueueForManager(projHolder).activeCount === 1);

  const pSelfCheck = sessions.runWorkerGate(workerB);
  await waitUntil(() => sessions.gateQueueForManager(projB).queued.length === 1);
  check("(B2-1) workerB's own self-check is queued (setup sanity)", sessions.gateQueueForManager(projB).queued.length === 1);

  // mgrA does NOT own workerB — confirmWorkerMergeTracked must refuse ("not your worker"), and per the
  // Code Review finding, must NOT have already cancelled workerB's queued self-check as a side effect of
  // even ATTEMPTING it.
  const mergeAttempt = await sessions.confirmWorkerMergeTracked(mgrA, workerB);
  check("(B2-1) the cross-manager merge attempt is genuinely refused (not your worker)",
    mergeAttempt.settled === true && mergeAttempt.ok === false && /not your worker/i.test(String(mergeAttempt.error?.message ?? mergeAttempt.error)));
  check("(B2-1) workerB's queued self-check is STILL queued — an unauthorized caller cancelled NOTHING",
    sessions.gateQueueForManager(projB).queued.length === 1);

  releaseHolder("go");
  await pHolderRun.catch(() => {});
  await pSelfCheck.catch(() => {});
}

// ── Code Review finding B2-2: gate_cancel's QUEUED branch has no gateType guard (unlike the RUNNING
//    branch, which explicitly refuses non-worker gates) — so a manager can cancel their OWN worker's
//    QUEUED merge gate, which throws an uncaught GateCancelledError inside confirmWorkerMerge (only
//    runWorkerGate catches it) and settles as `[loom:merge-failed] … errored: gate cancelled` — a
//    deliberate cancel misreported as a crash, potentially after mergeMainIntoWorktree already ran.
//    RED-first: written to demonstrate the bug against UNFIXED code.
{
  const sfx = `b2-2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-b22-${sfx}`);
  const db = new Db();
  dbs.push(db);
  db.setPlatformConfig({ maxConcurrentGates: 1 });

  // Manager and worker are in the SAME project (a real Loom manager/worker pair) — cancelGateOp's
  // project-scope check must PASS here so this test actually reaches the queued-branch gateType guard
  // under review, rather than being refused earlier at the (already-correct) project-scope check.
  const mgrId = `gc-b22-mgr-${sfx}`;
  const projId = `gc-b22-p-${sfx}`, taskId = `gc-b22-t-${sfx}`, workerId = `gc-b22-w-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "B22-W", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-b22-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-b22-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-b22-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "B22-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  worktrees.push(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt"`, { cwd: worktreePath });
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-b22-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  // A second, unrelated worker to saturate cap 1, so the MERGE gate itself (not just a worker self-check)
  // genuinely queues instead of running immediately.
  const projHolder = `gc-b22-h-${sfx}`, workerHolder = `gc-b22-hw-${sfx}`, taskHolder = `gc-b22-ht-${sfx}`;
  const repoHolder = path.join(reposDir, "holder");
  makeRepo(repoHolder);
  db.insertProject({ id: projHolder, name: "B22-H", repoPath: repoHolder, vaultPath: repoHolder, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-b22-h-${sfx}`, projectId: projHolder, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskHolder, projectId: projHolder, title: "B22-HTASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wtHolder = await createWorktree(repoHolder, projHolder, taskHolder);
  worktrees.push(wtHolder.worktreePath);
  db.insertSession({ id: workerHolder, projectId: projHolder, agentId: `agent-b22-h-${sfx}`, engineSessionId: null, title: null, cwd: wtHolder.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: null, taskId: taskHolder, worktreePath: wtHolder.worktreePath, branch: wtHolder.branch });

  let releaseHolder;
  const holderHold = new Promise((res) => { releaseHolder = res; });
  const sharedGate = async (_gate, cwd) => {
    if (cwd === wtHolder.worktreePath) { await holderHold; return { passed: true }; }
    return { passed: true };
  };
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate });

  const pHolderRun = sessions.runWorkerGate(workerHolder);
  await waitUntil(() => sessions.gateQueueForManager(projHolder).activeCount === 1);

  const pMergeConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId); // queues behind the holder
  const mergeEntry = await waitUntil(() => sessions.gateQueueForManager(projId).queued.find((e) => e.gateType === "merge"));
  check("(B2-2) the MERGE gate itself is queued (setup sanity)", !!mergeEntry);

  const cancelResult = await sessions.cancelGateOp(mgrId, mergeEntry.opId);
  check("(B2-2) cancelling a QUEUED merge gate is refused, never silently succeeds", cancelResult.outcome === "not_cancelled");

  releaseHolder("go");
  await pHolderRun.catch(() => {});
  const mergeResult = await pMergeConfirm;
  check("(B2-2) the merge itself is NEVER misreported as 'gate cancelled' — it settles for real",
    !(mergeResult.ok === false && /gate cancelled/i.test(String(mergeResult.error?.message ?? mergeResult.error))));
  check("(B2-2) the merge actually completed normally (refused cancel ≠ broken merge)",
    mergeResult.settled === true && mergeResult.ok === true && mergeResult.value?.merged === true);
}

// ── (3) The never-settling kill case: cancelGateOp must report NOT cancelled, and the slot must stay
//    held, when the underlying run never actually settles even after cancellation is requested. Asserted
//    on OBSERVED semaphore state (still 1 active, still occupying the worktree), never on wall-clock.
{
  const sfx = `hang-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-hang-${sfx}`);
  const db = new Db();
  dbs.push(db);

  const projId = `gc-hang-${sfx}`, workerId = `gc-wkr-hang-${sfx}`, taskId = `gc-task-hang-${sfx}`;
  const repo = path.join(reposDir, "hang");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "HANG", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-hang-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "HANG-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktree(repo, projId, taskId);
  worktrees.push(wt.worktreePath);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-hang-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: null, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

  // The fake gate NEVER settles, even once `cancelSignal` aborts — simulates a kill being issued whose
  // process-tree death can never be verified (the exact hazard this card's DoD names: "assert dead, do
  // not assume"). No timers, no retries — a single kill "attempt" (here, just observing the abort) that
  // deliberately never resolves this promise.
  //
  // OBSERVING THE ABORT: NOT a polled flag with an elapsed cap (card 44d1dfd8's own finding: a fixed poll
  // budget is a timing guess merely relocated from "how long until it happens" to "how long am I willing
  // to wait" — it does not become deterministic just because the guess moved). `abortObservedPromise`
  // resolves EXACTLY when the real abort is observed, however long that takes — no elapsed-time dimension
  // at all. If the real code path never delivers the abort (a genuine regression), this test hangs rather
  // than silently passing on a generous-but-still-arbitrary bound; the daemon test runner's own per-file
  // timeout (independent of this test's logic) is what catches a genuine hang, not a guessed duration
  // baked into this assertion's own pass/fail path.
  let resolveAbortObserved;
  const abortObservedPromise = new Promise((res) => { resolveAbortObserved = res; });
  const neverSettlingGate = (_gate, _cwd, _timeoutMs, _runStep, _envOverride, _allowExtend, cancelSignal) => new Promise(() => {
    // Mirrors the REAL runGateStep contract: an already-aborted signal (the abort can legitimately land
    // in the gap between semaphore admission and this fn actually starting — e.g. while runWorkerGate's
    // own pre-spawn admitStamp git call is still in flight) never re-fires its "abort" event, so a
    // realistic GateStepRunner must check `.aborted` up front, not ONLY listen for the event.
    if (!cancelSignal) return;
    if (cancelSignal.aborted) { resolveAbortObserved(); return; /* never resolves */ }
    cancelSignal.addEventListener("abort", () => resolveAbortObserved() /* never resolves */);
  });
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  // Tiny verify bound so this test doesn't wait out the real production default.
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: neverSettlingGate, gateCancelVerifyMs: 150 });

  const pRun = sessions.runWorkerGate(workerId).catch(() => {}); // never resolves in this test's lifetime
  const liveEntry = await waitUntil(() => sessions.gateQueueForManager(projId).running[0]);
  check("(never-settling) the self-check is RUNNING (admitted) before cancel", !!liveEntry);

  // "admitted" (RUNNING in the semaphore) fires BEFORE `fn` itself starts — runWorkerGate does its own
  // real git work (computeWorktreeGateStamp) inside `fn` before ever invoking the injected gate function —
  // so `cancelGateOp`'s (deliberately tiny, test-only) verify bound can genuinely elapse and this call can
  // RETURN before the fake gate has even been invoked yet. That race is exactly why `cancelResult` and
  // `abortObservedPromise` are asserted INDEPENDENTLY below, each on its own real completion signal, rather
  // than assuming one implies the timing of the other.
  const cancelResult = await sessions.cancelGateOp(workerId /* any manager id works here — same project */, liveEntry.opId);
  check("(never-settling) cancelGateOp reports NOT cancelled (kill unverified)", cancelResult.outcome === "not_cancelled");
  check("(never-settling) the reason names the verification bound, not a generic failure", /not verified dead/i.test(cancelResult.reason ?? ""));
  await abortObservedPromise; // no timeout — see its own doc above
  check("(never-settling) cancel was requested and (eventually) observed by the fake gate", true);

  // OBSERVED STATE, not wall-clock: the semaphore must still show this op RUNNING (slot NOT freed) — a
  // freed slot here would mean the daemon believes there's room for another op in a worktree whose work
  // may still genuinely be executing, which is strictly worse than not cancelling at all.
  const snapAfter = sessions.gateQueueForManager(projId);
  check("(never-settling) the op is STILL reported running — the slot was NOT freed on an unverified kill",
    snapAfter.running.some((e) => e.opId === liveEntry.opId));
  check("(never-settling) activeCount still reflects the held (unfreed) slot", snapAfter.activeCount === 1);

  void pRun; // deliberately left unresolved — this session/db is torn down below regardless
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GateSemaphore serializes same-worktree gate ops regardless of cap/tier (never grouping worktree-less ops together), a manager's merge decision auto-supersedes a worker's queued self-check for free, and gate_cancel is project-scoped + never frees a slot over an unverified kill."
  : `\n❌ ${failures} FAILURE(S).`);

for (const db of dbs) try { db.close(); } catch { /* ignore */ }
for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }

process.exit(failures === 0 ? 0 : 1);
