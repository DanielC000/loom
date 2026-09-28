# 13fc5227 — a held (retained) branch is reviewed and landed as the COMMITS it still owes main, not by its fork-point range and not by a chosen merge base

Follows `42daa283` (the hold). A `merge_batch` cherry-picks a candidate up to `assembledTip`; commits added afterwards, in `assembledTip..liveTip`, are what the branch still owes main. A solo retain (card `cc9bce38`) has the same shape with `landedTip` in place of `assembledTip`.

Before this card the manual path (`worker_merge` → `worker_merge_confirm`) worked against the branch's ORIGINAL fork point. Its diff mixed already-landed changes with the late commit and showed a late REVERT as nothing, and the squash (fork point → tip, against a main that already carries the cherry-picked commits) netted a late self-revert to an empty squash. Measured on `a7498224`: `worker_merge_confirm` was refused with cherry-pick guidance (the manager had to land the revert by hand), never landed.

## History of the design (why merge bases were abandoned)

Two intermediate designs used a merge base (`git merge-tree --merge-base=<assembledTip>`): the first resurrected a change main had made and reverted once the branch already held a union of main; its fix (apply the base only while the branch had absorbed no newer main) wrongly dropped the late revert when the worker had merged an OLDER main commit or current main into the branch. Each round found a history that defeats a base rule, so no base is chosen any more.

## Mechanism

- ONE resolver, `SessionService.resolveOwedRange(branch, repoPath)`, built on `isBranchHeld` and the shared `heldRecordedTip`: `none` (not held) | `range {base, tip}` | `refuse {reason}`. `worker_merge`, `worker_merge_confirm` and the reviewed-tip walk all call it.
- ONE computation of the owed work, `computeOwedLanding` (worktrees.ts): the NON-MERGE commits of `base..tip` that `main` does not reach (`git rev-list --reverse --topo-order --no-merges base..tip --not main`; `--topo-order` because the default order follows committer dates and a skewed clock can apply a child before its parent), each cherry-picked in order onto main with git's own three-way (`merge-tree --write-tree --merge-base=<c>^ <cur> <c>`, every call pinned to `--attr-source=<tip>` so worktree and canonical callers read the same merge drivers) into throwaway commit objects. A conflict fails closed naming the commit (never auto-resolved; the text says to rebase the late commits onto main); a commit that applies as a no-op is skipped and flagged `emptyOnMain`. The result tree is main plus the owed commits.
- MERGE commits in `base..tip --not main` are skipped only under `merge_batch`'s own predicate, ONE shared helper (`mergeCommitBlocksLinearization`, `git/merge-linearization.ts`, imported by both `batch-merge.ts` and `computeOwedLanding`): every non-first parent on main AND an empty `diff-tree --cc`. Any other merge (one carrying content of its own, or merging a branch not on main) REFUSES naming the merge, because skipping it would silently lose what it carries (card `bc2240d7`). The exception is Loom's own union commit: it is accepted when its tree is exactly what `computeOwedLanding` makes of its two parents (recursive, bounded depth), since a clean union of adjacent edits can still show in `--cc`.
- Review: `lateRange` on the `worker_merge` result — the commit list (`commits`, `commitSubjects`) and the diffstat of that tree against main come from that one computation, so review and landing cannot diverge. The ordinary fork-point output is unchanged. A `refuse` or a non-applying commit becomes a `HELD BRANCH` warning.
- Landing: the confirm's union of main into the worktree (`mergeMainIntoWorktree`, `owedBase`) commits that tree with parents (tip, main) (`commit-tree`, then a fast-forward of the worktree). The gate therefore tests exactly what will land, and the ordinary squash (`git merge --squash` of a tip that now contains main) lands exactly those commits. A held branch never takes the "already caught up" shortcut, and the already-landed shortcut (`preLanded`) is skipped for it.
- Reviewed-tip rule (`bbccf470`): `verifyReviewedTipChain` takes `extraUnionBases`; a merge hop is accepted when its tree equals the default union of its parents OR exactly what `computeOwedLanding` makes of them for the owed base. A NON-merge commit added after the review never reaches that check (it fails the two-parent test), so it is still refused.
- Fail closed (`refuse`): recorded tip missing/unreadable, not an ancestor of the tip (branch rewritten), live tip unreadable, or the hold's release unverifiable (`gitUnverified`). A held branch in a repo with no `gateCommand` is refused too (the union exists only on the gated path).

## Do not

- Do not compute "what a held branch owes main" anywhere but `resolveOwedRange` / `computeOwedLanding`; a second definition drifts.
- Do not squash a held branch against its fork point, and do not union main into it with a plain `git merge`: both lose a late revert.
- Do not choose a merge base for the owed work (fork point, `assembledTip`, or a computed "right" one): every such rule has a history that defeats it. Cherry-pick the commits.
- Do not include merge commits in the owed list, and do not drop the `--not main` filter: a worker's merge of main must neither be replayed nor hide a late commit.
- Do not skip a merge commit on any predicate but the shared `mergeCommitBlocksLinearization`; do not copy it into worktrees.ts. Do not drop `--topo-order` or the `--attr-source` pin from the owed-commit replay.
- Do not guess when the range cannot be read (unreadable/non-ancestor `assembledTip`) or a commit does not apply; refuse with guidance and never auto-resolve.
- Do not drop `extraUnionBases` from the reviewed-tip walk: without it the owed union is refused as an unreviewed advance (proven red by a negative control in `batch-merge-late-range-landing.mjs`). Do not accept a merge hop for any base but the resolver's `base` for that branch.

## Requirements

`git merge-tree --write-tree --merge-base=<commit>` needs git >= 2.40; an older git fails the computation closed, so a held branch stays held and is never landed wrongly.

## Not covered

- A late range that nets to nothing against main (its content already on main) still reaches the held refusal in `finishAlreadyMerged`; nothing releases it automatically.
- The owed commits are cherry-picked one at a time onto main, so a range whose later commit only applies on top of a commit that ALSO conflicts is reported at the first non-applying commit.
