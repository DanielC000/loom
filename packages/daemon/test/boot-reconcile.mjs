// Boot-time orchestration reconcile test (#22 run-2 + audit M4). REAL git on temp repos, NO claude
// and NO live daemon — drives SessionService.reconcileOrchestrationOnBoot() directly against an
// isolated LOOM_HOME (so WORKTREES_DIR + loom.db are hermetic; paths.ts reads LOOM_HOME at load).
// Proves:
//   (1) an INTERRUPTED MERGE (branch already merged into the canonical branch, but task still
//       in_progress + worktree present) is finished — worktree gone, branch deleted, task done, a
//       merge_done event appended — AND a second run is a clean no-op (no duplicate merge_done).
//   (2) an ORPHANED WORKTREE (exited worker, no merge) is pruned, leaving the task untouched.
// Run: 1) build daemon, 2) node test/boot-reconcile.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-br-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=br@loom -c user.name=br";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

// reconcile uses only db + git; pty/control are never touched on this path → a stub pty is safe.
const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

const mergeDoneCount = (mgrId) => db.listEvents(mgrId).filter((e) => e.kind === "merge_done").length;

function seed(p) {
  db.insertProject({ id: p.projId, name: "BR", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "BR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

// --- Scenario 1: a merge whose bookkeeping was interrupted ---
async function setupMerged(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# br merged\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "worker change\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });
  // The merge LANDED (this is what confirmWorkerMerge does first)... but the daemon died before the
  // bookkeeping ran: branch + worktree still present, task still in_progress.
  execSync(`git ${GIT_ID} merge --no-ff --no-edit ${branch}`, { cwd: p.repo });
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

// --- Scenario 2: an exited worker's leftover worktree, NEVER merged ---
async function setupOrphan(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# br orphan\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "uncommitted-ish work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath }); // committed, NOT merged
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const M = { projId: `br-m-proj-${sfx}`, agentId: `br-m-top-${sfx}`, taskId: `br-m-task-${sfx}`, mgrId: `br-m-mgr-${sfx}`, workerId: `br-m-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-br-merged-${sfx}`), file: "merged.txt" };
const O = { projId: `br-o-proj-${sfx}`, agentId: `br-o-top-${sfx}`, taskId: `br-o-task-${sfx}`, mgrId: `br-o-mgr-${sfx}`, workerId: `br-o-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-br-orphan-${sfx}`), file: "orphan.txt" };

try {
  await setupMerged(M);
  await setupOrphan(O);

  // Sanity: pre-conditions hold before the reconcile.
  check("(pre) merged-scenario branch is an ancestor of HEAD (merge landed)", git(M.repo, `branch --merged HEAD`).includes(M.branch));
  check("(pre) merged-scenario task starts in_progress", db.getTask(M.taskId).columnKey === "in_progress");
  check("(pre) merged-scenario worktree present", fs.existsSync(M.worktreePath));
  check("(pre) orphan-scenario worktree present", fs.existsSync(O.worktreePath));

  // --- FIRST reconcile ---
  const r1 = await sessions.reconcileOrchestrationOnBoot();
  check("(1) reconcile finished exactly 1 orphaned merge", r1.mergesFinished === 1);
  check("(1) reconcile pruned exactly 1 orphaned worktree", r1.worktreesPruned === 1);

  // Scenario 1 finished: worktree gone, branch deleted, task done, merge_done appended.
  check("(1) merged-scenario task moved to done", db.getTask(M.taskId).columnKey === "done");
  check("(1) merged-scenario worktree removed", !fs.existsSync(M.worktreePath));
  check("(1) merged-scenario branch deleted", git(M.repo, `branch --list ${M.branch}`) === "");
  check("(1) merged-scenario merge_done event appended (exactly 1)", mergeDoneCount(M.mgrId) === 1);

  // Scenario 2 GC'd: worktree pruned, task untouched, branch RETAINED (committed work recoverable).
  check("(2) orphan-scenario worktree pruned", !fs.existsSync(O.worktreePath));
  check("(2) orphan-scenario task untouched (still in_progress)", db.getTask(O.taskId).columnKey === "in_progress");
  check("(2) orphan-scenario branch retained (not deleted by GC)", git(O.repo, `branch --list ${O.branch}`).includes(O.branch));
  check("(2) orphan-scenario recorded NO merge_done", mergeDoneCount(O.mgrId) === 0);

  // --- SECOND reconcile: a clean no-op ---
  const r2 = await sessions.reconcileOrchestrationOnBoot();
  check("(no-op) second run finishes 0 merges, prunes 0 worktrees", r2.mergesFinished === 0 && r2.worktreesPruned === 0);
  check("(no-op) merged-scenario still done", db.getTask(M.taskId).columnKey === "done");
  check("(no-op) merged-scenario merge_done NOT duplicated (still exactly 1)", mergeDoneCount(M.mgrId) === 1);
} finally {
  db.close();
  for (const p of [M, O]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.rmSync(p.repo, { recursive: true, force: true });
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot reconcile finishes interrupted merges idempotently (worktree gone, branch deleted, task done, one merge_done) and GCs orphaned worktrees while leaving their task + branch intact."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
