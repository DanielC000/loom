import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cf17ebf3 — daemon-executed, worktree/PID-scoped process reap invocable by a manager (worker_reap)
// and the platform Lead (session_reap): a Lead's zombie-process kill during a fleet-down incident was
// twice blocked by Claude Code's own auto-mode safety classifier, forcing a manual owner one-liner — the
// daemon killing its OWN children is not a classifier question. Reuses reapWorktreeProcesses/
// reapProcessesRootedInWorktree EXACTLY (no new kill mechanism) — see worktree-process-reap.mjs for the
// underlying OS-level proof; this file proves the NEW entry points wire into that seam correctly:
//   (A) reapWorkerStrays is parent-scoped ("not your worker" for a session owned by a DIFFERENT manager)
//       and excludes the worker's OWN live pty pid from the kill set (injected seam, deterministic).
//   (B) reapSessionStrays is cross-project by sessionId alone (Lead reach, no manager/parent scoping) and
//       errors on an unknown sessionId (injected seam, deterministic) — AND (the Code Review CRITICAL
//       finding) REFUSES a session with NO worktree at all (manager/plain/run/Lead shape, cwd = repo
//       root) rather than silently falling back to reaping the whole repo root.
//   (C) against REAL OS processes (no injected fake): reapWorkerStrays(managerA, workerA) kills a stray
//       rooted in worker A's OWN worktree while a marker process rooted in an UNRELATED sibling worker's
//       worktree is NEVER touched — the load-bearing worktree-scoping safety invariant, end-to-end.
// Run: 1) build daemon (pnpm build), 2) node test/worker-session-reap.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wksr-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitUntil = async (cond, timeoutMs, stepMs = 100) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
};
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

