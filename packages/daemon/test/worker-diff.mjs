import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
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

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wd-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { createWorktree, removeWorktree, deleteBranch, mergeBranch, diffBranch, workerDiff } =
  await import("../dist/git/worktrees.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const commitInto = (dir, file, body, msg) => {
  fs.writeFileSync(path.join(dir, file), body);
  execSync(`git add . && git -c user.email=wd@loom -c user.name=wd commit -qm "${msg}"`, { cwd: dir });
};

const repo = path.join(os.tmpdir(), `loom-wd-repo-${Date.now()}-${process.pid}`);

try {
  // a real repo with one commit (a tracked README we can later edit uncommitted). Configure a git identity
  // so mergeBranch's PLAIN squash `git commit` (no `-c` overrides by design) has an author.
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# v1\n");
  execSync(`git init -q && git config user.email wd@loom && git config user.name wd && git add . && git commit -q -m "init"`, { cwd: repo });

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
    await deleteBranch(repo, branch); // -D force-deletes the unmerged branch; harmless, dir already gone
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
    await deleteBranch(repo, branch); // now force-deletes (-D) the unmerged branch → gone in one call
    check("(2) deleteBranch force-removed the unmerged branch", execSync(`git branch --list ${branch}`, { cwd: repo }).toString().trim() === "");
  }

  // ── CASE 3 — branch SQUASH-MERGED + deleted → reconstruct the landed diff from the squash commit,
  //    located by the deterministic Loom-Worker-Branch trailer (was a 500 "ambiguous argument" → red
  //    "No diff" in the UI for every merged worker; the old `Merge branch` grep finds nothing under squash).
  {
    const { worktreePath, branch } = await createWorktree(repo, "projWD", "merged-cccc-3333");
    commitInto(worktreePath, "landed.txt", "this work landed on main\n", "landed commit");
    const merged = await mergeBranch(repo, branch, "Landed task"); // squash → one commit + trailer
    check("(3 setup) clean squash merge", merged.ok === true && typeof merged.sha === "string");
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

  // ── CASE 5 — bounded git calls (card c6a6f405 item 1): workerDiff's stage-1 (uncommitted-worktree)
  // merge-base/diffSummary/diff calls, and its stage-2 branchExists() check, were bare `simpleGit(...)`
  // with no timeout and no injectable seam at all — this is what makes a RED-before-the-fix reproduction
  // for these two stages impossible: the seam itself is the fix, so there is nothing to inject against on
  // pre-fix code. Instead, this proves the wiring is real: an injected `gitFactory` whose `raw`/
  // `diffSummary`/`diff` all REJECT IMMEDIATELY with a distinctive sentinel must be reached by EVERY
  // stage that runs — if `deps` is genuinely threaded through, every stage's real git call is replaced by
  // the rejection, so all stages fail and workerDiff falls through to null. If `deps` were silently
  // ignored (the old, pre-fix shape), the REAL git underneath would run unaffected and return the real
  // uncommitted diff instead of null — so `d === null` only holds when the injection actually lands.
  {
    const { worktreePath, branch } = await createWorktree(repo, "projWD", "bounded-dddd-4444");
    fs.writeFileSync(path.join(worktreePath, "README.md"), "# v1\nbounded-check edit\n"); // uncommitted, so stage 1 is live
    const SENTINEL = "INJECTED-FAKE-c6a6f405-stage1-2";
    const rejectSentinel = () => Promise.reject(new Error(SENTINEL));
    const gitFactory = () => ({ raw: rejectSentinel, diffSummary: rejectSentinel, diff: rejectSentinel });
    const d = await workerDiff(repo, { branch, worktreePath }, { gitFactory, timeoutMs: 5000 });
    check("(5) injected gitFactory reaches stage 1 + stage 2's git calls (deps threaded through) → falls through to null", d === null);
    await removeWorktree(repo, worktreePath);
    await deleteBranch(repo, branch);
  }

  // ── CASE 6 — same proof, isolating stage 3 specifically (the merged-branch path's own
  // `git.diffSummary`/`git.diff`, also bare `simpleGit(repoPath)` before this fix). Uses a REAL bounded
  // git instance (via boundedSimpleGit) for `.raw` — so findLandedSquashCommit's own trailer lookup
  // genuinely SUCCEEDS and finds the real sha — but rejects with the sentinel ONLY on `diffSummary`/
  // `diff`, isolating stage 3's own two calls from findLandedSquashCommit's already-bounded internals.
  {
    const { worktreePath, branch } = await createWorktree(repo, "projWD", "bounded-eeee-5555");
    commitInto(worktreePath, "landed2.txt", "stage-3 bound check\n", "landed2 commit");
    const merged = await mergeBranch(repo, branch, "Landed task 2 (bound check)");
    check("(6 setup) clean squash merge", merged.ok === true);
    await removeWorktree(repo, worktreePath);
    await deleteBranch(repo, branch);
    const SENTINEL = "INJECTED-FAKE-c6a6f405-stage3";
    const rejectSentinel = () => Promise.reject(new Error(SENTINEL));
    const gitFactory = (repoPathArg, ms) => {
      const real = boundedSimpleGit(repoPathArg, ms);
      return { raw: (...args) => real.raw(...args), diffSummary: rejectSentinel, diff: rejectSentinel };
    };
    const d = await workerDiff(repo, { branch, worktreePath: null }, { gitFactory, timeoutMs: 5000 });
    check("(6) stage 3's own diffSummary/diff calls are reached via the injected deps (real git found the sha, diffSummary/diff rejected) → falls through to null", d === null);
  }
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — workerDiff surfaces uncommitted in-progress work from a live worktree, the committed branch diff when the worktree is gone, and the reconstructed landed diff after a merge+delete — the three states the orchestration view needs, where diffBranch alone was empty or errored."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
