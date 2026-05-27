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
 *
 * Windows handle-release race: when a worker is hard-stopped just before its worktree is removed
 * (the merge path — confirmWorkerMerge), node-pty's exit event fires when the process SIGNALS
 * exit, but the OS releases the worktree's directory handle a beat later. `git worktree remove`
 * then fails ("failed to delete '…': Permission denied") and is NOT idempotent — it can drop the
 * worktree's admin record while leaving the dir on disk, so retrying the same command fails with
 * "is not a working tree". So: attempt the clean git removal once (best-effort), then back it up
 * with a filesystem delete that retries the EBUSY/EPERM lag (fs.rm maxRetries — built for exactly
 * this), then prune any stale admin record. When nothing holds the dir (merge-gate's no-pty rows)
 * the git removal succeeds and the backstop is a no-op.
 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const git = simpleGit(repoPath);
  try {
    await git.raw(["worktree", "remove", worktreePath, "--force"]);
  } catch {
    // fall through to the filesystem backstop (the dir handle hasn't released, or git already
    // de-registered the worktree but couldn't delete the dir).
  }
  await fs.promises.rm(worktreePath, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  await git.raw(["worktree", "prune"]); // reconcile the admin record with what's on disk
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
 * commit; --no-edit so it never opens an editor and hangs). FAIL-CLOSED.
 *
 * NOTE: simple-git's `raw(["merge", …])` does NOT reliably reject on a merge conflict — it can
 * resolve while leaving the repo MID-MERGE (verified: `git merge` exits non-zero on conflict but
 * raw still resolves, leaving `UU` unmerged entries + MERGE_HEAD). So we do NOT trust raw's
 * resolve/reject; we detect a conflict EXPLICITLY via unmerged index entries and `git merge
 * --abort` on anything but a clean win, leaving the canonical repo untouched.
 */
export async function mergeBranch(repoPath: string, branch: string): Promise<{ ok: boolean; conflict?: boolean }> {
  const git = simpleGit(repoPath);
  let rawError = false;
  try {
    await git.raw(["merge", "--no-ff", "--no-edit", branch]);
  } catch {
    rawError = true; // a conflict OR a real failure — either way, the explicit check below decides
  }
  const conflicted = (await git.raw(["ls-files", "--unmerged"])).trim() !== "";
  if (conflicted || rawError) {
    try { await git.raw(["merge", "--abort"]); } catch { /* nothing in progress to abort */ }
    return { ok: false, conflict: true };
  }
  return { ok: true };
}