try {
  // ── (A) reapWorkerStrays: parent-scoped + excludes the worker's own live pty pid ────────────────────
  {
    const M1 = {
      projId: `wksr-a-proj1-${sfx}`, agentId: `wksr-a-agent1-${sfx}`, mgrId: `wksr-a-mgr1-${sfx}`, workerId: `wksr-a-wkr1-${sfx}`,
      repo: path.join(os.tmpdir(), `wksr-a-repo1-${sfx}`), worktreePath: path.join(os.tmpdir(), `wksr-a-wt1-${sfx}`), branch: "loom/wksr-a1",
    };
    const otherMgrId = `wksr-a-mgr2-${sfx}`;
    fs.mkdirSync(M1.repo, { recursive: true });
    fs.mkdirSync(M1.worktreePath, { recursive: true });
    const db = new Db();
    db.insertProject({ id: M1.projId, name: "WKSR-A1", repoPath: M1.repo, vaultPath: M1.repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: M1.agentId, projectId: M1.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: M1.mgrId, projectId: M1.projId, agentId: M1.agentId, engineSessionId: null, title: null, cwd: M1.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    // A SECOND, unrelated manager — used only to prove reapWorkerStrays refuses a worker it doesn't own.
    db.insertSession({ id: otherMgrId, projectId: M1.projId, agentId: M1.agentId, engineSessionId: null, title: null, cwd: M1.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: M1.workerId, projectId: M1.projId, agentId: M1.agentId, engineSessionId: null, title: null, cwd: M1.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: M1.mgrId, taskId: null, worktreePath: M1.worktreePath, branch: M1.branch });

    const WORKER_PID = 313131;
    const reapCalls = [];
    const sessions = new SessionService(db, {
      stop() {}, isAlive() { return false; }, enqueueStdin() {},
      getPid: (sid) => (sid === M1.workerId ? WORKER_PID : undefined),
    }, new OrchestrationControl(), {
      reapWorktreeProcesses: async (worktreePath, opts) => { reapCalls.push({ worktreePath, excludePids: opts?.excludePids ?? [] }); return { killedPids: [999] }; },
    });

    let threw = false;
    try { await sessions.reapWorkerStrays(otherMgrId, M1.workerId); } catch (e) { threw = /not your worker/.test(e.message); }
    check("(A) reapWorkerStrays refuses a worker that belongs to a DIFFERENT manager", threw);
    check("(A) the refusal never invoked the reap seam", reapCalls.length === 0);

    const result = await sessions.reapWorkerStrays(M1.mgrId, M1.workerId);
    check("(A) reapWorkerStrays (correct manager) reaps the worker's OWN worktree", reapCalls.some((c) => c.worktreePath === M1.worktreePath));
    check("(A) the reap excludes the worker's OWN live pty pid", !!reapCalls.find((c) => c.worktreePath === M1.worktreePath)?.excludePids.includes(WORKER_PID));
    check("(A) reapWorkerStrays returns the underlying killedPids", Array.isArray(result.killedPids) && result.killedPids.includes(999));

    db.close();
    fs.rmSync(M1.repo, { recursive: true, force: true });
    fs.rmSync(M1.worktreePath, { recursive: true, force: true });
  }

  // ── (B) reapSessionStrays: cross-project by sessionId alone (Lead reach), errors on unknown id ───────
  {
    const P = {
      projId: `wksr-b-proj-${sfx}`, agentId: `wksr-b-agent-${sfx}`, sessId: `wksr-b-sess-${sfx}`,
      repo: path.join(os.tmpdir(), `wksr-b-repo-${sfx}`), worktreePath: path.join(os.tmpdir(), `wksr-b-wt-${sfx}`),
    };
    fs.mkdirSync(P.repo, { recursive: true });
    fs.mkdirSync(P.worktreePath, { recursive: true });
    const db = new Db();
    db.insertProject({ id: P.projId, name: "WKSR-B", repoPath: P.repo, vaultPath: P.repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
    // NO parentSessionId — the Lead's reach is NOT parent-scoped, unlike reapWorkerStrays above.
    db.insertSession({ id: P.sessId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", worktreePath: P.worktreePath });
    // A REAL manager-shaped session: NO worktreePath at all, cwd = the REPO ROOT (exactly what a
    // manager/plain/run/Lead session looks like) — the CRITICAL Code Review case: this must REFUSE, not
    // silently fall back to reaping the repo root (which would match sibling ptys / the supervisor).
    const noWtId = `wksr-b-nowt-${sfx}`;
    db.insertSession({ id: noWtId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const PID = 424243;
    const reapCalls = [];
    const sessions = new SessionService(db, {
      stop() {}, isAlive() { return false; }, enqueueStdin() {},
      getPid: (sid) => (sid === P.sessId ? PID : undefined),
    }, new OrchestrationControl(), {
      reapWorktreeProcesses: async (worktreePath, opts) => { reapCalls.push({ worktreePath, excludePids: opts?.excludePids ?? [] }); return { killedPids: [] }; },
    });

    let threw = false;
    try { await sessions.reapSessionStrays("no-such-session"); } catch (e) { threw = /session not found/.test(e.message); }
    check("(B) reapSessionStrays errors on an unknown sessionId", threw);

    await sessions.reapSessionStrays(P.sessId);
    check("(B) reapSessionStrays reaches ANY session by id alone (no manager/parent scoping)", reapCalls.some((c) => c.worktreePath === P.worktreePath));
    check("(B) the reap excludes that session's OWN live pid", !!reapCalls.find((c) => c.worktreePath === P.worktreePath)?.excludePids.includes(PID));

    // ── THE CRITICAL CASE (Code Review, card cf17ebf3): a session with NO worktree (manager/plain/run/
    //    Lead shape) must REFUSE, never fall back to reaping its cwd (the repo root) ────────────────────
    const reapCallsBeforeNoWt = reapCalls.length;
    let noWtThrew = false;
    try { await sessions.reapSessionStrays(noWtId); } catch (e) { noWtThrew = /has no isolated worktree/.test(e.message); }
    check("(B) reapSessionStrays REFUSES a session with no worktreePath (manager/plain/run/Lead shape)", noWtThrew);
    check("(B) the refusal NEVER invokes the reap seam (would otherwise scope to the repo root)", reapCalls.length === reapCallsBeforeNoWt);

    db.close();
    fs.rmSync(P.repo, { recursive: true, force: true });
    fs.rmSync(P.worktreePath, { recursive: true, force: true });
  }

  // ── (C) REAL OS processes — the load-bearing worktree-scoping safety invariant, end-to-end ──────────
  {
    const target = {
      projId: `wksr-c-proj-t-${sfx}`, agentId: `wksr-c-agent-t-${sfx}`, mgrId: `wksr-c-mgr-t-${sfx}`, workerId: `wksr-c-wkr-t-${sfx}`,
      repo: path.join(os.tmpdir(), `wksr-c-repo-t-${sfx}`), worktreePath: path.join(os.tmpdir(), `wksr-c-wt-t-${sfx}`), branch: "loom/wksr-c-t",
    };
    const sibling = {
      projId: `wksr-c-proj-s-${sfx}`, agentId: `wksr-c-agent-s-${sfx}`, mgrId: `wksr-c-mgr-s-${sfx}`, workerId: `wksr-c-wkr-s-${sfx}`,
      repo: path.join(os.tmpdir(), `wksr-c-repo-s-${sfx}`), worktreePath: path.join(os.tmpdir(), `wksr-c-wt-s-${sfx}`), branch: "loom/wksr-c-s",
    };
    [target, sibling].forEach((p) => { fs.mkdirSync(p.repo, { recursive: true }); fs.mkdirSync(p.worktreePath, { recursive: true }); });

    const db = new Db();
    for (const p of [target, sibling]) {
      db.insertProject({ id: p.projId, name: p.workerId, repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
      db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
      db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: null, worktreePath: p.worktreePath, branch: p.branch });
    }

    // NO injected reapWorktreeProcesses here — falls back to the REAL reapProcessesRootedInWorktree, the
    // same real OS enumerator/killer worktree-process-reap.mjs proves at the unit level.
    const sessions = new SessionService(db, {
      stop() {}, isAlive() { return false; }, enqueueStdin() {}, getPid: () => undefined,
    }, new OrchestrationControl());

    const strayScript = path.join(target.worktreePath, "stray.js");
    const siblingScript = path.join(sibling.worktreePath, "marker.js");
    fs.writeFileSync(strayScript, "setInterval(() => {}, 1000);\n");
    fs.writeFileSync(siblingScript, "setInterval(() => {}, 1000);\n");
    const stray = spawnProcess(process.execPath, [strayScript], { stdio: "ignore" });
    const siblingMarker = spawnProcess(process.execPath, [siblingScript], { stdio: "ignore" });
    try {
      await sleep(400); // let both settle as steady-state live processes before reaping
      check("(C) the stray process (rooted in the TARGET worker's worktree) is alive before reap", isAlive(stray.pid));
      check("(C) the sibling marker (rooted in an UNRELATED worker's worktree) is alive before reap", isAlive(siblingMarker.pid));

      const result = await sessions.reapWorkerStrays(target.mgrId, target.workerId);
      const strayGone = await waitUntil(() => !isAlive(stray.pid), 8000);
      check("(C) reapWorkerStrays kills the stray via the REAL OS enumerator/killer", strayGone);
      check("(C) the stray's pid is reported in killedPids", result.killedPids.includes(stray.pid));

      await sleep(600);
      check("(C) the UNRELATED sibling worker's process is NEVER touched — the load-bearing scoping invariant", isAlive(siblingMarker.pid));
    } finally {
      if (isAlive(stray.pid)) { try { process.kill(stray.pid, "SIGKILL"); } catch { /* ignore */ } }
      if (isAlive(siblingMarker.pid)) { try { process.kill(siblingMarker.pid, "SIGKILL"); } catch { /* ignore */ } }
      await waitUntil(() => !isAlive(stray.pid) && !isAlive(siblingMarker.pid), 5000);
    }

    db.close();
    [target, sibling].forEach((p) => {
      try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      try { fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    });
  }
} finally {
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_reap (manager, parent-scoped) and session_reap (Lead, cross-project by id) reuse reapWorktreeProcesses/reapProcessesRootedInWorktree exactly: ownership-checked, exclude the target's own live pid, and — proven against REAL OS processes — never touch a process rooted in an unrelated sibling worktree."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
