// workerDiff lifecycle test — the fix for "/orchestration worker diffs are all empty". REAL git on a
// temp repo (worktrees.mjs style). Proves workerDiff is robust across a worker's whole lifecycle where
// the old diffBranch was not: it reads UNCOMMITTED in-progress work from a live worktree (was empty),
// the committed branch diff when the worktree is gone, and the LANDED diff reconstructed from the merge
// commit after the branch was merged + deleted (was a 500). LOOM_HOME set before importing dist/* so
// WORKTREES_DIR is isolated. Run: 1) build daemon, 2) node test/worker-diff.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wd-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { createWorktree, removeWorktree, deleteBranch, mergeBranch, diffBranch, workerDiff } =
  await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const commitInto = (dir, file, body, msg) => {
  fs.writeFileSync(path.join(dir, file), body);
  execSync(`git add . && git -c user.email=wd@loom -c user.name=wd commit -qm "${msg}"`, { cwd: dir });
};

const repo = path.join(os.tmpdir(), `loom-wd-repo-${Date.now()}`);

try {
  // a real repo with one commit (a tracked README we can later edit uncommitted).
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# v1\n");
  execSync(`git init -q && git add . && git -c user.email=wd@loom -c user.name=wd commit -q -m "init"`, { cwd: repo });

  // ── CASE 1a — live worktree, work UNCOMMITTED only (the headline bug). diffBranch reads EMPTY;
  //    workerDiff must surface the uncommitted edit so a manager can supervise in-progress work.
  {
    const { worktreePath, branch } = await createWorktree(repo, "projWD", "uncommitted-aaaa-1111");
    fs.writeFileSync(path.join(worktreePath, "README.md"), "# v1\nWIP line from the worker\n"); // edit, NO commit
    const old = await diffBranch(repo, branch); // what the page did before — committed branch only
    const d = await workerDiff(repo, { branch, worktreePath });
    check("(1a) OLD diffBranch sees nothing (branch tip == base; work is uncommitted)", old.patch.trim() === "");
    check("(1a) workerDiff surfaces the uncommitted edit", !!d && d.patch.includes("WIP line from the worker"));
    check("(1a) flagged uncommitted", !!d && d.uncommitted === true);
    check("(1a) filesChanged counts the edited file", !!d && d.filesChanged === 1);
    await removeWorktree(repo, worktreePath);
    await deleteBranch(repo, branch); // unmerged → -d refuses; harmless, dir already gone
  }

  // ── CASE 1b — live worktree with BOTH a commit and an uncommitted edit → diff spans both.
  {
    const { worktreePath, branch } = await createWorktree(repo, "projWD", "mixed-bbbb-2222");
    commitInto(worktreePath, "feature.txt", "committed feature\n", "feat commit");
    fs.writeFileSync(path.join(worktreePath, "README.md"), "# v1\nuncommitted tweak\n"); // tracked edit, no commit
    const d = await workerDiff(repo, { branch, worktreePath });
    check("(1b) includes the COMMITTED file", !!d && d.patch.includes("feature.txt") && d.patch.includes("committed feature"));
    check("(1b) AND the UNCOMMITTED edit", !!d && d.patch.includes("uncommitted tweak"));
    check("(1b) flagged uncommitted", !!d && d.uncommitted === true);
    await removeWorktree(repo, worktreePath);
    // keep the branch for case 2.
    globalThis.__case2 = branch;
  }

  // ── CASE 2 — committed, branch exists, worktree GONE → committed branch diff, no uncommitted flag.
  {
    const branch = globalThis.__case2;
    const d = await workerDiff(repo, { branch, worktreePath: "/no/such/worktree" });
    check("(2) committed branch diff still works with the worktree gone", !!d && d.patch.includes("feature.txt"));
    check("(2) NOT flagged uncommitted (no live worktree)", !!d && !d.uncommitted);
    check("(2) NOT flagged merged (branch still present)", !!d && !d.merged);
    await deleteBranch(repo, branch); // -d refuses (unmerged) — leaves it; explicit force to clean up
    execSync(`git branch -D ${branch}`, { cwd: repo });
  }

  // ── CASE 3 — branch MERGED + deleted → reconstruct the landed diff from the merge commit
  //    (was a 500 "ambiguous argument" → red "No diff" in the UI for every merged worker).
  {
    const { worktreePath, branch } = await createWorktree(repo, "projWD", "merged-cccc-3333");
    commitInto(worktreePath, "landed.txt", "this work landed on main\n", "landed commit");
    const merged = await mergeBranch(repo, branch); // --no-ff → "Merge branch 'loom/<key>'"
    check("(3 setup) clean merge", merged.ok === true);
    await removeWorktree(repo, worktreePath);
    await deleteBranch(repo, branch);
    check("(3 setup) branch is GONE", execSync(`git branch --list ${branch}`, { cwd: repo }).toString().trim() === "");
    check("(3 setup) OLD diffBranch now THROWS on the deleted branch (the 500)",
      await diffBranch(repo, branch).then(() => false, () => true));
    const d = await workerDiff(repo, { branch, worktreePath: null });
    check("(3) workerDiff reconstructs the landed diff instead of erroring", !!d && d.patch.includes("landed.txt"));
    check("(3) shows the landed content", !!d && d.patch.includes("this work landed on main"));
    check("(3) flagged merged", !!d && d.merged === true);
  }

  // ── CASE 4 — genuinely nothing to show → null (caller renders an honest "no diff").
  {
    check("(4) no branch → null", (await workerDiff(repo, { branch: null, worktreePath: null })) === null);
    check("(4) unknown branch, no worktree, no merge commit → null",
      (await workerDiff(repo, { branch: "loom/deadbeef", worktreePath: null })) === null);
  }
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — workerDiff surfaces uncommitted in-progress work from a live worktree, the committed branch diff when the worktree is gone, and the reconstructed landed diff after a merge+delete — the three states the orchestration view needs, where diffBranch alone was empty or errored."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
