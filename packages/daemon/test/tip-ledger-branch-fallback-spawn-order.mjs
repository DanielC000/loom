import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b5f01208 — tryWorkerTipLedgerBranchFallback (git/worktrees.ts) used to spawn `git branch --list`
// UNCONDITIONALLY before ever consulting the cheap, DB-only `hasAnyForBranch` ledger pre-check — paying
// one git spawn per read of a branch the ledger has never recorded a landing for (the COMMON case on a
// trailers-off project, now reached on every GET /api/tasks/:id read since card 03f85c8e removed the
// lazy-backfill's own trailers-off skip). The fix moves `hasAnyForBranch` to the top, before any git call.
// REAL git on a temp repo, NO claude and NO live daemon — drives getTaskMergedInfo() directly. Proves:
//   (ZERO) a branch with NO ledger row at all: getTaskMergedInfo makes ZERO git spawns (counted via an
//          injected gitFactory wrapping real git) once the merged-commit-map cache is warm, and returns
//          null (unresolved) — proving the DB check short-circuits before any git call, not just before
//          the specific `branch --list` one.
//   (PRESENT) a branch WITH a ledger row that is STILL LIVE in git resolves via the tip-keyed path
//          (tryWorkerTipLedgerFallback), exactly as before the reorder.
//   (GONE) a branch WITH a ledger row whose git ref has been deleted resolves via the branch-only path
//          (lookupGoneBranchLedgerSha), exactly as before the reorder.
// Run: 1) build (pnpm --filter @loom/daemon build), 2) node packages/daemon/test/tip-ledger-branch-fallback-spawn-order.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { simpleGit } from "simple-git";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-wtlbf-home-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = (p) => pathToFileURL(path.join(__dirname, "..", "dist", p)).href;
const { createWorktree, getTaskMergedInfo } = await import(distUrl("git/worktrees.js"));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID_ARGS = ["-c", "user.email=wtlbf@loom", "-c", "user.name=wtlbf"];
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const gitId = (cwd, ...args) => execFileSync("git", [...GIT_ID_ARGS, ...args], { cwd, encoding: "utf8" }).trim();

