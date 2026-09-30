import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE QUARANTINE — LOCK-LEVEL CONVERGENCE (round 6, card 24c0bdba, Code Review BLOCKER 1).
//
// THE BUG: round 4's quarantine mechanism was checked at `mergeBranchLocked`'s own entry and at a handful
// of op-entry points (confirmWorkerMerge, merge_batch, createWorktree, deleteBranch/deleteBranches,
// finalizeMerge/gcWorktreeDir) — but NOT at `GitWriter.checkout`/`createBranch`/`commit` (git/writer.ts),
// which write the SAME canonical repo index `mergeBranchLocked` squash-merges against and are reachable
// from the operator MCP git_* tools (mcp/operator.ts) and the Platform Lead tools (mcp/platform.ts).
// Reproduced (round 6 review): a `commit` and a `createBranch` both SUCCEEDED against a quarantined repo.
//
// THE FIX: the quarantine check moved to the TRUE convergence point, `withCanonicalIndexLock`
// (git/repo-lock.ts) — checked AFTER acquiring the lock, throwing `RepoQuarantinedError`. Every canonical-
// index writer already routes through that lock (GitWriter's three methods, `mergeBranch`, `createWorktree`'s
// fresh-cut path, `fastForwardCanonicalMain`'s ff-only — round 6 also moved that one under the lock).
//
// This file proves the FIX directly: quarantine a real repo, then call each writer and assert it refuses
// AND that nothing it would otherwise have done actually happened (no checkout, no branch, no commit).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-lock-convergence.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqlc-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { GitWriter } = await import(pathToFileURL(path.join(distGitDir, "writer.js")).href);
const { mergeBranch, createWorktree } = await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);
const { fastForwardCanonicalMain } = await import(pathToFileURL(path.join(distGitDir, "batch-merge.js")).href);
const { enterMergeQuarantine, clearMergeQuarantine, activeMergeQuarantineFor } =
  await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqlc@loom -c user.name=mqlc";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqlc-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# merge-quarantine-lock-convergence\n");
  execSync(`git init -q && git config user.email mqlc@loom && git config user.name mqlc`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  execSync(`git branch other-branch`, { cwd: repo });
  return repo;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // GitWriter.checkout — must refuse, and must NOT actually switch branches
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("checkout");
    const startBranch = git(repo, "rev-parse --abbrev-ref HEAD");
    enterMergeQuarantine(repo, "n/a", "manufactured for GitWriter.checkout test");
    check("(checkout) precondition: repo reads as quarantined", !!activeMergeQuarantineFor(repo));

    const writer = new GitWriter(repo);
    const res = await writer.checkout("other-branch");
    check("(checkout) BLOCKER-1 BUG WOULD HAVE SUCCEEDED HERE — now refuses", res.ok === false);
    check("(checkout) refusal names the quarantine (not some unrelated git error)", /QUARANTINED/i.test(res.error ?? ""));
    check("(checkout) HEAD did NOT actually move — the checkout never happened", git(repo, "rev-parse --abbrev-ref HEAD") === startBranch);

    clearMergeQuarantine(repo);
    check("(checkout) control: once cleared, the SAME checkout succeeds", (await writer.checkout("other-branch")).ok === true);
    check("(checkout) control: HEAD actually moved this time", git(repo, "rev-parse --abbrev-ref HEAD") === "other-branch");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // GitWriter.createBranch — must refuse, and must NOT actually create the branch
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("createbranch");
    enterMergeQuarantine(repo, "n/a", "manufactured for GitWriter.createBranch test");
    check("(createBranch) precondition: repo reads as quarantined", !!activeMergeQuarantineFor(repo));

    const writer = new GitWriter(repo);
    const res = await writer.createBranch("stray-branch-under-quarantine");
    check("(createBranch) BLOCKER-1 BUG WOULD HAVE SUCCEEDED HERE — now refuses", res.ok === false);
    check("(createBranch) refusal names the quarantine", /QUARANTINED/i.test(res.error ?? ""));
    check(
      "(createBranch) the branch was NEVER actually created",
      !git(repo, "branch --list stray-branch-under-quarantine"),
    );

    clearMergeQuarantine(repo);
    const res2 = await writer.createBranch("stray-branch-under-quarantine");
    check("(createBranch) control: once cleared, the SAME call succeeds", res2.ok === true);
    check("(createBranch) control: the branch now genuinely exists", !!git(repo, "branch --list stray-branch-under-quarantine"));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // GitWriter.commit — must refuse, and must NOT actually land a commit
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("commit");
    fs.writeFileSync(path.join(repo, "edit.txt"), "real edit\n");
    const headBefore = git(repo, "rev-parse HEAD");
    enterMergeQuarantine(repo, "n/a", "manufactured for GitWriter.commit test");
    check("(commit) precondition: repo reads as quarantined", !!activeMergeQuarantineFor(repo));

    const writer = new GitWriter(repo);
    const res = await writer.commit("a commit that must not land while quarantined");
    check("(commit) BLOCKER-1 BUG WOULD HAVE SUCCEEDED HERE — now refuses", res.ok === false);
    check("(commit) refusal names the quarantine", /QUARANTINED/i.test(res.error ?? ""));
    check("(commit) HEAD did NOT move — no commit landed", git(repo, "rev-parse HEAD") === headBefore);
    check("(commit) the edit is still merely staged/untracked, never committed", git(repo, "status --porcelain") !== "");

    clearMergeQuarantine(repo);
    const res2 = await writer.commit("a commit that must not land while quarantined");
    check("(commit) control: once cleared, the SAME commit lands", res2.ok === true);
    check("(commit) control: HEAD actually moved", git(repo, "rev-parse HEAD") !== headBefore);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // mergeBranch — the lock-level check now covers this too (mergeBranchLocked's own copy was DELETED as
  // dead code, round 6) — re-verify it still refuses, at the NEW convergence point.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("mergebranch");
    execSync(`git worktree add -q -b loom/mqlc-branch other-wt-${sfx} other-branch`, { cwd: repo });
    const wt = path.join(repo, `other-wt-${sfx}`);
    fs.writeFileSync(path.join(wt, "wt-file.txt"), "branch content\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "branch work"`, { cwd: wt });
    const headBefore = git(repo, "rev-parse HEAD");

    enterMergeQuarantine(repo, "loom/mqlc-branch", "manufactured for mergeBranch test");
    check("(mergeBranch) precondition: repo reads as quarantined", !!activeMergeQuarantineFor(repo));
    const res = await mergeBranch(repo, "loom/mqlc-branch", "Quarantine Test Card");
    check("(mergeBranch) refuses via the lock-level check (mergeBranchLocked's own copy is now dead code)", res.ok === false);
    check("(mergeBranch) refusal names the quarantine", /QUARANTINED/i.test(res.reason ?? ""));
    check("(mergeBranch) canonical HEAD did NOT move", git(repo, "rev-parse HEAD") === headBefore);

    clearMergeQuarantine(repo);
    const res2 = await mergeBranch(repo, "loom/mqlc-branch", "Quarantine Test Card");
    check("(mergeBranch) control: once cleared, the SAME merge lands", res2.ok === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // fastForwardCanonicalMain — round 6 wrapped its ff-only under withCanonicalIndexLock; re-verify its
  // OWN (now lock-derived) refusal still fires when called directly.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("ff");
    const baseSha = git(repo, "rev-parse HEAD");
    fs.writeFileSync(path.join(repo, "ff-file.txt"), "ff content\n");
    commitAll(repo, "feat(test): ff target", GIT_ID);
    const targetSha = git(repo, "rev-parse HEAD");
    execSync(`git reset --hard ${baseSha}`, { cwd: repo }); // canonical HEAD back at base; targetSha only reachable via its own ref

    enterMergeQuarantine(repo, "n/a", "manufactured for fastForwardCanonicalMain test");
    const res = await fastForwardCanonicalMain(repo, baseSha, targetSha);
    check("(ff) refuses with the TYPED quarantined flag", res.ok === false && res.quarantined === true);
    check("(ff) canonical HEAD did NOT advance", git(repo, "rev-parse HEAD") === baseSha);

    clearMergeQuarantine(repo);
    const res2 = await fastForwardCanonicalMain(repo, baseSha, targetSha);
    check("(ff) control: once cleared, the SAME ff succeeds", res2.ok === true);
    check("(ff) control: canonical HEAD advanced to the target", git(repo, "rev-parse HEAD") === targetSha);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // createWorktree's fresh-cut path — its OWN top-level check (round 6: kept, still needed for the reuse
  // path) plus the lock-level check both refuse; verify no worktree/branch is left behind.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("createworktree");
    enterMergeQuarantine(repo, "n/a", "manufactured for createWorktree test");
    let threw = null;
    try {
      await createWorktree(repo, `mqlc-proj-${sfx}`, `mqlc-task-${sfx}`);
    } catch (e) {
      threw = e;
    }
    check("(createWorktree) throws (its documented throw-or-succeed contract) rather than silently proceeding", threw !== null);
    check("(createWorktree) the throw names the quarantine", /QUARANTINED/i.test(threw?.message ?? ""));
    check("(createWorktree) no stray branch was cut", !git(repo, `branch --list loom/mqlc-task-${sfx}`));

    clearMergeQuarantine(repo);
    const info = await createWorktree(repo, `mqlc-proj-${sfx}`, `mqlc-task-${sfx}`);
    check("(createWorktree) control: once cleared, the SAME call succeeds", !!info.worktreePath);
    tmpDirs.push(info.worktreePath);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GitWriter.checkout/createBranch/commit, mergeBranch, fastForwardCanonicalMain, and " +
    "createWorktree ALL now refuse against a quarantined canonical repo (BLOCKER 1 closed: the check lives " +
    "at the one true convergence point, withCanonicalIndexLock, so no canonical-index writer can bypass it)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
