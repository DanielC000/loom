// Git worktree manager test (PR #12 + H1 hardening). REAL git on a temp repo (like busy-flag's
// repo setup). LOOM_HOME is set to a temp dir BEFORE importing dist/* so WORKTREES_DIR is isolated
// (paths.ts reads LOOM_HOME at module load). Run: 1) build daemon, 2) node test/worktrees.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wt-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { createWorktree, removeWorktree, deleteBranch, mergeBranch } = await import("../dist/git/worktrees.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const commitInto = (dir, file, body, msg) => {
  fs.writeFileSync(path.join(dir, file), body);
  execSync(`git add . && git -c user.email=wt@loom -c user.name=wt commit -qm "${msg}"`, { cwd: dir });
};

const repo = path.join(os.tmpdir(), `loom-wt-repo-${Date.now()}`);
const taskId = "abcd1234-ef56-7890";

try {
  // (a) a real repo with a commit on the default branch.
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# worktree test\n");
  execSync(`git init -q && git add . && git -c user.email=wt@loom -c user.name=wt commit -q -m "init"`, { cwd: repo });

  // (b) createWorktree → dir exists, HEAD on the loom/<key> branch (key is hashed, not a raw slice).
  const { worktreePath, branch } = await createWorktree(repo, "projWT", taskId);
  const key = path.basename(worktreePath);
  check(`(b) branch = loom/<key> (got ${branch})`, branch === `loom/${key}`);
  check("(b) worktree dir exists", fs.existsSync(worktreePath));
  check(`(b) worktree HEAD on ${branch}`, git(worktreePath, "rev-parse --abbrev-ref HEAD") === branch);
  check("(b) git worktree list includes the new worktree", git(repo, "worktree list").includes(key));

  // (c) ISOLATION: a commit on the worktree branch must not touch the canonical tree or its tip.
  const canonTipBefore = git(repo, "rev-parse HEAD");
  commitInto(worktreePath, "worker-file.txt", "from the worker\n", "worker commit");
  check("(c) worker commit advanced the worktree branch", git(worktreePath, "rev-parse HEAD") !== canonTipBefore);
  check("(c) canonical working tree does NOT contain worker-file.txt", !fs.existsSync(path.join(repo, "worker-file.txt")));
  check("(c) canonical branch tip unchanged", git(repo, "rev-parse HEAD") === canonTipBefore);

  // (d) distinct cwd → distinct transcript dir.
  check("(d) worktree cwd hashes to a distinct transcript dir from the repo",
    engineTranscriptPath(worktreePath, "x") !== engineTranscriptPath(repo, "x"));

  // (e) removeWorktree → dir gone, no longer listed (branch NOT deleted here — that's the merge's job).
  await removeWorktree(repo, worktreePath);
  check("(e) worktree dir removed", !fs.existsSync(worktreePath));
  check("(e) git worktree list no longer lists it", !git(repo, "worktree list").includes(key));
  check("(e) removeWorktree did NOT delete the branch", git(repo, `branch --list ${branch}`).includes(branch));

  // (f) H1.1 — a CLEAN merge deletes the branch: merge the worker's branch, remove the worktree,
  //     deleteBranch → the loom/<key> branch is gone (re-spawn won't hit "already exists").
  const tF = "feature-aaaa-1111";
  const { worktreePath: wtF, branch: brF } = await createWorktree(repo, "projWT", tF);
  commitInto(wtF, "f.txt", "f\n", "f commit");
  const merged = await mergeBranch(repo, brF);
  check("(f) clean merge ok", merged.ok === true);
  await removeWorktree(repo, wtF);
  await deleteBranch(repo, brF);
  check("(f) merged branch is GONE after deleteBranch", git(repo, `branch --list ${brF}`) === "");
  check("(f) merged worktree removed", !fs.existsSync(wtF));

  // (g) H1.2 — a REJECTED merge retains the worktree+branch; re-spawning on the same task must NOT throw.
  const tG = "rejected-bbbb-2222";
  const { worktreePath: wtG, branch: brG } = await createWorktree(repo, "projWT", tG);
  commitInto(wtG, "g.txt", "g\n", "g commit"); // worker's in-progress changes, merge rejected → retained
  // (g1) dir still present → createWorktree reuses it (no throw, same path).
  const reuse = await createWorktree(repo, "projWT", tG);
  check("(g1) re-create with the worktree present → reuses it (same path, no throw)", reuse.worktreePath === wtG && reuse.branch === brG);
  // (g2) dir removed but branch survives → createWorktree re-ATTACHES to the branch (no throw, history kept).
  await removeWorktree(repo, wtG);
  check("(g2 setup) branch survived the worktree removal", git(repo, `branch --list ${brG}`).includes(brG));
  const reattach = await createWorktree(repo, "projWT", tG);
  check("(g2) re-create with branch-only → attaches (dir back, HEAD on branch)",
    fs.existsSync(reattach.worktreePath) && git(reattach.worktreePath, "rev-parse --abbrev-ref HEAD") === brG);
  check("(g2) the retained branch kept the worker's commit (g.txt present in the re-attached tree)",
    fs.existsSync(path.join(reattach.worktreePath, "g.txt")));
  await removeWorktree(repo, reattach.worktreePath);
  await deleteBranch(repo, brG);

  // (i) H1.3 — two distinct task ids sharing the first 8 chars get DISTINCT branches/worktrees.
  const a = "abcd1234-1111", b = "abcd1234-2222"; // identical first 8 chars
  const A = await createWorktree(repo, "projWT", a);
  const B = await createWorktree(repo, "projWT", b);
  check("(i) id8-colliding tasks → distinct branches", A.branch !== B.branch);
  check("(i) id8-colliding tasks → distinct worktree dirs", A.worktreePath !== B.worktreePath);
  // cleanup: these were never merged, so deleteBranch (-d) would safely refuse — just drop the worktrees.
  await removeWorktree(repo, A.worktreePath);
  await removeWorktree(repo, B.worktreePath);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worktree-per-worker isolates, merges + deletes the branch on a clean merge, tolerates re-spawn on a retained (rejected) task, and never collides on the first 8 chars of a task id."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
