# 6796c9ea — a merge finalize keeps a worktree that holds uncommitted work (or whose status it cannot read)

42daa283 / cc9bce38 protect COMMITTED work that lands on a branch after a merge fixed its tip. UNCOMMITTED work was still destroyed: `finalizeMerge` force-removed the worktree under a "landed" result, so an untracked file or a tracked-file edit a worker made in its worktree while the batch gate ran (or between a solo confirm's review and its finalize) was silently lost.

## Where it lives: the one shared removal path

`finalizeMerge` is the single finalize for the solo `worker_merge_confirm`, `merge_batch` (via `finishAlreadyMerged`) and every ALREADY_MERGED / boot Pass A finish, and it removes the worktree only through `gcWorktreeDir`. The check is therefore ONE predicate at ONE site, not a copy per path: `finalizeMerge` passes `retainIfUncommitted: true` to `gcWorktreeDir`, which calls `readWorktreeUncommittedState` (`git/worktrees.ts`) AFTER the process reap and immediately before `removeWorktree`, so a process still rooted in the worktree cannot write a file between the check and the removal. The solo path had the same hole and is fixed by the same call; nothing solo-specific was added.

## Behaviour

- Dirty = tracked modifications OR untracked non-ignored files, with daemon-injected `.claude/` noise filtered by the same `filteredWorkEntries` the done pre-check uses, plus UNTRACKED `node_modules/` (the worktree's own provisioned dependency install; a repo whose .gitignore lacks it would otherwise retain every worktree). A tracked change under `node_modules` still counts.
- The worktree and the branch ref are KEPT. The merge itself stands: the task still moves to its landing lane and `merge_done` is filed (this mirrors the nested-repo guard; it is not the tip-moved retain, where nothing is finalized).
- Reported per candidate: the batch's landed row carries `worktreeRetainedDirty: {files, truncated, unverified}`; a solo confirm / ALREADY_MERGED finish folds `dirtyWorktreeRetainedWarning` into its `warning`.
- FAILS CLOSED: a git error/timeout reading status of a worktree that still has its `.git` link is `unverified:true` and retains (this includes a `.git` that points at a pruned gitdir: git cannot read it, so it may still hold work). A directory that no longer exists, or that has NO `.git` link (the Windows busy-handle leftover: `git worktree remove` dropped the registration but the dir survived), reads clean: git holds nothing there, and the re-finalize paths (stale-confirm retry, ALREADY_MERGED / Pass A replays) exist to retry exactly that removal. The no-`.git` rule is `worktreeHasGitLink`, the same single stat boot Pass B's dead-leftover GC uses (Pass B likewise leaves the pruned-gitdir variant alone).
- `forceRemoveWorktree:true` (the manager's explicit "disposable" override on `worker_merge_confirm`) skips the check, same semantics as the nested-repo guard.
- Only `finalizeMerge` sets the flag. Boot Pass B and the wedge sweep call `gcWorktreeDir` without it: they act on worktrees already judged discardable (Pass B ran `worktreeHasWork`) or already mid-removal, where an unreadable status would otherwise retain a half-removed dir forever.

## Do not

- Do not add a second dirty check at a call site (batch loop, solo confirm, boot reconcile): the predicate is `readWorktreeUncommittedState`, called from `gcWorktreeDir` under `retainIfUncommitted`.
- Do not remove on `unknown`. A status error is neither "clean" nor "dirty"; the worktree is kept.
- Do not file `batch_merge_branch_retained` / `merge_branch_retained` for this: `isBranchHeld` reads those events and would hold a branch whose tip never moved, so nothing would ever release it.
- Do not run the branch ref delete while the worktree was retained: `finalizeMerge` skips it (the branch is still checked out in that worktree).
- Do not set `retainIfUncommitted` from the wedge sweep or boot Pass B.
- Do not read the dirty state BEFORE the reap, and do not treat a no-`.git` leftover as `unknown` (it would never be removed, breaking the leftover re-finalize paths).
- Do not tell a manager to remove a retained worktree by hand: that leaks the `loom/*` ref forever (boot's ref sweep only reclaims `--merged` refs, which squashes and cherry-picks never are). The only cleanup path is re-confirming with `forceRemoveWorktree:true` after moving the work out.

## Coverage and limits

`batch-merge-dirty-worktree-retained.mjs`: a real `mergeBatchTracked` whose gate writes into candidate worktrees (untracked file, tracked edit, and a broken `.git` link for the unreadable-status case), with a clean control that is still removed; plus `finalizeMerge` directly (retain, `forceRemoveWorktree` override, `.claude/` noise control, missing-dir control). Shown RED by mutating the built output: fail-open on `unknown`, and `retainIfUncommitted:false`.

Not covered: a real `worker_merge_confirm` end to end (it reaches the same `finalizeMerge` call, covered directly); a status TIMEOUT specifically (the error path is exercised with a git error, and both land in the same `catch`); the retained worktree is not auto-cleaned later, a manager removes it (or re-confirms with `forceRemoveWorktree`).
