import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Worker self-gate structural bound (card 7f96aa09 — fix B for d5c5ccdf): proves `run_gate`
// (SessionService.runWorkerGate) is admitted through the SAME daemon-global GateSemaphore the
// merge/deploy gates already share — not a separate, unbounded budget — and that it composes safely
// with the existing PendingOpRegistry sync/async pattern.
//
// THE HOLE THIS GUARDS: before this, a worker's own DoD self-check ran the gate command via raw Bash,
// completely bypassing the daemon's GateSemaphore. Only the LOOM_GATE_TEST_CONCURRENCY=1 convention (fix A)
// kept N parallel workers from spiking total test-lanes. This test proves the STRUCTURAL bound: even a
// worker that runs its gate through `run_gate` alongside an in-flight MERGE gate never exceeds the
// configured `maxConcurrentGates` cap.
//
// Run: 1) build daemon (pnpm build), 2) node test/worker-run-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wg-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// STRUCTURAL barrier (card 4dd52048 — replaces (J)'s old fixed-wall-clock margin, which guessed how long
// confirmWorkerMerge's real git prep takes rather than observing it): polls SessionService.snapshotGates()
// — the same live GateSemaphore registry read the Gates page / gate_queue use — for a session's own gate
// entry to reach a given phase ("running"/"queued"). The registry records a QUEUED entry SYNCHRONOUSLY the
// instant GateSemaphore.runExclusive is called, before it ever awaits a slot (see gate-semaphore.ts), so
// this observes "has genuinely reached the semaphore" directly — no dependency on how long anything
// upstream (real git-subprocess work, admission itself) took to get there. `timeoutMs` is a safety-net
// backstop against a genuine hang, not part of the correctness logic: it never decides the assertion,
// only how long a broken run stalls before failing loudly instead of hanging the suite.
//
// Retrofitted onto the shared _wait.mjs waitUntil (card 0b8d8148): this file was excluded from the
// 22796d42 migration on the stated reason "deliberately performance.now(); migrating as-is reintroduces
// a documented CI flake class." That reason was accurate ONLY while _wait.mjs's own waitUntil was
// Date.now()-anchored — card 32ac0273 made it performance.now()-anchored (monotonic) before batch 3 even
// started, so both sides now share the same clock and the original discriminator no longer holds for
// THIS pair of helpers. (Blocks (L)/(L2) below do a genuinely different, still-untouched thing — a
// LOWER-bound assertion on the production `durationMs` value via a direct performance.now() delta, not a
// poll loop at all — and stay exactly as they were.) Same timeoutMs/intervalMs defaults and
// throw-on-timeout contract preserved; no call site here ever used the return value.
async function waitUntilGatePhase(sessions, sessionId, phase, label, timeoutMs = 10000, intervalMs = 20) {
  return sharedWaitUntil(() => {
    const entry = sessions.snapshotGates().gates.find((g) => g.sessionId === sessionId);
    return entry?.phase === phase;
  }, { timeoutMs, intervalMs, label });
}

// Generic poll-until (card acaf37cc): replaces a guessed fixed-wall-clock sleep before asserting on some
// side effect (an enqueued array, a callback firing) with a bounded poll against the ACTUAL condition.
// `timeoutMs` is a safety-net backstop against a genuine hang/regression, never part of the correctness
// logic — same role as `waitUntilGatePhase`'s own `timeoutMs`.
// Card 43f5b242: the local `waitUntil(conditionFn, label, timeoutMs, intervalMs)` wrapper that used to sit
// here was removed — its (fn, label, ...) positional order put `label` where the shared `_wait.mjs` helper
// expects a bare timeout number, the exact silent-misread shape that card exists to eliminate. The two
// call sites below now call `sharedWaitUntil` directly with an explicit options object (same
// timeoutMs:10000/intervalMs:20 the old wrapper defaulted to — values unchanged).

const GIT_ID = "-c user.email=wg@loom -c user.name=wg";
const now = new Date().toISOString();

