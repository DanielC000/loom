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
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gc-home-${Date.now()}-${process.pid}`);
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
// Retrofitted onto the shared _wait.mjs waitUntil (card 22796d42) — same timeoutMs/intervalMs defaults,
// same "return the predicate's own value; one last try, then give up honestly" contract on timeout — only
// difference is the added [waitUntil-outcome] diagnostic before that fallback try.
async function waitUntil(predicate, { intervalMs = 15, timeoutMs = 8000 } = {}) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: "gate-cancel: condition" });
  } catch {
    return predicate(); // one last try, then give up honestly
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

// ── Card 8f58c354 Half 2, NARROWED by card 361520a0 Half Two: `cancelQueued`'s OWN gateType constraint,
//    exercised DIRECTLY on the primitive. A queued `merge` entry is now CANCELLABLE (zero process risk —
//    nothing was ever spawned, same as a queued worker self-check); a queued `deploy` entry is STILL
//    refused (deployOwnProject has no GateCancelledError catch yet). Positive-controlled in BOTH
//    directions: the merge case proves a REAL cancel against a control that could equally have run for
//    real (the deploy sibling below); the deploy case proves the refusal against a control that DOES let
//    an identical-shaped entry through when cancel isn't attempted (this block's own merge case).
{
  const sem = new GateSemaphore();
  let releaseHolder;
  const holder = new Promise((res) => { releaseHolder = res; });
  // Saturate cap 1 with a WORKER entry so the synthetic merge entry below genuinely queues.
  const pHolder = sem.runExclusive(1, { gateType: "worker", projectId: "p", sessionId: "holder-1", worktreePath: "/wt/z" }, async () => { await holder; return "holder"; });
  await sleep(10);
  let mergeAdmitted = false;
  const pQueuedMerge = sem.runExclusive(
    1, { gateType: "merge", projectId: "p", sessionId: "mgr-2" },
    async () => { mergeAdmitted = true; return "merge-ran-for-real"; },
    "high",
  );
  await sleep(10); // let it genuinely queue
  check("(primitive gateType guard) the synthetic merge entry is queued, not yet admitted", !mergeAdmitted);
  const queuedMerge = sem.snapshot().entries.find((e) => e.gateType === "merge" && e.phase === "queued");
  check("(primitive gateType guard) found the queued merge entry via snapshot", !!queuedMerge);
  const cancelled = sem.cancelQueued(queuedMerge.id, "manual", "queued merge — should now be cancellable");
  check("(primitive gateType guard) cancelQueued now ALLOWS a queued merge entry (was refused before card 361520a0)", cancelled === true);
  let mergeCaught;
  try { await pQueuedMerge; } catch (e) { mergeCaught = e; }
  check("(primitive gateType guard) the cancelled merge entry REJECTS with GateCancelledError, never runs", mergeCaught instanceof GateCancelledError && !mergeAdmitted);
  // Checked AFTER awaiting the rejection above, not immediately after cancelQueued() returns: `cancelQueued`
  // splices the waiter out synchronously, but the REGISTRY map entry (what `snapshot()` reads) is only
  // deleted in `runExclusive`'s own `finally`, which runs on the NEXT microtask once the thrown
  // GateCancelledError actually propagates — checking synchronously here would be a timing artifact of
  // this test, not a real defect.
  check("(primitive gateType guard) the merge entry is GONE from the queue once the cancel has fully settled",
    !sem.snapshot().entries.some((e) => e.id === queuedMerge.id));

  // Sibling, same setup shape: a queued `deploy` entry is STILL refused — the negative control that proves
  // the widened check is scoped to `merge` specifically, not "everything but worker".
  let deployAdmitted = false;
  const pQueuedDeploy = sem.runExclusive(
    1, { gateType: "deploy", projectId: "p", sessionId: "mgr-3" },
    async () => { deployAdmitted = true; return "deploy-ran-for-real"; },
    "high",
  );
  await sleep(10); // let it genuinely queue (still behind the same holder)
  const queuedDeploy = sem.snapshot().entries.find((e) => e.gateType === "deploy" && e.phase === "queued");
  check("(primitive gateType guard) found the queued deploy entry via snapshot", !!queuedDeploy);
  const deployCancelResult = sem.cancelQueued(queuedDeploy.id, "manual", "should still be refused — deploy has no GateCancelledError catch");
  check("(primitive gateType guard) cancelQueued STILL REFUSES a queued deploy entry", deployCancelResult === false);
  check("(primitive gateType guard) the deploy entry is STILL queued after the refused cancel attempt",
    sem.snapshot().entries.some((e) => e.id === queuedDeploy.id && e.phase === "queued"));

  releaseHolder("go");
  const [holderResult, deployResult] = await Promise.all([pHolder, pQueuedDeploy]);
  check("(primitive gateType guard) positive control — the never-cancelled deploy entry WAS admitted and ran for real",
    deployAdmitted === true && deployResult === "deploy-ran-for-real");
  check("(primitive gateType guard) the holder completed normally too", holderResult === "holder");
}

// ── (1) End-to-end via SessionService: queued self-check + worker_merge_confirm on the SAME worktree ────
// -> single admission (only the merge gate actually runs the fake gate); the self-check settles cancelled.
{
  const sfx = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-repos-${sfx}`);
  registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
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
  registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
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

  // Guard: a timed-out waitUntil yields undefined — dereferencing liveEntry.opId unguarded is the exact
  // shape card f5767961 fixed (B2-2's crash). Skip the dependent assertions rather than crash the file.
  if (liveEntry) {
    const cancelFromA = await sessions.cancelGateOp(mgrA, liveEntry.opId);
    check("(refuse) a DIFFERENT project's manager is REFUSED", cancelFromA.outcome === "refused");
    // Pin the REASON, not just the outcome (card 8f58c354) — a future refusal branch could produce the same
    // "refused" outcome for a different reason (e.g. an auth check unrelated to project scope) and this
    // assertion would read green while no longer proving cross-project scoping actually fired.
    check("(refuse) the reason names project scope specifically", /different project/i.test(cancelFromA.reason ?? ""));
  } else {
    console.log("SKIP  (refuse) cancel assertions — setup sanity check above already failed");
  }
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
  registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
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

