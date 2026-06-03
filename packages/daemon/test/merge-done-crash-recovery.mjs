// Branch-gone dangling-merge recovery test (the daemon root-cause half of the lingering
// MERGE-REQUEST-alert bug). REAL git on temp repos, NO claude and NO live daemon — drives
// SessionService.reconcileOrchestrationOnBoot() directly against an isolated LOOM_HOME (so
// WORKTREES_DIR + loom.db are hermetic; paths.ts reads LOOM_HOME at load).
//
// The crash window finalizeMerge used to have: it ran removeWorktree → deleteBranch → updateTask →
// merge_done, so a crash AFTER deleteBranch but BEFORE merge_done lost the terminal event AND pruned
// the branch. Boot-reconcile Pass A is keyed on `isBranchMerged`, which is false once the branch is
// gone — so the merge could NEVER be re-detected and the `merge_request` dangled forever (a permanent
// stale MERGE REQUEST bell). This proves the new boot-reconcile Pass A2 closes it:
//   (1) CRASH-IN-WINDOW: merge LANDED, branch GONE, worktree GONE, task DONE, a merge_request with NO
//       terminal event → ONE reconciling merge_done is emitted (staleMergesResolved === 1), so the
//       dangling merge_request now pairs with a terminal event and resolves.
//   (2) IDEMPOTENT: a second reconcile emits NO duplicate merge_done and reports staleMergesResolved 0
//       (and takes no destructive action — nothing on disk to touch).
//   (3) NO FALSE POSITIVE: a genuinely-unresolved review (merge_request, NO terminal, task NOT done)
//       is LEFT ALONE — Pass A2 keys on task `done`, so an in-flight/rejected-and-retasked review is
//       never spuriously closed.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-done-crash-recovery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mdcr-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mdcr@loom -c user.name=mdcr";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

// reconcile uses only db + git; pty/control are never touched on this path → a stub pty is safe.
const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());

const workerMergeDoneCount = (workerId) =>
  db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_done").length;
const workerHasTerminal = (workerId) =>
  db.listEventsForWorker(workerId).some((e) => e.kind === "merge_done" || e.kind === "merge_rejected");

function seedCommon(p, taskColumn) {
  db.insertProject({ id: p.projId, name: "MDCR", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MDCR-TASK", body: "", columnKey: taskColumn, position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // The worker is EXITED (recoverStaleSessions ran) and STILL carries its branch name in the row even
  // though the branch is gone from git — exactly the prod-orphan shape.
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
  // The manager reviewed the worker's diff (reviewWorkerMerge) → a merge_request with NO terminal event.
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: p.mgrId, workerSessionId: p.workerId, taskId: p.taskId, kind: "merge_request", detail: { branch: p.branch } });
}

// --- Scenario C: a merge that LANDED, then the branch+worktree were pruned but merge_done was lost ---
// (task moved to done first under the new crash-safe order, OR by a later reconcile — either way the
// terminal merge_done never reached the DB and the branch is gone, so Pass A can't re-detect it.)
async function setupCrashInWindow(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mdcr crash\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "worker change\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });
  // The merge LANDED on the canonical branch.
  execSync(`git ${GIT_ID} merge --no-ff --no-edit ${branch}`, { cwd: p.repo });
  // ...then removeWorktree + deleteBranch ran, but the process died BEFORE merge_done was recorded.
  execSync(`git worktree remove --force "${worktreePath}"`, { cwd: p.repo });
  execSync(`git ${GIT_ID} branch -D ${branch}`, { cwd: p.repo });
  p.worktreePath = worktreePath; p.branch = branch;
  seedCommon(p, "done"); // task IS done (the merge demonstrably landed); merge_done is the ONLY thing missing
}

