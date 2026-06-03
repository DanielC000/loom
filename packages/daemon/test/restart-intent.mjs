// Self-host daemon-restart support test (the `daemon_restart` manager tool). NO claude, NO live
// daemon, NO process.exit — drives the restart module + SessionService directly against an isolated
// LOOM_HOME. Proves:
//   (1) restart-intent roundtrips: write → read → clear (and reads null when absent).
//   (2) reconcileOrchestrationOnBoot PROTECTS a restart-intent worker's worktree from pass-B GC —
//       without protection the exited worker's worktree is pruned (and would be unresumable); WITH
//       the worker in the protected set the worktree is RETAINED so boot can resume into it.
//   (3) requestDaemonRestart REFUSES when unsupervised (LOOM_SUPERVISED unset) — returns
//       {restarting:false,error} and writes NO intent + does NOT exit (so a dev/non-supervised
//       daemon can't be killed with nothing to bring it back).
// Run: 1) build daemon, 2) node test/restart-intent.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ri-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
delete process.env.LOOM_SUPERVISED; // ensure the unsupervised-refusal test is deterministic

const restart = await import("../dist/orchestration/restart.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ri@loom -c user.name=ri";
const now = new Date().toISOString();

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const repo = path.join(os.tmpdir(), `loom-ri-repo-${sfx}`);
const ids = { projId: `ri-proj-${sfx}`, agentId: `ri-top-${sfx}`, taskId: `ri-task-${sfx}`, mgrId: `ri-mgr-${sfx}`, workerId: `ri-wkr-${sfx}` };
let worktreePath; // hoisted so the finally cleanup can reach it

try {
  // --- (1) intent roundtrip ---
  check("(1) reads null when no intent present", restart.readRestartIntent() === null);
  const intent = { reason: "deploy merged daemon code", managerSessionId: ids.mgrId, workerSessionIds: [ids.workerId], requestedAt: now };
  restart.writeRestartIntent(intent);
  const read = restart.readRestartIntent();
  check("(1) intent roundtrips (reason + manager + workers)",
    read && read.reason === intent.reason && read.managerSessionId === ids.mgrId && JSON.stringify(read.workerSessionIds) === JSON.stringify([ids.workerId]));
  restart.clearRestartIntent();
  check("(1) intent cleared → reads null again", restart.readRestartIntent() === null);
  check("(1) RESTART_EXIT_CODE is the agreed sentinel (75)", restart.RESTART_EXIT_CODE === 75);

  // --- setup: a real exited worker with a committed-but-unmerged worktree on disk ---
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# ri\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  const wt = await createWorktree(repo, ids.projId, ids.taskId);
  worktreePath = wt.worktreePath;
  const branch = wt.branch;
  fs.writeFileSync(path.join(worktreePath, "work.txt"), "in-flight worker change\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m work`, { cwd: worktreePath });

  db.insertProject({ id: ids.projId, name: "RI", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: ids.agentId, projectId: ids.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: ids.taskId, projectId: ids.projId, title: "RI", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: ids.mgrId, projectId: ids.projId, agentId: ids.agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // The worker was LIVE at restart, marked 'exited' by recoverStaleSessions — exactly pass-B's GC target.
  db.insertSession({ id: ids.workerId, projectId: ids.projId, agentId: ids.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ids.mgrId, taskId: ids.taskId, worktreePath, branch });

  // --- (2) protection: WITH the worker protected, its worktree survives the reconcile ---
  check("(2-pre) worktree present before reconcile", fs.existsSync(worktreePath));
  const rProtected = await sessions.reconcileOrchestrationOnBoot(new Set([ids.workerId]));
  check("(2) protected reconcile pruned 0 worktrees", rProtected.worktreesPruned === 0);
  check("(2) protected worker's worktree RETAINED (resumable)", fs.existsSync(worktreePath));

  // --- and WITHOUT protection, the same exited worktree IS pruned (proves the guard is load-bearing) ---
  const rUnprotected = await sessions.reconcileOrchestrationOnBoot();
  check("(2) unprotected reconcile prunes the orphaned worktree", rUnprotected.worktreesPruned === 1);
  check("(2) unprotected worktree gone", !fs.existsSync(worktreePath));

  // --- (3) unsupervised refusal ---
  const refusal = await sessions.requestDaemonRestart(ids.mgrId, "should be refused");
  check("(3) unsupervised requestDaemonRestart returns restarting:false", refusal.restarting === false);
  check("(3) unsupervised refusal carries an explanatory error", typeof refusal.error === "string" && refusal.error.length > 0);
  check("(3) unsupervised refusal wrote NO intent (daemon left untouched)", restart.readRestartIntent() === null);
  // role gate: a non-manager cannot restart the daemon.
  let threw = false;
  try { await sessions.requestDaemonRestart(ids.workerId, "nope"); } catch { threw = true; }
  check("(3) a worker calling requestDaemonRestart throws (manager-only)", threw);
} finally {
  db.close();
  try { if (worktreePath) fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — restart intent roundtrips, the reconcile protects intent worktrees from GC, and an unsupervised/non-manager daemon_restart is refused without side effects."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
