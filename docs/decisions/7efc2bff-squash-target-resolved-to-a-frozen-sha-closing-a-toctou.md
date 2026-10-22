# 7efc2bff — Squash the branch's frozen sha, never the branch NAME — a TOCTOU closed

## Narrative

`mergeBranchLocked` resolves the branch tip to an exact sha, unconditionally, and squashes THAT SHA below — never the branch NAME. `git merge --squash <branch>` re-resolves the ref at squash time, ~175 lines and several intervening git subprocess spawns after the gate-base re-verification (see [[eda70da6-gate-base-re-verification-and-the-toctou-closed-squash-target]]); the worker's own pty can still be alive on the preLanded path and land a new commit on `branch` in that gap, which a name-based squash would then silently include even though it was never checked against `gateBaseBranchHead`/`requireCanonicalHead`. Squashing the frozen sha instead means a branch that moves in that window simply doesn't contribute its new commit to THIS squash — the object squashed is provably the same object this function validates just above.

**Superseded by card `56c10535` (Code Review `9483d176`, item 4):** a failed resolve used to fall back to squashing by branch NAME — but that fallback is itself the exact bare-revision hazard `56c10535` closes (a same-named tag, or — once the resolve became the exact `for-each-ref` lookup — a DWIM-reachable decoy when the branch is genuinely missing, could still land under the card's subject/trailer via the fallback alone, even with the primary resolve fixed). A failed resolve now REFUSES instead (zero side effects — nothing has mutated yet at that point in the function): there is no trustworthy squash target once the exact resolve has failed, so there is nothing safe left to fall back to.

## Do not

- Do not squash by branch NAME — `git merge --squash <name>` re-resolves the ref at squash time, which can silently pick up a commit that landed after the gate-base check but before the squash actually runs.
- Do not reintroduce a branch-name fallback for a failed resolve (the pre-`56c10535` behavior) — refuse instead; see the superseding note above.

## Consequences

A worker that keeps committing after its gate-base check (its pty not yet stopped) can never have that late commit silently squashed in unchecked — the squash target is frozen the moment it's resolved.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `mergeBranchLocked`'s squash-target resolution block, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed.
