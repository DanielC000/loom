import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Worker-stop worktree sweep (card 3564fd1e — the reap gap: stopWorker/killAllWorkers used to do nothing
// beyond pty.stop(), which only kills the worker's OWN pty tree. Anything that had already detached/
// re-parented away from it — an escaped dev-server, a survivor from ANY prior gate run — was never swept
// on a plain stop; it lingered until whatever later removed the worktree or ran a gate). HERMETIC: drives
// SessionService.stopWorker/killAllWorkers through the injected `reapWorktreeProcesses` seam — the SAME
// seam confirmWorkerMerge/gcWorktreeDir already use, proven against REAL OS processes in
// worktree-process-reap.mjs; this file proves the NEW call sites wire into that seam correctly, not the
// underlying OS mechanism again (already covered).
// Run: 1) build daemon (pnpm build), 2) node test/worker-stop-reap.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wsr-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

try {
  // ── (A) stopWorker sweeps the worktree, excluding the worker's OWN live pty pid ────────────────────
  {
    const P = {
      projId: `wsr-a-proj-${sfx}`, agentId: `wsr-a-agent-${sfx}`, mgrId: `wsr-a-mgr-${sfx}`, workerId: `wsr-a-wkr-${sfx}`,
      repo: path.join(os.tmpdir(), `loom-wsr-a-repo-${sfx}`), worktreePath: path.join(os.tmpdir(), `loom-wsr-a-wt-${sfx}`), branch: "loom/wsr-a",
    };
    fs.mkdirSync(P.repo, { recursive: true });
    fs.mkdirSync(P.worktreePath, { recursive: true });
    const db = new Db();
    db.insertProject({ id: P.projId, name: "WSR-A", repoPath: P.repo, vaultPath: P.repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    // processState:"exited" (not "live") — stopWorker's only guard is ownership (parentSessionId), so this
    // doesn't affect THIS block's assertions, and keeps this worker invisible to block (B)'s later
    // killAllWorkers() global live-worker scan (both blocks share the same underlying sqlite file — see
    // that block's own comment on why a fresh LOOM_HOME mid-file wouldn't actually isolate them).
    db.insertSession({ id: P.workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId: null, worktreePath: P.worktreePath, branch: P.branch });

    const WORKER_PID = 424242; // the worker's OWN "still-live claude pty" pid, per the stubbed getPid
    const reapCalls = [];
    const sessions = new SessionService(db, {
      stop() {}, isAlive() { return false; }, enqueueStdin() {},
      getPid: (sid) => (sid === P.workerId ? WORKER_PID : undefined),
    }, new OrchestrationControl(), {
      reapWorktreeProcesses: async (worktreePath, opts) => { reapCalls.push({ worktreePath, excludePids: opts?.excludePids ?? [] }); return { killedPids: [] }; },
    });

    sessions.stopWorker(P.mgrId, P.workerId, "hard");
    await sleep(50); // the sweep is fire-and-forget — let its microtask actually run
    check("(A) stopWorker triggered the worktree-path reap for the worker's OWN worktree",
      reapCalls.some((c) => c.worktreePath === P.worktreePath));
    check("(A) the reap excludes the worker's OWN live pty pid",
      !!reapCalls.find((c) => c.worktreePath === P.worktreePath)?.excludePids.includes(WORKER_PID));

    db.close();
    fs.rmSync(P.repo, { recursive: true, force: true });
    fs.rmSync(P.worktreePath, { recursive: true, force: true });
  }

  // ── (B) killAllWorkers sweeps EVERY live worker's worktree, never a non-worker session ──────────────
  {
    const mk = (n) => ({
      projId: `wsr-b-proj${n}-${sfx}`, agentId: `wsr-b-agent${n}-${sfx}`, workerId: `wsr-b-wkr${n}-${sfx}`,
      repo: path.join(os.tmpdir(), `loom-wsr-b-repo${n}-${sfx}`), worktreePath: path.join(os.tmpdir(), `loom-wsr-b-wt${n}-${sfx}`), branch: `loom/wsr-b${n}`,
    });
    const mgrId = `wsr-b-mgr-${sfx}`;
    const W1 = mk(1), W2 = mk(2);
    [W1, W2].forEach((p) => { fs.mkdirSync(p.repo, { recursive: true }); fs.mkdirSync(p.worktreePath, { recursive: true }); });
    // Reuses the SAME db as block (A) — Db() resolves ITS sqlite path from LOOM_HOME once, at first
    // import, so reassigning the env var mid-file would NOT actually open a second file. Block (A)'s
    // worker is deliberately seeded processState:"exited" (not "live") below for exactly this reason:
    // killAllWorkers's global live-worker scan would otherwise see it as a third live worker here.
    const db = new Db();
    db.insertProject({ id: W1.projId, name: "WSR-B1", repoPath: W1.repo, vaultPath: W1.repo, config: {}, createdAt: now, archivedAt: null });
    db.insertProject({ id: W2.projId, name: "WSR-B2", repoPath: W2.repo, vaultPath: W2.repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: W1.agentId, projectId: W1.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertAgent({ id: W2.agentId, projectId: W2.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: W1.projId, agentId: W1.agentId, engineSessionId: null, title: null, cwd: W1.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: W1.workerId, projectId: W1.projId, agentId: W1.agentId, engineSessionId: null, title: null, cwd: W1.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath: W1.worktreePath, branch: W1.branch });
    db.insertSession({ id: W2.workerId, projectId: W2.projId, agentId: W2.agentId, engineSessionId: null, title: null, cwd: W2.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath: W2.worktreePath, branch: W2.branch });
    // A non-worker (manager) session, ALSO live — killAllWorkers only ever touches role:"worker" sessions.
    db.insertSession({ id: `wsr-b-live-mgr-${sfx}`, projectId: W1.projId, agentId: W1.agentId, engineSessionId: null, title: null, cwd: W1.repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const reapCalls = [];
    const sessions = new SessionService(db, {
      stop() {}, isAlive() { return false; }, enqueueStdin() {}, getPid: () => undefined,
    }, new OrchestrationControl(), {
      reapWorktreeProcesses: async (worktreePath) => { reapCalls.push(worktreePath); return { killedPids: [] }; },
    });

    const n = sessions.killAllWorkers();
    await sleep(50);
    check("(B) killAllWorkers reports the correct live-worker count (2, not the live manager too)", n === 2);
    check("(B) BOTH live workers' worktrees were swept", reapCalls.includes(W1.worktreePath) && reapCalls.includes(W2.worktreePath));
    check("(B) exactly two reap calls were made (the live manager was never swept)", reapCalls.length === 2);

    db.close();
    [W1, W2].forEach((p) => { fs.rmSync(p.repo, { recursive: true, force: true }); fs.rmSync(p.worktreePath, { recursive: true, force: true }); });
  }
} finally {
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — stopWorker and killAllWorkers now sweep the stopped worker's worktree for stray processes (excluding the worker's own live pty pid), closing the reap gap a plain stop used to leave open."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
