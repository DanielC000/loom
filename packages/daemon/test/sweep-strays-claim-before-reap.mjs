import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b33a8101 (round 6 of a5d9c458, discovered from card beeae646 — see docs/decisions/a5d9c458-*.md
// ROUND 6) — the SAME claim-after-kill race class as beeae646, on the remaining paths that are NOT
// gcWorktreeDir: stopWorker/killAllWorkers's stray sweep (sweepWorktreeStrays), confirmWorkerMerge's
// pre-gate sweep, and runWorkerGate's post-timeout sweep all called reapWorktreeProcesses with NO
// claimedWorktreePaths check anywhere — unlike gcWorktreeDir's round-5 pre-reap check
// (gcworktreedir-claim-before-reap.mjs), a worktree path actively claimed by a reclaiming respawn gave
// zero protection on any of these three call sites.
//
// Fix: a synchronous pre-check at each call site (skip the reap entirely, log, when the path is already
// claimed) PLUS an `abortIfClaimed` callback wired into `reapProcessesRootedInWorktree` itself
// (pty/host.ts), checked once immediately after enumeration resolves — this also closes the window where
// a claim lands DURING the sweep's own up-to-~20.5s enumeration, not just one present before it fires.
//
// (A) sweepWorktreeStrays (stopWorker path): claimed before stop -> reap never invoked, [stop-worker] log fires.
// (B) NEGATIVE CONTROL: no claim -> reap invoked normally (proves (A) isn't vacuous).
// (C) confirmWorkerMerge's pre-gate sweep: claimed before confirm -> the pre-gate reap is never invoked
//     ([merge-confirm] log fires), yet the merge itself still lands (merged:true) — a claimed worktree is
//     a non-alarming GC outcome, never a merge failure (mirrors gcWorktreeDir's own round-4/5 treatment).
// (D) NEGATIVE CONTROL: no claim -> the pre-gate reap for this worktree IS invoked (mirrors
//     worktree-process-reap.mjs's own (C) scenario, which this file does not re-test beyond that).
// (E) runWorkerGate's post-timeout sweep: claimed before a timed-out gate -> reap never invoked,
//     [run-gate] log fires.
// (F) NEGATIVE CONTROL: no claim, same timeout -> reap IS invoked.
// (G) reapProcessesRootedInWorktree direct unit test — THE MECHANISM: abortIfClaimed is checked once
//     right after enumeration resolves. A claim that lands DURING enumeration (injected via the
//     `enumerate` seam itself, simulating a reclaiming spawn's claim landing mid-enumeration) still
//     aborts the kill loop entirely: killedPids:[], aborted:true, kill() never invoked at all.
// (H) NEGATIVE CONTROL / OPTIONALITY: the identical enumerate/kill seams, no `abortIfClaimed` passed at
//     all — every existing caller that omits it must behave BYTE-IDENTICALLY to pre-fix code: the kill
//     loop runs normally, the matching process is killed.
// (I) NEGATIVE CONTROL: `abortIfClaimed` passed but returns false — same as (H); proves the check only
//     aborts on an actual TRUE read, not merely on being passed a callback at all.
//
// Round 2 (Code Review 044d26f1 on commit ea3f9544): every scenario above injects `reapWorktreeProcesses`,
// which REPLACES the default builder closure that was the ONLY place `abortIfClaimed` got forwarded —
// stripping the forwarding from all three copy-pasted closures left every one of these scenarios green.
// Fixed with ONE shared helper, `reapWorktreeUnlessClaimed`, that ALWAYS forwards `abortIfClaimed` to
// whichever impl is active, the injected seam included — routed through at every site, including
// `gcWorktreeDir`'s own (closing round 5's stated residual too). New wiring-pin tests make the seam ITSELF
// assert it received a real callback:
// (J) wiring pin — the stop-sweep seam receives abortIfClaimed (false unclaimed, true once claimed).
// (K) wiring pin — confirmWorkerMerge's pre-gate seam, same shape.
// (L) wiring pin — runWorkerGate's post-timeout seam, same shape.
// (M) wiring pin — gcWorktreeDir's own seam, same shape (closes round 5's residual at this site too).
// (N) a THROWING abortIfClaimed is treated as CLAIMED (fail-safe), logged distinctly from both the
//     generic abort message and an enumeration failure.
//
// RED-ON-MAIN proof: scripts/negative-control.mjs against main (43a65f27) — see this card's worker_report.
// MUTATION PROOF (repeating the CR's own mutation, round 2): dropping `abortIfClaimed` from
// `reapWorktreeUnlessClaimed`'s forwarded opts turns (J)-(M) red while (A)-(I) stay green (confirming the
// wiring-pin tests — not the mechanism tests — are what catch this class of regression); restoring is
// byte-identical. See this card's worker_report for the recorded run.
// Run: 1) build daemon (pnpm build), 2) node test/sweep-strays-claim-before-reap.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-sscr-home-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, resolveWorktreePath, normForCompare } = await import("../dist/git/worktrees.js");
const { reapProcessesRootedInWorktree } = await import("../dist/pty/host.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=sscr@loom -c user.name=sscr";
const now = new Date().toISOString();
const ptyStub = () => ({ stop() {}, isAlive() { return true; }, enqueueStdin() { return { delivered: true }; }, getPid: () => undefined });

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# sscr\n");
  execSync(`git init -q && git config user.email sscr@loom && git config user.name sscr`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

function captureWarnings() {
  const lines = [];
  const orig = console.warn;
  console.warn = (msg) => { lines.push(String(msg)); };
  return { lines, restore: () => { console.warn = orig; } };
}

const dbs = [];
const worktrees = [];

try {
  // ============================================================================================
  // (A)/(B) sweepWorktreeStrays, via stopWorker
  // ============================================================================================
  {
    const sfx = `ab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const db = new Db(); dbs.push(db);
    const projId = `sscr-ab-proj-${sfx}`, agentId = `sscr-ab-agent-${sfx}`, mgrId = `sscr-ab-mgr-${sfx}`;
    const reposDir = path.join(os.tmpdir(), `loom-sscr-ab-repos-${sfx}`);
    registerForCleanup(reposDir);
    const repo = path.join(reposDir, "repo");
    makeRepo(repo);
    db.insertProject({ id: projId, name: "SSCR-AB", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    // (A) claimed before stop
    {
      const taskId = `sscr-a-task-${sfx}`;
      const workerId = `sscr-a-wkr-${sfx}`;
      const worktreePath = resolveWorktreePath(projId, taskId);
      db.insertTask({ id: taskId, projectId: projId, title: "SSCR-A", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch: `loom/${taskId}` });

      const reapCalls = [];
      const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), {
        reapWorktreeProcesses: async (p) => { reapCalls.push(p); return { killedPids: [] }; },
      });
      sessions.claimedWorktreePaths.add(normForCompare(worktreePath));

      const warn = captureWarnings();
      const stopResult = await sessions.stopWorker(mgrId, workerId, "hard");
      warn.restore();

      check("(A) stopWorker itself still reports success", stopResult.stopped === true);
      check("(A) reap was NEVER invoked for a worktree a reclaiming spawn already claimed", !reapCalls.includes(worktreePath));
      check("(A) the [stop-worker] skip was logged", warn.lines.some((l) => l.includes("[stop-worker]") && l.includes(worktreePath) && l.includes("not swept")));
      check("(A) the claim is still present afterward — sweepWorktreeStrays never reads or clears it", sessions.claimedWorktreePaths.has(normForCompare(worktreePath)));
      db.setProcessState(workerId, "exited");
    }

    // (B) NEGATIVE CONTROL: no claim
    {
      const taskId = `sscr-b-task-${sfx}`;
      const workerId = `sscr-b-wkr-${sfx}`;
      const worktreePath = resolveWorktreePath(projId, taskId);
      db.insertTask({ id: taskId, projectId: projId, title: "SSCR-B", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch: `loom/${taskId}` });

      const reapCalls = [];
      const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), {
        reapWorktreeProcesses: async (p) => { reapCalls.push(p); return { killedPids: [] }; },
      });

      const stopResult = await sessions.stopWorker(mgrId, workerId, "hard");
      check("(B) stopWorker itself still reports success", stopResult.stopped === true);
      check("(B) NEGATIVE CONTROL: with no claim, reap IS invoked normally — this fix never suppresses an ordinary stray sweep", reapCalls.includes(worktreePath));
      db.setProcessState(workerId, "exited");
    }
  }

  // ============================================================================================
  // (C)/(D) confirmWorkerMerge's pre-gate sweep
  // ============================================================================================
  {
    const sfx = `cd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    async function setupConfirmScenario(label) {
      const db = new Db(); dbs.push(db);
      const projId = `sscr-${label}-proj-${sfx}`, agentId = `sscr-${label}-agent-${sfx}`, mgrId = `sscr-${label}-mgr-${sfx}`, workerId = `sscr-${label}-wkr-${sfx}`, taskId = `sscr-${label}-task-${sfx}`;
      const reposDir = path.join(os.tmpdir(), `loom-sscr-${label}-repos-${sfx}`);
      registerForCleanup(reposDir);
      const repo = path.join(reposDir, "repo");
      makeRepo(repo);
      db.insertProject({ id: projId, name: `SSCR-${label.toUpperCase()}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: 'node -e "process.exit(0)"' } }, createdAt: now, archivedAt: null });
      db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
      db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      db.insertTask({ id: taskId, projectId: projId, title: `SSCR-${label.toUpperCase()}-TASK`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
      worktrees.push(worktreePath);
      fs.writeFileSync(path.join(worktreePath, "change.txt"), "worker change\n");
      commitAll(worktreePath, "change.txt", GIT_ID);
      db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
      return { db, mgrId, workerId, worktreePath };
    }

    // (C) claimed before confirm
    {
      const { db, mgrId, workerId, worktreePath } = await setupConfirmScenario("c");
      const reapCalls = [];
      const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), {
        reapWorktreeProcesses: async (p) => { reapCalls.push(p); return { killedPids: [] }; },
      });
      sessions.claimedWorktreePaths.add(normForCompare(worktreePath));

      const warn = captureWarnings();
      const result = await sessions.confirmWorkerMerge(mgrId, workerId);
      warn.restore();

      check("(C) confirmWorkerMerge STILL lands the merge despite the pre-gate reap being skipped — a claimed worktree is non-alarming, never a merge failure", result.merged === true);
      check("(C) the pre-gate reap was NEVER invoked for the claimed worktree", !reapCalls.includes(worktreePath));
      check("(C) the [merge-confirm] pre-gate skip was logged", warn.lines.some((l) => l.includes("[merge-confirm]") && l.includes(worktreePath) && l.includes("not swept pre-gate")));
    }

    // (D) NEGATIVE CONTROL: no claim
    {
      const { db, mgrId, workerId, worktreePath } = await setupConfirmScenario("d");
      const reapCalls = [];
      const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), {
        reapWorktreeProcesses: async (p) => { reapCalls.push(p); return { killedPids: [] }; },
      });

      const result = await sessions.confirmWorkerMerge(mgrId, workerId);
      check("(D) confirmWorkerMerge lands the merge", result.merged === true);
      check("(D) NEGATIVE CONTROL: with no claim, the pre-gate reap IS invoked normally", reapCalls.includes(worktreePath));
    }
  }

  // ============================================================================================
  // (E)/(F) runWorkerGate's post-timeout sweep — synthetic worktree path (no real git needed: the
  // breaker's HEAD read fails-safe to null, same shape gate-timeout-circuit-breaker.mjs's own (A) uses).
  // ============================================================================================
  {
    const sfx = `ef-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timeoutGate = async () => ({ passed: false, failedTimedOut: true, failedSignal: "SIGKILL" });

    async function setupGateScenario(label) {
      const db = new Db(); dbs.push(db);
      const projId = `sscr-${label}-proj-${sfx}`, agentId = `sscr-${label}-agent-${sfx}`, mgrId = `sscr-${label}-mgr-${sfx}`, workerId = `sscr-${label}-wkr-${sfx}`;
      const reposDir = path.join(os.tmpdir(), `loom-sscr-${label}-repos-${sfx}`);
      registerForCleanup(reposDir);
      const repo = path.join(reposDir, "repo");
      db.insertProject({ id: projId, name: `SSCR-${label.toUpperCase()}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
      db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
      db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      const worktreePath = path.join(reposDir, "gate-worker-wt"); // no real git needed, mirrors gate-timeout-circuit-breaker.mjs's own (A)
      db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath, branch: `loom/${label}-${sfx}` });
      return { db, workerId, worktreePath };
    }

    // (E) claimed before a timed-out gate
    {
      const { db, workerId, worktreePath } = await setupGateScenario("e");
      const reapCalls = [];
      const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), {
        runGate: timeoutGate,
        reapWorktreeProcesses: async (p) => { reapCalls.push(p); return { killedPids: [] }; },
      });
      sessions.claimedWorktreePaths.add(normForCompare(worktreePath));

      const warn = captureWarnings();
      const r = await sessions.runWorkerGate(workerId);
      warn.restore();

      check("(E setup) the gate genuinely timed out", r.ok === true && r.value?.gateDetail?.timedOut === true);
      check("(E) the post-timeout reap was NEVER invoked for the claimed worktree", !reapCalls.includes(worktreePath));
      check("(E) the [run-gate] post-timeout skip was logged", warn.lines.some((l) => l.includes("[run-gate]") && l.includes(worktreePath) && l.includes("not swept post-timeout")));
    }

    // (F) NEGATIVE CONTROL: no claim, same timeout
    {
      const { db, workerId, worktreePath } = await setupGateScenario("f");
      const reapCalls = [];
      const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), {
        runGate: timeoutGate,
        reapWorktreeProcesses: async (p) => { reapCalls.push(p); return { killedPids: [] }; },
      });

      const r = await sessions.runWorkerGate(workerId);
      check("(F setup) the gate genuinely timed out", r.ok === true && r.value?.gateDetail?.timedOut === true);
      check("(F) NEGATIVE CONTROL: with no claim, the post-timeout reap IS invoked normally", reapCalls.includes(worktreePath));
    }
  }

  // ============================================================================================
  // (G)/(H)/(I) reapProcessesRootedInWorktree direct unit test — the mechanism itself
  // ============================================================================================
  {
    const WT = "/home/x/.loom/worktrees/proj1/b33a8101claim";
    const PROC = { pid: 424242, exePath: `${WT}/node_modules/.bin/vite`, cwd: null, commandLine: null };

    // (G) claim lands DURING enumeration — simulated by seeding the claim flag inside the injected
    // `enumerate` seam itself, right before it resolves, mirroring where a reclaiming spawn's claim would
    // actually land relative to the real enumeration await.
    {
      let claimed = false;
      const killed = [];
      const result = await reapProcessesRootedInWorktree(WT, {
        enumerate: async () => { claimed = true; return [PROC]; },
        kill: (pid) => killed.push(pid),
        abortIfClaimed: () => claimed,
      });
      check("(G) the kill loop is skipped entirely once a claim landed during enumeration", killed.length === 0);
      check("(G) killedPids is empty", result.killedPids.length === 0);
      check("(G) THE FIX: the result is distinguishable via aborted:true (this assertion FAILS against pre-fix code, where the field never existed)", result.aborted === true);
    }

    // (H) NEGATIVE CONTROL / OPTIONALITY: no abortIfClaimed passed at all — byte-identical to pre-fix
    // behavior for every existing caller that omits it.
    {
      const killed = [];
      const result = await reapProcessesRootedInWorktree(WT, {
        enumerate: async () => [PROC],
        kill: (pid) => killed.push(pid),
      });
      check("(H) NEGATIVE CONTROL: with no abortIfClaimed at all, the kill loop runs normally", killed.includes(PROC.pid));
      check("(H) killedPids includes the matched pid", result.killedPids.includes(PROC.pid));
      check("(H) aborted is NOT set when abortIfClaimed was never passed", result.aborted !== true);
    }

    // (I) NEGATIVE CONTROL: abortIfClaimed passed but returns false — proves the check discriminates on
    // the VALUE, not merely on being passed a callback.
    {
      const killed = [];
      const result = await reapProcessesRootedInWorktree(WT, {
        enumerate: async () => [PROC],
        kill: (pid) => killed.push(pid),
        abortIfClaimed: () => false,
      });
      check("(I) NEGATIVE CONTROL: abortIfClaimed() returning false still runs the kill loop normally", killed.includes(PROC.pid));
      check("(I) killedPids includes the matched pid", result.killedPids.includes(PROC.pid));
      check("(I) aborted is NOT set when abortIfClaimed read false", result.aborted !== true);
    }

    // (N) abortIfClaimed THROWS — fail-safe: treated as CLAIMED (never kill when the claim check itself
    // is broken), logged distinctly from both the generic abort message and an enumeration failure.
    {
      const killed = [];
      const warnLines = [];
      const origWarn = console.warn;
      console.warn = (msg) => { warnLines.push(String(msg)); };
      let result;
      try {
        result = await reapProcessesRootedInWorktree(WT, {
          enumerate: async () => [PROC],
          kill: (pid) => killed.push(pid),
          abortIfClaimed: () => { throw new Error("simulated broken claim check"); },
        });
      } finally {
        console.warn = origWarn;
      }
      check("(N) a THROWING abortIfClaimed is treated as CLAIMED — the kill loop is skipped", killed.length === 0);
      check("(N) killedPids is empty", result.killedPids.length === 0);
      check("(N) aborted:true even though the callback itself threw", result.aborted === true);
      check("(N) the throw is logged DISTINCTLY (names the callback's own error message)",
        warnLines.some((l) => l.includes("abortIfClaimed THREW") && l.includes("simulated broken claim check")));
      check("(N) this is NEVER classified as an enumeration failure", result.enumerationFailed !== true);
    }
  }

  // ============================================================================================
  // (J)-(M) WIRING-PIN tests (Code Review 044d26f1, round 2): make the injected reapWorktreeProcesses
  // seam itself assert it RECEIVED a real abortIfClaimed callback — one that reads false while the path
  // is unclaimed and true once claimed — at every site now routed through reapWorktreeUnlessClaimed.
  // ============================================================================================

  // (J) wiring pin — sweepWorktreeStrays (the stop-sweep path)
  {
    const sfx = `j-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const db = new Db(); dbs.push(db);
    const projId = `sscr-j-proj-${sfx}`, agentId = `sscr-j-agent-${sfx}`, mgrId = `sscr-j-mgr-${sfx}`, workerId = `sscr-j-wkr-${sfx}`, taskId = `sscr-j-task-${sfx}`;
    const reposDir = path.join(os.tmpdir(), `loom-sscr-j-repos-${sfx}`);
    registerForCleanup(reposDir);
    const repo = path.join(reposDir, "repo");
    makeRepo(repo);
    db.insertProject({ id: projId, name: "SSCR-J", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const worktreePath = resolveWorktreePath(projId, taskId);
    db.insertTask({ id: taskId, projectId: projId, title: "SSCR-J", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch: `loom/${taskId}` });

    let capturedAbortIfClaimed;
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), {
      reapWorktreeProcesses: async (p, opts) => { capturedAbortIfClaimed = opts?.abortIfClaimed; return { killedPids: [] }; },
    });

    await sessions.stopWorker(mgrId, workerId, "hard");
    check("(J) the stop-sweep seam RECEIVED a real abortIfClaimed callback", typeof capturedAbortIfClaimed === "function");
    check("(J) it reads false while the path is unclaimed", typeof capturedAbortIfClaimed === "function" && capturedAbortIfClaimed() === false);
    sessions.claimedWorktreePaths.add(normForCompare(worktreePath));
    check("(J) the SAME callback instance now reads true once the path is claimed", typeof capturedAbortIfClaimed === "function" && capturedAbortIfClaimed() === true);
    db.setProcessState(workerId, "exited");
  }

  // (K) wiring pin — confirmWorkerMerge's pre-gate sweep
  {
    const sfx = `k-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const db = new Db(); dbs.push(db);
    const projId = `sscr-k-proj-${sfx}`, agentId = `sscr-k-agent-${sfx}`, mgrId = `sscr-k-mgr-${sfx}`, workerId = `sscr-k-wkr-${sfx}`, taskId = `sscr-k-task-${sfx}`;
    const reposDir = path.join(os.tmpdir(), `loom-sscr-k-repos-${sfx}`);
    registerForCleanup(reposDir);
    const repo = path.join(reposDir, "repo");
    makeRepo(repo);
    db.insertProject({ id: projId, name: "SSCR-K", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: 'node -e "process.exit(0)"' } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertTask({ id: taskId, projectId: projId, title: "SSCR-K-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "change.txt"), "worker change\n");
    commitAll(worktreePath, "change.txt", GIT_ID);
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    let capturedAbortIfClaimed;
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), {
      reapWorktreeProcesses: async (p, opts) => { capturedAbortIfClaimed = opts?.abortIfClaimed; return { killedPids: [] }; },
    });

    const result = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(K) confirmWorkerMerge lands the merge", result.merged === true);
    check("(K) the merge pre-gate seam RECEIVED a real abortIfClaimed callback", typeof capturedAbortIfClaimed === "function");
    check("(K) it reads false while the path is unclaimed", typeof capturedAbortIfClaimed === "function" && capturedAbortIfClaimed() === false);
    sessions.claimedWorktreePaths.add(normForCompare(worktreePath));
    check("(K) the SAME callback instance now reads true once the path is claimed", typeof capturedAbortIfClaimed === "function" && capturedAbortIfClaimed() === true);
  }

  // (L) wiring pin — runWorkerGate's post-timeout sweep
  {
    const sfx = `l-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const db = new Db(); dbs.push(db);
    const projId = `sscr-l-proj-${sfx}`, agentId = `sscr-l-agent-${sfx}`, mgrId = `sscr-l-mgr-${sfx}`, workerId = `sscr-l-wkr-${sfx}`;
    const reposDir = path.join(os.tmpdir(), `loom-sscr-l-repos-${sfx}`);
    registerForCleanup(reposDir);
    const repo = path.join(reposDir, "repo");
    db.insertProject({ id: projId, name: "SSCR-L", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const worktreePath = path.join(reposDir, "gate-worker-wt"); // no real git needed, mirrors gate-timeout-circuit-breaker.mjs's own (A)
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath, branch: `loom/l-${sfx}` });

    let capturedAbortIfClaimed;
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), {
      runGate: async () => ({ passed: false, failedTimedOut: true, failedSignal: "SIGKILL" }),
      reapWorktreeProcesses: async (p, opts) => { capturedAbortIfClaimed = opts?.abortIfClaimed; return { killedPids: [] }; },
    });

    const r = await sessions.runWorkerGate(workerId);
    check("(L setup) the gate genuinely timed out", r.ok === true && r.value?.gateDetail?.timedOut === true);
    check("(L) the run_gate timeout seam RECEIVED a real abortIfClaimed callback", typeof capturedAbortIfClaimed === "function");
    check("(L) it reads false while the path is unclaimed", typeof capturedAbortIfClaimed === "function" && capturedAbortIfClaimed() === false);
    sessions.claimedWorktreePaths.add(normForCompare(worktreePath));
    check("(L) the SAME callback instance now reads true once the path is claimed", typeof capturedAbortIfClaimed === "function" && capturedAbortIfClaimed() === true);
  }

  // (M) wiring pin — gcWorktreeDir's own reap call (closes round 5's stated residual at this site too)
  {
    const sfx = `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const db = new Db(); dbs.push(db);
    const repo = path.join(os.tmpdir(), `loom-sscr-m-repo-${sfx}`);
    registerForCleanup(repo);
    makeRepo(repo);
    const worktreePath = resolveWorktreePath(`projSscrM${sfx}`, `sscr-m-task-${sfx}`);
    fs.mkdirSync(worktreePath, { recursive: true });
    registerForCleanup(worktreePath);

    let capturedAbortIfClaimed;
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), {
      reapWorktreeProcesses: async (p, opts) => { capturedAbortIfClaimed = opts?.abortIfClaimed; return { killedPids: [] }; },
    });

    await sessions.gcWorktreeDir(repo, worktreePath, undefined, { forceRemoveWorktree: true });
    check("(M) gcWorktreeDir's own reap seam RECEIVED a real abortIfClaimed callback", typeof capturedAbortIfClaimed === "function");
    check("(M) it reads false while the path is unclaimed", typeof capturedAbortIfClaimed === "function" && capturedAbortIfClaimed() === false);
    sessions.claimedWorktreePaths.add(normForCompare(worktreePath));
    check("(M) the SAME callback instance now reads true once the path is claimed", typeof capturedAbortIfClaimed === "function" && capturedAbortIfClaimed() === true);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the stop-path sweep (sweepWorktreeStrays), confirmWorkerMerge's pre-gate sweep, runWorkerGate's post-timeout sweep, and gcWorktreeDir's own reap all now refuse to reap a worktree a reclaiming spawn already claimed (checked synchronously before firing, logged, and never suppressing an ordinary unclaimed sweep — proven by each scenario's negative control), and reapProcessesRootedInWorktree's new optional abortIfClaimed callback closes the remaining window where a claim lands DURING enumeration itself, with zero behavior change for any caller that omits it or whose claim check reads false, and fail-safe (treated as claimed) if the callback itself throws. Round 2's wiring-pin tests (J)-(M) prove every one of those call sites' injected seam genuinely RECEIVES that callback, through the single shared reapWorktreeUnlessClaimed helper — closing the Code-Review-found gap where the three original copy-pasted closures could silently drop the forwarding with nothing going red."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
