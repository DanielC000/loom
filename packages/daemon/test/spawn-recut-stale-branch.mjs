import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Stale-base re-cut test (board card d9e39eaf — the worker_spawn-reuses-an-EMPTY-branch-at-its-OLD-base
// bug that bit the lead twice on 2026-06-04). REAL git on temp repos under %TEMP%, NO claude and NO
// live daemon — drives createWorktree() directly against an isolated LOOM_HOME (so WORKTREES_DIR is
// hermetic; paths.ts reads LOOM_HOME at module load). Torn down in a finally.
//
// When worker_spawn runs on a task that already has a worktree branch from a PRIOR attempt,
// createWorktree re-attaches/reuses that branch. The fix (Option A): for the two REUSE paths only,
// re-cut a branch that is EMPTY (0 commits ahead of current main) onto current main, while leaving a
// branch that carries real unmerged work (RECOVERY) exactly as-is. This proves all three cases against
// createWorktree, across BOTH reuse shapes (dir-present reuse AND branch-present/dir-gone re-attach):
//   (a) reused EMPTY branch (0 ahead) → worktree comes up at current main's HEAD (re-cut);
//   (b) reused branch WITH an unmerged commit (>0 ahead) → that commit is PRESERVED (recovery untouched);
//   (c) fresh task (no prior branch) → new branch cut off current main, unchanged behavior.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/spawn-recut-stale-branch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-recut-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { createWorktree, mayRecutOntoMain } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ============================================================================================
// (D) FAIL-SAFE gate for the DESTRUCTIVE re-cut (card fed15845): mayRecutOntoMain decides whether
// recutStaleReusedBranch may run `reset --hard`. Re-cut is allowed ONLY on a provably-empty branch
// (rev-list --count == "0"). A recovery branch (>0) OR a malformed/unparseable count (NaN) must NOT
// reset — the prior `parseInt(...) || 0` collapsed NaN→0 and would have DESTROYED recovery work.
check("(D) '0' (empty branch) → may re-cut (true)", mayRecutOntoMain("0") === true);
check("(D) '0\\n' (trailing newline from git.raw) → may re-cut (true)", mayRecutOntoMain("0\n") === true);
check("(D) '  0  ' (padded) → may re-cut (true)", mayRecutOntoMain("  0  ") === true);
check("(D) '1' (recovery, 1 ahead) → MUST NOT re-cut (false)", mayRecutOntoMain("1") === false);
check("(D) '42' (recovery) → MUST NOT re-cut (false)", mayRecutOntoMain("42") === false);
check("(D) '' (empty/no output) → NaN → FAIL SAFE, MUST NOT re-cut (false)", mayRecutOntoMain("") === false);
check("(D) 'garbage' (unparseable) → NaN → FAIL SAFE, MUST NOT re-cut (false)", mayRecutOntoMain("garbage") === false);
check("(D) 'fatal: bad revision' (git error text) → NaN → FAIL SAFE (false)", mayRecutOntoMain("fatal: bad revision") === false);
const GIT_ID = "-c user.email=recut@loom -c user.name=recut";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const head = (cwd) => git(cwd, "rev-parse HEAD");
// Commit a file into a checkout (the canonical repo to advance main, or a worktree to add prior work).
const commitInto = (dir, file, body, msg) => {
  fs.writeFileSync(path.join(dir, file), body);
  execSync(`git add . && git ${GIT_ID} commit -qm "${msg}"`, { cwd: dir });
};

const repo = path.join(os.tmpdir(), `loom-recut-repo-${Date.now()}`);
const PROJ = "projRecut";

try {
  // A real repo with one commit on the default branch (this is "old main", C1).
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# recut test\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

  // ============================================================================================
  // (a) DIR-PRESENT reuse, EMPTY branch → re-cut onto current main.
  // ============================================================================================
  const tA = "empty-dir-aaaa-1111";
  const A = await createWorktree(repo, PROJ, tA); // cut off C1
  check("(a setup) initial worktree HEAD == old main (C1)", head(A.worktreePath) === head(repo));
  // main advances to C2 while the branch sits at C1 (the stale-base condition).
  commitInto(repo, "main-advance-a.txt", "C2\n", "advance main to C2");
  const c2 = head(repo);
  check("(a setup) branch is now stale (0 commits ahead of C2)",
    git(repo, `rev-list --count ${c2}..${A.branch}`) === "0");
  // Re-spawn: dir present → reuse path. The empty branch must be re-cut onto C2.
  const Areuse = await createWorktree(repo, PROJ, tA);
  check("(a) reuse returns the same worktree path + branch", Areuse.worktreePath === A.worktreePath && Areuse.branch === A.branch);
  check("(a) DIR-PRESENT empty branch re-cut → worktree HEAD == current main (C2)", head(A.worktreePath) === c2);
  check("(a) branch pointer also moved to current main (C2)", git(repo, `rev-parse ${A.branch}`) === c2);
  check("(a) still on the loom/<key> branch after re-cut", git(A.worktreePath, "rev-parse --abbrev-ref HEAD") === A.branch);
  check("(a) the stale tree is gone (C1-only worktree did not carry forward a phantom file)",
    !fs.existsSync(path.join(A.worktreePath, "should-not-exist.txt")));
  // cleanup A
  execSync(`git worktree remove --force "${A.worktreePath}"`, { cwd: repo });

  // ============================================================================================
  // (b) DIR-PRESENT reuse, RECOVERY branch (real unmerged commit) → PRESERVED untouched.
  // ============================================================================================
  const tB = "recovery-dir-bbbb-2222";
  const B = await createWorktree(repo, PROJ, tB); // cut off current main (C2)
  commitInto(B.worktreePath, "recovery.txt", "real prior work\n", "recovery commit"); // 1 commit ahead
  const recoveryTip = head(B.worktreePath);
  // main advances again to C3 (so the branch is behind main AND ahead by its own commit — recovery shape).
  commitInto(repo, "main-advance-b.txt", "C3\n", "advance main to C3");
  const c3 = head(repo);
  check("(b setup) recovery branch is 1 commit ahead of current main", git(repo, `rev-list --count ${c3}..${B.branch}`) === "1");
  // Re-spawn: dir present → reuse path. A branch with unmerged work must be left EXACTLY as-is.
  const Breuse = await createWorktree(repo, PROJ, tB);
  check("(b) DIR-PRESENT recovery branch PRESERVED → worktree HEAD == the recovery tip (not reset)", head(Breuse.worktreePath) === recoveryTip);
  check("(b) the recovery commit's file is still present", fs.existsSync(path.join(Breuse.worktreePath, "recovery.txt")));
  check("(b) recovery branch was NOT advanced to current main", git(repo, `rev-parse ${B.branch}`) !== c3);
  // cleanup B
  execSync(`git worktree remove --force "${B.worktreePath}"`, { cwd: repo });
  execSync(`git ${GIT_ID} branch -D ${B.branch}`, { cwd: repo });

  // ============================================================================================
  // (a2) BRANCH-PRESENT / DIR-GONE re-attach, EMPTY branch → re-cut onto current main.
  // ============================================================================================
  const tC = "empty-attach-cccc-3333";
  const C = await createWorktree(repo, PROJ, tC); // cut off current main (C3)
  const cBranch = C.branch, cWt = C.worktreePath;
  // Remove the worktree dir but KEEP the branch (the rejected-merge-then-GC shape).
  execSync(`git worktree remove --force "${cWt}"`, { cwd: repo });
  check("(a2 setup) branch survived the worktree removal", git(repo, `branch --list ${cBranch}`).includes(cBranch));
  // main advances to C4 while only the (empty) branch survives at C3.
  commitInto(repo, "main-advance-c.txt", "C4\n", "advance main to C4");
  const c4 = head(repo);
  check("(a2 setup) surviving branch is stale (0 commits ahead of C4)", git(repo, `rev-list --count ${c4}..${cBranch}`) === "0");
  // Re-spawn: branch present, dir gone → re-attach path. The empty branch must be re-cut onto C4.
  const Creattach = await createWorktree(repo, PROJ, tC);
  check("(a2) re-attach restored the worktree dir", fs.existsSync(Creattach.worktreePath));
  check("(a2) BRANCH-PRESENT empty branch re-cut → worktree HEAD == current main (C4)", head(Creattach.worktreePath) === c4);
  check("(a2) branch pointer also moved to current main (C4)", git(repo, `rev-parse ${cBranch}`) === c4);
  check("(a2) on the loom/<key> branch after re-attach + re-cut", git(Creattach.worktreePath, "rev-parse --abbrev-ref HEAD") === cBranch);
  execSync(`git worktree remove --force "${Creattach.worktreePath}"`, { cwd: repo });

  // ============================================================================================
  // (b2) BRANCH-PRESENT / DIR-GONE re-attach, RECOVERY branch → PRESERVED untouched.
  // ============================================================================================
  const tD = "recovery-attach-dddd-4444";
  const D = await createWorktree(repo, PROJ, tD); // cut off current main (C4)
  commitInto(D.worktreePath, "recovery2.txt", "real prior work 2\n", "recovery commit 2");
  const recovery2Tip = head(D.worktreePath);
  execSync(`git worktree remove --force "${D.worktreePath}"`, { cwd: repo }); // dir gone, branch (with work) survives
  commitInto(repo, "main-advance-d.txt", "C5\n", "advance main to C5");
  const c5 = head(repo);
  check("(b2 setup) surviving recovery branch is 1 commit ahead of current main", git(repo, `rev-list --count ${c5}..${D.branch}`) === "1");
  const Dreattach = await createWorktree(repo, PROJ, tD);
  check("(b2) BRANCH-PRESENT recovery branch PRESERVED → worktree HEAD == the recovery tip (not reset)", head(Dreattach.worktreePath) === recovery2Tip);
  check("(b2) the recovery commit's file is present in the re-attached tree", fs.existsSync(path.join(Dreattach.worktreePath, "recovery2.txt")));
  check("(b2) recovery branch was NOT advanced to current main", git(repo, `rev-parse ${D.branch}`) !== c5);
  execSync(`git worktree remove --force "${Dreattach.worktreePath}"`, { cwd: repo });
  execSync(`git ${GIT_ID} branch -D ${D.branch}`, { cwd: repo });

  // ============================================================================================
  // (c) FRESH task (no prior branch/dir) → new branch cut off current main — unchanged behavior.
  // ============================================================================================
  const tE = "fresh-eeee-5555";
  const before = head(repo); // current main (C5)
  const E = await createWorktree(repo, PROJ, tE);
  check("(c setup) fresh task got a brand-new branch (didn't exist before)", git(repo, `branch --list ${E.branch}`).includes(E.branch));
  check("(c) fresh worktree cut off current main → HEAD == current main (C5)", head(E.worktreePath) === before);
  check("(c) fresh branch on the loom/<key> branch", git(E.worktreePath, "rev-parse --abbrev-ref HEAD") === E.branch);
  execSync(`git worktree remove --force "${E.worktreePath}"`, { cwd: repo });
} finally {
  try { execSync("git worktree prune", { cwd: repo }); } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createWorktree re-cuts an EMPTY/STALE reused branch (0 commits ahead) onto current main across BOTH reuse shapes (dir-present reuse AND branch-present/dir-gone re-attach), PRESERVES a recovery branch that carries real unmerged work, and leaves the fresh-task path cutting off current main unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
