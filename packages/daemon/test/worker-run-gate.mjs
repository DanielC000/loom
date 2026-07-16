import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Worker self-gate structural bound (card 7f96aa09 — fix B for d5c5ccdf): proves `run_gate`
// (SessionService.runWorkerGate) is admitted through the SAME daemon-global GateSemaphore the
// merge/deploy gates already share — not a separate, unbounded budget — and that it composes safely
// with the existing PendingOpRegistry sync/async pattern.
//
// THE HOLE THIS GUARDS: before this, a worker's own DoD self-check ran the gate command via raw Bash,
// completely bypassing the daemon's GateSemaphore. Only the LOOM_TEST_CONCURRENCY=1 convention (fix A)
// kept N parallel workers from spiking total test-lanes. This test proves the STRUCTURAL bound: even a
// worker that runs its gate through `run_gate` alongside an in-flight MERGE gate never exceeds the
// configured `maxConcurrentGates` cap.
//
// Run: 1) build daemon (pnpm build), 2) node test/worker-run-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wg-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT_ID = "-c user.email=wg@loom -c user.name=wg";
const now = new Date().toISOString();

const dbs = [];
const worktrees = [];

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wg\n");
  execSync(`git init -q && git config user.email wg@loom && git config user.name wg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

// Seeds a manager + ONE merge-capable worker (real git worktree, for confirmWorkerMerge) + ONE
// gate-only worker (no real git needed — runWorkerGate never touches git, only the injected fake
// runGate is called with its worktreePath, which the fake ignores). Separate repos, same reasoning as
// gate-semaphore-concurrency.mjs: isolates the git side so the semaphore is the only shared resource.
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
  execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt"`, { cwd: mergeWorktreePath });
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

try {
  // ── (A) mixed merge-gate + worker-gate calls never exceed the configured cap ────────────────────────
  {
    const sfx = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-a-${sfx}`);
    const { db, mgrId, mergeWorkerId, gateWorkerId } = await seedWorkers(sfx, reposDir);

    let active = 0, maxActive = 0, calls = 0;
    const fakeGate = async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      // WIDE overlap window: confirmWorkerMerge does real git prep (stranded-check, union-merge) BEFORE
      // it ever reaches the gate call, while runWorkerGate has none of that — so the two calls' actual
      // gate windows start skewed in real wall-clock time (empirically measured ~1.1s of real git-subprocess
      // overhead locally). 4000ms comfortably dwarfs that skew (with margin for a slower/loaded host) so the
      // two windows reliably overlap regardless of which starts first.
      await sleep(4000);
      active--;
      return { passed: true };
    };
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: fakeGate });

    const [mergeResult, gateResult] = await Promise.all([
      sessions.confirmWorkerMerge(mgrId, mergeWorkerId),
      sessions.runWorkerGate(gateWorkerId),
    ]);
    check("(A) both the merge gate and the worker gate actually ran", calls === 2);
    check("(A) default cap 1 NEVER let a merge gate and a worker gate run concurrently", maxActive === 1);
    check("(A) the merge still succeeded", mergeResult.merged === true);
    check("(A) the worker gate settled inline and passed", gateResult.settled === true && gateResult.ok === true && gateResult.value.passed === true);
  }

  // ── (B) raising the cap to 2 lets a merge gate and a worker gate run TRULY concurrently ────────────
  {
    const sfx = `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-b-${sfx}`);
    const { db, mgrId, mergeWorkerId, gateWorkerId } = await seedWorkers(sfx, reposDir);
    db.setPlatformConfig({ maxConcurrentGates: 2 });

    let active = 0, maxActive = 0, calls = 0;
    const fakeGate = async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      await sleep(4000); // same wide overlap window rationale as (A) above
      active--;
      return { passed: true };
    };
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: fakeGate });

    const [mergeResult, gateResult] = await Promise.all([
      sessions.confirmWorkerMerge(mgrId, mergeWorkerId),
      sessions.runWorkerGate(gateWorkerId),
    ]);
    check("(B) both ran", calls === 2);
    check("(B) cap 2 let the merge gate and the worker gate run truly concurrently", maxActive === 2);
    check("(B) the merge still succeeded", mergeResult.merged === true);
    check("(B) the worker gate still passed", gateResult.ok === true && gateResult.value.passed === true);
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
    const { db, gateWorkerId } = await seedWorkers(sfx, reposDir);
    const fastGate = async () => ({ passed: true });
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: fastGate });

    const r = await sessions.runWorkerGate(gateWorkerId);
    check("(D) a fast gate settles inline (no opId/pending wrapper)", r.settled === true && r.ok === true);
    check("(D) reports ran:true, passed:true", r.value.ran === true && r.value.passed === true);
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
    await sleep(400); // let the underlying op actually settle
    check("(E) the terminal settle callback eventually fired", enqueued.length === 1 && enqueued[0][0] === short.op.opId);
  }

  // ── (F) unconfigured gateCommand: clear result, no throw, never touches the semaphore ─────────────
  {
    const sfx = `f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-f-${sfx}`);
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
    const { db, gateWorkerId } = await seedWorkers(sfx, reposDir);
    let callNum = 0;
    const crashThenRecover = async () => {
      callNum++;
      if (callNum === 1) throw new Error("boom");
      return { passed: true };
    };
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: crashThenRecover });

    // A rejecting run() is caught INSIDE PendingOpRegistry.attach (its `.then(_, onError)` never rethrows
    // — see pending-ops.ts) and surfaces as a normal {settled:true, ok:false, error} result, not a thrown
    // exception — runWorkerGate itself never throws for a rejecting gate.
    const r1 = await sessions.runWorkerGate(gateWorkerId);
    check("(G) a rejecting gate run surfaces as ok:false (not swallowed, not a throw)", r1.settled === true && r1.ok === false);
    const r2 = await sessions.runWorkerGate(gateWorkerId);
    check("(G) a SUBSEQUENT gate run still acquires the semaphore slot (no permanent leak)", r2.settled === true && r2.ok === true && r2.value.passed === true);
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
  }

  // ── (H) role gate: a non-worker session cannot call runWorkerGate ──────────────────────────────────
  {
    const sfx = `h-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-wg-repos-h-${sfx}`);
    const { db, mgrId } = await seedWorkers(sfx, reposDir);
    const { stub } = ptyStub();
    const sessions = new SessionService(db, stub, new OrchestrationControl(), { runGate: async () => ({ passed: true }) });
    let threw = false;
    try { await sessions.runWorkerGate(mgrId); } catch { threw = true; }
    check("(H) a manager session is REFUSED run_gate (worker-only surface)", threw === true);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — run_gate is admitted through the SAME GateSemaphore merge/deploy gates share (structural bound, not just LOOM_TEST_CONCURRENCY=1 convention), composes with PendingOpRegistry's sync/async degrade, and fails closed/role-gated correctly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
