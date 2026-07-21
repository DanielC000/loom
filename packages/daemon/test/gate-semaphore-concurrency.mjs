import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Host-load guard test (card 301d8c01): proves the daemon-global GateSemaphore actually BOUNDS
// concurrent daemon-executed heavy gate runs (confirmWorkerMerge), not just that the code compiles.
//
// THE HOLE IT GUARDS: before this, N concurrent worker_merge_confirm calls could each spawn a heavy
// build/test command (runGateSequential) with zero coordination — only manager discipline (sequencing
// merges by hand) kept a self-hosting host from being starved by its own daemon. The incident that
// reopened this card was a single worker's OWN gate run starving a live sibling service; this guard
// targets the OTHER half of the card's framing — concurrent DAEMON-run gates.
//
// Proves, with an INJECTED `runGate` seam (no real spawn — a fake gate that sleeps a bit so two
// concurrent confirms have a wide window to actually overlap if nothing is bounding them):
//   (A) default cap (1, no platform override) SERIALIZES two concurrent confirmWorkerMerge calls on
//       the same daemon — the fake gate NEVER observes more than 1 concurrent invocation.
//   (B) raising the cap to 2 (via db.setPlatformConfig) lets both run TRULY concurrently — the fake
//       gate DOES observe 2 concurrent invocations (proving the guard isn't just an accidental full
//       serialization; it holds the config'd cap, not a hardcoded 1).
//   (C) a queued call still completes (no deadlock) and composes with the existing merge pipeline.
// Also a pure unit check of GateSemaphore.runExclusive in isolation, independent of the wiring above.
//
// Run: 1) build daemon (pnpm build), 2) node test/gate-semaphore-concurrency.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gs-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GateSemaphore } = await import("../dist/orchestration/gate-semaphore.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT_ID = "-c user.email=gs@loom -c user.name=gs";
const now = new Date().toISOString();

const dbs = [];
const worktrees = [];

// ── Pure unit check: GateSemaphore.runExclusive in isolation ──────────────────────────────────────
{
  const sem = new GateSemaphore();
  let active = 0, maxActive = 0;
  const task = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(80);
    active--;
    return "ok";
  };
  const results = await Promise.all([
    sem.runExclusive(1, task),
    sem.runExclusive(1, task),
    sem.runExclusive(1, task),
  ]);
  check("(unit, cap 1) three tasks all resolve", results.every((r) => r === "ok"));
  check("(unit, cap 1) never more than 1 concurrent", maxActive === 1);

  active = 0; maxActive = 0;
  const results2 = await Promise.all([
    sem.runExclusive(2, task),
    sem.runExclusive(2, task),
  ]);
  check("(unit, cap 2) both resolve", results2.every((r) => r === "ok"));
  check("(unit, cap 2) reaches 2 concurrent (cap isn't a silent hardcoded 1)", maxActive === 2);

  // a thrown fn still releases its slot (no permanent deadlock on an error)
  active = 0;
  await sem.runExclusive(1, async () => { throw new Error("boom"); }).catch(() => {});
  const after = await sem.runExclusive(1, async () => "released");
  check("(unit) a slot is released even when fn rejects", after === "released");
}

