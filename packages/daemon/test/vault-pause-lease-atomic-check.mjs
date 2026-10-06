// Card a09b81a0, round 4: commitVault() itself never checked the advisory pause lease (card 614dfbef)
// anywhere in its own body — only VaultVersioner.commit() (the debounce tick) checked it, and only BEFORE
// calling commitVault at all. Two real consequences, both closed here: (1) vault/writer.ts's three
// UI-write functions (writeVaultFile/createVaultFile/deleteVaultFile), which all call commitVault directly
// via commitAndReportOutcome, never checked the lease at all — a REST/MCP vault write while an agent held
// a sanctioned-git-surgery pause lease committed anyway. (2) even VaultVersioner.commit()'s own pre-check
// was a check-then-act gap: the lease could be raised in the window between that check returning "not
// paused" and the actual git add/commit running.
//
// The fix moves the authoritative check INSIDE runCommitSequence (the closure commitVault builds for its
// own add+commit work), immediately before "git add ." — the ONE place both of commitVault's two call
// shapes (merge-eligible/locked, and non-merge-eligible/unlocked) converge. See
// docs/decisions/a09b81a0-vault-commit-code-repo-guard.md's "Round 4: the pause-lease check's placement"
// section for the full design + why this placement (not the tick, not just-before-the-lock) is correct.
//
// Proves, with REAL git (no mocked git):
//   (1) commitVault() called DIRECTLY (the vault/writer.ts shape) while a pause lease is held backs off
//       with { committed:false, blockedReason:"paused" } — no new commit lands — even though a real,
//       uncommitted edit is sitting in the working tree.
//   (2) that edit is NOT lost: it still sits in the working tree, untouched, while paused.
//   (3) once the lease lifts (resumeVaultAutoCommit), a LATER commitVault call (simulating the next tick)
//       commits the previously-paused edit.
//   (4) the SAME check also fires for a MERGE-ELIGIBLE commitPath (one some registered project's own
//       repoPath canonically equals) — i.e. the authoritative check reaches the locked call shape too, not
//       just the unlocked one.
//   (5) negative control: via `pnpm --filter @loom/daemon negative-control`, reverting versioner.ts to
//       commit 5f09fcb5 (the commit immediately before this fix) reproduces the bug — test (1)/(2) go RED
//       (the unfixed code commits anyway, ignoring the held lease) — and restoring the fix returns them to
//       GREEN. See this file's own run instructions below for the exact command.
//
// Run after build: node test/vault-pause-lease-atomic-check.mjs
// Negative control (RED against pre-fix code, GREEN restored) — --ref names 5f09fcb5, the commit
// immediately BEFORE this fix landed (1ff7a790's parent), not a floating HEAD that drifts the moment a
// later commit lands on this branch:
//   pnpm --filter @loom/daemon negative-control \
//     --file packages/daemon/src/vault/versioner.ts \
//     --test packages/daemon/test/vault-pause-lease-atomic-check.mjs \
//     --ref 5f09fcb5
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitVault, setCodeRepoGuardProvider, pauseVaultAutoCommit, resumeVaultAutoCommit } from "../dist/vault/versioner.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = fs.realpathSync(mkdtempManaged("loom-vault-pause-atomic-"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "loom-pause-atomic-test@example.com");
  git(dir, "config", "user.name", "loom-pause-atomic-test");
}
const commitCount = (dir) => parseInt(git(dir, "rev-list", "--all", "--count").trim() || "0", 10);

// ===================== (1)-(3) the direct-caller gap: commitVault() itself must respect a held lease =====================
{
  const vault1 = path.join(root, "vault1");
  initRepo(vault1);
  fs.writeFileSync(path.join(vault1, "base.md"), "# base\n");
  git(vault1, "add", ".");
  git(vault1, "commit", "-m", "base");
  const before = commitCount(vault1);

  // Simulates an agent doing sanctioned git surgery (card 614dfbef) — the SAME advisory lease mergeBranch/
  // GitWriter use (not simulated via a real merge here; the point of this test is the direct-caller gap,
  // not the lock — test (4) below separately exercises the merge-eligible/locked shape).
  const token = pauseVaultAutoCommit(vault1, 60_000);

  fs.writeFileSync(path.join(vault1, "doc.md"), "# an edit made while paused\n");
  const resultPaused = await commitVault(vault1, "loom: write doc.md (via UI, while paused)");

  check("(1) commitVault() called directly backs off while a pause lease is held: committed:false", resultPaused.committed === false);
  check("(1) ...with the specific blockedReason:'paused', not swallowed as an ordinary backoff", resultPaused.blockedReason === "paused");
  check("(1) ...and NO new commit landed despite a real uncommitted edit sitting in the repo", commitCount(vault1) === before);
  check("(2) the paused edit is NOT lost — it still sits in the working tree", git(vault1, "status", "--porcelain").includes("doc.md"));

  resumeVaultAutoCommit(vault1, token);
  const resultResumed = await commitVault(vault1, "loom: auto-commit (next tick, after the lease lifted)");
  check("(3) once the lease lifts, a LATER commitVault call (simulating the next tick) commits the previously-paused edit", resultResumed.committed === true);
  check("(3) ...and the commit count actually advanced", commitCount(vault1) === before + 1);
  check("(3) ...the edit is no longer pending", !git(vault1, "status", "--porcelain").includes("doc.md"));
}

// ===================== (4) the SAME check also fires for a MERGE-ELIGIBLE (locked) commitPath =====================
{
  const vault4 = path.join(root, "vault4");
  initRepo(vault4);
  fs.writeFileSync(path.join(vault4, "base.md"), "# base\n");
  git(vault4, "add", ".");
  git(vault4, "commit", "-m", "base");
  const before4 = commitCount(vault4);

  // Register vault4's OWN repoPath === commitPath so isCommitPathMergeEligible(vault4) is true — this
  // exercises runCommitSequence's LOCKED call shape (withCanonicalIndexLock), not the unlocked one test
  // (1)-(3) exercised.
  const project4 = { id: "p-pause-4", repoPath: vault4, vaultPath: vault4, vaultOnly: true, repos: [] };
  setCodeRepoGuardProvider({
    snapshot: () => [{ id: project4.id, repoPath: project4.repoPath, repos: project4.repos, vaultOnly: project4.vaultOnly, vaultPath: project4.vaultPath }],
    recordEvent: () => {},
  });

  const token4 = pauseVaultAutoCommit(vault4, 60_000);
  fs.writeFileSync(path.join(vault4, "doc4.md"), "# an edit on a merge-eligible repo, made while paused\n");
  const result4 = await commitVault(vault4, "loom: auto-commit (merge-eligible, while paused)");

  check("(4) the pause check ALSO fires for a merge-eligible (lock-covered) commitPath: committed:false", result4.committed === false);
  check("(4) ...with blockedReason:'paused'", result4.blockedReason === "paused");
  check("(4) ...and no new commit landed on the merge-eligible repo either", commitCount(vault4) === before4);

  resumeVaultAutoCommit(vault4, token4);
  const result4b = await commitVault(vault4, "loom: auto-commit (merge-eligible, after resume)");
  check("(4) ...and it commits normally once resumed", result4b.committed === true && commitCount(vault4) === before4 + 1);

  setCodeRepoGuardProvider(undefined); // leave no provider registered for any later test in the SAME process
}

console.log(failures === 0
  ? "\nALL PASS — commitVault() itself respects a held pause lease, for both the unlocked and the merge-eligible (locked) call shape, and the paused edit is never lost."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
