import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { simpleGit } from "simple-git";
import { WORKTREES_DIR } from "../paths.js";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
}

/**
 * Filesystem- and ref-safe key for a task: 12 hex chars of sha256(taskId). Keyed off the FULL id,
 * not `taskId.slice(0,8)` — two human-readable task ids sharing the first 8 chars used to collide
 * onto the same branch/worktree (H1.3). Deterministic, so the SAME task always resolves to the same
 * worktree (re-spawn after a rejected merge, and recycle which carries the stored path forward).
 */
function taskKey(taskId: string): string {
  return createHash("sha256").update(taskId).digest("hex").slice(0, 12);
}

/**
 * Create (or re-attach) an isolated git worktree for a worker (phase-2 §A5): a checkout under
 * ~/.loom/worktrees on branch `loom/<key>` off the repo's current HEAD. Worktrees share the repo's
 * object store (cheap) and live outside the repo so parallel workers can't corrupt one tree.
 *
 * TOLERANT of a pre-existing branch/worktree (H1.2) — re-spawning a worker on a task whose merge
 * was rejected (worktree + branch intentionally retained) must NOT fatal with "already exists":
 *   - worktree dir present  → reuse it as-is (the retained checkout carries the worker's changes);
 *   - branch present, dir gone → attach a fresh worktree to the existing branch (no -b);
 *   - neither               → fresh worktree on a new branch (-b).
 */
export async function createWorktree(repoPath: string, projectId: string, taskId: string): Promise<WorktreeInfo> {
  const key = taskKey(taskId);
  const branch = `loom/${key}`;
  const worktreePath = path.join(WORKTREES_DIR, projectId, key);
  if (fs.existsSync(worktreePath)) return { worktreePath, branch }; // retained worktree → reuse

  const git = simpleGit(repoPath);
  fs.mkdirSync(path.join(WORKTREES_DIR, projectId), { recursive: true });
  await git.raw(["worktree", "prune"]); // drop any stale admin record for a since-deleted dir
  const branchExists = (await git.raw(["branch", "--list", branch])).trim() !== "";
  await git.raw(branchExists
    ? ["worktree", "add", worktreePath, branch]        // branch survived a worktree removal → re-attach
    : ["worktree", "add", worktreePath, "-b", branch]); // fresh task → new branch
  return { worktreePath, branch };
}

/**
 * Delete a worker's branch after a CLEAN merge (H1.1) — `git branch -d` (safe: refuses an unmerged
 * branch). Without this, re-spawning on the same task hit "a branch named 'loom/…' already exists".
 * Best-effort: the merge already succeeded, and createWorktree tolerates a leftover branch anyway, so
 * a delete hiccup is logged, not fatal. NOT called on a rejected merge or recycle (branch retained).
 */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  try {
    await simpleGit(repoPath).raw(["branch", "-d", branch]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[worktree] could not delete merged branch ${branch}: ${(e as Error).message}`);
  }
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
  await fs.promises.rm(worktreePath, { recursive: true, force: true, maxRetries: 40, retryDelay: 200 });
  await git.raw(["worktree", "prune"]); // reconcile the admin record with what's on disk
}

/**
 * Is `branch` already fully merged into `base` (default: the repo's current HEAD — the canonical
 * branch confirmWorkerMerge's `git merge` lands onto)? Used by the boot-time reconcile to finish a
 * merge whose bookkeeping (worktree/branch/task) never completed (e.g. the daemon died right after
 * the commit). Detected via `git branch --merged <base> --list <branch>` membership — exit-0 with a
 * non-empty line only when the branch both exists AND is fully reachable from `base`. (We deliberately
 * do NOT use `merge-base --is-ancestor`: simple-git's raw doesn't reject on its exit-1 "not-ancestor"
 * signal, so a try/catch around it reads every branch as merged.) Returns false when the branch ref
 * is gone (a completed merge deletes it), which keeps the reconcile idempotent.
 */
export async function isBranchMerged(repoPath: string, branch: string, base = "HEAD"): Promise<boolean> {
  try {
    return (await simpleGit(repoPath).raw(["branch", "--merged", base, "--list", branch])).trim() !== "";
  } catch {
    return false;
  }
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