function makeRepo() {
  const repo = mkdtempManaged("loom-wtlbf-repo-");
  fs.writeFileSync(path.join(repo, "README.md"), "# wtlbf\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "wtlbf@loom");
  git(repo, "config", "user.name", "wtlbf");
  commitAll(repo, "init", "-c user.email=wtlbf@loom -c user.name=wtlbf");
  return repo;
}

// Wraps REAL git (so present/gone resolution is proven against actual git behaviour, not a stub) while
// counting every `.raw()` call — the actual OS-level spawn point, per boundedGit's own doc.
function makeCountingGitFactory(repoPath) {
  const real = simpleGit(repoPath);
  let calls = 0;
  const wrapped = { raw: async (args) => { calls++; return real.raw(args); } };
  return { gitFactory: () => wrapped, callCount: () => calls, resetCallCount: () => { calls = 0; } };
}

function squashLandNoTrailer(repo, branch, subject) {
  git(repo, "merge", "--squash", "--no-edit", branch);
  gitId(repo, "commit", "-q", "-m", subject);
  return git(repo, "log", "-1", "--format=%H");
}

let seq = 0;
async function addWorkerBranch(repo, tag) {
  const n = `wtlbf-${tag}-${++seq}`;
  const taskId = `${n}-task`;
  const { worktreePath, branch } = await createWorktree(repo, "wtlbf-proj", taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const v${seq} = 1;\n`);
  commitAll(worktreePath, `feat(test): ${n} work`, "-c user.email=wtlbf@loom -c user.name=wtlbf");
  const tip = git(worktreePath, "rev-parse", "HEAD");
  return { taskId, branch, worktreePath, tip };
}

const repo = makeRepo();
const { gitFactory, callCount, resetCallCount } = makeCountingGitFactory(repo);

// A minimal in-memory WorkerTipLedgerFacts — exactly the three-method shape git/worktrees.ts declares
// (BoundedGitDeps.workerTipLedger). `ledgerRows` is this test's own stand-in for the real `mainline_landed_
// commits`/`batch_landed_worker_tips` DB tables; a row's presence here is what `hasAnyForBranch` reports.
const ledgerRows = new Map();
const workerTipLedger = {
  hasAnyForBranch: (branch) => ledgerRows.has(branch),
  lookupByWorkerTip: (branch, workerTip) => {
    const row = ledgerRows.get(branch);
    return row && row.kind === "tip" && row.workerTip === workerTip ? row.landedSha : null;
  },
  lookupLandedForBranch: (branch) => {
    const row = ledgerRows.get(branch);
    return row ? row.landedSha : null;
  },
};

const deps = { gitFactory, workerTipLedger };

try {
  // ===================================================================================================
  // (ZERO) a branch with no ledger row at all → ZERO git spawns, ever, once the map cache is warm.
  // ===================================================================================================
  const zero = await addWorkerBranch(repo, "zero");
  check("(ZERO) setup control: no ledger row recorded for this branch", !ledgerRows.has(zero.branch));

  await getTaskMergedInfo(repo, zero.taskId, deps); // warm the merged-commit-map cache for base "HEAD"
  resetCallCount();
  const resultZero = await getTaskMergedInfo(repo, zero.taskId, deps);
  check("(ZERO) a never-landed branch (no ledger row) resolves unresolved (null)", resultZero === null);
  check(
    "(ZERO) zero ledger rows ⇒ ZERO git spawns from getTaskMergedInfo (hasAnyForBranch short-circuits " +
      "before boundedGit/branch --list is ever reached, with the map cache already warm)",
    callCount() === 0,
  );

  // ===================================================================================================
  // (PRESENT) a branch WITH a ledger row that is STILL LIVE → resolves via the tip-keyed path.
  // ===================================================================================================
  const present = await addWorkerBranch(repo, "present");
  const landedShaPresent = squashLandNoTrailer(repo, present.branch, "feat(test): land present (no trailer)");
  ledgerRows.set(present.branch, { kind: "tip", workerTip: present.tip, landedSha: landedShaPresent });
  check(
    "(PRESENT) setup control: branch still present in git after the squash merge",
    git(repo, "branch", "--list", "--end-of-options", present.branch) !== "",
  );

  const resultPresent = await getTaskMergedInfo(repo, present.taskId, deps);
  check(
    "(PRESENT) present-branch tip-keyed ledger fallback still resolves the landed sha exactly as before the reorder",
    resultPresent !== null && resultPresent.sha === landedShaPresent.slice(0, 7),
  );
  check("(PRESENT) verification mode is \"ledger\"", resultPresent?.verification === "ledger");

  // ===================================================================================================
  // (GONE) a branch WITH a ledger row whose git ref is deleted → resolves via the branch-only path.
  // ===================================================================================================
  const gone = await addWorkerBranch(repo, "gone");
  const landedShaGone = squashLandNoTrailer(repo, gone.branch, "feat(test): land gone (no trailer)");
  // A branch checked out by a worktree can't be deleted until the worktree itself is gone first.
  git(repo, "worktree", "remove", "--force", gone.worktreePath);
  git(repo, "branch", "-D", gone.branch);
  ledgerRows.set(gone.branch, { kind: "branch", landedSha: landedShaGone });
  check(
    "(GONE) setup control: branch genuinely deleted from git",
    git(repo, "branch", "--list", "--end-of-options", gone.branch) === "",
  );

  const resultGone = await getTaskMergedInfo(repo, gone.taskId, deps);
  check(
    "(GONE) gone-branch ledger-only fallback still resolves the landed sha exactly as before the reorder",
    resultGone !== null && resultGone.sha === landedShaGone.slice(0, 7),
  );
  check("(GONE) verification mode is \"ledger\"", resultGone?.verification === "ledger");
} finally {
  console.log(failures === 0
    ? "\n✅ ALL PASS — a zero-ledger-rows branch costs no git spawn; a present-branch and a gone-branch " +
      "ledger hit both still resolve exactly as before the reorder."
    : `\n❌ ${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}
