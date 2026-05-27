// Git worktree manager test (PR #12). REAL git on a temp repo (like busy-flag's repo setup).
// LOOM_HOME is set to a temp dir BEFORE importing dist/* so WORKTREES_DIR is isolated
// (paths.ts reads LOOM_HOME at module load). Run: 1) build daemon, 2) node test/worktrees.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wt-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const repo = path.join(os.tmpdir(), `loom-wt-repo-${Date.now()}`);
const taskId = "abcd1234-ef56-7890"; // short = "abcd1234"
const short = taskId.slice(0, 8);
const branch = `loom/${short}`;

try {
  // (a) a real repo with a commit on the default branch.
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# worktree test\n");
  execSync(`git init -q && git add . && git -c user.email=wt@loom -c user.name=wt commit -q -m "init"`, { cwd: repo });

  // (b) createWorktree → dir exists, HEAD on the loom/<taskId8> branch.
  const { worktreePath, branch: gotBranch } = await createWorktree(repo, "projWT", taskId);
  check(`(b) branch name = ${branch} (got ${gotBranch})`, gotBranch === branch);
  check("(b) worktree dir exists", fs.existsSync(worktreePath));
  const wtHead = git(worktreePath, "rev-parse --abbrev-ref HEAD");
  check(`(b) worktree HEAD on ${branch} (got ${wtHead})`, wtHead === branch);
  const listBefore = git(repo, "worktree list");
  check("(b) git worktree list includes the new worktree", listBefore.includes(short));

  // (c) ISOLATION (the core property): a commit on the worktree branch must not touch the
  //     canonical working tree or advance the canonical branch tip.
  const canonTipBefore = git(repo, "rev-parse HEAD");
  fs.writeFileSync(path.join(worktreePath, "worker-file.txt"), "from the worker\n");
  // The new file is untracked, so `git add` it explicitly before committing.
  execSync(`git add . && git -c user.email=wt@loom -c user.name=wt commit -qm "worker commit"`, { cwd: worktreePath });
  check("(c) worker commit landed on the worktree branch (it advanced)",
    git(worktreePath, "rev-parse HEAD") !== canonTipBefore);
  check("(c) canonical working tree does NOT contain worker-file.txt",
    !fs.existsSync(path.join(repo, "worker-file.txt")));
  check("(c) canonical branch tip unchanged", git(repo, "rev-parse HEAD") === canonTipBefore);

  // (d) distinct cwd → distinct transcript dir (full per-worker-transcript proof is a #13 concern).
  check("(d) worktree cwd hashes to a distinct transcript dir from the repo",
    engineTranscriptPath(worktreePath, "x") !== engineTranscriptPath(repo, "x"));

  // (e) removeWorktree → dir gone, no longer listed.
  await removeWorktree(repo, worktreePath);
  check("(e) worktree dir removed", !fs.existsSync(worktreePath));
  check("(e) git worktree list no longer lists it", !git(repo, "worktree list").includes(short));
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worktree-per-worker creates an isolated checkout/branch and removes cleanly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
