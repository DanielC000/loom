import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// isRetainedResultUsable rejects tree-contaminated results but NOT cancelled ones (card ec994992 — the hole
// in card 45ffb33b's own guard, card 79b0ee52). Complements run-gate-result-consumption.mjs's scenarios
// (A)/(B)/(C) — this file drives the REAL SessionService.runWorkerGate + cancelGateOp end to end (no mocked
// registry), proving the fourth settle shape those scenarios don't cover: a CANCELLED result.
//
// Before the fix: `isRetainedResultUsable: (value) => !(value.ran && value.headCurrent === false)` treated
// a cancelled result (`{ran:false, cancelled:true, ...}`) as usable — `value.ran` is false, so the `&&`
// short-circuits and the predicate returns true — and an immediate re-call after a `gate_cancel` was handed
// the stale cancelled result straight back out of the retention cache instead of running for real. See card
// ec994992's worker_report for the registry-level measurement that established this shape.
//
// After the fix: `isRetainedResultUsable` states what IS usable (ran:true, a real boolean `passed`,
// headCurrent exactly true) — a cancelled result fails all three conjuncts, so it's never re-served.
//
// Asserts:
//   (D) a QUEUED self-check cancel (via cancelGateOp, the manual gate_cancel path), followed immediately by
//       a re-call within GATE_OP_RETAIN_MS, does NOT reuse the cancelled result — it mints a genuinely
//       fresh op (a DIFFERENT opId, attachedToInFlight:false on the fresh call itself, since nothing was
//       actually running for it to attach to).
//   (D2) REGRESSION GUARD for the `typeof value.passed === "boolean"` conjunct specifically (not just
//        `!== undefined`): a settled FAILING verdict (passed:false, headCurrent:true) — not just a passing
//        one — is STILL served from the retention cache with no second gate invocation. Complements
//        run-gate-result-consumption.mjs scenario (A), which only covers the PASS case.
//
// Run: 1) build daemon (pnpm build), 2) node test/run-gate-cancelled-retention.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gcr-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, timeoutMs = 8000, intervalMs = 15) {
  const start = Date.now();
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return predicate(); // one last try, then give up honestly
    await sleep(intervalMs);
  }
}
const GIT_ID = "-c user.email=gcr@loom -c user.name=gcr";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# gcr\n");
  execSync(`git init -q && git config user.email gcr@loom && git config user.name gcr && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const worktrees = [];
const dbs = [];
try {
  // ── (D) a QUEUED cancel, then an immediate re-call, must NOT reuse the cancelled retained result ───────
  {
    const sfx = `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-gcr-d-${sfx}`);
    const db = new Db();
    dbs.push(db);
    db.setPlatformConfig({ maxConcurrentGates: 1 }); // forces the target's self-check to genuinely QUEUE

    // Target project: a manager + worker in the SAME project (cancelGateOp requires this — see its own
    // project-scope check) whose self-check we will queue then cancel.
    const projX = `gcr-d-x-${sfx}`, mgrX = `gcr-d-mgr-${sfx}`, workerX = `gcr-d-w-${sfx}`, taskX = `gcr-d-t-${sfx}`;
    const repoX = path.join(reposDir, "x");
    makeRepo(repoX);
    db.insertProject({ id: projX, name: "GCR-D-X", repoPath: repoX, vaultPath: repoX, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `agent-d-m-${sfx}`, projectId: projX, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrX, projectId: projX, agentId: `agent-d-m-${sfx}`, engineSessionId: null, title: null, cwd: repoX, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertAgent({ id: `agent-d-w-${sfx}`, projectId: projX, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskX, projectId: projX, title: "GCR-D-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const wtX = await createWorktree(repoX, projX, taskX);
    worktrees.push([repoX, wtX.worktreePath]);
    db.insertSession({ id: workerX, projectId: projX, agentId: `agent-d-w-${sfx}`, engineSessionId: null, title: null, cwd: wtX.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrX, taskId: taskX, worktreePath: wtX.worktreePath, branch: wtX.branch });

    // Holder project + worker: saturates the ONE cap-1 slot so the target's own self-check genuinely queues
    // instead of running immediately (mirrors gate-cancel.mjs's B2-2 pattern).
    const projH = `gcr-d-h-${sfx}`, workerH = `gcr-d-hw-${sfx}`, taskH = `gcr-d-ht-${sfx}`;
    const repoH = path.join(reposDir, "h");
    makeRepo(repoH);
    db.insertProject({ id: projH, name: "GCR-D-H", repoPath: repoH, vaultPath: repoH, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `agent-d-h-${sfx}`, projectId: projH, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskH, projectId: projH, title: "GCR-D-HTASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const wtH = await createWorktree(repoH, projH, taskH);
    worktrees.push([repoH, wtH.worktreePath]);
    db.insertSession({ id: workerH, projectId: projH, agentId: `agent-d-h-${sfx}`, engineSessionId: null, title: null, cwd: wtH.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: null, taskId: taskH, worktreePath: wtH.worktreePath, branch: wtH.branch });

    let releaseHolder;
    const holderHold = new Promise((res) => { releaseHolder = res; });
    let freshGateCalls = 0;
    let freshGateEntered;
    const freshGateEnteredSignal = new Promise((resolve) => { freshGateEntered = resolve; });
    // Bounded (16s), not unbounded — mirrors run-gate-result-consumption.mjs scenario (B)'s own reasoning:
    // this only runs long enough to comfortably exceed SYNC_ATTACH_BUDGET_MS (12s), so the RE-CALL below
    // (after the cancel) degrades to a pending handle we can directly inspect for attachedToInFlight/opId,
    // instead of settling inline where those fields wouldn't be present at all.
    const sharedGate = async (_gate, cwd) => {
      if (cwd === wtH.worktreePath) { await holderHold; return { passed: true }; }
      freshGateCalls++;
      freshGateEntered();
      await sleep(16_000);
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate });

    const pHolderRun = sessions.runWorkerGate(workerH);
    await waitUntil(() => sessions.gateQueueForManager(projH).activeCount === 1);

    const pTargetRun = sessions.runWorkerGate(workerX); // queues behind the holder — cap is saturated
    const queuedEntry = await waitUntil(() => sessions.gateQueueForManager(projX).queued.find((e) => e.gateType === "worker"));
    check("(D) setup: the target's self-check is genuinely QUEUED, not running", !!queuedEntry);

    if (queuedEntry) {
      const cancelResult = await sessions.cancelGateOp(mgrX, queuedEntry.opId);
      check("(D) setup: the queued self-check was cancelled", cancelResult.outcome === "cancelled" && cancelResult.phase === "queued");

      const r1 = await pTargetRun;
      check("(D) MEASURED SHAPE: the cancelled settle is ran:false, cancelled:true", r1.settled === true && r1.ok === true && r1.value.ran === false && r1.value.cancelled === true);
      const opId1 = r1.value.opId;

      // Release the holder so the ONE cap-1 slot is free for the re-call below.
      releaseHolder("go");
      await pHolderRun.catch(() => {});

      // Immediately re-call — comfortably inside GATE_OP_RETAIN_MS (5s default) — the exact window a re-call
      // meant to "fetch the result" would land in after a cancel.
      const p2 = sessions.runWorkerGate(workerX);
      const entered = await Promise.race([
        freshGateEnteredSignal.then(() => true),
        sleep(8000).then(() => false),
      ]);
      check("(D) THE FIX: the re-call after a cancel triggers a genuinely FRESH gate invocation (not a cache hit)", entered && freshGateCalls === 1);
      const r2 = await p2;
      check("(D) the fresh call degrades to pending (its own gate is genuinely slow)", r2.settled === false);
      // Guarded (not a bare r2.op.opId dereference): a regression here means r2 settled INLINE with the
      // stale cached value instead of degrading to pending at all, in which case `r2.op` is undefined — an
      // unguarded dereference would crash the whole file instead of reporting a clean FAIL (mirrors
      // gate-cancel.mjs's own "a timed-out waitUntil yields undefined" guard pattern).
      check("(D) attachedToInFlight:false — this call minted the fresh op itself; nothing was running to attach to", r2.settled === false && r2.attachedToInFlight === false);
      check("(D) the fresh op has a DIFFERENT opId than the stale cancelled one", r2.settled === false && r2.op?.opId !== undefined && r2.op.opId !== opId1);

      // Drain the fresh op before moving on, so nothing dangles past this block (mirrors scenario (B)'s own
      // cleanup in run-gate-result-consumption.mjs).
      await waitUntil(() => sessions.pendingOps.peek(`gate:${workerX}`)?.state !== "running", 20_000);
    } else {
      console.log("SKIP  (D) cancel/re-call assertions — setup sanity check above already failed");
      releaseHolder("go");
      await pHolderRun.catch(() => {});
      await pTargetRun.catch(() => {});
    }
  }

  // ── (D2) REGRESSION GUARD: a FAILING verdict (not just a passing one) is still served from the retention
  //     cache — pins `typeof value.passed === "boolean"`, not `value.passed === true` ─────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-gcr-d2-repo-${Date.now()}`);
    makeRepo(repo);

    const db = new Db();
    dbs.push(db);
    const P = "gcr-d2", workerId = "gcr-d2-wkr";
    const { worktreePath, branch } = await createWorktree(repo, P, "t-d2");
    worktrees.push([repo, worktreePath]);
    db.insertProject({ id: P, name: "GCR-D2", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: null, worktreePath, branch });

    let gateCalls = 0;
    const failingGate = async () => { gateCalls++; return { passed: false, failedStep: "test", failedStatus: 1 }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: failingGate });

    const r1 = await sessions.runWorkerGate(workerId);
    check("(D2) setup: first run settles inline and FAILS", r1.settled === true && r1.ok === true && r1.value.passed === false && r1.value.ran === true);
    check("(D2) setup: settled with a current HEAD (unedited worktree)", r1.value.headCurrent === true);
    check("(D2) setup: exactly one gate invocation so far", gateCalls === 1);
    const opId1 = r1.value.opId;

    const r2 = await sessions.runWorkerGate(workerId);
    check("(D2) a FAILING verdict IS served from the retention cache — same opId, no second invocation", r2.settled === true && r2.ok === true && r2.value.opId === opId1 && gateCalls === 1);
  }
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card ec994992: a QUEUED self-check cancel (via gate_cancel), followed by an immediate re-call within the retention window, mints a genuinely FRESH gate run instead of re-serving the stale cancelled result (a different opId, attachedToInFlight:false on the fresh call) — and a FAILING verdict (not just a passing one) is still correctly served from the retention cache, pinning the `typeof value.passed === \"boolean\"` conjunct rather than a `passed === true` narrowing."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