// ── The gate-superseded nudge's `reason` text must not assert a merge HAPPENED when the confirm that
//    triggered the supersede is then REFUSED. Sibling of the B2-1 block above, but SAME-project this
//    time: B2-1's mgrA is in a DIFFERENT project, so supersedeQueuedSelfCheck's own projectId check
//    refuses it before anything is cancelled. Here mgrA is a PEER manager in the SAME project as
//    workerB's real owner (mgrB) — that project-level (not ownership-level) scope is DELIBERATE (mirrors
//    gate_cancel's own scope; see supersedeQueuedSelfCheck's doc) — so this confirm DOES supersede
//    workerB's queued self-check, even though confirmWorkerMerge itself goes on to refuse the confirm
//    ("not your worker", checked deeper in the call chain, well after the supersede already fired). The
//    self-check's own settled `reason` — the exact text also threaded into the worker's
//    `[loom:gate-superseded]` nudge and into `gate_status`'s cancelled payload — must therefore read
//    truthfully for this exact case: it must NOT claim a merge happened or was decided, only that a
//    manager in this project called worker_merge_confirm for this worker. RED-first: this fails against
//    the pre-fix text ("the manager decided to merge — this self-check's result would no longer be
//    used") and passes against the corrected text.
{
  const sfx = `wording-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-wording-${sfx}`);
  registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
  const db = new Db();
  dbs.push(db);
  db.setPlatformConfig({ maxConcurrentGates: 1 });

  const projId = `gc-wd-p-${sfx}`;
  const mgrB = `gc-wd-mgrb-${sfx}`, mgrA = `gc-wd-mgra-${sfx}`; // PEERS in the SAME project
  const workerB = `gc-wd-wkr-${sfx}`, taskB = `gc-wd-task-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "WD", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-wd-a-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrA, projectId: projId, agentId: `agent-wd-a-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-wd-b-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrB, projectId: projId, agentId: `agent-wd-b-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-wd-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskB, projectId: projId, title: "WD-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wtB = await createWorktree(repo, projId, taskB);
  worktrees.push(wtB.worktreePath);
  fs.writeFileSync(path.join(wtB.worktreePath, "feature.txt"), "work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt"`, { cwd: wtB.worktreePath });
  db.insertSession({ id: workerB, projectId: projId, agentId: `agent-wd-w-${sfx}`, engineSessionId: null, title: null, cwd: wtB.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrB, taskId: taskB, worktreePath: wtB.worktreePath, branch: wtB.branch });

  // A second, unrelated worker (same project) to saturate cap 1, so workerB's own self-check genuinely
  // queues instead of running immediately.
  const workerHolder = `gc-wd-hwkr-${sfx}`, taskHolder = `gc-wd-htask-${sfx}`;
  const repoHolder = path.join(reposDir, "holder");
  makeRepo(repoHolder);
  db.insertAgent({ id: `agent-wd-h-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskHolder, projectId: projId, title: "WD-HTASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wtHolder = await createWorktree(repoHolder, projId, taskHolder);
  worktrees.push(wtHolder.worktreePath);
  db.insertSession({ id: workerHolder, projectId: projId, agentId: `agent-wd-h-${sfx}`, engineSessionId: null, title: null, cwd: wtHolder.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: null, taskId: taskHolder, worktreePath: wtHolder.worktreePath, branch: wtHolder.branch });

  let releaseHolder;
  const holderHold = new Promise((res) => { releaseHolder = res; });
  const sharedGate = async (_gate, cwd) => {
    if (cwd === wtHolder.worktreePath) { await holderHold; return { passed: true }; }
    return { passed: true };
  };
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate });

  const pHolderRun = sessions.runWorkerGate(workerHolder);
  await waitUntil(() => sessions.gateQueueForManager(projId).activeCount === 1);

  const pSelfCheck = sessions.runWorkerGate(workerB);
  await waitUntil(() => sessions.gateQueueForManager(projId).queued.length === 1);
  check("(wording) workerB's own self-check is queued (setup sanity)", sessions.gateQueueForManager(projId).queued.length === 1);

  // mgrA is a PEER manager (same project) but does NOT own workerB — confirmWorkerMergeTracked must
  // refuse ("not your worker"), same as B2-1's own assertion shape — but here, UNLIKE B2-1, the queued
  // self-check DOES get superseded as a side effect, because supersedeQueuedSelfCheck's project-level
  // scope matches (both mgrA and workerB are in projId). That's the existing, deliberate scope — this
  // block is about the WORDING of what the worker is then told, not about whether the supersede itself
  // should fire (it should, and must keep firing).
  const mergeAttempt = await sessions.confirmWorkerMergeTracked(mgrA, workerB);
  check("(wording) the same-project peer manager's merge attempt is genuinely refused (not your worker)",
    mergeAttempt.settled === true && mergeAttempt.ok === false && /not your worker/i.test(String(mergeAttempt.error?.message ?? mergeAttempt.error)));

  const selfCheckSettled = await pSelfCheck;
  check("(wording) workerB's queued self-check WAS superseded despite the refused confirm (deliberate project-level scope, unchanged)",
    selfCheckSettled.ok === true && selfCheckSettled.value?.cancelled === true && selfCheckSettled.value?.cancelKind === "superseded-by-merge");
  const reasonText = String(selfCheckSettled.value?.reason ?? "");
  check("(wording) the reason text is non-empty (setup sanity — everything downstream reads this string)", reasonText.length > 0);
  // THE ACTUAL BUG: the pre-fix text asserted "the manager decided to merge" unconditionally — false on
  // THIS path, where the confirm that triggered the supersede was refused, not decided.
  check("(wording) the reason text does NOT assert a merge happened or was decided — this confirm was REFUSED",
    !/decided to merge/i.test(reasonText) && !/\bmerged?\b/i.test(reasonText));
  check("(wording) the reason text still names the real, unconditional trigger — the worker_merge_confirm call itself, true regardless of that call's own outcome",
    /worker_merge_confirm/i.test(reasonText) && /regardless/i.test(reasonText));

  releaseHolder("go");
  await pHolderRun.catch(() => {});
}

// ── Card 8f58c354 B2-2 origin, INVERTED by card 361520a0 Half Two: gate_cancel's QUEUED branch used to
//    have no gateType guard for merge, so cancelling a manager's OWN worker's QUEUED merge gate threw an
//    uncaught GateCancelledError inside confirmWorkerMerge and settled as `[loom:merge-failed] … errored:
//    gate cancelled` — a deliberate cancel misreported as a crash. Half Two made this an INTENDED,
//    supported operation: `confirmWorkerMerge` now catches GateCancelledError and settles a clean
//    `cancelled:true` ConfirmMergeResult instead. This block proves the NEW behavior — negative control
//    (before this card, `outcome` would have been `not_cancelled`) pasted alongside the positive result.
{
  const sfx = `b2-2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-b22-${sfx}`);
  registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
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
  // Tracks whether the REAL worker's own gate ever actually spawned — a cancelled QUEUED op must never
  // reach here (fn is never invoked for a withdrawn admission).
  let realWorkerGateSpawned = false;
  const sharedGate = async (_gate, cwd) => {
    if (cwd === wtHolder.worktreePath) { await holderHold; return { passed: true }; }
    realWorkerGateSpawned = true;
    return { passed: true };
  };
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate });

  const pHolderRun = sessions.runWorkerGate(workerHolder);
  await waitUntil(() => sessions.gateQueueForManager(projHolder).activeCount === 1);

  const pMergeConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId); // queues behind the holder
  const mergeEntry = await waitUntil(() => sessions.gateQueueForManager(projId).queued.find((e) => e.gateType === "merge"));
  check("(B2-2) the MERGE gate itself is queued (setup sanity)", !!mergeEntry);

  // Guard: this is the exact site that fired live (op 6e29e337, card f5767961) — a timed-out waitUntil
  // yields undefined, and dereferencing mergeEntry.opId unguarded turned a soft, correctly-reported
  // assertion failure into a TypeError that killed the whole suite. Skip the dependent assertions instead.
  if (mergeEntry) {
    const cancelResult = await sessions.cancelGateOp(mgrId, mergeEntry.opId);
    check("(B2-2/361520a0) cancelling a QUEUED merge gate now SUCCEEDS — negative control: before this card outcome would be 'not_cancelled'",
      cancelResult.outcome === "cancelled" && cancelResult.phase === "queued" && cancelResult.gateType === "merge");
  } else {
    console.log("SKIP  (B2-2) cancel assertions — setup sanity check above already failed");
  }

  releaseHolder("go");
  await pHolderRun.catch(() => {});
  const mergeResult = await pMergeConfirm;
  if (mergeEntry) {
    check("(B2-2/361520a0) the merge settles OK (never a thrown/rejected error) despite the cancel",
      mergeResult.settled === true && mergeResult.ok === true);
    check("(B2-2/361520a0) the merge's OWN value reports cancelled, never merged and never a generic rejection",
      mergeResult.ok && mergeResult.value?.cancelled === true && mergeResult.value?.merged === false);
    check("(B2-2/361520a0) the cancel is tagged 'manual' (gate_cancel, not an automatic supersede)",
      mergeResult.ok && mergeResult.value?.cancelKind === "manual");
    check("(B2-2/361520a0) it is NEVER misreported as a crash-shaped 'gate cancelled' error string",
      !/errored:.*gate cancelled/i.test(String(mergeResult.value?.reason ?? mergeResult.value?.detailText ?? "")));
    check("(B2-2/361520a0) the real worker's OWN gate command NEVER actually spawned — the cancel fired before admission",
      realWorkerGateSpawned === false);

    // DoD-5 (Code Review, card 361520a0): the SYNC `mergeResult.value.cancelled` shape above only proves
    // the immediate return value — it says nothing about what the DURABLE tombstone (gate_status/
    // gate_history's own read path) recorded via deriveMergeGateVerdict's cancelled branch. Before this
    // assertion existed, that branch shipped completely UNEXERCISED by any test: a cancelled MERGE op's
    // verdict could regress to "fail" (the exact DoD-3 class this card fixes for the async nudge/Board
    // hairline) with nothing here to catch it.
    const cancelledStatus = sessions.gateStatus(mergeEntry.opId);
    check("(B2-2/361520a0 — DoD-5) gate_status reports outcome:\"cancelled\" for the settled tombstone, NEVER \"fail\"",
      cancelledStatus.state === "settled" && cancelledStatus.outcome === "cancelled" && cancelledStatus.outcome !== "fail");
    check("(B2-2/361520a0 — DoD-5) gate_status's cancelled:true flag is set, passed is NOT (never a fabricated pass/fail on a cancel)",
      cancelledStatus.cancelled === true && cancelledStatus.passed === undefined);
  }
}

