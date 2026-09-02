import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// TOCTOU CLOSE (card 7efc2bff item 1) — mergeBranchLocked's own branch-stability check used to squash the
// branch NAME (`git merge --squash <branch>`), which git re-resolves at squash time — ~175 lines and
// several intervening git subprocess spawns AFTER the check that was supposed to have validated it. A
// still-alive worker (the worker's pty is not stopped until AFTER confirmWorkerMerge returns, per
// worktrees.ts's own preLanded doc) could land a genuinely NEW commit on `branch` in that exact window; the
// old code would then silently squash it too, even though it was never checked against
// `gateBaseBranchHead`/`requireCanonicalHead`. The fix: resolve the branch's tip to an exact sha ONCE,
// right after the canonical-index lock, and squash THAT SHA — never the moving ref.
//
// THE RED HALF this proves (card's own 📌 spec, built here rather than left unbuilt): a real git repo +
// worktree, `deps.gitFactory` hooking the EXACT `rev-parse --verify <branch>^{commit}` call
// mergeBranchLocked makes to resolve its squash target — real result returned to the caller (so the
// stability check still reports "stable", exactly matching gateBaseBranchHead), but a NEW commit is landed
// on the branch in the gap between that call returning and the eventual `git merge --squash` call.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-squash-target-toctou.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mstt-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { mergeBranch, createWorktree } = await import("../dist/git/worktrees.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mstt@loom -c user.name=mstt";

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const repo = path.join(os.tmpdir(), `loom-mstt-repo-${sfx}`);
registerForCleanup(repo);

fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# mstt\n");
execSync(`git init -q && git config user.email mstt@loom && git config user.name mstt && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

const { worktreePath, branch } = await createWorktree(repo, "mstt-proj", "mstt-task");
registerForCleanup(worktreePath);
fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work for the branch\n");
execSync(`git add . && git ${GIT_ID} commit -q -m "feature work"`, { cwd: worktreePath });

const mainSha = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
const branchShaBeforeMutation = execSync(`git rev-parse ${branch}`, { cwd: repo }).toString().trim();

// A gitFactory that delegates EVERY call to a real boundedSimpleGit instance, EXCEPT: the specific
// `rev-parse --verify <branch>^{commit}` call mergeBranchLocked makes to resolve its squash target. That
// one call still returns the REAL (pre-mutation) result to the caller — exactly what a genuinely stable
// branch would have returned — but AFTER getting that result, and BEFORE returning it, lands a brand-new
// commit on the branch. This is the exact race: the check (and, pre-fix, the eventual squash-by-name) see
// two DIFFERENT trees, one of which no stability check ever validated.
let mutated = false;
const NEW_FILE = "toctou-late-commit.txt";
function toctouGitFactory(repoPath, blockTimeoutMs) {
  const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
  return {
    raw: async (args) => {
      const result = await real.raw(args);
      if (!mutated && Array.isArray(args) && args[0] === "rev-parse" && args[1] === "--verify" && args[2] === `${branch}^{commit}`) {
        mutated = true;
        // Simulate a still-alive worker committing more work in the exact TOCTOU window.
        fs.writeFileSync(path.join(worktreePath, NEW_FILE), "landed after the stability check resolved\n");
        execSync(`git add . && git ${GIT_ID} commit -q -m "late commit during the TOCTOU window"`, { cwd: worktreePath });
      }
      return result;
    },
  };
}

check("precondition: gitFactory hook has not fired yet", mutated === false);
const result = await mergeBranch(
  repo, branch, "MSTT toctou", { gitFactory: toctouGitFactory }, mainSha, branchShaBeforeMutation,
);
check("precondition: the hook actually fired (the mutation is not vacuous)", mutated === true);
check("precondition: the branch really did gain a new commit after the resolved sha", execSync(`git rev-parse ${branch}`, { cwd: repo }).toString().trim() !== branchShaBeforeMutation);

check("mergeBranch still succeeds (a valid squash of the content the check actually validated)", result.ok === true);
const lateFileLanded = fs.existsSync(path.join(repo, NEW_FILE));
check(`THE FIX: the late-arriving commit's content does NOT land in canonical main (found ${NEW_FILE}: ${lateFileLanded}) — the squash targeted the FROZEN sha the check validated, not the branch name the worker kept moving`,
  lateFileLanded === false);
check("the content the check DID validate (feature.txt) landed normally", fs.existsSync(path.join(repo, "feature.txt")) === true);

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeBranchLocked squashes the sha its own stability check resolved, so a branch that gains a new commit in the window between that check and the eventual squash cannot have that new content silently land unverified."
  : `\n❌ ${failures} FAILURE(S).`);

try { await import("node:child_process").then(({ execSync: es }) => es(`git worktree remove --force "${worktreePath}"`, { cwd: repo })); } catch { /* best-effort */ }
cleanupPathSync(repo);
cleanupPathSync(worktreePath);
process.exit(failures === 0 ? 0 : 1);