// ── Pure unit check: priority-aware queue ordering (card 24642c3d — a low-priority worker run_gate
//    self-check must not head-of-line-block a higher-priority merge/deploy gate queued behind it) ────
{
  const sem = new GateSemaphore();
  const order = [];
  let active = 0, maxActive = 0;
  const task = (label, ms) => async () => {
    order.push(label); active++; maxActive = Math.max(maxActive, active);
    await sleep(ms);
    active--;
    return label;
  };

  // cap 1: "holder" grabs the only slot immediately. While it holds, queue TWO low-priority waiters,
  // THEN a high-priority one (arrives LAST). A plain FIFO queue would run low1, low2, high in arrival
  // order — the priority queue must run high BEFORE the already-queued low2 (low1 is unaffected: it
  // queued before the holder even released, so nothing could have jumped ahead of it — the guarantee is
  // ONLY that high jumps LOW waiters queued ahead of it, not that it jumps EVERYTHING).
  const holder = sem.runExclusive(1, task("holder", 150));
  await sleep(20); // ensure "holder" has genuinely acquired the slot before anything else queues
  const low1 = sem.runExclusive(1, task("low1", 20), "low");
  await sleep(10);
  const low2 = sem.runExclusive(1, task("low2", 20), "low");
  await sleep(10);
  const high = sem.runExclusive(1, task("high", 20), "high");

  await Promise.all([holder, low1, low2, high]);
  check("(priority) all four ran", order.length === 4);
  check("(priority) cap 1 held throughout — priority reorders the QUEUE, never lets more than 1 run at once", maxActive === 1);
  check("(priority) the holder (already running before anything queued) ran first", order[0] === "holder");
  check("(priority) the HIGH-priority waiter (queued LAST) is serviced BEFORE the already-queued low2 — no head-of-line blocking",
    order.indexOf("high") < order.indexOf("low2"));
  check("(priority) low1 (queued before low2) still keeps its place ahead of low2 — same-tier FIFO preserved",
    order.indexOf("low1") < order.indexOf("low2"));

  // Same-priority-only queue stays strict FIFO (regression check, no "high" tier involved at all).
  const semFifo = new GateSemaphore();
  const fifoOrder = [];
  const fifoTask = (label) => async () => { fifoOrder.push(label); await sleep(20); return label; };
  const fh = semFifo.runExclusive(1, fifoTask("h"), "low");
  await sleep(10);
  const f1 = semFifo.runExclusive(1, fifoTask("f1"), "low");
  const f2 = semFifo.runExclusive(1, fifoTask("f2"), "low");
  const f3 = semFifo.runExclusive(1, fifoTask("f3"), "low");
  await Promise.all([fh, f1, f2, f3]);
  check("(priority) same-tier queue stays strict FIFO", JSON.stringify(fifoOrder) === JSON.stringify(["h", "f1", "f2", "f3"]));

  // Omitting priority entirely defaults to "high" — an untouched call site behaves exactly as before
  // this card (every caller was implicitly equal-priority FIFO, i.e. all "high"). Proved by showing the
  // omitted-priority call still jumps an already-queued "low" waiter, not by absence-of-throw alone.
  const semDefault = new GateSemaphore();
  const defaultOrder = [];
  const dTask = (label, ms = 20) => async () => { defaultOrder.push(label); await sleep(ms); return label; };
  const dHolder = semDefault.runExclusive(1, dTask("dholder", 150)); // holds well past both queue-ins below, avoiding a release/push race
  await sleep(10);
  const dLow = semDefault.runExclusive(1, dTask("dlow"), "low");
  await sleep(10);
  const dNoArg = semDefault.runExclusive(1, dTask("dnoarg")); // priority omitted
  await Promise.all([dHolder, dLow, dNoArg]);
  check("(priority) an omitted-priority call defaults to high and jumps an already-queued low waiter",
    defaultOrder.indexOf("dnoarg") < defaultOrder.indexOf("dlow"));
}

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# gs\n");
  execSync(`git init -q && git config user.email gs@loom && git config user.name gs && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

// Seeds ONE manager + TWO workers, each in its OWN project/repo (confirmWorkerMerge derives the repo
// from the WORKER's own projectId, not the manager's — so this is a legitimate shape, not a synthetic
// one) — deliberately NOT two workers sharing one repo: two REAL concurrent squash-merges into the
// SAME shared repoPath race each other on git's own state (a separate, pre-existing concurrency
// property of the merge/union-merge git operations, unrelated to the gate semaphore this test targets)
// and would make this test flaky for a reason that has nothing to do with GateSemaphore. Separate repos
// isolate the git side entirely, so the only shared resource left is the semaphore itself.
async function seedTwoWorkers(sfx, reposDir) {
  const db = new Db();
  dbs.push(db);
  const agentId = `gs-agent-${sfx}`, mgrId = `gs-mgr-${sfx}`;
  const mgrProjId = `gs-proj-mgr-${sfx}`;
  const mgrRepo = path.join(reposDir, "mgr");
  makeRepo(mgrRepo);
  db.insertProject({ id: mgrProjId, name: "GS-MGR", repoPath: mgrRepo, vaultPath: mgrRepo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: mgrProjId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: mgrProjId, agentId, engineSessionId: null, title: null, cwd: mgrRepo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const workers = [];
  for (const label of ["1", "2"]) {
    const projId = `gs-proj-${label}-${sfx}`, taskId = `gs-task-${label}-${sfx}`, workerId = `gs-wkr-${label}-${sfx}`;
    const repo = path.join(reposDir, `worker-${label}`);
    makeRepo(repo);
    db.insertProject({ id: projId, name: `GS-${label}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${agentId}-${label}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: `GS-TASK-${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    const file = `feature-${label}.txt`;
    fs.writeFileSync(path.join(worktreePath, file), `work for ${label}\n`);
    execSync(`git add . && git ${GIT_ID} commit -q -m "${file}"`, { cwd: worktreePath });
    db.insertSession({ id: workerId, projectId: projId, agentId: `${agentId}-${label}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    workers.push(workerId);
  }
  return { db, mgrId, workers };
}

try {
  // ── (A) default cap (1, no platform override) SERIALIZES two concurrent daemon-run gates ───────────
  {
    const sfx = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-gs-repos-a-${sfx}`);
    const { db, mgrId, workers } = await seedTwoWorkers(sfx, reposDir);

    let active = 0, maxActive = 0, calls = 0;
    const fakeGate = async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      await sleep(150); // wide overlap window — real per-worktree git ops here take single-digit ms
      active--;
      return { passed: true };
    };
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    const [r1, r2] = await Promise.all([
      sessions.confirmWorkerMerge(mgrId, workers[0]),
      sessions.confirmWorkerMerge(mgrId, workers[1]),
    ]);
    check("(A) both confirms ran the gate", calls === 2);
    check("(A) default cap 1 NEVER let both gates run concurrently", maxActive === 1);
    check("(A) both merges still succeeded (queued, not rejected)", r1.merged === true && r2.merged === true);
  }

  // ── (B) raising the cap to 2 lets both gates run TRULY concurrently ────────────────────────────────
  {
    const sfx = `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-gs-repos-b-${sfx}`);
    const { db, mgrId, workers } = await seedTwoWorkers(sfx, reposDir);
    db.setPlatformConfig({ maxConcurrentGates: 2 });

    let active = 0, maxActive = 0, calls = 0;
    const fakeGate = async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      await sleep(150);
      active--;
      return { passed: true };
    };
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    const [r1, r2] = await Promise.all([
      sessions.confirmWorkerMerge(mgrId, workers[0]),
      sessions.confirmWorkerMerge(mgrId, workers[1]),
    ]);
    check("(B) both confirms ran the gate", calls === 2);
    check("(B) cap 2 actually let both gates run concurrently (not a silent hardcoded serialize)", maxActive === 2);
    check("(B) both merges succeeded", r1.merged === true && r2.merged === true);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GateSemaphore bounds concurrent daemon-executed heavy gate runs to the configured cap (default 1, serializing; raised, allowing real concurrency up to the cap), with no deadlock and no lost merges."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