// ── DoD-6, THE LOAD-BEARING TEST (card 361520a0): a RUNNING merge gate must STILL refuse cancellation —
//    interrupting one risks leaving staged residue in the canonical checkout (memory
//    concurrent-squash-merges-lose-work, trigger 2), which fails closed and needs a HUMAN to clear it by
//    hand. Half Two ONLY widened the QUEUED case; this asserts the RUNNING case is untouched. Positive
//    control: the SAME merge gate is later allowed to complete normally (not a queue that never advances).
{
  const sfx = `running-refused-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-run-${sfx}`);
  registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
  const db = new Db();
  dbs.push(db);

  const mgrId = `gc-run-mgr-${sfx}`;
  const projId = `gc-run-p-${sfx}`, taskId = `gc-run-t-${sfx}`, workerId = `gc-run-w-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "RUN-W", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-run-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-run-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-run-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "RUN-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  worktrees.push(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt"`, { cwd: worktreePath });
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-run-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  // Cap default (1) with nothing else queued — the merge gate admits (RUNS) immediately, never queues.
  let releaseGate;
  const gateHold = new Promise((res) => { releaseGate = res; });
  let gateSpawned = false;
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => { gateSpawned = true; await gateHold; return { passed: true }; } });

  const pMergeConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId);
  // Since card b798e706: "admitted" (RUNNING in the semaphore) fires BEFORE `fn` itself starts —
  // confirmWorkerMerge's merge-gate `fn` now does its OWN real git work (the admission-time
  // gateBaseMainHead re-derivation — a `git rev-parse HEAD`, genuinely async) before ever invoking the
  // injected gate function, mirroring the SAME pre-existing gap runWorkerGate's `fn` already has via
  // computeWorktreeGateStamp (see the "(never-settling)" block below, which already asserts around this
  // for the worker-gate path). So `running.find(...)` can resolve before `gateSpawned` flips true — wait
  // for BOTH independently rather than assuming one implies the timing of the other.
  const mergeEntry = await waitUntil(() => sessions.gateQueueForManager(projId).running.find((e) => e.gateType === "merge"));
  await waitUntil(() => gateSpawned);
  check("(DoD-6) the MERGE gate is genuinely RUNNING, not queued (setup sanity)", !!mergeEntry && gateSpawned === true);

  if (mergeEntry) {
    const cancelResult = await sessions.cancelGateOp(mgrId, mergeEntry.opId);
    check("(DoD-6) cancelling a RUNNING merge gate is REFUSED", cancelResult.outcome === "not_cancelled");
    check("(DoD-6) the refusal names the RUNNING-merge-specific reason, not a generic/queued one",
      /RUNNING merge gate is not supported/i.test(cancelResult.reason ?? ""));
    check("(DoD-6) the gate op is STILL reported running — refusing the cancel never freed the slot",
      sessions.gateQueueForManager(projId).running.some((e) => e.opId === mergeEntry.opId));
  } else {
    console.log("SKIP  (DoD-6) cancel assertions — setup sanity check above already failed");
  }

  // Positive control: the SAME merge gate, left alone, completes normally — this queue genuinely advances,
  // so the refusal above was a real decision, not a queue that could never have produced a different result.
  releaseGate("go");
  const mergeResult = await pMergeConfirm;
  if (mergeEntry) {
    check("(DoD-6) positive control — the never-cancelled RUNNING merge gate completed for real",
      mergeResult.settled === true && mergeResult.ok === true && mergeResult.value?.merged === true);
  }
}

