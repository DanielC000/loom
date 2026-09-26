# e21cfd5f — worktree directory removal can never reach a project's repo checkout

A session row's `worktreePath` (or the `cwd` Pass A falls back to) is not proof of a Loom-cut worktree. A plain, run or mis-set row could point at a project's primary checkout, and boot Pass A/B would then `git worktree remove -f -f` and `killableRemoveDir` it. Before this card no site checked: `gcWorktreeDir` and `removeWorktree` trusted the path.

Measured 2026-09-26 on a read-only copy of the live DB (6762 sessions): 0 rows have `worktree_path` equal to or containing a registered repo path, and 1021 rows have `cwd` equal to a repo path, all with `worktree_path` NULL and none a worker with a branch and task, so neither pass reaches them today. The 1237 rows outside `~/.loom-worktrees` are legacy `~/.loom/worktrees/` workers and none exists on disk. The hole is latent, not live.

## Decision

`worktreeRemovalRefusal` (`git/worktrees.ts`) is the single predicate. It is enforced in `removeWorktree` (the last chokepoint before any deletion, covering `gcWorktreeDir`, finalize, boot passes, the wedge sweep and the batch worktree) and in `gcWorktreeDir` (which passes every registered repo of the project and reports a distinct `path-refused` outcome). A refusal logs and returns; it never throws and never marks the path wedged.

## Do not

- Do not add a removal call site that skips `removeWorktree`/`gcWorktreeDir`.
- Do not weaken the predicate to path equality: a parent of a repo is as fatal as the repo.
- Do not compare only resolved paths: realpath is checked too so a junction into a repo is refused.
