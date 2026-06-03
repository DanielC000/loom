import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { simpleGit, type SimpleGit } from "simple-git";
import { WORKTREES_DIR } from "../paths.js";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
}

/**
 * Per-git-op ceiling for the BOOT-RECONCILE git ops (removeWorktree / isBranchMerged / deleteBranch).
 * Generous for a real op (sub-second normally), but BOUNDED so a wedged child can't hang the caller.
 * This is the fix for the boot-outage: a git op on a busy/locked dir (e.g. a directory handle stuck by
 * an unrelated process) HANGS INDEFINITELY — it doesn't throw — and a try/catch only catches throws.
 * boot-reconcile runs these ops during daemon BOOT (Pass A: isBranchMerged → finalizeMerge's
 * removeWorktree + deleteBranch; Pass B: removeWorktree), so one hung op blocked the whole daemon from
 * booting, for hours, on 2026-06-03. Every op in the reconcile path is now bounded by this.
 */
const GIT_OP_TIMEOUT_MS = 15_000;

/**
 * Injectable seam for the bounded git ops. Lets a test simulate a hanging git child with a tiny budget
 * and assert the call returns/throws within the window (not never). `gitFactory` defaults to a simpleGit
 * whose `block` timeout KILLS a no-output (hung) child; `timeoutMs` bounds BOTH the simpleGit block
 * timeout and the {@link withTimeout} race below, so a never-settling git promise — a real child wedged,
 * or an injected fake that never resolves — still unblocks the function.
 */
export interface BoundedGitDeps {
  gitFactory?: (repoPath: string, blockTimeoutMs: number) => Pick<SimpleGit, "raw">;
  timeoutMs?: number;
}

/** Build the bounded git instance + resolve the timeout for one op, applying the seam's defaults. */
function boundedGit(repoPath: string, deps: BoundedGitDeps): { git: Pick<SimpleGit, "raw">; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const makeGit = deps.gitFactory ?? ((p, ms) => simpleGit(p, { timeout: { block: ms } }));
  return { git: makeGit(repoPath, timeoutMs), timeoutMs };
}

/**
 * Reject `p` after `ms` if it hasn't settled, so a git step is bounded even if the underlying promise
 * NEVER settles. In production the simpleGit `block` timeout (set on the instance) also kills the hung
 * child so it doesn't leak — this race is the belt-and-suspenders guarantee that the FUNCTION returns
 * within the window regardless. The timer is cleared on the winning path; if it fires first the timer
 * is already done, so nothing lingers on the event loop.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms (hung child?)`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
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
 *
 * BOUNDED: called by finalizeMerge during boot-reconcile Pass A, so a hung `git branch -d` (busy ref
 * lock) must not wedge boot. The op runs through the same block-timeout + {@link withTimeout} guard;
 * a timeout-throw is swallowed + warned exactly like any other delete failure.
 */
export async function deleteBranch(repoPath: string, branch: string, deps: BoundedGitDeps = {}): Promise<void> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    await withTimeout(git.raw(["branch", "-d", branch]), timeoutMs, "git branch -d");
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
 *
 * BOUNDED (priority reliability fix): a busy/locked worktree dir makes `git worktree remove` HANG
 * INDEFINITELY rather than throw, and boot-reconcile's Pass B calls this DURING daemon boot — so one
 * stuck removal blocked the whole daemon from booting for hours (2026-06-03). Both git ops now run on
 * a simpleGit configured with a `block` timeout (kills a no-output hung child) AND through a
 * {@link withTimeout} race, so the worst case is a BOUNDED failure within ~{@link GIT_OP_TIMEOUT_MS}
 * — the dir is left on disk for a later GC (boot-reconcile Pass B), NEVER an infinite hang. The
 * git instance/timeout is injectable via {@link BoundedGitDeps} so a test can prove the bound.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  deps: BoundedGitDeps = {},
): Promise<void> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    await withTimeout(git.raw(["worktree", "remove", worktreePath, "--force"]), timeoutMs, "git worktree remove");
  } catch {
    // A hang (timeout-kill), a busy handle, or git already de-registering the worktree without
    // deleting the dir — all fall through to the filesystem backstop.
  }
  await fs.promises.rm(worktreePath, { recursive: true, force: true, maxRetries: 40, retryDelay: 200 });
  try {
    await withTimeout(git.raw(["worktree", "prune"]), timeoutMs, "git worktree prune");
  } catch {
    // A hung/failed prune must NOT throw past removeWorktree (which would re-introduce the boot hang
    // via finalizeMerge / Pass B). A stale admin record is harmless — createWorktree prunes on reuse.
  }
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
 *
 * BOUNDED: this is the FIRST op boot-reconcile Pass A runs per session, so a hang here wedges boot
 * before any removal even starts. The op now runs through the block-timeout + {@link withTimeout}
 * guard; a timeout-throw is caught and read as "not merged" (false) — the SAFE default, since Pass A
 * then skips the session rather than acting on a bad signal. The next boot retries it.
 */
