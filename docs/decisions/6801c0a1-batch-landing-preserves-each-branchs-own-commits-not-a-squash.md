# 6801c0a1 — A batched landing preserves each candidate branch's own commits individually — no squash, no merge commit

## Context

The original shape shipped for the batched merge path (commit `b577f43`) squash-merged each candidate
branch via `mergeBranch` (reused unchanged from the solo path), landing ONE commit per branch —
byte-shape-identical to a solo `worker_merge_confirm`. That was the wrong commit shape: the owner
explicitly asked (verbatim, twice, on this card) for a batched landing to preserve each branch's own
commits individually on main, squashing away only merge commits (there are none to begin with — this
file never creates one). The solo `worker_merge_confirm` path is unchanged and still squashes; only the
batched path (`git/batch-merge.ts`) changed.

Once a branch can contribute N commits instead of 1, "which commit carries `Loom-Worker-Branch`" is no
longer answered for free — `scanMergedCommitMap` (`git/worktrees.ts`) maps a branch to ONE commit via a
single-match `git log --grep` scan.

## Decision

`assembleBatchBranches` REBASES (cherry-picks) each candidate's own commit range
(`merge-base(batchTip, branch)..branch`) onto the batch tip, ONE COMMIT AT A TIME, in original order — a
branch contributing 3 commits lands 3 commits on main, not 1. No merge commits are ever created
(cherry-pick never does). This module deliberately does not reuse `mergeBranch` (`git merge --squash`)
for this path — that primitive is fundamentally the wrong shape (it collapses N commits to 1 by
construction) and stays reserved, untouched, for the solo path.

**Trailer placement** (the card's own "real open question"): the `Loom-Worker-Branch` trailer lands on
the branch's LAST (tip) commit only, written AFTER that commit is cherry-picked — a rebase rewrites SHAs,
so the trailer can only be attached to the commit's FINAL sha, never inherited from the original. This
preserves the existing one-branch-one-trailer invariant `scanMergedCommitMap`/`findLandedSquashCommit`
already depend on, with zero changes needed to either reader. The non-tip commits from a batched branch
carry no `Loom-Worker-Branch` trailer at all — exactly like any other ordinary, non-landing commit in the
repo. This is intentional, not a gap: a single trailer per branch is exactly what every existing reader
expects, and a branch's ship-state has always been found via ITS trailer commit, never "every commit this
branch happens to touch."

## Do not

- Do not reuse `mergeBranch` (`git merge --squash`) for the batched path — it collapses N commits to 1 by
  construction, the opposite of what this card asked for.
- Do not attach `Loom-Worker-Branch` to any commit but the branch's cherry-picked TIP, and never before the
  cherry-pick (the rebase rewrites SHAs).
- Do not expect `scanMergedCommitMap`/`findLandedSquashCommit` to need changes for multi-commit branches —
  the one-trailer-per-branch invariant is preserved by construction.

## Consequences

A batched landing's mainline history shows each worker's own commits verbatim, in order, instead of one
synthesized squash commit per branch — closer to what a reviewer sees on the worker's own branch, at the
cost of a multi-commit cherry-pick sequence needing its own atomicity handling (see
`landBranchCommitsIndividually`, same file) that a single squash got for free.

## Source

JSDoc comment (module header) in `packages/daemon/src/git/batch-merge.ts`, as of this worktree's HEAD
before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers
stripped, no wording changed.
