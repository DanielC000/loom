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
import { commitAll } from "./_git-commit.mjs";

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
// GENEROUS syncAttachBudgetMs (card 71a6a29e, sibling of c188412a): the `settled === true` checks assert the OUTCOME, not
// wall-clock — under host load a confirm/self-check outliving the default 12s degrades to pending. DI-seam idiom, never
// the production constant. Ctors that don't assert a settle (gate-cancel's registry-only / {} cases) are left on the default.
const GENEROUS_SYNC_BUDGET_MS = 600_000;
// Poll instead of a blind fixed sleep for "has this op reached the live registry yet" — a blind sleep is
// exactly the wall-clock-coincidence flake this file's own DoD explicitly rejects (never assert on elapsed
// wall-clock), and it's genuinely too fragile here: a block running right after a real squash-merge/
// worktree-removal can see its OWN git subprocess prep take longer than a fixed short sleep under host
// load. Bounded generously (16s) so a real bug still fails fast rather than hanging.
// Retrofitted onto the shared _wait.mjs waitUntil (card 22796d42) — same timeoutMs/intervalMs defaults,
// same "return the predicate's own value; one last try, then give up honestly" contract on timeout — only
// difference is the added [waitUntil-outcome] diagnostic before that fallback try.
// Card 43f5b242: kept as a local wrapper rather than flattened to bare `sharedWaitUntil` calls — its
// never-throw contract genuinely differs from the shared helper's throw-on-timeout one, and real call
// sites below (e.g. the `liveEntry`/`mergeEntry` guards) depend on a timed-out call yielding undefined
// instead of throwing. merge-gate-retry.mjs/merge-gate-single-file-retry.mjs now share this exact pattern.
// Card 88469855: the 8s default genuinely arrived LATE, not never — the (e2e single-admission)/(DoD-6)
// scenarios' own retained log showed "[waitUntil-outcome] ARRIVED LATE at 10829ms (budget 8000ms,
// overshoot 1.4x)". Same mechanism this comment already documented above (real git subprocess prep under
// host contention, not a production ordering bug — see case (O)'s identical fix in
// emit-compare-gate-scope-reclassify.mjs for the fault-injection proof this is a genuine-but-slow
// condition, never an error). 16s keeps ~2x margin over the one measured overshoot while still failing a
// genuinely wedged op in well under this file's per-test budget.
async function waitUntil(predicate, { intervalMs = 15, timeoutMs = 16000, label = "gate-cancel: condition" } = {}) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label });
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
  // Card 0910531e: a baseline JS/TS file, committed alongside README.md, so this fixture models a
  // genuine JS/TS project — scenario (b) below depends on worker2's docs/-only diff being classified
  // inert (so it takes the repo-guard-only-wait path this scenario exists to test), which
  // `repoTreeReferencesInertPrefix`'s applicability guard (`repoTreeHasJsTsSourceFile`) now correctly
  // refuses to trust for a repo with no JS/TS files at all. Same reasoning as
  // `merge-gate-inert-diff.mjs`'s own `makeRepo` fix. Content is inert (never referenced by any
  // scenario's diff, never reads docs/) so it can't itself trip the read-call/anchor scan.
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  execSync(`git init -q && git config user.email gc@loom && git config user.name gc`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
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
  commitAll(worktreePath, "feature.txt", GIT_ID);
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
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedFakeGate, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });

  const pHolderRun = sessions.runWorkerGate(workerId2); // occupies the ONE cap-1 slot

  // Poll (never a blind sleep — see waitUntil's own doc) until the holder has genuinely acquired the slot.
  await waitUntil(() => sessions.gateQueueForManager(projId2).activeCount === 1);

  // Now the worker's own run_gate queues (cap is saturated by the holder above).
  const pSelfCheck = sessions.runWorkerGate(workerId);
  await waitUntil(() => sessions.gateQueueForManager(projId).queued.length === 1);

  check("(e2e single-admission) the self-check has not run the real gate yet (still queued)", gateCalls === 0);

  // The manager decides to merge WHILE the self-check is STILL queued. Since card 86c3286a (Round 3),
  // confirmWorkerMergeTracked no longer decides the supersede as its own first, pre-any-await statement —
  // it decides it fresh, in the same synchronous step as `pendingOps.attach()`, AFTER its two
  // identity-resolving git reads (resolveGitRef/readMainlineHead) settle. So simply INITIATING this call no
  // longer guarantees the queued self-check is cancelled before the holder's slot could otherwise be handed
  // to it — releasing the holder too early would let the self-check win admission via a totally UNRELATED
  // race (GateSemaphore admission latency vs. this call's own git reads), making this block VACUOUS (it
  // would pass by the self-check running for real and being reused, never by exercising supersede at all —
  // a real Code Review finding against this exact block). `confirmMergeMainlineHeadReader` (the second of
  // the two awaits) is overridden here PURELY to signal "the identity reads are done, the supersede
  // decision has now run" — never to mutate state, unlike merge-confirm-supersede-mint-window.mjs's own
  // (1)/(2) scenarios — so the holder is only released once that decision has already happened, same
  // discipline, different purpose.
  let identityResolved = false;
  const realHeadReader = sessions.confirmMergeMainlineHeadReader;
  sessions.confirmMergeMainlineHeadReader = async (...args) => {
    const result = await realHeadReader(...args);
    identityResolved = true;
    return result;
  };
  // Deliberately NOT awaited yet: the merge's own gate call will itself queue behind the still-held
  // unrelated holder below, so awaiting here first would deadlock this test.
  const pMerge = sessions.confirmWorkerMergeTracked(mgrId, workerId);

  await waitUntil(() => identityResolved === true);
  releaseUnrelated("go"); // free the slot the holder occupied, so the merge's own gate can now proceed
  await pHolderRun.catch(() => {});
  sessions.confirmMergeMainlineHeadReader = realHeadReader;

  const mergeResult = await pMerge;
  const selfCheckSettled = await pSelfCheck;

  check("(e2e single-admission) the merge itself succeeded", mergeResult?.ok === true && mergeResult.value?.merged === true);
  check("(e2e single-admission) the self-check settled ok (never a thrown error surfaced to the caller)", selfCheckSettled.settled === true && selfCheckSettled.ok === true);
  check("(e2e single-admission) the self-check's OWN value reports cancelled, never a real pass/fail",
    selfCheckSettled.ok && selfCheckSettled.value?.cancelled === true && selfCheckSettled.value?.passed === undefined);
  check("(e2e single-admission) the cancel is tagged superseded-by-merge",
    selfCheckSettled.ok && selfCheckSettled.value?.cancelKind === "superseded-by-merge");
  // Single admission: guards against a DOUBLE-RUN (the self-check AND the merge both spawning their own
  // real gate call) — it is NOT a supersede witness. It passes even with `supersedeQueuedSelfCheck`
  // no-op'd, because a self-check that wins admission and settles green before the merge's own reuse check
  // runs still collapses to one real invocation via reuse (see docs/decisions/164f7915-*.md's Round 3
  // residual) — this check alone can't tell that apart from a genuine supersede. The two `cancelled`-shape
  // checks immediately above are what actually discriminate whether supersede fired.
  check("(e2e single-admission) exactly ONE real gate invocation total (never a double-run, by whichever mechanism)", gateCalls === 1);
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
    const cancelFromA = await sessions.cancelGateOp(mgrA, liveEntry.opId, { scope: { kind: "project" } });
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
//    worker's queued self-check as a SIDE EFFECT of a refused worker_merge_confirm call. At the time of
//    this incident, the ownership ("not your worker") check lived deep inside confirmWorkerMerge, reached
//    only via attach()'s factory, while supersedeQueuedSelfCheck fired as the FIRST statement of
//    confirmWorkerMergeTracked, unconditionally, before that check ever ran. (Since card 656e326f the
//    lineage pre-check runs first, and since card 86c3286a/164f7915 Round 3 the supersede decision itself
//    moved past confirmWorkerMergeTracked's own identity-resolving awaits — see that record's own history;
//    this comment describes the shape the fix below was ORIGINALLY built against, not current timing.)
//    RED-first: this block is written to demonstrate the bug against UNFIXED code — run it before applying
//    the projectId-scoping fix to confirm it fails, then again after to confirm it passes.
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
  commitAll(wtB.worktreePath, "feature.txt", GIT_ID);
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
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });

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

