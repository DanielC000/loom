# 7efc2bff — Squash the branch's frozen sha, never the branch NAME — a TOCTOU closed

## Narrative

`mergeBranchLocked` resolves the branch tip to an exact sha, unconditionally, and squashes THAT SHA below — never the branch NAME. `git merge --squash <branch>` re-resolves the ref at squash time, ~175 lines and several intervening git subprocess spawns after the gate-base re-verification (see [[eda70da6-gate-base-re-verification-and-the-toctou-closed-squash-target]]); the worker's own pty can still be alive on the preLanded path and land a new commit on `branch` in that gap, which a name-based squash would then silently include even though it was never checked against `gateBaseBranchHead`/`requireCanonicalHead`. Squashing the frozen sha instead means a branch that moves in that window simply doesn't contribute its new commit to THIS squash — the object squashed is provably the same object this function validates just above. A failed resolve (a git error/timeout) falls back to squashing by branch name, matching this function's behavior before this fix.

## Do not

- Do not squash by branch NAME — `git merge --squash <name>` re-resolves the ref at squash time, which can silently pick up a commit that landed after the gate-base check but before the squash actually runs.
- Do not treat a failed sha resolve as a hard failure — fall back to squashing by branch name, the pre-fix behavior, rather than refusing the merge outright.

## Consequences

A worker that keeps committing after its gate-base check (its pty not yet stopped) can never have that late commit silently squashed in unchecked — the squash target is frozen the moment it's resolved.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `mergeBranchLocked`'s squash-target resolution block, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed.
