# c6a6f405 — `removeWorktree` deliberately does not take the canonical index lock

## Narrative

`removeWorktree` is UNLOCKED BY DESIGN, not an oversight (board card `c6a6f405` item 2 — filed as a reviewer QUESTION, not a data-loss finding, and left that way). `git worktree remove -f -f` plus the trailing `prune` mutate the SAME shared `.git/worktrees/` admin state that `createWorktree` takes `withCanonicalIndexLock` for (card `2fcd5eae`'s "prune → branch --list → add is a multi-step read-modify-write" rationale) — but `removeWorktree` does NOT take that lock, and runs concurrently with spawns (`finalizeMerge`, boot-reconcile Pass B, the wedge sweep). This is judged safe today because git's own `locked`/`initializing` admin marker makes a concurrent `prune` SKIP an in-flight `add` BY DESIGN — the realistic overlap this function can actually race against.

The lock is NOT RE-ENTRANT: `removeWorktree`'s one caller (`SessionService`'s worktree-GC path) never holds it, and `finalizeMerge` only calls `removeWorktree` AFTER `mergeBranch` has fully released the lock — but a FUTURE caller invoking `removeWorktree` from inside an already-held `withCanonicalIndexLock` block would DEADLOCK.

## `workerDiff` — the three-lifecycle-stage orchestration view, and its own bound

`workerDiff` is the orchestration-view diff for a worker — "what has this worker changed?" — robust across the worker's WHOLE lifecycle. `diffBranch` alone only sees COMMITTED branch refs, so it reads EMPTY for a live worker mid-task (uncommitted, in the worktree) and ERRORS for a merged+deleted branch — the "/orchestration diffs are all empty" bug. Resolved in three stages: (1) WORKTREE present → diff IN the worktree from the branch's spawn point to the WORKING TREE, so committed AND uncommitted edits both show; (2) branch ref present, worktree gone → the committed 3-dot branch diff (`diffBranch`); (3) branch merged + deleted → reconstruct the landed diff from the SQUASH commit located by the `Loom-Worker-Branch:` trailer (`findLandedSquashCommit`), diffed against its single parent. Returns `null` only when there is genuinely nothing to show.

BOUNDED: every git call goes through the same `boundedDiffGit` + `withTimeout` convention `diffBranch` already uses — a busy/locked repo fails within the normal `GIT_OP_TIMEOUT_MS` bound instead of hanging indefinitely. Runs on-demand per HTTP request (never at boot); each stage is guarded so a failure falls through to the next rather than throwing the whole call.

## Do not

- Do not wrap `removeWorktree` in `withCanonicalIndexLock` reflexively "to be safe" — the lock is not re-entrant, and a caller that already holds it would deadlock.
- Before adding any new caller of `removeWorktree`, confirm it does not already hold `withCanonicalIndexLock`, or give `removeWorktree` (and its callers) an actual re-entrancy story first.
- Do not let any `workerDiff` git call skip the bounded convention — an unbounded call reintroduces the hang risk the rest of this file already closes.

## Consequences

`workerDiff` shows a meaningful diff across a worker's entire lifecycle instead of an empty result or a 500, and every one of its git calls fails within a bounded window rather than hanging.

## Source

Inline comments in `packages/daemon/src/git/worktrees.ts`: `removeWorktree`'s own doc comment (the "UNLOCKED BY DESIGN" / re-entrancy paragraphs, relocated by card `5b001dde`) and `workerDiff`'s own doc comment, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed. The re-entrancy warning stays inline at the source too, compressed, as a class-A guard.