// ── The gate-superseded nudge's `reason` text must not assert a merge HAPPENED. Sibling of the B2-1
//    block above — but since a66ed81f ("check ownership before attaching to an in-flight spawn or merge
//    op", card 656e326f, this card's own discoveredFrom) hoisted the ownership check (now lineage-based,
//    `sameManagerLineage`) in `confirmWorkerMergeTracked` to run BEFORE `supersedeQueuedSelfCheck` ever
//    fires, a same-project PEER manager — not just a cross-project one, per B2-1 — can no longer reach
//    the supersede at all: a refused "not your worker" caller cancels NOTHING, same-project or not. This
//    block now proves BOTH halves: (a) the same-project peer's refused confirm leaves workerB's queued
//    self-check alone (closing the narrower gap B2-1 only covered for a DIFFERENT project — the two
//    blocks are no longer asymmetric); (b) the WORDING coverage itself — the self-check's settled
//    `reason` (also threaded into the worker's `[loom:gate-superseded]` nudge and `gate_status`'s
//    cancelled payload) must never claim a merge happened or was decided, only that worker_merge_confirm
//    was called — driven through the ONE path that still reaches supersedeQueuedSelfCheck for real:
//    workerB's actual owner (mgrB) calling its own confirm. (Grepped every other test asserting
//    "superseded"/`cancelKind` or calling `confirmWorkerMergeTracked` with a non-owner for the same
//    assumption — none found; see this card's own worker_report.) RED-first on (a): this failed by
//    hanging forever at the old (b)-shaped `await pSelfCheck` below, because the pre-fix same-project
//    peer call never superseded anything once ownership was checked first — see this block's own `try`/
//    `finally` for why that can no longer wedge the file even if this regresses again.
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
  commitAll(wtB.worktreePath, "feature.txt", GIT_ID);
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
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });

  const pHolderRun = sessions.runWorkerGate(workerHolder);
  await waitUntil(() => sessions.gateQueueForManager(projId).activeCount === 1);

  const pSelfCheck = sessions.runWorkerGate(workerB);
  await waitUntil(() => sessions.gateQueueForManager(projId).queued.length === 1);
  check("(wording) workerB's own self-check is queued (setup sanity)", sessions.gateQueueForManager(projId).queued.length === 1);

  // `finally` so a thrown/failed assertion path (or a future regression reopening the old hang) can
  // never again leave the holder's gate occupied forever — see this block's own header comment.
  try {
    // (a) mgrA is a PEER manager (same project) but does NOT own workerB — confirmWorkerMergeTracked
    // refuses it ("not your worker") via the ownership pre-check, hoisted ahead of ANY side effect. This
    // refusal settles quickly (it's a synchronous-shaped refusal, never a hang), so a plain `await` here
    // is safe.
    const peerAttempt = await sessions.confirmWorkerMergeTracked(mgrA, workerB);
    check("(wording) the same-project peer manager's merge attempt is genuinely refused (not your worker)",
      peerAttempt.settled === true && peerAttempt.ok === false && /not your worker/i.test(String(peerAttempt.error?.message ?? peerAttempt.error)));
    check("(wording) workerB's queued self-check is STILL queued — the refused peer confirm cancelled NOTHING",
      sessions.gateQueueForManager(projId).queued.length === 1);

    // (b) Drive the WORDING coverage through the one path that still reaches supersedeQueuedSelfCheck for
    // real: workerB's ACTUAL owner (mgrB) calling its own confirm. The ownership pre-check passes
    // trivially for a worker's real owner, so execution still reaches the supersede exactly as before
    // this card. Fired without an immediate `await` — its own merge gate queues behind workerHolder, and
    // we don't need that to settle before checking the self-check's own outcome below.
    const pOwnerConfirm = sessions.confirmWorkerMergeTracked(mgrB, workerB);

    // Card 08cdba65: a plain `await pSelfCheck` here hangs the whole file at an external timeout
    // (opaque, no named FAIL) if `supersedeQueuedSelfCheck` ever regresses to a no-op — workerB's
    // self-check then just sits queued behind workerHolder, who is only released in this block's own
    // `finally`, AFTER this await would need to have already returned. Poll a flag `pSelfCheck` itself
    // sets on settlement, bounded by the shared waitUntil helper, so a regression here reports a named
    // FAIL fast instead of wedging the file; the `.then` handlers below are attached unconditionally
    // and settle `selfCheckOutcome` whenever `pSelfCheck` actually resolves, even if that happens after
    // this wait gives up (e.g. once `finally` below releases the holder and frees the queue slot).
    let selfCheckDone = false;
    let selfCheckOutcome;
    pSelfCheck.then(
      (v) => { selfCheckOutcome = v; selfCheckDone = true; },
      (e) => { selfCheckOutcome = { ok: false, error: e }; selfCheckDone = true; },
    );
    await waitUntil(() => selfCheckDone, { label: "(wording) workerB's self-check settles (superseded by its owner's confirm, or a supersedeQueuedSelfCheck regression)" });
    check("(wording) workerB's own self-check settled instead of hanging (a FAIL here means supersedeQueuedSelfCheck likely regressed to a no-op)", selfCheckDone === true);
    const selfCheckSettled = selfCheckOutcome ?? {};
    check("(wording) workerB's queued self-check WAS superseded by its real owner's confirm",
      selfCheckSettled.ok === true && selfCheckSettled.value?.cancelled === true && selfCheckSettled.value?.cancelKind === "superseded-by-merge");
    const reasonText = String(selfCheckSettled.value?.reason ?? "");
    check("(wording) the reason text is non-empty (setup sanity — everything downstream reads this string)", reasonText.length > 0);
    // THE ACTUAL BUG this block guards: the pre-fix text asserted "the manager decided to merge"
    // unconditionally — false whenever the triggering confirm doesn't itself end in a real merge.
    check("(wording) the reason text does NOT assert a merge happened or was decided — it only states that worker_merge_confirm was called",
      !/decided to merge/i.test(reasonText) && !/\bmerged?\b/i.test(reasonText));
    check("(wording) the reason text still names the real, unconditional trigger — the worker_merge_confirm call itself, true regardless of that call's own outcome",
      /worker_merge_confirm/i.test(reasonText) && /regardless/i.test(reasonText));

    // Tidy up the owner's own now-redundant merge op without needing a real end-to-end git merge: cancel
    // it once it reaches the queue (same shape as the B2-2 block below) rather than releasing the holder
    // and letting it run to completion — this block is about the self-check's wording, not the merge's
    // own outcome.
    const ownerMergeEntry = await waitUntil(() => sessions.gateQueueForManager(projId).queued.find((e) => e.gateType === "merge"));
    if (ownerMergeEntry) {
      await sessions.cancelGateOp(mgrB, ownerMergeEntry.opId, { scope: { kind: "project" } });
    }
    await pOwnerConfirm.catch(() => {});
  } finally {
    releaseHolder("go");
    await pHolderRun.catch(() => {});
  }
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
  commitAll(worktreePath, "feature.txt", GIT_ID);
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
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });

  const pHolderRun = sessions.runWorkerGate(workerHolder);
  await waitUntil(() => sessions.gateQueueForManager(projHolder).activeCount === 1);

  const pMergeConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId); // queues behind the holder
  const mergeEntry = await waitUntil(() => sessions.gateQueueForManager(projId).queued.find((e) => e.gateType === "merge"));
  check("(B2-2) the MERGE gate itself is queued (setup sanity)", !!mergeEntry);

  // Guard: this is the exact site that fired live (op 6e29e337, card f5767961) — a timed-out waitUntil
  // yields undefined, and dereferencing mergeEntry.opId unguarded turned a soft, correctly-reported
  // assertion failure into a TypeError that killed the whole suite. Skip the dependent assertions instead.
  if (mergeEntry) {
    const cancelResult = await sessions.cancelGateOp(mgrId, mergeEntry.opId, { scope: { kind: "project" } });
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
  commitAll(worktreePath, "feature.txt", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-run-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  // Cap default (1) with nothing else queued — the merge gate admits (RUNS) immediately, never queues.
  let releaseGate;
  const gateHold = new Promise((res) => { releaseGate = res; });
  let gateSpawned = false;
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => { gateSpawned = true; await gateHold; return { passed: true }; }, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });

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
    const cancelResult = await sessions.cancelGateOp(mgrId, mergeEntry.opId, { scope: { kind: "project" } });
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
    const cancelResult = await sessions.cancelGateOp(workerId /* any manager id works here — same project */, liveEntry.opId, { scope: { kind: "project" } });
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
  commitAll(wt1.worktreePath, "feat: real change", GIT_ID);
  db.insertSession({ id: worker1Id, projectId: P1, agentId: `${P1}-agent`, engineSessionId: null, title: null, cwd: wt1.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: task1Id, worktreePath: wt1.worktreePath, branch: wt1.branch });

  const wt2 = await createWorktree(repo, P1, task2Id);
  worktrees.push(wt2.worktreePath);
  fs.mkdirSync(path.join(wt2.worktreePath, "docs"), { recursive: true });
  fs.writeFileSync(path.join(wt2.worktreePath, "docs", "note.md"), "notes\n");
  commitAll(wt2.worktreePath, "docs: add note", GIT_ID);
  db.insertSession({ id: worker2Id, projectId: P1, agentId: `${P1}-agent`, engineSessionId: null, title: null, cwd: wt2.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: task2Id, worktreePath: wt2.worktreePath, branch: wt2.branch });

  const p1 = sessions.confirmWorkerMerge(mgrId, worker1Id);
  await gate1Admitted; // worker1's real gate is genuinely mid-run, holding the repo guard

  const p2 = sessions.confirmWorkerMerge(mgrId, worker2Id); // worker2's inert skip queues behind worker1

  const waiterEntry = await waitUntil(() => sessions.gateQueueForManager(P1).repoGuardOnly.find((e) => e.phase === "queued"));
  check("(b) precondition: worker2's inert-skip wait is genuinely QUEUED and visible in gate_queue", !!waiterEntry);

  if (waiterEntry) {
    const cancelResult = await sessions.cancelGateOp(mgrId, waiterEntry.opId, { scope: { kind: "project" } });
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

  const cancelResult = await sessions.cancelGateOp(mgr1, "rgo-c-waiter", { scope: { kind: "project" } }); // P1's manager, P2's opId
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
  const cancelResult = await sessions.cancelGateOp(mgr1, "rgo-d-holder", { scope: { kind: "project" } });
  check("(d) cancelling a HOLDING repo-guard-only wait is REFUSED (not_cancelled)", cancelResult.outcome === "not_cancelled");
  check("(d) the refusal names the staged-residue/HOLDING reason, not a generic one", /staged-residue|HOLDING/i.test(cancelResult.reason ?? ""));
  release();
}

