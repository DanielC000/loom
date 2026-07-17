// getWorkerDiffCached test — the perf fix for the polled orchestration-view diff endpoint
// (GET /api/sessions/:id/diff): Overview polls this once per rendered worker card every ~4s regardless
// of whether the worktree changed, and workerDiff() always shells out to git (350-415ms/poll in the
// 2026-07-16 perf profile). getWorkerDiffCached wraps it with a git-free freshness proof so an unchanged
// poll skips the subprocess entirely, while staying correct across BOTH a new commit and an uncommitted
// working-tree edit (the stale-diff trap: HEAD sha alone can't see an uncommitted edit, since it never
// touches a git ref). REAL git on a temp repo (worker-diff.mjs style).
// LOOM_HOME set before importing dist/* so WORKTREES_DIR is isolated. Run: 1) build daemon, 2) node test/worker-diff-cache.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wdc-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const {
  createWorktree, removeWorktree, deleteBranch, workerDiff,
  getWorkerDiffCached, __resetWorkerDiffCacheForTest, __workerDiffCacheSizeForTest,
} = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const commitInto = (dir, file, body, msg) => {
  fs.writeFileSync(path.join(dir, file), body);
  execSync(`git add . && git -c user.email=wd@loom -c user.name=wd commit -qm "${msg}"`, { cwd: dir });
};

const repo = path.join(os.tmpdir(), `loom-wdc-repo-${Date.now()}`);

try {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# v1\n");
  execSync(`git init -q && git config user.email wd@loom && git config user.name wd && git add . && git commit -q -m "init"`, { cwd: repo });

  // ── CASE A — unchanged poll skips the git subprocess; changes (uncommitted edit, then a real commit)
  //    are still picked up correctly, and each such change re-triggers exactly one recompute.
  {
    __resetWorkerDiffCacheForTest();
    let computeCalls = 0;
    const countingCompute = async (repoPath, opts) => { computeCalls++; return workerDiff(repoPath, opts); };
    const dep = { compute: countingCompute };

    const { worktreePath, branch } = await createWorktree(repo, "projWDC", "cache-aaaa-1111");

    const d1 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A1) baseline diff computed (miss #1)", computeCalls === 1);
    check("(A1) baseline shows no changes yet", !!d1 && d1.filesChanged === 0);

    const d2 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A2) identical repeat poll skips the git subprocess", computeCalls === 1);
    check("(A2) cached result matches the prior poll", JSON.stringify(d2) === JSON.stringify(d1));

    // Uncommitted edit — must invalidate even though no git ref/index changed (the stale-diff trap).
    fs.writeFileSync(path.join(worktreePath, "README.md"), "# v1\nWIP uncommitted edit\n");
    const d3 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A3) uncommitted edit forces a recompute", computeCalls === 2);
    check("(A3) uncommitted edit is reflected in the diff", !!d3 && d3.patch.includes("WIP uncommitted edit"));
    check("(A3) flagged uncommitted", !!d3 && d3.uncommitted === true);

    const d4 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A4) repeat poll after the edit skips the subprocess again", computeCalls === 2);
    check("(A4) still the same content as (A3)", JSON.stringify(d4) === JSON.stringify(d3));

    // A real commit that ALSO changes file content (new file) — must invalidate and surface the commit.
    commitInto(worktreePath, "feature.txt", "committed feature\n", "feat commit");
    const d5 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A5) a new commit forces a recompute", computeCalls === 3);
    check("(A5) new commit's file is in the diff", !!d5 && d5.patch.includes("feature.txt") && d5.patch.includes("committed feature"));
    check("(A5) prior uncommitted edit is still present too", !!d5 && d5.patch.includes("WIP uncommitted edit"));

    const d6 = await getWorkerDiffCached(repo, { branch, worktreePath }, dep);
    check("(A6) repeat poll after the commit skips the subprocess", computeCalls === 3);
    check("(A6) still the same content as (A5)", JSON.stringify(d6) === JSON.stringify(d5));

    await removeWorktree(repo, worktreePath);
    await deleteBranch(repo, branch);
  }

  // ── CASE B — two branches never share a cache entry (no cross-worker leak).
  {
    __resetWorkerDiffCacheForTest();
    const wt1 = await createWorktree(repo, "projWDC", "cache-bbbb-2222");
    const wt2 = await createWorktree(repo, "projWDC", "cache-cccc-3333");
    fs.writeFileSync(path.join(wt1.worktreePath, "README.md"), "# v1\nfrom worker ONE\n");
    fs.writeFileSync(path.join(wt2.worktreePath, "README.md"), "# v1\nfrom worker TWO\n");

    const dOne = await getWorkerDiffCached(repo, { branch: wt1.branch, worktreePath: wt1.worktreePath });
    const dTwo = await getWorkerDiffCached(repo, { branch: wt2.branch, worktreePath: wt2.worktreePath });
    check("(B1) worker ONE's diff shows its own edit", !!dOne && dOne.patch.includes("from worker ONE"));
    check("(B1) worker ONE's diff does NOT leak worker TWO's edit", !!dOne && !dOne.patch.includes("from worker TWO"));
    check("(B2) worker TWO's diff shows its own edit", !!dTwo && dTwo.patch.includes("from worker TWO"));
    check("(B2) worker TWO's diff does NOT leak worker ONE's edit", !!dTwo && !dTwo.patch.includes("from worker ONE"));

    await removeWorktree(repo, wt1.worktreePath);
    await removeWorktree(repo, wt2.worktreePath);
    await deleteBranch(repo, wt1.branch);
    await deleteBranch(repo, wt2.branch);
  }

  // ── CASE C — the cache is bounded: it cannot grow without limit as branches come and go.
  {
    __resetWorkerDiffCacheForTest();
    const fastCompute = async () => ({ filesChanged: 0, insertions: 0, deletions: 0, patch: "" });
    const TOTAL = 550; // comfortably above the internal cap, without needing to know its exact value
    for (let i = 0; i < TOTAL; i++) {
      await getWorkerDiffCached(repo, { branch: `fake/evict-${i}`, worktreePath: null }, { compute: fastCompute });
    }
    const size = __workerDiffCacheSizeForTest();
    check("(C1) cache size is bounded well below the total insert count (eviction happened)", size > 0 && size < TOTAL);
  }
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an unchanged poll skips the git subprocess, an uncommitted edit and a real commit both correctly invalidate the cache, branches never leak into each other, and the cache stays bounded."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
