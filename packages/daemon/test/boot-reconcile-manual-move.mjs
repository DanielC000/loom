import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression test for the reconnect/boot-reconciliation column-clobber bug: during a daemon
// connection-loss + reconnect (which, under `tsx watch`, is a real daemon restart that re-runs
// reconcileOrchestrationOnBoot), a merged card the manager had manually moved OFF the terminal
// column — e.g. into a "ready for owner review" lane — got silently reset back to the terminal
// column. finalizeMerge unconditionally force-set columnKey to terminal on EVERY call, and Pass A's
// "already reconciled?" skip check keyed off the task's CURRENT column (`columnKey === terminalKey`)
// rather than a durable "did this merge already finish?" signal — so a task moved OFF terminal always
// looked unreconciled, re-running finalizeMerge (and, pre-fix, re-forcing the column) on EVERY future
// boot, forever. worker_spawn then refused to re-dispatch that task because it read as terminal-column.
//
// Fix: both finalizeMerge's column-set AND Pass A's skip check now key off a recorded `merge_done`
// EVENT for the worker (the same idempotency idiom finishAlreadyMerged already used), not the task's
// current column — a human's later manual move is never overwritten by a reconciliation replay.
//
// Proves the DoD points:
//   (1) a merged card manually moved to a NON-terminal column after the merge STAYS there across
//       repeated reconcile replays (simulating repeated reconnects) — never reset to terminal.
//   (2) worker_spawn's terminal-column refusal is NOT tripped by the reconciliation replay — a
//       re-dispatch onto that same task succeeds.
//
// Run: 1) build daemon, 2) node test/boot-reconcile-manual-move.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const tmpHome = path.join(os.tmpdir(), `loom-brmm-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=brmm@loom -c user.name=brmm";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
class SeamHost extends PtyHost {
  createPty(opts) { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const sessions = new SessionService(db, new SeamHost(events), new OrchestrationControl());

const mergeDoneCount = (mgrId) => db.listEvents(mgrId).filter((e) => e.kind === "merge_done").length;

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const repo = path.join(os.tmpdir(), `loom-brmm-repo-${sfx}`);
const projId = `brmm-proj-${sfx}`;
const taskId = `brmm-task-${sfx}`;
const mgrAgentId = `brmm-mgr-agent-${sfx}`;
const devAgentId = `brmm-dev-agent-${sfx}`;
const mgrId = `brmm-mgr-${sfx}`;
const workerId = `brmm-wkr-${sfx}`;
const file = "merged.txt";
const spawnedWorktrees = [];

try {
  // --- seed: a project with the DEFAULT column set (terminal="done", review="review", active="in_progress") ---
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# brmm\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
  db.insertProject({ id: projId, name: "BRMM", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: mgrAgentId, projectId: projId, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  db.insertAgent({ id: devAgentId, projectId: projId, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
  db.insertSession({ id: mgrId, projectId: projId, agentId: mgrAgentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertTask({ id: taskId, projectId: projId, title: "BRMM-TASK", body: "", columnKey: "in_progress", position: 1, priority: "p2", createdAt: now, updatedAt: now });

  // --- a worker did the work: its squash landed on main (Loom-Worker-Branch trailer), but the daemon
  //     died before finishing bookkeeping — exactly boot-reconcile.mjs's Scenario 1 setup. ---
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), "worker change\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${file}"`, { cwd: worktreePath });
  execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "BRMM-TASK" -m "Loom-Worker-Branch: ${branch}"`, { cwd: repo });
  db.insertSession({ id: workerId, projectId: projId, agentId: devAgentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  check("(pre) task starts in_progress", db.getTask(taskId).columnKey === "in_progress");
  check("(pre) worktree present", fs.existsSync(worktreePath));

  // --- FIRST reconcile: finishes the interrupted merge — task lands in the terminal column. ---
  const r1 = await sessions.reconcileOrchestrationOnBoot();
  check("(1) first reconcile finished the orphaned merge", r1.mergesFinished === 1);
  check("(1) task landed in the terminal column ('done')", db.getTask(taskId).columnKey === "done");
  check("(1) worktree removed", !fs.existsSync(worktreePath));
  check("(1) branch deleted", git(repo, `branch --list ${branch}`) === "");
  check("(1) exactly one merge_done event recorded", mergeDoneCount(mgrId) === 1);

  // --- the manager manually curates the merged card into a NON-terminal "ready for owner review" lane ---
  db.updateTask(taskId, { columnKey: "review" });
  check("(manual move) task moved to the non-terminal 'review' lane", db.getTask(taskId).columnKey === "review");

  // --- SECOND + THIRD reconcile: simulate repeated connection-loss+reconnect replays. The manual move
  //     must WIN over every replay — never reset back to terminal. ---
  const r2 = await sessions.reconcileOrchestrationOnBoot();
  check("(2) reconcile replay finishes 0 merges (already reconciled — event-based, not column-based)", r2.mergesFinished === 0);
  check("(2) task STAYS in 'review' — the reconnect replay did NOT clobber the manual move", db.getTask(taskId).columnKey === "review");
  check("(2) merge_done NOT duplicated by the replay", mergeDoneCount(mgrId) === 1);

  const r3 = await sessions.reconcileOrchestrationOnBoot();
  check("(3) a THIRD replay still finishes 0 merges", r3.mergesFinished === 0);
  check("(3) task STILL in 'review' after repeated replays", db.getTask(taskId).columnKey === "review");

  // --- worker_spawn re-dispatch must NOT be refused as terminal-column: the reconciliation replay must
  //     never have re-forced the column back to 'done'. ---
  const respawned = await sessions.spawnWorker(mgrId, { taskId, agentId: devAgentId, kickoffPrompt: "GO" });
  spawnedWorktrees.push(respawned.worktreePath);
  check("(4) worker_spawn re-dispatch onto the task SUCCEEDS (not refused as terminal-column)",
    respawned.role === "worker" && respawned.taskId === taskId);
  check("(4) re-dispatch moved the card into the active lane ('in_progress')", db.getTask(taskId).columnKey === "in_progress");
} finally {
  db.close();
  for (const wt of spawnedWorktrees.filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a merged card manually moved off the terminal column survives repeated reconnect/boot reconciliation replays (event-based idempotency, not column-based), and worker_spawn can re-dispatch onto it without a false terminal-column refusal."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