// ── (e) card a0d912f5: the WORKER-scoped gate_cancel surface — cancelGateOp's `restrictToOwnerSessionId`.
//    A worker can cancel its OWN "worker" self-check; it CANNOT cancel a "merge" gate even though that
//    merge op's own descriptor happens to be stamped with the SAME worker sessionId (confirmWorkerMerge's
//    gate descriptor uses sessionId:workerSessionId, since it shares that worker's worktree key — see
//    cancelGateOp's own doc for why gateType is part of the ownership check, not just sessionId); and it
//    cannot cancel a DIFFERENT worker's own self-check. Also proves intent/reason land in the cancelled
//    op's own reason text (and so, transitively, in its [loom:gate-cancelled] nudge — see that nudge's own
//    composition, which reads outcome.value.reason verbatim). ─────────────────────────────────────────────
{
  const sfx = `wscope-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-wscope-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db();
  dbs.push(db);
  db.setPlatformConfig({ maxConcurrentGates: 1 }); // saturate with an unrelated holder so everything below genuinely queues

  const projId = `gc-ws-p-${sfx}`, mgrId = `gc-ws-mgr-${sfx}`;
  const taskAId = `gc-ws-ta-${sfx}`, workerAId = `gc-ws-wa-${sfx}`;
  const taskBId = `gc-ws-tb-${sfx}`, workerBId = `gc-ws-wb-${sfx}`;
  const taskHolderId = `gc-ws-th-${sfx}`, workerHolderId = `gc-ws-wh-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "WS", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-ws-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-ws-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  db.insertAgent({ id: `agent-ws-a-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskAId, projectId: projId, title: "WS-TASK-A", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wtA = await createWorktree(repo, projId, taskAId);
  worktrees.push(wtA.worktreePath);
  fs.writeFileSync(path.join(wtA.worktreePath, "feature-a.txt"), "work-a\n");
  commitAll(wtA.worktreePath, "feature-a.txt", GIT_ID);
  db.insertSession({ id: workerAId, projectId: projId, agentId: `agent-ws-a-${sfx}`, engineSessionId: null, title: null, cwd: wtA.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskAId, worktreePath: wtA.worktreePath, branch: wtA.branch });

  db.insertAgent({ id: `agent-ws-b-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskBId, projectId: projId, title: "WS-TASK-B", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wtB = await createWorktree(repo, projId, taskBId);
  worktrees.push(wtB.worktreePath);
  db.insertSession({ id: workerBId, projectId: projId, agentId: `agent-ws-b-${sfx}`, engineSessionId: null, title: null, cwd: wtB.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskBId, worktreePath: wtB.worktreePath, branch: wtB.branch });

  db.insertAgent({ id: `agent-ws-h-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskHolderId, projectId: projId, title: "WS-HTASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wtHolder = await createWorktree(repo, projId, taskHolderId);
  worktrees.push(wtHolder.worktreePath);
  db.insertSession({ id: workerHolderId, projectId: projId, agentId: `agent-ws-h-${sfx}`, engineSessionId: null, title: null, cwd: wtHolder.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskHolderId, worktreePath: wtHolder.worktreePath, branch: wtHolder.branch });

  let releaseHolder;
  const holderHold = new Promise((res) => { releaseHolder = res; });
  const sharedGate = async (_gate, cwd) => {
    if (cwd === wtHolder.worktreePath) { await holderHold; return { passed: true }; }
    return { passed: true };
  };
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });

  const pHolderRun = sessions.runWorkerGate(workerHolderId);
  await waitUntil(() => sessions.gateQueueForManager(projId).activeCount === 1);

  // workerA's OWN self-check — queues behind the holder. Selected by `taskId`, never by find-order/index —
  // both workerA's and workerB's own self-checks queue with gateType:"worker", so an order-based pick would
  // be a real, silent risk of testing the WRONG worker's op under the RIGHT worker's label (each own-project
  // entry's `taskId` is unambiguous and distinct per worker here, unlike opId-arrival order).
  const pSelfCheckA = sessions.runWorkerGate(workerAId);
  await waitUntil(() => sessions.gateQueueForManager(projId).queued.some((e) => e.gateType === "worker" && e.taskId === taskAId));
  const selfCheckAEntry = sessions.gateQueueForManager(projId).queued.find((e) => e.gateType === "worker" && e.taskId === taskAId);
  check("(e) workerA's own self-check is queued (setup sanity)", !!selfCheckAEntry);

  // workerB's OWN self-check — queues too, so there's a genuine "someone else's own op" to test refusal
  // against (not merely a foreign project, already covered by (2) above). Also selected by taskId.
  const pSelfCheckB = sessions.runWorkerGate(workerBId);
  await waitUntil(() => sessions.gateQueueForManager(projId).queued.some((e) => e.gateType === "worker" && e.taskId === taskBId));
  const selfCheckBEntry = sessions.gateQueueForManager(projId).queued.find((e) => e.gateType === "worker" && e.taskId === taskBId);
  check("(e) workerB's own self-check is ALSO queued (setup sanity)", !!selfCheckBEntry);
  check("(e) workerA's and workerB's own self-checks are genuinely DIFFERENT ops (setup sanity)", selfCheckAEntry?.opId !== selfCheckBEntry?.opId);

  // A queued MERGE gate for workerA — its OWN descriptor.sessionId is workerAId, mirroring the EXACT
  // production coincidence cancelGateOp's own doc warns about (confirmWorkerMerge's real gate descriptor
  // shares the worker's own worktree key, sessionId:workerSessionId — see service.ts's own construction).
  // Synthesized DIRECTLY via gateSemaphore.runExclusive (same technique batch-merge-gate-history.mjs /
  // emit-compare-gate-scope.mjs already use) rather than via confirmWorkerMergeTracked: that real call
  // would ALSO fire supersedeQueuedSelfCheck as a side effect of its own exact-owner decision (see this
  // file's block (1) above; since card 86c3286a/164f7915 Round 3 that decision is made right before
  // pendingOps.attach(), not as the method's first statement, but it still fires for an exact owner like
  // workerA here), auto-cancelling workerA's queued self-check as a SIDE EFFECT before this block ever gets
  // to test its OWN cancel path against it — a real interaction with an unrelated mechanism this block
  // must not depend on. Constructing the merge op directly isolates exactly the ownership-scope question
  // this block exists to answer.
  const MERGE_A_OP_ID = `gc-ws-merge-op-${sfx}`;
  const pMergeA = sessions.gateSemaphore.runExclusive(
    1, { gateType: "merge", projectId: projId, sessionId: workerAId, taskId: taskAId, opId: MERGE_A_OP_ID, worktreePath: wtA.worktreePath },
    async () => ({ passed: true }), "high",
  );
  pMergeA.catch(() => {}); // observed via gateQueueForManager below, not its own settle
  const mergeAEntry = await waitUntil(() => sessions.gateQueueForManager(projId).queued.find((e) => e.gateType === "merge" && e.opId === MERGE_A_OP_ID));
  check("(e) workerA's merge gate is ALSO queued, under the SAME sessionId (setup sanity)", !!mergeAEntry);

  if (selfCheckAEntry && selfCheckBEntry && mergeAEntry) {
    // (e-1) workerB cannot cancel workerA's own self-check — cross-session refusal.
    const crossSessionAttempt = await sessions.cancelGateOp(workerBId, selfCheckAEntry.opId, { scope: { kind: "own", sessionId: workerBId } });
    check("(e-1) workerB is REFUSED cancelling workerA's own self-check", crossSessionAttempt.outcome === "refused");
    check("(e-1) the refusal names the session-ownership reason", /different session/i.test(crossSessionAttempt.reason ?? ""));
    check("(e-1) workerA's self-check is STILL queued — the cross-session attempt cancelled NOTHING",
      sessions.gateQueueForManager(projId).queued.some((e) => e.opId === selfCheckAEntry.opId));

    // (e-2) workerA cannot cancel its OWN merge gate, despite sharing its own sessionId — gateType scope.
    const ownMergeAttempt = await sessions.cancelGateOp(workerAId, mergeAEntry.opId, { scope: { kind: "own", sessionId: workerAId } });
    check("(e-2) workerA is REFUSED cancelling its OWN merge gate (gateType scope, not just sessionId)", ownMergeAttempt.outcome === "refused");
    check("(e-2) the refusal names the merge/deploy-gateType reason, not the session-ownership one",
      /merge\/deploy gate/i.test(ownMergeAttempt.reason ?? ""));
    check("(e-2) workerA's merge gate is STILL queued — refusing it never touched the semaphore",
      sessions.gateQueueForManager(projId).queued.some((e) => e.opId === mergeAEntry.opId));

    // (e-3) workerA CAN cancel its OWN self-check — the actual DoD-1 capability — WITH intent/reason
    // (DoD-4) threaded into the settled op's own reason text.
    const ownCancel = await sessions.cancelGateOp(workerAId, selfCheckAEntry.opId, {
      scope: { kind: "own", sessionId: workerAId }, intent: "hold-for-instructions", reason: "waiting on manager direction",
    });
    check("(e-3) workerA CAN cancel its own self-check", ownCancel.outcome === "cancelled" && ownCancel.phase === "queued" && ownCancel.gateType === "worker");
    let selfCheckACaught;
    try { await pSelfCheckA; } catch (e) { selfCheckACaught = e; }
    check("(e-3) awaiting the cancelled self-check does NOT throw (runWorkerGate never throws for a cancelled op — it resolves with {cancelled:true, reason} — see its own GateCancelledError catch)",
      selfCheckACaught === undefined);
    // Card a0d912f5 Code Review [7]: kept INSIDE this guard, unlike every other block in this file's own
    // convention where dependent assertions were left outside one — a setup timeout here must not ALSO
    // produce 3 misleading FAILs on top of the real one below.
    const selfCheckASettled = await pSelfCheckA;
    check("(e-3) the settled self-check reports cancelled, never a real pass/fail", selfCheckASettled.settled === true && selfCheckASettled.ok === true && selfCheckASettled.value?.cancelled === true);
    check("(e-3) intent + reason both landed in the settled op's own reason text",
      /hold-for-instructions/.test(selfCheckASettled.value?.reason ?? "") && /waiting on manager direction/.test(selfCheckASettled.value?.reason ?? ""));
    check("(e-3) the reason also names the caller as \"worker\", not \"manager\" (card a0d912f5's callerLabel)",
      /cancelled by worker/i.test(selfCheckASettled.value?.reason ?? ""));
  } else {
    console.log("SKIP  (e) worker-scope assertions — setup sanity check above already failed");
    await pSelfCheckA.catch(() => {});
  }

  releaseHolder("go");
  await pHolderRun.catch(() => {});
  await pSelfCheckB.catch(() => {});
  const mergeAResult = await pMergeA;
  check("(e) workerA's merge, left uncancelled by the refused attempt, still completes normally (real fn ran, real result)", mergeAResult?.passed === true);
}

// ── (f) Code Review Minor [5] (card a0d912f5): the RUNNING-cancel abort-reason threading (`cancelSignalRef`
//    in runWorkerGate) is exercised end to end — a VERIFIED cancel of a genuinely RUNNING self-check, with
//    intent+reason, must carry them in the settled op's own `reason`, not the generic fallback string. The
//    fallback string is EXACTLY what a regression that stops assigning `cancelSignalRef` would silently
//    produce (still `outcome:"cancelled"`, still a plausible-looking reason) — so this also NEGATIVE-
//    controls the SAME mechanism with a bare cancel (no intent/reason), proving the fallback text is real
//    and distinguishable from the threaded one, not just present in both cases by coincidence. ───────────
{
  const sfx = `running-reason-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-rr-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db();
  dbs.push(db);

  const projId = `gc-rr-p-${sfx}`, mgrId = `gc-rr-mgr-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "RR", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-rr-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-rr-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  // A fake gate that RESPONDS to cancellation (unlike the "never-settling" block above, which deliberately
  // never does) — resolves with a real GateSequentialResult `{cancelled:true}` shape the instant the abort
  // signal fires, mirroring gate-runner.ts's OWN cancel-handling contract (checks `.aborted` up front,
  // ALSO listens for the event — the same real race window the "never-settling" block's own comment names).
  const respondingGate = (_gate, _cwd, _timeoutMs, _runStep, _envOverride, _allowExtend, cancelSignal) => new Promise((resolve) => {
    const onAbort = () => resolve({ cancelled: true, steps: [] });
    if (!cancelSignal) return;
    if (cancelSignal.aborted) { onAbort(); return; }
    cancelSignal.addEventListener("abort", onAbort);
  });
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

  // (f-1) WITH intent/reason — must land verbatim in the settled reason.
  {
    const agentId = `agent-rr-w1-${sfx}`, workerId = `gc-rr-w1-${sfx}`, taskId = `gc-rr-t1-${sfx}`;
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "RR-TASK-1", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const wt = await createWorktree(repo, projId, taskId);
    worktrees.push(wt.worktreePath);
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: respondingGate, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });

    const pRun = sessions.runWorkerGate(workerId);
    const liveEntry = await waitUntil(() => sessions.gateQueueForManager(projId).running[0]);
    check("(f-1) the self-check is genuinely RUNNING before cancel", !!liveEntry);
    if (liveEntry) {
      const cancelResult = await sessions.cancelGateOp(mgrId, liveEntry.opId, { scope: { kind: "project" }, intent: "refire-when-clear", reason: "clearing the lane for a higher-priority merge" });
      check("(f-1) the RUNNING self-check cancel is VERIFIED (outcome:cancelled, not merely requested)", cancelResult.outcome === "cancelled" && cancelResult.phase === "running");
      const settled = await pRun;
      check("(f-1) the settled result reports cancelled, never a real pass/fail", settled.settled === true && settled.ok === true && settled.value?.cancelled === true);
      const reasonText = settled.value?.reason ?? "";
      check("(f-1) intent + reason both landed in the RUNNING-cancel settled reason (cancelSignalRef threaded, not the generic fallback)",
        /refire-when-clear/.test(reasonText) && /clearing the lane for a higher-priority merge/.test(reasonText));
      check("(f-1) the reason names the caller as \"manager\" (card a0d912f5's callerLabel)", /cancelled by manager/i.test(reasonText));
    } else {
      console.log("SKIP  (f-1) cancel assertions — setup sanity check above already failed");
      await pRun.catch(() => {});
    }
  }

  // (f-2) NEGATIVE CONTROL — a bare cancel (no intent/reason) on the SAME mechanism must NOT carry either
  // string, proving (f-1)'s match wasn't a coincidence of some OTHER, unrelated text always being present.
  {
    const agentId = `agent-rr-w2-${sfx}`, workerId = `gc-rr-w2-${sfx}`, taskId = `gc-rr-t2-${sfx}`;
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "RR-TASK-2", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const wt = await createWorktree(repo, projId, taskId);
    worktrees.push(wt.worktreePath);
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: respondingGate });

    const pRun = sessions.runWorkerGate(workerId);
    const liveEntry = await waitUntil(() => sessions.gateQueueForManager(projId).running.find((e) => e.taskId === taskId));
    check("(f-2) the self-check is genuinely RUNNING before cancel", !!liveEntry);
    if (liveEntry) {
      const cancelResult = await sessions.cancelGateOp(mgrId, liveEntry.opId, { scope: { kind: "project" } });
      check("(f-2) the RUNNING self-check cancel is VERIFIED (outcome:cancelled)", cancelResult.outcome === "cancelled" && cancelResult.phase === "running");
      const settled = await pRun;
      const reasonText = settled.value?.reason ?? "";
      check("(f-2) NEGATIVE CONTROL: a bare cancel carries NEITHER (f-1)'s intent nor its reason text",
        !/refire-when-clear/.test(reasonText) && !/clearing the lane for a higher-priority merge/.test(reasonText));
      check("(f-2) the reason STILL names the caller (proves this is a real, threaded reason, not an empty/undefined one falling through)",
        /cancelled by manager/i.test(reasonText));
    } else {
      console.log("SKIP  (f-2) cancel assertions — setup sanity check above already failed");
      await pRun.catch(() => {});
    }
  }
}

// ── (g) card bd9a483b (CR round 4): a worker's `{kind:"own"}` gate_cancel refused against its OWN
//    in-flight landing-check must NOT call it "a merge/deploy gate" — `isWorkerSelfCheckGate` is false for
//    BOTH a real merge/deploy gate AND a landingCheckOnly entry (same gateType:"worker", different reason),
//    so the refusal text must discriminate instead of reusing (e-2)'s wording for a shape that isn't one. ──
{
  const sfx = `landingcheck-own-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-lc-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db();
  dbs.push(db);
  db.setPlatformConfig({ maxConcurrentGates: 1 }); // saturate so the landing-check entry below genuinely queues

  const projId = `gc-lc-p-${sfx}`, mgrId = `gc-lc-mgr-${sfx}`;
  const taskId = `gc-lc-t-${sfx}`, workerId = `gc-lc-w-${sfx}`;
  const taskHolderId = `gc-lc-th-${sfx}`, workerHolderId = `gc-lc-wh-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "LC", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-lc-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-lc-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  db.insertAgent({ id: `agent-lc-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "LC-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktree(repo, projId, taskId);
  worktrees.push(wt.worktreePath);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-lc-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

  db.insertAgent({ id: `agent-lc-h-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskHolderId, projectId: projId, title: "LC-HTASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wtHolder = await createWorktree(repo, projId, taskHolderId);
  worktrees.push(wtHolder.worktreePath);
  db.insertSession({ id: workerHolderId, projectId: projId, agentId: `agent-lc-h-${sfx}`, engineSessionId: null, title: null, cwd: wtHolder.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskHolderId, worktreePath: wtHolder.worktreePath, branch: wtHolder.branch });

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });
  let releaseHolder;
  const holderHold = new Promise((res) => { releaseHolder = res; });
  const pHolder = sessions.gateSemaphore.runExclusive(1, { gateType: "worker", projectId: projId, sessionId: workerHolderId, worktreePath: wtHolder.worktreePath }, async () => { await holderHold; return "holder"; });
  await waitUntil(() => sessions.gateSemaphore.snapshot().active === 1);

  // Synthesize the worker's OWN landing-check entry directly (same technique block (e) uses for its
  // merge-op synthesis) — landingCheckOnly:true, gateType:"worker", sessionId:workerId (mirrors
  // runUngatedLandingCheck's real descriptor shape in sessions/service.ts).
  const LANDING_OP_ID = `gc-lc-landing-op-${sfx}`;
  const pLanding = sessions.gateSemaphore.runExclusive(
    1, { gateType: "worker", projectId: projId, sessionId: workerId, taskId, opId: LANDING_OP_ID, worktreePath: wt.worktreePath, landingCheckOnly: true },
    async () => ({ passed: true }), "low",
  );
  pLanding.catch(() => {});
  const landingEntry = await waitUntil(() => sessions.gateQueueForManager(projId).queued.find((e) => e.opId === LANDING_OP_ID));
  check("(g) the worker's own landing-check entry is queued, carrying landingCheckOnly:true (setup sanity)", !!landingEntry && landingEntry.landingCheckOnly === true);

  if (landingEntry) {
    const ownAttempt = await sessions.cancelGateOp(workerId, landingEntry.opId, { scope: { kind: "own", sessionId: workerId } });
    check("(g) the worker is REFUSED cancelling its own in-flight landing-check via {kind:\"own\"}", ownAttempt.outcome === "refused");
    check("(g) the refusal does NOT call it \"a merge/deploy gate\" (it is neither)", !/merge\/deploy gate/i.test(ownAttempt.reason ?? ""));
    check("(g) the refusal instead names it as the manager's own ungated-landing-check / worker_merge_confirm call",
      /ungated-landing-check/i.test(ownAttempt.reason ?? "") && /worker_merge_confirm/i.test(ownAttempt.reason ?? ""));
    check("(g) the landing-check entry is STILL queued — the refused attempt never touched the semaphore",
      sessions.gateQueueForManager(projId).queued.some((e) => e.opId === landingEntry.opId));
  } else {
    console.log("SKIP  (g) cancel assertions — setup sanity check above already failed");
  }

  releaseHolder("go");
  await pHolder.catch(() => {});
  const landingResult = await pLanding;
  check("(g) the landing-check, left uncancelled by the refused attempt, still completes normally", landingResult?.passed === true);
}

// ── (h) card cee17efe (round-3 ruling 3/R3-3): the SAME discriminating refusal as (g), for the
//    automatic post-ungated-landing dist-importer advisory (`distImporterCheckOnly:true`) — a worker's
//    `{kind:"own"}` gate_cancel against it must name it correctly, never "a merge/deploy gate" (the
//    `isWorkerSelfCheckGate` exclusion covers BOTH landingCheckOnly and distImporterCheckOnly the same way). ──
{
  const sfx = `distimporter-own-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-dic-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db();
  dbs.push(db);
  db.setPlatformConfig({ maxConcurrentGates: 1 }); // saturate so the dist-importer-check entry below genuinely queues

  const projId = `gc-dic-p-${sfx}`, mgrId = `gc-dic-mgr-${sfx}`;
  const taskId = `gc-dic-t-${sfx}`, workerId = `gc-dic-w-${sfx}`;
  const taskHolderId = `gc-dic-th-${sfx}`, workerHolderId = `gc-dic-wh-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "DIC", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-dic-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-dic-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  db.insertAgent({ id: `agent-dic-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "DIC-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktree(repo, projId, taskId);
  worktrees.push(wt.worktreePath);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-dic-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

  db.insertAgent({ id: `agent-dic-h-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskHolderId, projectId: projId, title: "DIC-HTASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wtHolder = await createWorktree(repo, projId, taskHolderId);
  worktrees.push(wtHolder.worktreePath);
  db.insertSession({ id: workerHolderId, projectId: projId, agentId: `agent-dic-h-${sfx}`, engineSessionId: null, title: null, cwd: wtHolder.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskHolderId, worktreePath: wtHolder.worktreePath, branch: wtHolder.branch });

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });
  let releaseDicHolder;
  const dicHolderHold = new Promise((res) => { releaseDicHolder = res; });
  const pDicHolder = sessions.gateSemaphore.runExclusive(1, { gateType: "worker", projectId: projId, sessionId: workerHolderId, worktreePath: wtHolder.worktreePath }, async () => { await dicHolderHold; return "holder"; });
  await waitUntil(() => sessions.gateSemaphore.snapshot().active === 1);

  // Synthesize the manager's OWN dist-importer-check entry directly — distImporterCheckOnly:true,
  // gateType:"worker", sessionId:mgrId (mirrors `runOneDistImporterCheck`'s real descriptor shape in
  // sessions/service.ts, which always carries the MANAGER's own sessionId, never a worker's).
  const DIC_OP_ID = `gc-dic-op-${sfx}`;
  const pDic = sessions.gateSemaphore.runExclusive(
    1, { gateType: "worker", projectId: projId, sessionId: mgrId, taskId: null, opId: DIC_OP_ID, distImporterCheckOnly: true },
    async () => ({ passed: true }), "low",
  );
  pDic.catch(() => {});
  const dicEntry = await waitUntil(() => sessions.gateQueueForManager(projId).queued.find((e) => e.opId === DIC_OP_ID));
  check("(h) the dist-importer-check entry is queued, carrying distImporterCheckOnly:true (setup sanity)", !!dicEntry && dicEntry.distImporterCheckOnly === true);

  if (dicEntry) {
    const ownAttempt = await sessions.cancelGateOp(workerId, dicEntry.opId, { scope: { kind: "own", sessionId: workerId } });
    check("(h) the worker is REFUSED cancelling the manager's own in-flight dist-importer-check via {kind:\"own\"}", ownAttempt.outcome === "refused");
    check("(h) the refusal does NOT call it \"a merge/deploy gate\" (it is neither)", !/merge\/deploy gate/i.test(ownAttempt.reason ?? ""));
    check("(h) the refusal instead names it as the manager's own automatic dist-importer advisory",
      /dist-importer advisory/i.test(ownAttempt.reason ?? ""));
    check("(h) the dist-importer-check entry is STILL queued — the refused attempt never touched the semaphore",
      sessions.gateQueueForManager(projId).queued.some((e) => e.opId === dicEntry.opId));
  } else {
    console.log("SKIP  (h) cancel assertions — setup sanity check above already failed");
  }

  releaseDicHolder("go");
  await pDicHolder.catch(() => {});
  const dicResult = await pDic;
  check("(h) the dist-importer-check, left uncancelled by the refused attempt, still completes normally", dicResult?.passed === true);
}

// ── (i) card cee17efe (round-4 ruling 4b): a distImporterCheckOnly op never calls `pendingOps.attach`,
//    so the generic `gate:<sessionId>` key `cancelGateOp`'s RUNNING-cancel verification used to wait on
//    had NOTHING registered under it — `waitBriefly` returned `true` AT ONCE regardless of whether the
//    kill was ever verified, reporting `outcome:"cancelled"` on a run that may still be executing. This
//    mirrors the "never-settling kill" scenario above (3), but for a distImporterCheckOnly entry: the fn
//    never settles even after `cancelSignal` aborts, so a HONEST verification must report NOT cancelled
//    and leave the slot held — the exact outcome the pre-fix vacuous wait could never produce. ──────────
{
  const sfx = `dic-hang-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-dichang-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db();
  dbs.push(db);
  const projId = `gc-dichang-p-${sfx}`, mgrId = `gc-dichang-mgr-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "DICHANG", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-dichang-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-dichang-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  // Tiny verify bound — this test does not wait out the real production default.
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { gateCancelVerifyMs: 150 });

  let resolveAbortObserved;
  const abortObservedPromise = new Promise((res) => { resolveAbortObserved = res; });
  const DIC_HANG_OP_ID = `gc-dichang-op-${sfx}`;
  const pDic = sessions.gateSemaphore.runExclusive(
    1, { gateType: "worker", projectId: projId, sessionId: mgrId, taskId: null, opId: DIC_HANG_OP_ID, distImporterCheckOnly: true },
    (_startedAt, cancelSignal) => new Promise(() => {
      // Mirrors runOneDistImporterCheck's own real descriptor shape — never settles, even once
      // cancelSignal aborts, simulating a kill whose completion can never be verified.
      if (cancelSignal.aborted) { resolveAbortObserved(); return; }
      cancelSignal.addEventListener("abort", () => resolveAbortObserved());
    }),
    "low",
  ).catch(() => {}); // deliberately left unresolved — this session/db is torn down below regardless

  const liveEntry = await waitUntil(() => sessions.gateQueueForManager(projId).running.find((e) => e.opId === DIC_HANG_OP_ID));
  check("(i) [setup] the distImporterCheckOnly entry is genuinely RUNNING before cancel", !!liveEntry && liveEntry.distImporterCheckOnly === true);

  if (liveEntry) {
    const cancelResult = await sessions.cancelGateOp(mgrId, liveEntry.opId, { scope: { kind: "project" } });
    check("(i) cancelGateOp reports NOT cancelled (the kill is genuinely unverified — the pre-fix vacuous wait could never produce this)", cancelResult.outcome === "not_cancelled");
    check("(i) the reason names the verification bound, not a generic failure", /not verified dead/i.test(cancelResult.reason ?? ""));
    await abortObservedPromise; // no timeout — the abort really was delivered to this op's own fn
    check("(i) the abort was requested and (eventually) observed by the fake fn", true);
    const snapAfter = sessions.gateQueueForManager(projId);
    check("(i) the op is STILL reported running — the slot was NOT freed on an unverified kill",
      snapAfter.running.some((e) => e.opId === liveEntry.opId));
  } else {
    console.log("SKIP  (i) cancel/abort assertions — setup sanity check above already failed");
  }

  void pDic;
}

// ── (j) card 02c5311d: a landingCheckOnly op ALSO never calls `pendingOps.attach` under
//    `gate:<sessionId>` (it attaches, when it attaches at all, under `merge:<workerSessionId>` inside
//    confirmWorkerMerge — see runUngatedLandingCheck's own real descriptor shape) — so the OLD
//    `waitBriefly(\`gate:<workerSessionId>\`)` verification was vacuous for it too, exactly like (i) for
//    distImporterCheckOnly. Mirrors the "never-settling kill" scenario (3)/(i): the fn never settles even
//    after cancelSignal aborts, so an honest verification must report NOT cancelled, never "cancelled"
//    on an unverified assumption. ──────────────────────────────────────────────────────────────────────
{
  const sfx = `lc-hang-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-lchang-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db();
  dbs.push(db);
  const projId = `gc-lchang-p-${sfx}`, mgrId = `gc-lchang-mgr-${sfx}`, workerId = `gc-lchang-w-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "LCHANG", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-lchang-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-lchang-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { gateCancelVerifyMs: 150 });

  let resolveAbortObserved;
  const abortObservedPromise = new Promise((res) => { resolveAbortObserved = res; });
  const LC_HANG_OP_ID = `gc-lchang-op-${sfx}`;
  const pLc = sessions.gateSemaphore.runExclusive(
    1, { gateType: "worker", projectId: projId, sessionId: workerId, taskId: null, opId: LC_HANG_OP_ID, landingCheckOnly: true },
    (_startedAt, cancelSignal) => new Promise(() => {
      // Mirrors runUngatedLandingCheck's own real descriptor shape — never settles, even once
      // cancelSignal aborts, simulating a kill whose completion can never be verified.
      if (cancelSignal.aborted) { resolveAbortObserved(); return; }
      cancelSignal.addEventListener("abort", () => resolveAbortObserved());
    }),
    "low",
  ).catch(() => {}); // deliberately left unresolved — this session/db is torn down below regardless

  const liveEntry = await waitUntil(() => sessions.gateQueueForManager(projId).running.find((e) => e.opId === LC_HANG_OP_ID));
  check("(j) [setup] the landingCheckOnly entry is genuinely RUNNING before cancel", !!liveEntry && liveEntry.landingCheckOnly === true);

  if (liveEntry) {
    const cancelResult = await sessions.cancelGateOp(mgrId, liveEntry.opId, { scope: { kind: "project" } });
    check("(j) cancelGateOp reports NOT cancelled (the kill is genuinely unverified — the pre-fix vacuous wait could never produce this)", cancelResult.outcome === "not_cancelled");
    check("(j) the reason names the verification bound, not a generic failure", /not verified dead/i.test(cancelResult.reason ?? ""));
    await abortObservedPromise; // no timeout — the abort really was delivered to this op's own fn
    check("(j) the abort was requested and (eventually) observed by the fake fn", true);
    const snapAfter = sessions.gateQueueForManager(projId);
    check("(j) the op is STILL reported running — the slot was NOT freed on an unverified kill",
      snapAfter.running.some((e) => e.opId === liveEntry.opId));
  } else {
    console.log("SKIP  (j) cancel/abort assertions — setup sanity check above already failed");
  }

  void pLc;
}

// ── (k) card 02c5311d: the POSITIVE-PATH companion to (i) — a distImporterCheckOnly op whose fn DOES
//    settle promptly once cancelSignal aborts must report outcome:"cancelled", phase:"running". Every
//    other assertion in this file about distImporterCheckOnly/landingCheckOnly RUNNING-cancel is a
//    NEGATIVE one (the fn never settles); an always-false `waitForSettleBriefly` would still pass all of
//    them. This is the scenario that would catch exactly that regression. ──────────────────────────────
{
  const sfx = `dic-ok-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const reposDir = path.join(os.tmpdir(), `loom-gc-dicok-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db();
  dbs.push(db);
  const projId = `gc-dicok-p-${sfx}`, mgrId = `gc-dicok-mgr-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "DICOK", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-dicok-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-dicok-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { gateCancelVerifyMs: 2000 });

  const DIC_OK_OP_ID = `gc-dicok-op-${sfx}`;
  const pDic = sessions.gateSemaphore.runExclusive(
    1, { gateType: "worker", projectId: projId, sessionId: mgrId, taskId: null, opId: DIC_OK_OP_ID, distImporterCheckOnly: true },
    (_startedAt, cancelSignal) => new Promise((resolve) => {
      // UNLIKE (i)/(j): this fn genuinely stops once cancelled, settling promptly — the honest "the kill
      // actually worked" case `waitForSettleBriefly` must be able to report just as reliably as the
      // never-settling case reports the opposite.
      cancelSignal.addEventListener("abort", () => resolve({ passed: false, cancelled: true }));
    }),
    "low",
  ).catch(() => {});

  const liveEntry = await waitUntil(() => sessions.gateQueueForManager(projId).running.find((e) => e.opId === DIC_OK_OP_ID));
  check("(k) [setup] the distImporterCheckOnly entry is genuinely RUNNING before cancel", !!liveEntry && liveEntry.distImporterCheckOnly === true);

  if (liveEntry) {
    const cancelResult = await sessions.cancelGateOp(mgrId, liveEntry.opId, { scope: { kind: "project" } });
    check("(k) cancelGateOp reports cancelled (the kill WAS genuinely verified)", cancelResult.outcome === "cancelled");
    check("(k) the reported phase is \"running\" (it was admitted, not merely queued)", cancelResult.phase === "running");
    const snapAfter = sessions.gateQueueForManager(projId);
    check("(k) the slot IS now freed — the op is no longer reported live",
      !snapAfter.running.some((e) => e.opId === liveEntry.opId) && !snapAfter.queued.some((e) => e.opId === liveEntry.opId));
  } else {
    console.log("SKIP  (k) cancel assertions — setup sanity check above already failed");
  }

  void pDic;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GateSemaphore serializes same-worktree gate ops regardless of cap/tier (never grouping worktree-less ops together), a manager's merge decision auto-supersedes a worker's queued self-check for free, gate_cancel is project-scoped + never frees a slot over an unverified kill, and — card b9e07a4a — the SAME tool now reaches a repo-guard-only wait: a QUEUED one cancels cleanly through confirmWorkerMerge's own merge_cancelled path, a foreign project's is refused, and a HOLDING one is refused for the same staged-residue reason a RUNNING merge gate is. Card a0d912f5: a WORKER can cancel only its OWN run_gate self-check — never another worker's, and never a merge gate that happens to share its own sessionId — and intent/reason land verbatim in the settled op's own reason text, for BOTH a QUEUED cancel (GateCancelledError.detail) AND a VERIFIED RUNNING cancel (cancelSignalRef), the latter negative-controlled against a bare cancel that carries neither string."
  : `\n❌ ${failures} FAILURE(S).`);

for (const db of dbs) try { db.close(); } catch { /* ignore */ }
for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }

process.exit(failures === 0 ? 0 : 1);
