import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
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
const { createWorktree, deleteBranch } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Warn capture: reconcile + deleteBranch warn via console.warn. We record every warn so we can prove a
// DEAD-LEFTOVER prune (no-`.git` dir) emits NO "kept worktree …" line for it, and deleteBranch on a
// missing branch emits NO warn. The original console.warn is preserved so genuine output still shows.
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(" ")); realWarn(...a); };
const warnsMatching = (needle) => warns.filter((w) => w.includes(needle));
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
  // The SQUASH merge LANDED (this is what confirmWorkerMerge does first: `git merge --squash` + a plain
  // commit carrying the deterministic Loom-Worker-Branch trailer)... but the daemon died before the
  // bookkeeping ran: branch + worktree still present, task still in_progress. Under squash the branch is
  // NOT in main's ancestry, so Pass A must detect this via the trailer, not `git branch --merged`.
  execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "BR-TASK" -m "Loom-Worker-Branch: ${branch}"`, { cwd: p.repo });
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

// --- Scenario 2: an exited worker's leftover worktree holding UNMERGED COMMITTED work (branch ahead
//     of main, never merged). Pass A skips it (isBranchMerged=false), so it reaches Pass B — where the
//     P0 safe-to-discard guard must now KEEP it (data-loss prevention), NOT prune it. (Before the fix,
//     Pass B deleted this worktree mid-task; that is the bleeding this card stops. The clean/merged
//     "still GC'd" no-regression case is covered by Scenario 1's Pass-A finalize + boot-reconcile-keep-work.mjs.) ---
async function setupOrphan(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# br orphan\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "completed work, committed to the branch but NOT merged\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath }); // committed, NOT merged → branch ahead
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

// --- Scenario 3: a DEAD LEFTOVER — an exited worker's worktree DIR that survived on disk but has NO
//     `.git` linkage file (git dropped the admin entry + `.git` during a partially-failed removeWorktree
//     on Windows; the dir leaked). `git status` in it throws "not a git repository", so pre-fix Pass B's
//     fail-safe KEPT it forever (~270M leak + a misleading "holds unmerged work" log every boot). The fix:
//     the no-`.git` discriminator GCs it as a dead leftover — pruned (not kept), NO warn. ---
async function setupDeadLeftover(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# br dead leftover\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  // Simulate the live failure: the prior removeWorktree dropped git's admin entry + the `.git` linkage
  // file, but the directory survived on disk. `.git` in a worktree is a FILE (gitdir pointer); rm it.
  fs.rmSync(path.join(worktreePath, ".git"), { recursive: true, force: true });
  execSync(`git ${GIT_ID} worktree prune`, { cwd: p.repo }); // drop the now-dangling admin entry, as git would
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const M = { projId: `br-m-proj-${sfx}`, agentId: `br-m-top-${sfx}`, taskId: `br-m-task-${sfx}`, mgrId: `br-m-mgr-${sfx}`, workerId: `br-m-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-br-merged-${sfx}`), file: "merged.txt" };
const O = { projId: `br-o-proj-${sfx}`, agentId: `br-o-top-${sfx}`, taskId: `br-o-task-${sfx}`, mgrId: `br-o-mgr-${sfx}`, workerId: `br-o-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-br-orphan-${sfx}`), file: "orphan.txt" };
const D = { projId: `br-d-proj-${sfx}`, agentId: `br-d-top-${sfx}`, taskId: `br-d-task-${sfx}`, mgrId: `br-d-mgr-${sfx}`, workerId: `br-d-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-br-dead-${sfx}`), file: "dead.txt" };

try {
  await setupMerged(M);
  await setupOrphan(O);
  await setupDeadLeftover(D);

  // Sanity: pre-conditions hold before the reconcile. Under squash the branch is NOT an ancestor of HEAD
  // (no merge commit) — the landed squash is identified by the Loom-Worker-Branch trailer on main's HEAD.
  check("(pre) merged-scenario branch is NOT an ancestor of HEAD (squash, not a merge commit)", !git(M.repo, `branch --merged HEAD`).includes(M.branch));
  check("(pre) merged-scenario HEAD carries the Loom-Worker-Branch trailer", git(M.repo, "log -1 --format=%b").includes(`Loom-Worker-Branch: ${M.branch}`));
  check("(pre) merged-scenario task starts in_progress", db.getTask(M.taskId).columnKey === "in_progress");
  check("(pre) merged-scenario worktree present", fs.existsSync(M.worktreePath));
  check("(pre) orphan-scenario worktree present", fs.existsSync(O.worktreePath));
  check("(pre) dead-leftover worktree present on disk", fs.existsSync(D.worktreePath));
  check("(pre) dead-leftover dir has NO .git linkage (the leak's root cause)", !fs.existsSync(path.join(D.worktreePath, ".git")));

  // --- FIRST reconcile ---
  const r1 = await sessions.reconcileOrchestrationOnBoot();
  check("(1) reconcile finished exactly 1 orphaned merge", r1.mergesFinished === 1);
  check("(1) reconcile pruned exactly 1 worktree (the dead leftover with no .git → GC'd)", r1.worktreesPruned === 1);
  check("(1) reconcile KEPT exactly 1 worktree holding unmerged work (P0 data-loss guard)", r1.worktreesKept === 1);

  // Scenario 3 GC'd: the no-`.git` dead leftover is REMOVED and counted PRUNED (not kept), with NO
  // "holds unmerged work" warn for it (the misleading boot noise the fix kills).
  check("(3) dead-leftover dir REMOVED from disk (GC'd, not leaked)", !fs.existsSync(D.worktreePath));
  check("(3) dead-leftover emitted NO 'kept worktree' warn (no misleading boot noise)", warnsMatching(D.worktreePath).length === 0);
  check("(3) dead-leftover task untouched (GC touches only the dir, not the task)", db.getTask(D.taskId).columnKey === "in_progress");

  // Scenario 1 finished: worktree gone, branch deleted, task done, merge_done appended.
  check("(1) merged-scenario task moved to done", db.getTask(M.taskId).columnKey === "done");
  check("(1) merged-scenario worktree removed", !fs.existsSync(M.worktreePath));
  check("(1) merged-scenario branch deleted", git(M.repo, `branch --list ${M.branch}`) === "");
  check("(1) merged-scenario merge_done event appended (exactly 1)", mergeDoneCount(M.mgrId) === 1);

  // Scenario 2 KEPT: the worktree holds unmerged committed work, so Pass B's guard leaves it on disk —
  // contents intact, task untouched, branch retained, no spurious merge_done. (Pre-fix this was deleted.)
  check("(2) orphan-scenario worktree KEPT (holds unmerged commit → never auto-deleted)", fs.existsSync(O.worktreePath));
  check("(2) orphan-scenario worktree CONTENTS intact (committed work survives)", fs.existsSync(path.join(O.worktreePath, O.file)));
  check("(2) orphan-scenario task untouched (still in_progress)", db.getTask(O.taskId).columnKey === "in_progress");
  check("(2) orphan-scenario branch retained (not deleted by GC)", git(O.repo, `branch --list ${O.branch}`).includes(O.branch));
  check("(2) orphan-scenario recorded NO merge_done", mergeDoneCount(O.mgrId) === 0);

  // --- SECOND reconcile: idempotent — finishes 0 merges, prunes 0, and STILL keeps the work-holding worktree ---
  const r2 = await sessions.reconcileOrchestrationOnBoot();
  check("(no-op) second run finishes 0 merges, prunes 0 worktrees", r2.mergesFinished === 0 && r2.worktreesPruned === 0);
  check("(no-op) second run STILL keeps the work-holding worktree (idempotent)", r2.worktreesKept === 1 && fs.existsSync(O.worktreePath));
  check("(no-op) merged-scenario still done", db.getTask(M.taskId).columnKey === "done");
  check("(no-op) merged-scenario merge_done NOT duplicated (still exactly 1)", mergeDoneCount(M.mgrId) === 1);

  // --- deleteBranch idempotency: a missing branch is the DESIRED end state → resolve WITHOUT throw and
  //     WITHOUT a warn. Inject a git whose `git branch -D` rejects with git's real not-found message. ---
  const NF_BRANCH = `loom/never-existed-${sfx}`;
  const notFoundGit = { raw: async () => { throw new Error(`error: branch '${NF_BRANCH}' not found.`); } };
  const warnsBefore = warns.length;
  let threw = false;
  try { await deleteBranch(D.repo, NF_BRANCH, { gitFactory: () => notFoundGit }); } catch { threw = true; }
  check("(4) deleteBranch on a missing branch resolves WITHOUT throwing", !threw);
  check("(4) deleteBranch on a missing branch emitted NO warn (idempotent)", warns.length === warnsBefore);

  // Negative control: a GENUINE failure (e.g. busy ref lock) STILL warns — proves we didn't over-swallow.
  const failGit = { raw: async () => { throw new Error("fatal: Unable to create '.git/refs/…': File exists"); } };
  const warnsBeforeFail = warns.length;
  await deleteBranch(D.repo, `loom/locked-${sfx}`, { gitFactory: () => failGit });
  check("(4) deleteBranch on a GENUINE failure STILL warns (not over-swallowed)", warns.length === warnsBeforeFail + 1);
} finally {
  console.warn = realWarn;
  db.close();
  for (const p of [M, O, D]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.rmSync(p.repo, { recursive: true, force: true });
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot reconcile finishes interrupted merges idempotently (worktree gone, branch deleted, task done, one merge_done); per the P0 data-loss guard KEEPS an orphaned worktree that still holds unmerged/uncommitted work (contents + branch + task intact); GCs a DEAD LEFTOVER (no-`.git` dir → pruned, not kept, no warn); and deleteBranch treats a missing branch as the idempotent end state (no throw, no warn) while still warning on genuine failures."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