const dbs = [];
const worktrees = [];

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wg\n");
  execSync(`git init -q && git config user.email wg@loom && git config user.name wg`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

// Seeds a manager + ONE merge-capable worker (real git worktree, for confirmWorkerMerge) + ONE
// gate-only worker whose worktreePath is a directory that's never created. The injected fake runGate
// is called with that path, which it ignores; runWorkerGate's OWN worktree-stamp read (card 50c1e0d0)
// against a nonexistent dir fails fast (simpleGit's constructor throws synchronously for a missing
// path — see computeWorktreeGateStamp's fail-safe catch), so this stays git-free in practice for these
// cases. Separate repos, same reasoning as gate-semaphore-concurrency.mjs: isolates the git side so the
// semaphore is the only shared resource.
async function seedWorkers(sfx, reposDir) {
  const db = new Db();
  dbs.push(db);
  const agentId = `wg-agent-${sfx}`, mgrId = `wg-mgr-${sfx}`;
  const mgrProjId = `wg-proj-mgr-${sfx}`;
  const mgrRepo = path.join(reposDir, "mgr");
  makeRepo(mgrRepo);
  db.insertProject({ id: mgrProjId, name: "WG-MGR", repoPath: mgrRepo, vaultPath: mgrRepo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: mgrProjId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: mgrProjId, agentId, engineSessionId: null, title: null, cwd: mgrRepo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  // Merge-capable worker (real worktree, gateCommand configured).
  const mergeProjId = `wg-proj-merge-${sfx}`, mergeTaskId = `wg-task-merge-${sfx}`, mergeWorkerId = `wg-wkr-merge-${sfx}`;
  const mergeRepo = path.join(reposDir, "merge-worker");
  makeRepo(mergeRepo);
  db.insertProject({ id: mergeProjId, name: "WG-MERGE", repoPath: mergeRepo, vaultPath: mergeRepo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${agentId}-merge`, projectId: mergeProjId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: mergeTaskId, projectId: mergeProjId, title: "WG-TASK-MERGE", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath: mergeWorktreePath, branch: mergeBranch } = await createWorktree(mergeRepo, mergeProjId, mergeTaskId);
  worktrees.push(mergeWorktreePath);
  fs.writeFileSync(path.join(mergeWorktreePath, "feature.txt"), "work\n");
  commitAll(mergeWorktreePath, "feature.txt", GIT_ID);
  db.insertSession({ id: mergeWorkerId, projectId: mergeProjId, agentId: `${agentId}-merge`, engineSessionId: null, title: null, cwd: mergeWorktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: mergeTaskId, worktreePath: mergeWorktreePath, branch: mergeBranch });

  // Gate-only worker (no git needed, gateCommand configured).
  const gateProjId = `wg-proj-gate-${sfx}`, gateWorkerId = `wg-wkr-gate-${sfx}`;
  const gateRepo = path.join(reposDir, "gate-worker");
  db.insertProject({ id: gateProjId, name: "WG-GATE", repoPath: gateRepo, vaultPath: gateRepo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${agentId}-gate`, projectId: gateProjId, name: "t", startupPrompt: "", position: 0 });
  const gateWorktreePath = path.join(reposDir, "gate-worker-wt");
  db.insertSession({ id: gateWorkerId, projectId: gateProjId, agentId: `${agentId}-gate`, engineSessionId: null, title: null, cwd: gateWorktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath: gateWorktreePath, branch: "loom/gate-only" });

  return { db, mgrId, mergeWorkerId, gateWorkerId };
}

const ptyStub = () => {
  const enqueued = [];
  return { stub: { stop() {}, isAlive() { return false; }, enqueueStdin: (...args) => enqueued.push(args) }, enqueued };
};

// Card 9ef89fee — sibling of 4032ba4d's AttachResult fix, but a DIFFERENT mechanism: below, `Promise.all`
// races the UNTRACKED `confirmWorkerMerge`/`runWorkerGate` calls directly (not the Tracked/
// PendingOpRegistry wrapper), so a genuine rejection (either call can throw for real under CPU
// starvation) rejects `Promise.all` itself and throws AT THE AWAIT, aborting the rest of this file before
// any later block runs. `Promise.allSettled` + explicit per-entry handling reports that rejection as a
// NAMED FAIL (with its error printed) and lets every remaining block still execute.
// DECISION (per the card): a rejection here is NOT tolerated — it's reported as a FAIL, not swallowed.
// Every block below asserts both calls SUCCEED under the semaphore; a rejection failing that property is
// the exact thing this file exists to catch, so it must surface as a failing check, not be silently
// treated as an acceptable outcome of "racing under load".
async function raceReport(promises, labels, blockLabel) {
  const settled = await Promise.allSettled(promises);
  return settled.map((s, i) => {
    check(`(${blockLabel}) ${labels[i]} did not reject`, s.status === "fulfilled");
    if (s.status === "rejected") {
      console.log(`  -> (${blockLabel}) ${labels[i]} rejected: ${s.reason?.stack || s.reason}`);
    }
    return s.status === "fulfilled" ? s.value : null;
  });
}

try {
  // ── (A) mixed merge-gate + worker-gate calls never exceed the configured cap ────────────────────────
  // Card acaf37cc: the old version raced both calls behind a fixed 4000ms fake-gate sleep and HOPED that
  // was wide enough to outlast confirmWorkerMerge's real git prep (stranded-check, union-merge) before the
  // second call ever reached the semaphore — on a slow enough host the two windows simply fail to overlap,
  // maxActive===1 holds TRIVIALLY, and the cap-blocks-concurrency property goes untested while the test
  // still reads green. Fixed the same STRUCTURAL way as sibling block (J): the first call is held open by
  // an externally-controlled promise, released ONLY once `waitUntilGatePhase` has structurally confirmed
  // the second call actually reached the semaphore and is genuinely QUEUED behind it — real contention for
  // the cap-1 slot, not a guessed wall-clock margin. If that contention never happens (e.g. a slow host, or
  // a regression that lets the second call skip queueing), `waitUntilGatePhase` throws and this block — and
  // the whole file — fails loudly: an untested cap can no longer read as a passing cap.
  {
    const sfx = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-a-${sfx}`);
    registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
    const { db, mgrId, mergeWorkerId, gateWorkerId } = await seedWorkers(sfx, reposDir);

    let active = 0, maxActive = 0, calls = 0;
    let releaseGate1;
    const gate1Wait = new Promise((res) => { releaseGate1 = res; });
    const fakeGate = async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      if (calls === 1) await gate1Wait; // hold the FIRST call open until contention is structurally confirmed
      active--;
      return { passed: true };
    };
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: fakeGate });

    const gatePromise = sessions.runWorkerGate(gateWorkerId);
    await waitUntilGatePhase(sessions, gateWorkerId, "running", "(A) gate");
    const mergePromise = sessions.confirmWorkerMerge(mgrId, mergeWorkerId);
    // POSITIVE CONTROL on the test's own premise: fails the file if the merge never genuinely contends
    // for the cap-1 slot, instead of letting an unproven "no overlap happened" read as a passing cap.
    await waitUntilGatePhase(sessions, mergeWorkerId, "queued", "(A) merge");
    releaseGate1(); // only now — the second call is structurally confirmed queued behind the first

    const [gateResult, mergeResult] = await raceReport(
      [gatePromise, mergePromise],
      ["runWorkerGate", "confirmWorkerMerge"],
      "A",
    );
    check("(A) both the merge gate and the worker gate actually ran", calls === 2);
    check("(A) default cap 1 NEVER let a merge gate and a worker gate run concurrently", maxActive === 1);
    check("(A) the merge still succeeded", mergeResult?.merged === true);
    check("(A) the worker gate settled inline and passed", gateResult?.settled === true && gateResult?.ok === true && gateResult?.value.passed === true);
  }

  // ── (B) raising the cap to 2 lets a merge gate and a worker gate run TRULY concurrently ────────────
  // Card 0742f8c3: the old version proved overlap by HOPING a 4000ms sleep was wide enough to outlast
  // confirmWorkerMerge's real git prep (stranded-check + union-merge) before runWorkerGate's own gate call
  // finished — an invisible margin that a saturated host can blow through (git prep can itself take
  // arbitrarily long under load), letting the first fake gate complete and release its slot before the
  // second is ever admitted. That's the same "guessed wall-clock margin" class as (J)'s old fixed-2500ms
  // hold and (L)'s old bare durationMs pin — fixed here the same way: make the overlap STRUCTURALLY
  // GUARANTEED rather than scheduler-dependent. Each fake-gate invocation blocks (after recording its own
  // active++, so maxActive is already captured) until BOTH invocations have actually entered — i.e. both
  // calls were genuinely admitted concurrently by the semaphore — then releases both together. This
  // observes the real property under test (cap 2 lets two calls be inside the gate at once) directly,
  // with no dependency on how long anything upstream took. `OVERLAP_TIMEOUT_MS` is a safety-net backstop
  // for a genuine regression (cap 2 somehow never admits the second call) — like `waitUntilGatePhase`'s
  // `timeoutMs`, it never decides the assertion (maxActive would correctly stay at 1 and the check would
  // fail), it just stops a broken run from hanging the suite forever.
  {
    const sfx = `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-b-${sfx}`);
    registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
    const { db, mgrId, mergeWorkerId, gateWorkerId } = await seedWorkers(sfx, reposDir);
    db.setPlatformConfig({ maxConcurrentGates: 2 });

    let active = 0, maxActive = 0, calls = 0;
    let resolveBothEntered;
    const bothEntered = new Promise((res) => { resolveBothEntered = res; });
    const OVERLAP_TIMEOUT_MS = 8000; // safety net only — see comment above; never widen this to "fix" a flake
    const bothEnteredOrTimeout = Promise.race([bothEntered, sleep(OVERLAP_TIMEOUT_MS)]);
    const fakeGate = async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      if (calls === 2) resolveBothEntered();
      await bothEnteredOrTimeout; // block until the OTHER call has genuinely entered too (or the safety net fires)
      active--;
      return { passed: true };
    };
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: fakeGate });

    const [mergeResult, gateResult] = await raceReport(
      [sessions.confirmWorkerMerge(mgrId, mergeWorkerId), sessions.runWorkerGate(gateWorkerId)],
      ["confirmWorkerMerge", "runWorkerGate"],
      "B",
    );
    check("(B) both ran", calls === 2);
    check("(B) cap 2 let the merge gate and the worker gate run truly concurrently", maxActive === 2);
    check("(B) the merge still succeeded", mergeResult?.merged === true);
    check("(B) the worker gate still passed", gateResult?.ok === true && gateResult?.value.passed === true);
  }

  // ── (C) WITHOUT the semaphore (calling the fake gate directly), two concurrent calls DO overlap —
  //        proves (A)'s maxActive===1 is a real guard, not an accident of how fast the fake resolves ──
  {
    let active = 0, maxActive = 0;
    const rawGate = async () => {
      active++; maxActive = Math.max(maxActive, active);
      await sleep(150);
      active--;
      return { passed: true };
    };
    await Promise.all([rawGate(), rawGate()]);
    check("(C) unguarded, the SAME fake gate genuinely overlaps (maxActive===2)", maxActive === 2);
  }

  // ── (D) fast path returns inline, no opId/pending wrapper ──────────────────────────────────────────
  {
    const sfx = `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-d-${sfx}`);
    registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
    const { db, gateWorkerId } = await seedWorkers(sfx, reposDir);
    const fastGate = async () => ({ passed: true });
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: fastGate });

    const r = await sessions.runWorkerGate(gateWorkerId);
    check("(D) a fast gate settles inline (no opId/pending wrapper)", r.settled === true && r.ok === true);
    check("(D) reports ran:true, passed:true", r.value.ran === true && r.value.passed === true);

    // Card 78214063 DoD-3 (PASS path): the durable `worker_gate` event's own detail carries the SAME
    // opId the caller was returned — the reachability key `findGateOpEventsByOpId`/`gate_history` depend
    // on. `findGateOpEventsByOpId` is the exact join-key lookup `recoverGateOpVerdict` (card 7d492f8b)
    // uses — querying BY the returned opId and finding a row back is itself the proof the event's detail
    // actually carries it (json_extract match), not merely that some `worker_gate` row happens to exist.
    const passEvents = db.findGateOpEventsByOpId(r.value.opId);
    const passGateEvent = passEvents.find((e) => e.kind === "worker_gate");
    check("(D) the durable worker_gate event is reachable BY the caller's own returned opId", !!passGateEvent);
    check("(D) that event's own detail.opId equals the returned opId (not just query-matched)", passGateEvent?.detail?.opId === r.value.opId);
    check("(D) §SCOPE-LIMIT: a PASS with no auto-extend records extended:false (never omitted)", passGateEvent?.detail?.extended === false);
  }

  // ── (D2) run_gate's spawned child is pinned to LOOM_GATE_TEST_CONCURRENCY=3 (card 68920f5b: matches
  //         the merge gate's own default lane count — was "=1" pre-68920f5b, half the merge gate's
  //         parallelism against the same gateCommandTimeoutMs, which made run_gate structurally more
  //         timeout-prone than the merge gate it feeds; raised 2->3 by card 2ff32b5c alongside
  //         DEFAULT_CONCURRENCY's own 2->3 raise, to keep matching the merge gate's default) ─────────
  // Card ba3c9580: renamed from the generic `LOOM_TEST_CONCURRENCY`, which this project's own gate child
  // (as any OTHER project's would too — nothing here branches on project identity, so this "WG-GATE" test
  // project stands in for a non-Loom project just as well) received unconditionally regardless of whether
  // anything in ITS harness was ever meant to read that generic a name. The second check below proves the
  // old name is now GONE from the injected env, not merely that the new one is present — verified failing
  // against pre-rename code (git-stashed) before this fix, passing after: this is the DoD's required
  // positive control on the "non-Loom project does not receive the Loom-private variable" property.
  {
    const sfx = `d2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-d2-${sfx}`);
    registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
    const { db, gateWorkerId } = await seedWorkers(sfx, reposDir);
    let capturedEnvOverride;
    const capturingGate = async (_gate, _worktreePath, _timeoutMs, _onOutput, envOverride) => {
      capturedEnvOverride = envOverride;
      return { passed: true };
    };
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: capturingGate });

    await sessions.runWorkerGate(gateWorkerId);
    check("(D2) run_gate pins LOOM_GATE_TEST_CONCURRENCY=3 on its spawned child", capturedEnvOverride?.LOOM_GATE_TEST_CONCURRENCY === "3");
    check("(D2) run_gate does NOT inject the old generic LOOM_TEST_CONCURRENCY name (closes the cross-project collision hazard)", capturedEnvOverride?.LOOM_TEST_CONCURRENCY === undefined);
    // Card 85c3812d DoD-3: `gateOpIdEnvOverride(opId, WORKER_GATE_ENV_OVERRIDE)` (service.ts, both private —
    // this real `runWorkerGate` call is the only way to exercise that merge without re-deriving its logic
    // by hand) must deliver BOTH keys in the SAME object, not just the LOOM_GATE_TEST_CONCURRENCY checked
    // above — a merge that silently clobbered LOOM_GATE_OP_ID while keeping the concurrency pin would still
    // pass the two checks above.
    check("(D2) the SAME captured envOverride also carries a LOOM_GATE_OP_ID (the merge keeps BOTH keys, neither clobbers the other)",
      typeof capturedEnvOverride?.LOOM_GATE_OP_ID === "string" && capturedEnvOverride.LOOM_GATE_OP_ID.length > 0);
  }

  // ── (E) slow path degrades to {opId,status:pending} and later delivers a [loom:gate-*] nudge ──────
  {
    const { enqueued } = ptyStub();
    // SYNC_ATTACH_BUDGET_MS (runWorkerGate's real sync-wait budget) is a module constant (12s) — too slow
    // to wait out in a unit test. This case instead directly drives PendingOpRegistry with a short waitMs
    // via a raw attach() call, using the EXACT same "gate" kind + degrade/nudge shape runWorkerGate wires
    // into, to prove the pending→settle→nudge mechanics without waiting 12 real seconds.
    const { PendingOpRegistry } = await import("../dist/orchestration/pending-ops.js");
    const registry = new PendingOpRegistry();
    const short = await registry.attach(
      "gate:manual-test", "gate", "manual-test", 50,
      async (opId) => { await sleep(300); return { ran: true, passed: false, reason: "build gate failed", opId }; },
      (outcome, opId) => { enqueued.push([opId, outcome]); },
    );
    check("(E) a slow op degrades to {settled:false, op}", short.settled === false && typeof short.op.opId === "string");
    // "exactly one" is a prove-a-negative property (no SECOND settle callback) — gating on the arrival of
    // the FIRST push would shrink the window a duplicate could still be observed in to ~zero (the (A)
    // false-pass shape). Instead poll the registry's OWN terminal signal: no `retainMs` was passed to this
    // `attach()` call, so `peek()` EVICTS TO undefined the instant the entry settles (see pending-ops.ts's
    // "EVICT-ON-SETTLE" class doc) — and that eviction happens synchronously, in the SAME un-awaited
    // callback turn as the `onSettledAfterPending` push below it, so by the time this observes the entry
    // gone, the (sole legitimate) push has already happened. Counting only AFTER that structural terminal
    // state is reached is sound, unlike counting the instant the first push lands.
    await sharedWaitUntil(() => registry.peek("gate:manual-test") === undefined, { timeoutMs: 10000, intervalMs: 20, label: "(E) settle callback" });
    check("(E) the terminal settle callback eventually fired", enqueued.length === 1 && enqueued[0][0] === short.op.opId);
  }

  // ── (F) unconfigured gateCommand: clear result, no throw, never touches the semaphore ─────────────
  {
    const sfx = `f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-f-${sfx}`);
    registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
    const { db, gateWorkerId } = await seedWorkers(sfx, reposDir);
    // Blank out gateCommand for the gate-only worker's own project.
    const gateWorkerProjId = db.getSession(gateWorkerId).projectId;
    db.setProjectConfig(gateWorkerProjId, {});
    let gateCalls = 0;
    const neverCalledGate = async () => { gateCalls++; return { passed: true }; };
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: neverCalledGate });

    const r = await sessions.runWorkerGate(gateWorkerId);
    check("(F) unconfigured gateCommand returns ran:false with a clear reason, doesn't throw", r.settled === true && r.ok === true && r.value.ran === false && typeof r.value.reason === "string");
    check("(F) the gate runner was never invoked", gateCalls === 0);
  }

  // ── (G) a thrown/rejecting gate still releases its semaphore slot (no permanent leak) ─────────────
  {
    const sfx = `g-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-g-${sfx}`);
    registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
    const { db, gateWorkerId } = await seedWorkers(sfx, reposDir);
    let callNum = 0;
    const crashThenRecover = async () => {
      callNum++;
      if (callNum === 1) throw new Error("boom");
      return { passed: true };
    };
    const { stub } = ptyStub();
    // gateOpRetainMs shrunk to 100ms (from the 5s production GATE_OP_RETAIN_MS default) via its existing
    // test-only DI seam (service.ts, mirrors gateCancelVerifyMs) — card 0faaaa55. Same logical shape (a
    // re-call outside the retention window genuinely retries) at a fraction of the wall-clock cost.
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: crashThenRecover, gateOpRetainMs: 100 });

    // A rejecting run() is caught INSIDE PendingOpRegistry.attach (its `.then(_, onError)` never rethrows
    // — see pending-ops.ts) and surfaces as a normal {settled:true, ok:false, error} result, not a thrown
    // exception — runWorkerGate itself never throws for a rejecting gate.
    const r1 = await sessions.runWorkerGate(gateWorkerId);
    check("(G) a rejecting gate run surfaces as ok:false (not swallowed, not a throw)", r1.settled === true && r1.ok === false);

    // An IMMEDIATE re-call lands inside this instance's (shrunk) gateOpRetainMs settle-grace window —
    // it must be served the SAME cached errored outcome, NOT trigger a second (recovering) run.
    const rImmediate = await sessions.runWorkerGate(gateWorkerId);
    check("(G) an immediate re-call within the retention window replays the SAME errored outcome (no new run)", rImmediate.settled === true && rImmediate.ok === false);
    check("(G) that re-call did NOT invoke the gate again", callNum === 1);

    // Only OUTSIDE the retention window does a re-call genuinely retry — proving the slot isn't
    // PERMANENTLY leaked by a rejecting run, which is what this case is actually about.
    await new Promise((r) => setTimeout(r, 250));
    const r2 = await sessions.runWorkerGate(gateWorkerId);
    check("(G) a SUBSEQUENT gate run (past the retention window) still acquires the semaphore slot (no permanent leak)", r2.settled === true && r2.ok === true && r2.value.passed === true);
    // AUDIT-ON-ERROR (CR follow-up): a genuine throw (not a gate FAILURE) used to leave NO durable
    // event at all — appendEvent was only ever reached after a normal settle. Confirm the FIRST
    // (rejecting) call still left a worker_gate audit row with the error message recorded.
    const events = db.listEventsForWorker(gateWorkerId);
    const errorEvents = events.filter((e) => e.kind === "worker_gate" && e.detail?.error);
    check("(G) the rejecting run STILL left a durable worker_gate audit event", errorEvents.length === 1);
    check("(G) the audit event's error detail names the thrown error", errorEvents[0]?.detail?.error === "boom" && errorEvents[0]?.detail?.passed === false);
  }

  // ── (I) audit enrichment: a FAILED gate's durable event carries the same rich diagnostic detail
  //        (phase/failedStep/failingTest/exitCode/signal/timedOut/outputTail) the return value/nudge do,
  //        not just a flat {passed:false} ─────────────────────────────────────────────────────────────
  {
    const sfx = `i-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-i-${sfx}`);
    registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
    const { db, gateWorkerId } = await seedWorkers(sfx, reposDir);
    const failingGate = async () => ({
      passed: false, failedStep: "pnpm test", failedStatus: 1, failedSignal: null, failedTimedOut: false,
      outputTail: "FAIL some-test.mjs\nAssertionError: expected true",
    });
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: failingGate });

    const r = await sessions.runWorkerGate(gateWorkerId);
    check("(I) the failure settles inline with the rich gateDetail", r.settled === true && r.ok === true && r.value.passed === false && r.value.gateDetail?.failedStep === "pnpm test");

    const events = db.listEventsForWorker(gateWorkerId);
    const failEvent = events.find((e) => e.kind === "worker_gate" && e.detail?.passed === false);
    check("(I) a worker_gate audit event was recorded for the failure", !!failEvent);
    check("(I) it carries phase (derived from the failing step's own command)", failEvent?.detail?.phase === "test");
    check("(I) it carries failedStep + exitCode + signal + timedOut (deploy-event parity)",
      failEvent?.detail?.failedStep === "pnpm test" && failEvent?.detail?.exitCode === 1 && failEvent?.detail?.signal === null && failEvent?.detail?.timedOut === false);
    // CONTROL_CHAR_RE (pty/host.ts) strips the FULL C0 range (0x00-0x1F), which includes `\n` — same
    // sanitizer confirmWorkerMerge's own rejection path uses, applied here BEFORE extractFailingTest runs
    // (mirrors that call order exactly), so a multi-line tail collapses to one line before extraction —
    // extractFailingTest's first pattern (FAIL/✗/✖/not ok) then matches that single collapsed line in
    // full. Not a bug introduced here; asserting the ACTUAL (collapsed) shape rather than the naive
    // per-line expectation.
    check("(I) it carries failingTest, extracted from the (newline-collapsed) output tail",
      failEvent?.detail?.failingTest === "FAIL some-test.mjsAssertionError: expected true");
    check("(I) it carries the outputTail too", typeof failEvent?.detail?.outputTail === "string" && failEvent.detail.outputTail.includes("FAIL some-test.mjs"));

    // Card 78214063 DoD-3 (FAIL path): same opId-reachability + extended:false proof as (D)'s PASS case,
    // through the SAME real production write path (runWorkerGate -> the `evt` closure -> appendEvent).
    check("(I) the failure event's own opId equals the caller's returned opId", failEvent?.detail?.opId === r.value.opId);
    const failByOpId = db.findGateOpEventsByOpId(r.value.opId).find((e) => e.kind === "worker_gate");
    check("(I) the SAME event is reachable BY that opId via findGateOpEventsByOpId (the recoverGateOpVerdict join key)", failByOpId?.id === failEvent?.id);
    check("(I) §SCOPE-LIMIT: a FAIL with no auto-extend records extended:false (never omitted)", failEvent?.detail?.extended === false);
  }

  // ── (I2) card 78214063 §SCOPE-LIMIT: when the gate's current step DOES consume its one-time
  //         auto-extend, the worker_gate event's own `extended` field reads true — proves the field is a
  //         REAL signal (RED against pre-fix code, which never stamped this key at all), not just a
  //         constant `false` that (D)/(I) alone couldn't tell apart from "always false" ─────────────────
  {
    const sfx = `i2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-i2-${sfx}`);
    registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
    const { db, gateWorkerId } = await seedWorkers(sfx, reposDir);
    // Signature mirrors runGateSequential's real one: (gate, worktreePath, timeoutMs, onOutput, envOverride,
    // _unused, cancelSignal, hooks) — `hooks` is runWorkerGate's own `mirroredHooks` wrapper, so calling
    // onExtend here exercises the SAME interception confirmWorkerMerge's `anyExtended` already proves safe.
    const extendingGate = async (_gate, _worktreePath, _timeoutMs, _onOutput, _envOverride, _unused, _cancelSignal, hooks) => {
      hooks.onExtend();
      return { passed: true, steps: [] };
    };
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: extendingGate });

    const r = await sessions.runWorkerGate(gateWorkerId);
    check("(I2) the extending gate still settles inline and passes", r.settled === true && r.ok === true && r.value.passed === true);
    const extEvent = db.findGateOpEventsByOpId(r.value.opId).find((e) => e.kind === "worker_gate");
    check("(I2) the durable event exists and carries the same opId", !!extEvent && extEvent.detail?.opId === r.value.opId);
    check("(I2) §SCOPE-LIMIT, THE ACTUAL SIGNAL: extended reads true when onExtend genuinely fired", extEvent?.detail?.extended === true);
  }

  // ── (J) PRIORITY WIRING (card 24642c3d): confirmWorkerMerge ("high") is NOT head-of-line-blocked by
  //        ALREADY-QUEUED runWorkerGate ("low") calls — the exact starvation pattern this card fixes.
  //        Cap 1 (default): gate1 grabs the only slot and holds it (until the test explicitly releases
  //        it — see below); gate2 (a SECOND, independent gate-only worker — runWorkerGate single-flights
  //        per workerSessionId via PendingOpRegistry, so two concurrent calls for the SAME worker would
  //        attach to one in-flight op instead of each taking their own semaphore turn) queues behind it;
  //        the merge fires LAST but, being high-priority, is serviced BEFORE gate2's already-queued call
  //        once gate1 releases the slot.
  //
  //        STRUCTURAL, not wall-clock (card 4dd52048): the original version held gate1 for a fixed
  //        2500ms and guessed confirmWorkerMerge's real git prep (stranded-check + union-merge) would
  //        finish enqueueing within that window (empirically ~1.1s locally) — an INVISIBLE margin that
  //        reproduced flaky under real fleet load. This version instead uses `waitUntilGatePhase` to poll
  //        the semaphore's own live registry and only releases gate1 once gate2 and the merge are BOTH
  //        structurally confirmed queued behind it — correct regardless of how long git prep actually
  //        takes on the host it runs on. ─────────────────────────────────────────────────────────────
  {
    const sfx = `j-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-j-${sfx}`);
    registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
    const { db, mgrId, mergeWorkerId, gateWorkerId: gateWorkerId1 } = await seedWorkers(sfx, reposDir);
    // Platform config is GLOBAL and persists across test blocks sharing this file's one LOOM_HOME db (test
    // (B) above raises it to 2) — pin it back to the default 1 explicitly so this test's cap=1 assumption
    // (needed to force gate2 to actually queue) doesn't depend on block ordering.
    db.setPlatformConfig({ maxConcurrentGates: 1 });
    const gateWorktreePath1 = path.join(reposDir, "gate-worker-wt"); // matches seedWorkers' own construction

    const gateProjId2 = `wg-proj-gate2-${sfx}`, gateWorkerId2 = `wg-wkr-gate2-${sfx}`;
    const gateRepo2 = path.join(reposDir, "gate-worker-2");
    const gateWorktreePath2 = path.join(reposDir, "gate-worker-2-wt");
    db.insertProject({ id: gateProjId2, name: "WG-GATE-2", repoPath: gateRepo2, vaultPath: gateRepo2, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `wg-agent-gate2-${sfx}`, projectId: gateProjId2, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: gateWorkerId2, projectId: gateProjId2, agentId: `wg-agent-gate2-${sfx}`, engineSessionId: null, title: null, cwd: gateWorktreePath2, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath: gateWorktreePath2, branch: "loom/gate-only-2" });

    const startOrder = [];
    let active = 0, maxActive = 0;
    // gate1 is held open by an EXTERNALLY-controlled promise, not a fixed sleep — the test releases it
    // only once it has structurally confirmed gate2 AND the merge are both genuinely queued behind it.
    let releaseGate1;
    const gate1Wait = new Promise((res) => { releaseGate1 = res; });
    const fakeGate = async (_gate, worktreePath) => {
      const label = worktreePath === gateWorktreePath1 ? "gate1" : worktreePath === gateWorktreePath2 ? "gate2" : "merge";
      startOrder.push(label);
      active++; maxActive = Math.max(maxActive, active);
      if (label === "gate1") await gate1Wait;
      active--;
      return { passed: true };
    };
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: fakeGate });

    const p1 = sessions.runWorkerGate(gateWorkerId1);
    await waitUntilGatePhase(sessions, gateWorkerId1, "running", "(J) gate1");
    const p2 = sessions.runWorkerGate(gateWorkerId2); // queues ("low") behind gate1
    await waitUntilGatePhase(sessions, gateWorkerId2, "queued", "(J) gate2");
    const p3 = sessions.confirmWorkerMerge(mgrId, mergeWorkerId); // queues ("high") — LAST to fire
    // Waits out confirmWorkerMerge's real git prep for however long it ACTUALLY takes on this host —
    // no guessed margin, however loaded the machine is.
    await waitUntilGatePhase(sessions, mergeWorkerId, "queued", "(J) merge");
    releaseGate1(); // only now — every party is structurally confirmed running/queued

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    check("(J) all three eventually ran", startOrder.length === 3);
    check("(J) cap 1 held throughout — never more than 1 concurrent (the ordering below isn't an artifact of a leaked higher cap)", maxActive === 1);
    check("(J) gate1 (already running before anything queued) ran first", startOrder[0] === "gate1");
    check("(J) the HIGH-priority merge (queued LAST) is serviced BEFORE the already-queued LOW-priority gate2 — no head-of-line blocking",
      startOrder.indexOf("merge") < startOrder.indexOf("gate2"));
    check("(J) all three calls still completed successfully", r1.ok === true && r2.ok === true && r3.merged === true);
  }

  // ── (H) role gate: a non-worker session cannot call runWorkerGate ──────────────────────────────────
  {
    const sfx = `h-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-h-${sfx}`);
    registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
    const { db, mgrId } = await seedWorkers(sfx, reposDir);
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: async () => ({ passed: true }) });
    let threw = false;
    try { await sessions.runWorkerGate(mgrId); } catch { threw = true; }
    check("(H) a manager session is REFUSED run_gate (worker-only surface)", threw === true);
  }

  // ── (K) card 55cba5c5: the ASYNC [loom:gate-failed] nudge — the ONLY thing a worker sees for a
  //        genuinely slow gate (its tool set has no fetch-by-opId) — carries the structured
  //        phase/failedStep/failingTest detail, not just a raw stderr tail. Forces the real pending→
  //        settle→nudge path (the fake gate sleeps past this instance's shrunk syncAttachBudgetMs — see
  //        card 0faaaa55, from the 12s production SYNC_ATTACH_BUDGET_MS) through the ACTUAL
  //        runWorkerGate/PendingOpRegistry wiring — not a re-derivation — and supplies a `failingTest`
  //        separately from `outputTail` (an unrelated epilogue), exactly the truncation shape the card
  //        was filed over: the tail alone would never reveal the failing test's identity. ────────────
  {
    const sfx = `k-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-k-${sfx}`);
    registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
    const { db, gateWorkerId } = await seedWorkers(sfx, reposDir);
    const failingAsyncGate = async () => {
      await sleep(350); // past this instance's 150ms syncAttachBudgetMs — forces the pending→settle→nudge path
      return {
        passed: false, failedStep: "pnpm test", failedStatus: 1, failedSignal: null, failedTimedOut: false,
        // Live-scanned by gate-runner.ts independently of outputTail (card 55cba5c5) — outputTail here is
        // deliberately UNRELATED trailing noise, mirroring a tail dominated by a pnpm epilogue that never
        // itself contains the failing-test line.
        failingTest: "FAIL some-test.mjs > widget renders",
        outputTail: "epilogue noise unrelated to the failure\n".repeat(50),
      };
    };
    const { stub, enqueued } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: failingAsyncGate, syncAttachBudgetMs: 150 });

    const pending = await sessions.runWorkerGate(gateWorkerId);
    check("(K) the slow gate degrades to the pending shape", pending.settled === false);
    const isGateFailedMsg = (args) => args[0] === gateWorkerId && typeof args[1] === "string" && args[1].includes("[loom:gate-failed]");
    // "exactly ONE" is a prove-a-negative property — gating on the arrival of the first matching push (as
    // opposed to a fixed sleep) would shrink the window a genuine DUPLICATE nudge could still be caught in
    // to ~zero, the same false-pass shape (A) was carded for. Instead poll runWorkerGate's OWN pending op
    // for its terminal settle: `state !== "running"` means the op has left PendingOpRegistry's `entries`
    // map for good (runWorkerGate passes `retainMs`, so it lands in the RETAINED view rather than
    // evicting to `undefined` — see pending-ops.ts's "EVICT-ON-SETTLE"/"RETAINED TERMINAL VIEW" class doc)
    // — and that transition happens synchronously, in the SAME un-awaited callback turn as the
    // `onSettledAfterPending` push that sends this nudge, so by the time this observes the terminal state,
    // the (sole legitimate) push has already landed. Same seam an existing sibling test already uses for
    // this exact purpose — see run-gate-result-consumption.mjs's own `sessions.pendingOps.peek(...)` wait.
    await sharedWaitUntil(() => sessions.pendingOps.peek(`gate:${gateWorkerId}`)?.state !== "running", { timeoutMs: 10000, intervalMs: 20, label: "(K) gate op settle" });

    const gateFailedMsgs = enqueued.filter(isGateFailedMsg);
    check("(K) exactly ONE [loom:gate-failed] nudge reached the worker's own pty", gateFailedMsgs.length === 1);
    const text = gateFailedMsgs[0]?.[1] ?? "";
    check("(K) the nudge names the failed step (not just a raw tail)", text.includes("step: pnpm test"));
    check("(K) the nudge names the phase", text.includes("phase: test"));
    check("(K) the nudge names the failing test from the LIVE-scanned field", text.includes("failing: FAIL some-test.mjs > widget renders"));
    const tailBlock = text.split("--- gate output tail ---")[1] ?? "";
    check("(K) the raw tail block does NOT itself contain the failing test — proving the identity came from the live field, not the tail", !tailBlock.includes("widget renders"));
  }
  // ── (L) card 2d72595c: run_gate returns a numeric durationMs — wall-clock from admission to settle
  //        (excludes queue wait) — on BOTH a passing and a failing outcome. This is the timing number a
  //        manager should read instead of directing a worker to hand-run the suite for one (the second
  //        of the two observed semaphore-bypass instances this card exists to fix).
  //
  //        TIMING NOTE (card 4dd52048): the production `durationMs` is computed in service.ts via
  //        `Date.now() - gateStartedAt` — `Date.now()` reads the SYSTEM wall clock, which is not
  //        guaranteed monotonic (an NTP/clock-sync adjustment mid-run can make two reads a few ms apart
  //        disagree with the real elapsed time), and its coarse per-ms resolution leaves no headroom
  //        under host load. The original assertion pinned a bare `>=` against the fake's own exact sleep
  //        value with zero slack and flaked 3x under real fleet load. This version (a) widens the fake's
  //        own sleep so a few ms of clock jitter can't meaningfully threaten the property, (b)
  //        cross-checks `durationMs` against an INDEPENDENT `performance.now()` (monotonic) measurement
  //        of the whole call, and (c) gives the lower bound explicit, documented slack instead of an
  //        undeclared exact match — still failing on the real regression this guards (durationMs stuck
  //        at 0, or otherwise not actually measuring the run). ────────────────────────────────────────
  {
    const sfx = `l-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-l-${sfx}`);
    registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
    const { db, gateWorkerId } = await seedWorkers(sfx, reposDir);
    const SLEEP_MS = 100; // wide margin — see TIMING NOTE above
    const SLACK_MS = 50; // explicit, generous jitter budget (half of SLEEP_MS) — see TIMING NOTE above
    const slowishGate = async () => { await sleep(SLEEP_MS); return { passed: true }; };
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: slowishGate });

    const wallStart = performance.now(); // MONOTONIC — avoids the Date.now() CI timing-flake class
    const rPass = await sessions.runWorkerGate(gateWorkerId);
    const wallElapsed = performance.now() - wallStart;
    check("(L) a PASSING gate returns a numeric durationMs", rPass.settled === true && rPass.ok === true && typeof rPass.value.durationMs === "number");
    check("(L) that durationMs reflects the actual run time (within slack of the fake's own sleep, and never more than the independently-measured wall-clock call)",
      rPass.value.durationMs >= SLEEP_MS - SLACK_MS && rPass.value.durationMs <= wallElapsed + SLACK_MS);
  }
  {
    const sfx = `l2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-l2-${sfx}`);
    registerForCleanup(reposDir); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repos root
    const { db, gateWorkerId } = await seedWorkers(sfx, reposDir);
    const SLEEP_MS = 100; // see (L)'s own TIMING NOTE above
    const SLACK_MS = 50;
    const failingGate = async () => {
      await sleep(SLEEP_MS);
      return { passed: false, failedStep: "pnpm test", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "FAIL x" };
    };
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: failingGate });

    const wallStart = performance.now();
    const rFail = await sessions.runWorkerGate(gateWorkerId);
    const wallElapsed = performance.now() - wallStart;
    check("(L) a FAILING gate ALSO returns a numeric durationMs", rFail.settled === true && rFail.ok === true && rFail.value.passed === false && typeof rFail.value.durationMs === "number");
    check("(L) that durationMs reflects the actual run time (within slack of the fake's own sleep, and never more than the independently-measured wall-clock call)",
      rFail.value.durationMs >= SLEEP_MS - SLACK_MS && rFail.value.durationMs <= wallElapsed + SLACK_MS);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — run_gate is admitted through the SAME GateSemaphore merge/deploy gates share (structural bound, not just LOOM_GATE_TEST_CONCURRENCY=1 convention), composes with PendingOpRegistry's sync/async degrade, and fails closed/role-gated correctly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
