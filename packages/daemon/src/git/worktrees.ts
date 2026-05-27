import fs from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { WORKTREES_DIR } from "../paths.js";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
}

/** Short, filesystem- and ref-safe slug for a task (worktrees/branches key off this). */
function shortId(taskId: string): string {
  return taskId.slice(0, 8);
}

/**
 * Create an isolated git worktree for a worker (phase-2 §A5): a fresh checkout under
 * ~/.loom/worktrees on a NEW branch `loom/<taskId8>` off the repo's current HEAD. Worktrees
 * share the repo's object store (cheap) and live outside the repo so parallel workers can't
 * corrupt one working tree. Git errors (branch/worktree already exists) are SURFACED, not
 * swallowed — reuse is the caller's concern (#13/#15); #12 always creates fresh.
 */
export async function createWorktree(repoPath: string, projectId: string, taskId: string): Promise<WorktreeInfo> {
  const short = shortId(taskId);
  const branch = `loom/${short}`;
  const worktreePath = path.join(WORKTREES_DIR, projectId, short);
  // Ensure only the PARENT exists — `git worktree add` creates the leaf dir itself and errors
  // if it already exists (which we want to surface).
  fs.mkdirSync(path.join(WORKTREES_DIR, projectId), { recursive: true });
  await simpleGit(repoPath).raw(["worktree", "add", worktreePath, "-b", branch]);
  return { worktreePath, branch };
}

/**
 * Remove a worker's worktree and prune the admin record. Branch deletion (after merge) is
 * #16's concern, not here.
 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const git = simpleGit(repoPath);
  await git.raw(["worktree", "remove", worktreePath, "--force"]);
  await git.raw(["worktree", "prune"]);
}

/** A branch's changes since it diverged from base — the manager's pre-merge diff review (#16). */
export async function diffBranch(
  repoPath: string, branch: string, base = "HEAD",
): Promise<{ filesChanged: number; insertions: number; deletions: number; patch: string }> {
  const git = simpleGit(repoPath);
  const range = `${base}...${branch}`; // 3-dot: changes on `branch` since the merge-base with `base`
  const summary = await git.diffSummary([range]);
  const patch = await git.diff([range]);
  return { filesChanged: summary.files.length, insertions: summary.insertions, deletions: summary.deletions, patch };
}

/**
 * Merge a worker's branch back into the repo's current branch with `--no-ff` (always a merge
 * commit; --no-edit so it never opens an editor and hangs). On ANY merge failure (conflict),
 * `git merge --abort` to leave the canonical repo UNTOUCHED — fail-closed.
 */
export async function mergeBranch(repoPath: string, branch: string): Promise<{ ok: boolean; conflict?: boolean }> {
  const git = simpleGit(repoPath);
  try {
    await git.raw(["merge", "--no-ff", "--no-edit", branch]);
    return { ok: true };
  } catch {
    try { await git.raw(["merge", "--abort"]); } catch { /* nothing in progress to abort */ }
    return { ok: false, conflict: true };
  }
}
