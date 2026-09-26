# e21cfd5f — worktree directory removal can never reach a project's repo checkout

Two distinct routes to deleting a repo checkout, guarded by two distinct mechanisms. Neither is a blanket "never".

## Route 1 — the removal TARGET is a repo (guarded by `worktreeRemovalRefusal`)

A session row's `worktreePath` (or the `cwd` Pass A falls back to) is not proof of a Loom-cut worktree. A plain, run or mis-set row could point at a project's primary checkout, and boot Pass A/B would then remove it. `worktreeHasWork` reads a clean, branchless checkout as "no work".

`worktreeRemovalRefusal` (`git/worktrees.ts`) refuses a target that is not strictly under the worktrees root, or that equals or contains a registered repo path (target and repo both compared resolved and by realpath). It is enforced in `removeWorktree` (against the `repoPath` it is handed), up front in `gcWorktreeDir` (against every registered repo of every project, archived included), and in `reclaimNodeModulesDir` (the `node_modules` path, so a `node_modules` that is itself a link into a repo is refused). A refusal logs and returns, never throws; `gcWorktreeDir` reports `path-refused`, boot Pass B counts it (`worktreesPathRefused`), and a wedge row for a refused path is parked `needsHuman` so the slow-retry sweep stops.

Measured 2026-09-26 on a read-only copy of the live DB (6762 sessions): 0 rows have `worktree_path` equal to or containing a registered repo path; 1021 have `cwd` equal to a repo path, all with `worktree_path` NULL and none a worker with a branch and task, so neither pass reaches them. Latent, not live.

## Route 2 — a link planted INSIDE a worktree (guarded by the removal ORDER, not by the predicate)

`git worktree remove -f -f` recurses through a junction inside the tree on Windows (git 2.47.0.windows.2): a worker can plant `node_modules` as a junction to the primary repo, gitignored so `git status` is clean, and the recursive delete empties the repo. The predicate cannot see this (the target is a normal worktree). `removeWorktree` therefore removes the directory FIRST with `killableRemoveDir` (`cmd rmdir /s /q` / `rm -rf`, neither follows a link), then unlocks and prunes git's admin record. It never calls `git worktree remove`.

POSIX: not tested here. Reasoning from git's `remove_dir_recurse` (`dir.c`), which `lstat`s each entry and unlinks a symlink instead of descending, is that `git worktree remove` does not follow a symlinked dir on POSIX; the removal order makes that moot.

## Do not

- Do not add a removal call site that skips `removeWorktree`/`gcWorktreeDir`/`reclaimNodeModulesDir`.
- Do not reintroduce `git worktree remove` (or any git recursive delete) before the killable directory removal: it follows a planted junction.
- Do not weaken the predicate to path equality: a parent of a repo is as fatal as the repo.
- Do not source the protected repo list from `listProjects()` (it excludes archived and reserved projects).
- Do not read this record as covering a link planted deeper than the directory removal handles, or a hard-linked/bind-mounted path: only the two routes above are verified.