// ── (3) The never-settling kill case: cancelGateOp must report NOT cancelled, and the slot must stay
//    held, when the underlying run never actually settles even after cancellation is requested. Asserted
//    on OBSERVED semaphore state (still 1 active, still occupying the worktree), never on wall-clock.
{
  const sfx = `hang-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-hang-${sfx}`);
  registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
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

  // Guard: a timed-out waitUntil yields undefined — dereferencing liveEntry.opId unguarded is the same
  // shape card f5767961 fixed. Skip the dependent assertions rather than crash the file. (Also: if
  // liveEntry were undefined, cancelGateOp below would never be called, so abortObservedPromise would
  // never resolve — awaiting it unconditionally would hang the whole suite, not just fail an assertion.)
  if (liveEntry) {
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
  } else {
    console.log("SKIP  (never-settling) cancel/abort assertions — setup sanity check above already failed");
  }

  void pRun; // deliberately left unresolved — this session/db is torn down below regardless
}

// ── Positive control for the fix (card f5767961 DoD 3): force a waitUntil call to genuinely time out —
//    a predicate that can NEVER become true, since this SessionService instance never runs a single gate
//    op — with a short bound so this doesn't cost the real 8s production budget, then prove the guarded
//    shape used at all three sites fixed above (the "refuse" block, B2-2, and "never-settling") now
//    reports a clean FAIL and skips, rather than dereferencing undefined and crashing. "The suite went
//    green" can't tell a repaired guard from a run that simply never hit the race — this deliberately
//    hits it. Uses its own local check-alike so the FORCED sanity FAIL below doesn't pollute this file's
//    real pass/fail signal; what's asserted with the real `check` is the control's own outcome.
{
  const sfx = `timeout-control-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const db = new Db();
  dbs.push(db);
  // Nothing is ever inserted or enqueued on this fresh SessionService — gateQueueForManager legitimately
  // reports an empty queue forever, so this waitUntil is GUARANTEED to exhaust its (short, test-only)
  // budget and yield undefined — deterministically reproducing the "op hadn't queued yet" shape from the
  // live incident, without waiting out the real 8s production timeout or racing real host load.
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});

  let controlFailures = 0;
  const controlCheck = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) controlFailures++; };

  const mergeEntry = await waitUntil(() => sessions.gateQueueForManager(`gc-tc-${sfx}`).queued.find((e) => e.gateType === "merge"), { intervalMs: 5, timeoutMs: 100 });
  controlCheck("(timeout control) the forced-timeout waitUntil genuinely gives up and yields undefined", mergeEntry === undefined);

  // The FIXED shape: guard before dereferencing — mirrors the if/else added at the three sites above.
  let tookSkipBranch = false, threwInFixedShape = false;
  try {
    if (mergeEntry) { void mergeEntry.opId; } else { tookSkipBranch = true; }
  } catch { threwInFixedShape = true; }
  controlCheck("(timeout control) the fixed (guarded) shape takes the skip branch, never throws", tookSkipBranch && !threwInFixedShape);

  // Not vacuous: the OLD unguarded shape (what actually shipped and crashed live, op 6e29e337) DOES throw
  // a TypeError on this same undefined value — proves this control could have caught the original bug.
  let oldShapeThrew = false;
  try { void mergeEntry.opId; } catch (e) { oldShapeThrew = e instanceof TypeError; }
  controlCheck("(timeout control) the OLD unguarded shape DOES throw TypeError here — control is not vacuous", oldShapeThrew);

  // Assert on the CONTROL's own outcome with the real `check` — this is what should affect the suite's
  // real pass/fail signal, not the deliberately-forced sanity FAIL inside the control itself.
  check("(timeout control) forced timeout: sanity check correctly failed, the fixed guard skipped cleanly without throwing, and the old unguarded shape is proven non-vacuous",
    controlFailures === 0);
}

// ── (b) gate_cancel resolves a QUEUED repo-guard-only wait — Code Review MAJOR, card b9e07a4a: a
// brand-new throw path through the merge entry point (confirmWorkerMerge's own GateCancelledError catch
// around acquireRepoGuardOnly) with ZERO coverage before this. Two real workers sharing a repo: worker1
// holds it with a real, injected-slow gate; worker2's inert-diff skip queues behind it; the manager
// cancels worker2's wait via gate_cancel, and worker2's confirmWorkerMerge call must settle CLEANLY as a
// cancellation, never a crash-shaped generic failure. ──────────────────────────────────────────────────
{
  const sfx = `rgo-b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const repo = path.join(os.tmpdir(), `loom-gc-rgo-b-${sfx}`);
  registerForCleanup(repo); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repo dir
  makeRepo(repo);
  const db = new Db(); dbs.push(db);
  const P1 = `gc-rgo-b-proj-${sfx}`;
  db.insertProject({ id: P1, name: "RGO-B", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${P1}-agent`, projectId: P1, name: "t", startupPrompt: "", position: 0 });
  const mgrId = `${P1}-mgr`;
  db.insertSession({ id: mgrId, projectId: P1, agentId: `${P1}-agent`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  let gate1AdmittedResolve;
  const gate1Admitted = new Promise((res) => { gate1AdmittedResolve = res; });
  let releaseGate1;
  const fakeGate = async () => {
    gate1AdmittedResolve();
    await new Promise((res) => { releaseGate1 = res; });
    return { passed: true };
  };
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

  const task1Id = `${P1}-task-1`, task2Id = `${P1}-task-2`;
  const worker1Id = `${P1}-wkr-1`, worker2Id = `${P1}-wkr-2`;
  db.insertTask({ id: task1Id, projectId: P1, title: "RGO-B-REAL", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertTask({ id: task2Id, projectId: P1, title: "RGO-B-INERT", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });

  const wt1 = await createWorktree(repo, P1, task1Id);
  worktrees.push(wt1.worktreePath);
  fs.mkdirSync(path.join(wt1.worktreePath, "src"), { recursive: true });
  fs.writeFileSync(path.join(wt1.worktreePath, "src", "index.ts"), "export const x = 1;\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "feat: real change"`, { cwd: wt1.worktreePath });
  db.insertSession({ id: worker1Id, projectId: P1, agentId: `${P1}-agent`, engineSessionId: null, title: null, cwd: wt1.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: task1Id, worktreePath: wt1.worktreePath, branch: wt1.branch });

  const wt2 = await createWorktree(repo, P1, task2Id);
  worktrees.push(wt2.worktreePath);
  fs.mkdirSync(path.join(wt2.worktreePath, "docs"), { recursive: true });
  fs.writeFileSync(path.join(wt2.worktreePath, "docs", "note.md"), "notes\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "docs: add note"`, { cwd: wt2.worktreePath });
  db.insertSession({ id: worker2Id, projectId: P1, agentId: `${P1}-agent`, engineSessionId: null, title: null, cwd: wt2.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: task2Id, worktreePath: wt2.worktreePath, branch: wt2.branch });

  const p1 = sessions.confirmWorkerMerge(mgrId, worker1Id);
  await gate1Admitted; // worker1's real gate is genuinely mid-run, holding the repo guard

  const p2 = sessions.confirmWorkerMerge(mgrId, worker2Id); // worker2's inert skip queues behind worker1

  const waiterEntry = await waitUntil(() => sessions.gateQueueForManager(P1).repoGuardOnly.find((e) => e.phase === "queued"));
  check("(b) precondition: worker2's inert-skip wait is genuinely QUEUED and visible in gate_queue", !!waiterEntry);

  if (waiterEntry) {
    const cancelResult = await sessions.cancelGateOp(mgrId, waiterEntry.opId);
    check("(b) gate_cancel resolves worker2's QUEUED repo-guard-only wait", cancelResult.outcome === "cancelled" && cancelResult.phase === "queued" && cancelResult.gateType === "merge");

    const confirm2 = await p2;
    check("(b) worker2's confirmWorkerMerge settles as a CLEAN cancellation, not a crash/generic failure", confirm2.merged === false && confirm2.cancelled === true && confirm2.cancelKind === "manual");
    check("(b) worker2's cancellation names a real reason (the cancelGateOp detail text)", typeof confirm2.reason === "string" && confirm2.reason.length > 0);
  }

  releaseGate1("go");
  const confirm1 = await p1;
  check("(b) worker1 (the sibling) merged successfully, unaffected by worker2's cancellation", confirm1.merged === true);
}

// ── (c) gate_cancel: a FOREIGN project's QUEUED repo-guard-only wait is REFUSED — Code Review MAJOR,
// card b9e07a4a: mirrors the existing cross-project refusal for the ordinary registry above, now also
// proven for the fallback lookup. ──────────────────────────────────────────────────────────────────────
{
  const sfx = `rgo-c-${Date.now()}`;
  const db = new Db(); dbs.push(db);
  const P1 = `gc-rgo-c-own-${sfx}`, P2 = `gc-rgo-c-foreign-${sfx}`;
  db.insertProject({ id: P1, name: "RGO-C Own", repoPath: "/tmp/rgo-c-own", vaultPath: "/tmp/rgo-c-own", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: P2, name: "RGO-C Foreign", repoPath: "/tmp/rgo-c-foreign", vaultPath: "/tmp/rgo-c-foreign", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${P1}-a`, projectId: P1, name: "t", startupPrompt: "", position: 0 });
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});
  const mgr1 = `${P1}-mgr`;
  db.insertSession({ id: mgr1, projectId: P1, agentId: `${P1}-a`, engineSessionId: null, title: null, cwd: "/tmp/rgo-c-own", processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  // P2's own op HOLDS repoPath R, then a SECOND P2 op QUEUES behind it (opId "rgo-c-waiter") — P1's
  // manager should never be able to touch either.
  const releaseHolder = await sessions.gateSemaphore.acquireRepoGuardOnly({ repoPath: "/tmp/rgo-c-foreign/repo", projectId: P2, sessionId: "holder", opId: "rgo-c-holder" });
  const pWaiter = sessions.gateSemaphore.acquireRepoGuardOnly({ repoPath: "/tmp/rgo-c-foreign/repo", projectId: P2, sessionId: "waiter", opId: "rgo-c-waiter" }).catch((e) => e);
  await waitUntil(() => sessions.gateQueueForManager(P2).repoGuardOnly.some((e) => e.phase === "queued"));

  const cancelResult = await sessions.cancelGateOp(mgr1, "rgo-c-waiter"); // P1's manager, P2's opId
  check("(c) a DIFFERENT project's QUEUED repo-guard-only wait is REFUSED", cancelResult.outcome === "refused");
  check("(c) the refusal names the cross-project reason", /different project/i.test(cancelResult.reason ?? ""));

  releaseHolder();
  const waiterResult = await pWaiter;
  check("(c) the waiter itself was NEVER touched by the refused attempt — it still resolves normally (not a GateCancelledError)", typeof waiterResult === "function");
  waiterResult();
}

// ── (d) gate_cancel: a HOLDING repo-guard-only entry is REFUSED (not_cancelled) — Code Review MAJOR,
// card b9e07a4a: interrupting an in-flight hold risks the same staged-residue hazard a RUNNING merge gate
// cancel is already refused for; only a QUEUED wait is ever zero-risk. ───────────────────────────────────
{
  const sfx = `rgo-d-${Date.now()}`;
  const db = new Db(); dbs.push(db);
  const P1 = `gc-rgo-d-${sfx}`;
  db.insertProject({ id: P1, name: "RGO-D", repoPath: "/tmp/rgo-d", vaultPath: "/tmp/rgo-d", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${P1}-a`, projectId: P1, name: "t", startupPrompt: "", position: 0 });
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});
  const mgr1 = `${P1}-mgr`;
  db.insertSession({ id: mgr1, projectId: P1, agentId: `${P1}-a`, engineSessionId: null, title: null, cwd: "/tmp/rgo-d", processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const release = await sessions.gateSemaphore.acquireRepoGuardOnly({ repoPath: "/tmp/rgo-d/repo", projectId: P1, sessionId: "holder-d", opId: "rgo-d-holder" });
  const cancelResult = await sessions.cancelGateOp(mgr1, "rgo-d-holder");
  check("(d) cancelling a HOLDING repo-guard-only wait is REFUSED (not_cancelled)", cancelResult.outcome === "not_cancelled");
  check("(d) the refusal names the staged-residue/HOLDING reason, not a generic one", /staged-residue|HOLDING/i.test(cancelResult.reason ?? ""));
  release();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GateSemaphore serializes same-worktree gate ops regardless of cap/tier (never grouping worktree-less ops together), a manager's merge decision auto-supersedes a worker's queued self-check for free, gate_cancel is project-scoped + never frees a slot over an unverified kill, and — card b9e07a4a — the SAME tool now reaches a repo-guard-only wait: a QUEUED one cancels cleanly through confirmWorkerMerge's own merge_cancelled path, a foreign project's is refused, and a HOLDING one is refused for the same staged-residue reason a RUNNING merge gate is."
  : `\n❌ ${failures} FAILURE(S).`);

for (const db of dbs) try { db.close(); } catch { /* ignore */ }
for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }

process.exit(failures === 0 ? 0 : 1);
