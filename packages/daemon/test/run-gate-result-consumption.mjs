import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// run_gate RESULT-CONSUMPTION FIX (card 50c1e0d0, origin finding c7492bde): the pending note used to read
// "re-call run_gate to fetch the result once ready" — true only WHILE the gate is running. Three faces:
//   1) a re-call AFTER settle started a brand-new run instead of returning the cached result (this file's
//      scenario (A));
//   2) a re-call WHILE the gate is still running silently attached to the stale op with no signal that the
//      worktree had since changed (this file's scenario (B));
//   3) nothing recorded which worktree HEAD a gate actually validated.
// Fix: PendingOpRegistry.attach's opt-in retention (the SAME mechanism confirmWorkerMergeTracked already
// uses — see MERGE_OP_RETAIN_MS) now also covers "gate" ops (GATE_OP_RETAIN_MS), and runWorkerGate stamps
// the worktree's HEAD/dirty state at the moment a run genuinely starts (WorktreeGateStamp), so a re-call
// can report `attachedToInFlight`/`staleAgainstWorktree`, and a settled result carries `validatedHead`.
//
// This file drives the REAL runWorkerGate (an injected `runGate` seam controls TIMING only — never git),
// against a REAL git worktree (via createWorktree), so the worktree-stamp comparisons are exercised for
// real, not faked.
//
// Asserts:
//   (A) a re-call within the settle-grace window returns the SAME settled result (same opId) with NO
//       second gate invocation.
//   (B) a re-call while the gate is still running reports attachedToInFlight:true, and — after the
//       worktree is edited mid-flight — staleAgainstWorktree:true.
// Run: 1) build daemon (pnpm build), 2) node test/run-gate-result-consumption.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rgc-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, timeoutMs, intervalMs = 100) {
  const start = performance.now(); // MONOTONIC — avoids the Date.now() CI timing-flake class
  while (performance.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}
const GIT_ID = "-c user.email=rgc@loom -c user.name=rgc";
const now = new Date().toISOString();
const ptyStub = () => ({ stop() {}, isAlive() { return false; }, enqueueStdin() {} });

const worktrees = [];
const dbs = [];
try {
  // ── (A) settle-grace re-call returns the SAME settled result, with NO second gate run ────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-rgc-repo-a-${Date.now()}`);
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# rgc\n");
    execSync(`git init -q && git config user.email rgc@loom && git config user.name rgc && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

    const db = new Db();
    dbs.push(db);
    const P = "rgc-a", workerId = "rgc-a-wkr";
    const { worktreePath, branch } = await createWorktree(repo, P, "t-a");
    worktrees.push([repo, worktreePath]);
    db.insertProject({ id: P, name: "RGC-A", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: null, worktreePath, branch });

    let gateCalls = 0;
    const fastGate = async () => { gateCalls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: fastGate });

    const r1 = await sessions.runWorkerGate(workerId);
    check("(A) first call settles inline and passes", r1.settled === true && r1.ok === true && r1.value.passed === true);
    check("(A) exactly one gate invocation so far", gateCalls === 1);
    const opId1 = r1.value.opId;

    // Re-call immediately — comfortably inside GATE_OP_RETAIN_MS (5s).
    const r2 = await sessions.runWorkerGate(workerId);
    check("(B setup skip) re-call settles", r2.settled === true && r2.ok === true);
    check("(A) the re-call returns the SAME cached opId (served from the retention window)", r2.value.opId === opId1);
    check("(A) NO second gate invocation was triggered by the re-call", gateCalls === 1);
    check("(A) the settled result carries a validatedHead", typeof r1.value.validatedHead === "string" && r1.value.validatedHead.length > 0);
  }

  // ── (B) mid-flight re-call: attachedToInFlight + staleAgainstWorktree after an edit ────────────────────
  {
    const repo = path.join(os.tmpdir(), `loom-rgc-repo-b-${Date.now()}`);
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# rgc\n");
    execSync(`git init -q && git config user.email rgc@loom && git config user.name rgc && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

    const db = new Db();
    dbs.push(db);
    const P = "rgc-b", workerId = "rgc-b-wkr";
    const { worktreePath, branch } = await createWorktree(repo, P, "t-b");
    worktrees.push([repo, worktreePath]);
    db.insertProject({ id: P, name: "RGC-B", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: null, worktreePath, branch });

    // Comfortably longer than SYNC_ATTACH_BUDGET_MS (12s) so BOTH calls degrade to pending, with real
    // margin left before the underlying op actually settles.
    const slowGate = async () => { await sleep(16_000); return { passed: true }; };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: slowGate });

    const p1 = sessions.runWorkerGate(workerId); // don't await — runs in the background
    await sleep(500); // let run() start and record its worktree stamp

    // Simulate "the worker edited the test after starting the gate" — an uncommitted edit to an EXISTING
    // tracked file (the origin finding's exact scenario), no commit.
    fs.appendFileSync(path.join(worktreePath, "README.md"), "edited mid-gate\n");

    const r2 = await sessions.runWorkerGate(workerId); // attaches to the SAME in-flight op
    check("(B) the re-call degrades to pending (gate still running)", r2.settled === false);
    check("(B) attachedToInFlight is true (this call did NOT start the op)", r2.attachedToInFlight === true);
    check("(B) staleAgainstWorktree is true (worktree edited since the run started)", r2.staleAgainstWorktree === true);

    const r1 = await p1;
    check("(B) the ORIGINATING call also degraded to pending (gate genuinely slow)", r1.settled === false);
    check("(B) the originating call reports attachedToInFlight:false (it minted the op itself)", r1.attachedToInFlight === false);
    // Code Review hardening (card 50c1e0d0): staleAgainstWorktree is independent of attachedToInFlight —
    // the ORIGINATING call's own pending check is computed AFTER its own sync-wait elapses, by which point
    // the mid-flight edit above has already happened, so it must ALSO report staleAgainstWorktree:true,
    // not just the re-call that attached to it.
    check("(B) the ORIGINATING call ALSO reports staleAgainstWorktree:true (edited during its own sync-wait)", r1.staleAgainstWorktree === true);
    check("(B) both calls report the SAME opId", r1.op.opId === r2.op.opId);

    // Let the real op actually settle so nothing dangles past this block.
    await waitUntil(() => sessions.pendingOps.peek(`gate:${workerId}`)?.state !== "running", 20_000);
  }
} finally {
  for (const [repo, wt] of worktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — run_gate's settle-grace retention window returns a cached result with no second run, and a mid-flight re-call correctly reports attachedToInFlight + staleAgainstWorktree after a worktree edit."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