export async function isBranchMerged(repoPath: string, branch: string, base = "HEAD", deps: BoundedGitDeps = {}): Promise<boolean> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    return (await withTimeout(git.raw(["branch", "--merged", base, "--list", branch]), timeoutMs, "git branch --merged")).trim() !== "";
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

export interface WorkerDiff {
  filesChanged: number;
  insertions: number;
  deletions: number;
  patch: string;
  /** the diff includes UNCOMMITTED working-tree edits read from the live worktree (case 1). */
  uncommitted?: boolean;
  /** the branch was already merged + deleted; this is the landed diff reconstructed from the
   *  merge commit (case 3). */
  merged?: boolean;
}

/** Does `branch` still exist as a ref in `repoPath`? (A completed merge deletes it.) */
async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    return (await simpleGit(repoPath).raw(["branch", "--list", branch])).trim() !== "";
  } catch {
    return false;
  }
}

/**
 * The orchestration-view diff for a worker — "what has this worker changed?" — robust across the
 * worker's WHOLE lifecycle. {@link diffBranch} alone only sees COMMITTED branch refs in the canonical
 * repo, so it reads EMPTY for a live worker mid-task (its work is uncommitted, in the worktree) and
 * ERRORS for a merged+deleted branch (`HEAD...<gone>` → "ambiguous argument") — that was the
 * "/orchestration diffs are all empty" bug. This resolves it in three lifecycle stages:
 *
 *  1. WORKTREE present (live or retained) → diff IN the worktree from the branch's spawn point
 *     (merge-base with the canonical HEAD) to the WORKING TREE, so committed AND uncommitted
 *     in-progress edits both show — the live-supervision case the view exists for. (`uncommitted`.)
 *  2. branch ref present, worktree gone   → the committed 3-dot branch diff ({@link diffBranch}).
 *  3. branch merged + deleted             → reconstruct the landed diff from the `--no-ff` merge
 *     commit, whose 2nd parent IS the old branch tip: `<merge>^1...<merge>^2`. So a merged worker
 *     shows what it contributed instead of a 500. (`merged`.)
 *
 * Returns null only when there is genuinely nothing to show (no branch + no worktree, or a merged
 * branch whose merge commit can't be located) — the caller renders that as an honest "no diff".
 *
 * NOT bounded like the boot-reconcile ops: this runs on-demand per HTTP request, so a wedged git
 * child hangs only that one request, never daemon boot. Each stage is guarded so a failure falls
 * through to the next rather than throwing the whole call.
 */
export async function workerDiff(
  repoPath: string,
  opts: { branch: string | null; worktreePath: string | null },
): Promise<WorkerDiff | null> {
  const { branch, worktreePath } = opts;

  // 1. Live/retained worktree → include uncommitted work (diff from spawn point to the working tree).
  if (branch && worktreePath && fs.existsSync(worktreePath)) {
    try {
      const base = (await simpleGit(repoPath).raw(["merge-base", "HEAD", branch])).trim();
      const wt = simpleGit(worktreePath);
      const summary = await wt.diffSummary([base]); // <base> with one arg = base..WORKING-TREE
      const patch = await wt.diff([base]);
      return {
        filesChanged: summary.files.length, insertions: summary.insertions,
        deletions: summary.deletions, patch, uncommitted: true,
      };
    } catch { /* worktree gone/wedged mid-read → fall through to the committed-branch paths */ }
  }

  // 2. Branch still on the canonical repo (committed, not yet merged) → committed 3-dot diff.
  if (branch && await branchExists(repoPath, branch)) {
    try { return await diffBranch(repoPath, branch); } catch { /* fall through */ }
  }

  // 3. Branch merged + deleted → reconstruct the landed diff from the --no-ff merge commit.
  if (branch) {
    try {
      const git = simpleGit(repoPath);
      const merge = (await git.raw([
        "log", "--all", "--merges", "--max-count=1", "--format=%H", `--grep=Merge branch '${branch}'`,
      ])).trim();
      if (merge) {
        const range = `${merge}^1...${merge}^2`; // ^2 is the old branch tip; 3-dot = its changes
        const summary = await git.diffSummary([range]);
        const patch = await git.diff([range]);
        return {
          filesChanged: summary.files.length, insertions: summary.insertions,
          deletions: summary.deletions, patch, merged: true,
        };
      }
    } catch { /* merge commit unfindable → null below */ }
  }

  return null;
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
