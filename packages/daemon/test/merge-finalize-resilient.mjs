import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// finalizeMerge worktree-removal resilience test. REAL git on a temp repo, NO claude and NO live
// daemon — drives SessionService.confirmWorkerMerge() directly against an isolated LOOM_HOME (mirrors
// boot-reconcile.mjs's in-process style). Regression for the Windows handle-release bug: a worker's
// worktree dir can stay busy past fs.rm's retry budget right after a hard-stop, so worktree removal
// FAILS even though the `git merge` already committed. removeWorktree is the FIRST step of
// finalizeMerge, so an unguarded failure there used to abort the rest — branch not deleted, task left
// in_progress, no merge_done — and worker_merge_confirm returned an ERROR for an already-landed merge.
// (removeWorktree itself now SWALLOWS+warns the fs.rm failure — the boot-hang hardening in
// git/worktrees.ts — leaving the dir for boot-reconcile Pass B instead of throwing; finalizeMerge's
// own try/catch stays as a belt-and-suspenders second guard. Either way the merge must still finalize.)
//
// Proves:
//   (1) HAPPY path  — normal removal works: merged:true, worktree gone, branch deleted, task done,
//                     merge_done recorded.
//   (2) BUSY-DIR path — when worktree removal FAILS (we force fs.promises.rm to reject, simulating the
//                     busy-handle race), confirmWorkerMerge STILL returns merged:true, the branch is
//                     deleted, the task moves to done, a merge_done event is recorded, and a warning is
//                     emitted (dir left on disk for boot-reconcile Pass B to GC).
// Run: 1) build daemon (pnpm build), 2) node test/merge-finalize-resilient.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mfr-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mfr@loom -c user.name=mfr";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
// confirmWorkerMerge only calls pty.stop / pty.isAlive / pty.enqueueStdin on this path. A no-pty
// worker row (processState 'exited') means isAlive is false anyway; a stub keeps it hermetic.
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const mergeDoneCount = (mgrId) => db.listEvents(mgrId).filter((e) => e.kind === "merge_done").length;