// --- Scenario P: a genuinely-unresolved review — merge_request, NO terminal, task NOT done ---
// Pass A2 must NOT touch this (no spurious merge_done): the review hasn't landed.
async function setupPendingReview(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mdcr pending\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "in-flight work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath }); // committed, NOT merged
  p.worktreePath = worktreePath; p.branch = branch;
  seedCommon(p, "in_progress"); // NOT done → not a landed merge
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const C = { projId: `mdcr-c-proj-${sfx}`, agentId: `mdcr-c-top-${sfx}`, taskId: `mdcr-c-task-${sfx}`, mgrId: `mdcr-c-mgr-${sfx}`, workerId: `mdcr-c-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mdcr-crash-${sfx}`), file: "crash.txt" };
const P = { projId: `mdcr-p-proj-${sfx}`, agentId: `mdcr-p-top-${sfx}`, taskId: `mdcr-p-task-${sfx}`, mgrId: `mdcr-p-mgr-${sfx}`, workerId: `mdcr-p-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mdcr-pending-${sfx}`), file: "pending.txt" };

try {
  await setupCrashInWindow(C);
  await setupPendingReview(P);

  // Sanity: the orphan's preconditions hold before the reconcile (this is the un-redetectable shape).
  check("(pre) crash-scenario branch is GONE from git (Pass A can't re-detect)", git(C.repo, `branch --list ${C.branch}`) === "");
  check("(pre) crash-scenario worktree GONE", !fs.existsSync(C.worktreePath));
  check("(pre) crash-scenario task is done", db.getTask(C.taskId).columnKey === "done");
  check("(pre) crash-scenario has a dangling merge_request (NO terminal event)", !workerHasTerminal(C.workerId));
  check("(pre) pending-scenario has a dangling merge_request (NO terminal event)", !workerHasTerminal(P.workerId));
  check("(pre) pending-scenario task NOT done", db.getTask(P.taskId).columnKey !== "done");

  // --- FIRST reconcile ---
  const r1 = await sessions.reconcileOrchestrationOnBoot();
  check("(1) reconcile resolved exactly 1 branch-gone dangling merge", r1.staleMergesResolved === 1);
  check("(1) reconcile finished 0 orphaned merges (branch gone → Pass A blind), 0 failed", r1.mergesFinished === 0 && r1.mergesFailed === 0);

  // The crash orphan is resolved: exactly one merge_done now pairs with its merge_request.
  check("(1) crash-scenario merge_done emitted (exactly 1)", workerMergeDoneCount(C.workerId) === 1);
  check("(1) crash-scenario merge_request now resolved (a terminal event exists)", workerHasTerminal(C.workerId));
  const reconciledEvt = db.listEventsForWorker(C.workerId).find((e) => e.kind === "merge_done");
  check("(1) crash-scenario merge_done is flagged reconciled", reconciledEvt?.detail?.reconciled === true);

  // The genuinely-pending review is LEFT ALONE.
  check("(1) pending-scenario got NO merge_done (not spuriously resolved)", workerMergeDoneCount(P.workerId) === 0);
  check("(1) pending-scenario still has a dangling merge_request", !workerHasTerminal(P.workerId));
  check("(1) pending-scenario task untouched (still in_progress)", db.getTask(P.taskId).columnKey === "in_progress");

  // --- SECOND reconcile: idempotent — no duplicate merge_done, no destructive action ---
  const r2 = await sessions.reconcileOrchestrationOnBoot();
  check("(2) second run resolves 0 stale merges (terminal event already present)", r2.staleMergesResolved === 0);
  check("(2) crash-scenario merge_done NOT duplicated (still exactly 1)", workerMergeDoneCount(C.workerId) === 1);
  check("(2) crash-scenario task still done", db.getTask(C.taskId).columnKey === "done");
  check("(2) pending-scenario STILL untouched (no merge_done, still in_progress)",
    workerMergeDoneCount(P.workerId) === 0 && db.getTask(P.taskId).columnKey === "in_progress");
} finally {
  db.close();
  for (const p of [C, P]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot-reconcile Pass A2 emits exactly one reconciling merge_done for a branch-gone dangling merge (merge landed, branch pruned, merge_done lost, task done), is idempotent on re-run, and never closes a genuinely-unresolved (task-not-done) review."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