// gateCommand left EMPTY so confirmWorkerMerge skips the build gate (no claude / cwd dependence) and
// goes straight to the merge + finalizeMerge bookkeeping we're exercising.
function seed(p) {
  db.insertProject({ id: p.projId, name: "MFR", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MFR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

// HAPPY worker: a real worktree with a committed file on its branch (a clean, mergeable change),
// seeded as a row. confirmWorkerMerge will remove this worktree normally.
async function setupWorker(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mfr\n");
  // Configure a git identity so the daemon's PLAIN squash `git commit` (no `-c` overrides) has an author.
  execSync(`git init -q && git config user.email mfr@loom && git config user.name mfr && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "worker change\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file} part 1"`, { cwd: worktreePath });
  fs.writeFileSync(path.join(worktreePath, `${p.file}.2`), "worker change 2\n"); // 2nd commit → must collapse to ONE
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file} part 2"`, { cwd: worktreePath });
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

// BUSY worker: the merge-able branch is committed but its worktree is DETACHED (removed) so the branch
// is freely deletable — this mirrors the real Windows symptom where `git worktree remove` de-registers
// the admin record but the dir lingers on disk. The worker row then points at a standalone LEFTOVER
// dir; forcing fs.promises.rm to reject (below) makes removeWorktree throw on it, exactly as a busy
// handle would. Keeping the leftover dir SEPARATE from any registered worktree lets us prove both that
// the branch is still deleted AND that the un-removable dir is left on disk for Pass B.
async function setupBusyWorker(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mfr\n");
  execSync(`git init -q && git config user.email mfr@loom && git config user.name mfr && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "worker change\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });
  await removeWorktree(p.repo, worktreePath); // detach the branch from its worktree (branch retained)
  // The leftover dir the busy handle "couldn't release": a plain dir that fs.rm will be forced to fail on.
  p.busyDir = path.join(os.tmpdir(), `loom-mfr-busydir-${sfx}`);
  fs.mkdirSync(p.busyDir, { recursive: true });
  fs.writeFileSync(path.join(p.busyDir, "leftover.txt"), "still busy\n");
  p.worktreePath = p.busyDir; p.branch = branch;
  seed(p);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const H = { projId: `mfr-h-proj-${sfx}`, agentId: `mfr-h-top-${sfx}`, taskId: `mfr-h-task-${sfx}`, mgrId: `mfr-h-mgr-${sfx}`, workerId: `mfr-h-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mfr-happy-${sfx}`), file: "happy.txt" };
const X = { projId: `mfr-x-proj-${sfx}`, agentId: `mfr-x-top-${sfx}`, taskId: `mfr-x-task-${sfx}`, mgrId: `mfr-x-mgr-${sfx}`, workerId: `mfr-x-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mfr-busy-${sfx}`), file: "busy.txt" };

const realRm = fs.promises.rm;
try {
  await setupWorker(H);
  await setupBusyWorker(X);

  // --- (1) HAPPY path: removal works normally. ---
  const headHBefore = git(H.repo, "rev-parse HEAD"); // canonical HEAD before the squash merge
  const confirmH = await sessions.confirmWorkerMerge(H.mgrId, H.workerId);
  check("(happy) confirmWorkerMerge → merged:true", confirmH.merged === true);
  check("(happy) file landed on canonical repo", fs.existsSync(path.join(H.repo, H.file)));
  check("(happy) BOTH worker commits' content landed (collapsed into the squash)",
    fs.existsSync(path.join(H.repo, `${H.file}.2`)));
  // ONE-COMMIT-PER-TASK: the worker's 2 commits collapse into exactly ONE non-merge commit on main,
  // with the clean task-title subject + trailer, and NO `Merge branch` noise commit.
  check("(happy) exactly ONE new commit on main (squash collapsed 2 worker commits)",
    git(H.repo, `rev-list --count ${headHBefore}..HEAD`) === "1");
  check("(happy) the landed commit is NOT a merge commit (single parent)",
    git(H.repo, "rev-list --parents -n 1 HEAD").trim().split(/\s+/).length === 2);
  check("(happy) NO `Merge branch` commit was created",
    git(H.repo, `log --format=%s ${headHBefore}..HEAD`).includes("Merge branch") === false);
  // The merge safety-net coerces a bare-prose title into Conventional Commits form (no type → "chore: ").
  check("(happy) squash subject is the task title coerced to Conventional Commits form",
    git(H.repo, "log -1 --format=%s") === "chore: MFR-TASK");
  check("(happy) squash body carries the Loom-Worker-Branch trailer",
    git(H.repo, "log -1 --format=%b").includes(`Loom-Worker-Branch: ${H.branch}`));
  check("(happy) NO Co-Authored-By trailer", git(H.repo, "log -1 --format=%b").includes("Co-Authored-By") === false);
  check("(happy) worktree removed", !fs.existsSync(H.worktreePath));
  check("(happy) branch deleted", git(H.repo, `branch --list ${H.branch}`) === "");
  check("(happy) task moved to done", db.getTask(H.taskId).columnKey === "done");
  check("(happy) merge_done event recorded (exactly 1)", mergeDoneCount(H.mgrId) === 1);

  // --- (2) BUSY-DIR path: force worktree removal to fail, prove the merge still finalizes. ---
  // removeWorktree tries `git worktree remove` (swallowed), then falls back to fs.promises.rm; we make
  // THAT reject (the busy-handle race fs.rm can't outwait) — exactly the Windows symptom. removeWorktree
  // now SWALLOWS that rejection internally (the boot-hang hardening) and warns `[worktree] could not
  // remove dir … left on disk for a later GC`, so finalizeMerge runs to completion; its own try/catch is
  // the second guard. The merge bookkeeping must finish AND a warning about the un-removed dir must fire.
  // Scoped to this one call, then restored.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(" ")); };
  fs.promises.rm = async () => { const e = new Error("EBUSY: resource busy or locked (simulated)"); e.code = "EBUSY"; throw e; };
  let confirmX;
  try {
    confirmX = await sessions.confirmWorkerMerge(X.mgrId, X.workerId);
  } finally {
    fs.promises.rm = realRm;
    console.warn = realWarn;
  }

  check("(busy) confirmWorkerMerge STILL returns merged:true despite removal failure", confirmX.merged === true);
  check("(busy) file landed on canonical repo (merge committed)", fs.existsSync(path.join(X.repo, X.file)));
  check("(busy) branch STILL deleted (bookkeeping continued past the throw)", git(X.repo, `branch --list ${X.branch}`) === "");
  check("(busy) task STILL moved to done", db.getTask(X.taskId).columnKey === "done");
  check("(busy) merge_done event STILL recorded (exactly 1)", mergeDoneCount(X.mgrId) === 1);
  check("(busy) worktree dir LEFT on disk for boot-reconcile Pass B to GC", fs.existsSync(X.worktreePath));
  check("(busy) a warning about the un-removed worktree (left on disk for GC) was emitted",
    warnings.some((w) => w.includes(X.worktreePath) && /left on disk|boot-reconcile|Pass B|GC/i.test(w)));
} finally {
  fs.promises.rm = realRm;
  db.close();
  for (const p of [H, X]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { if (p.busyDir) fs.rmSync(p.busyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.rmSync(p.repo, { recursive: true, force: true });
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — finalizeMerge finishes the merge bookkeeping (branch deleted, task done, merge_done) and reports merged:true EVEN WHEN worktree removal fails; the busy dir is left for boot-reconcile Pass B."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
