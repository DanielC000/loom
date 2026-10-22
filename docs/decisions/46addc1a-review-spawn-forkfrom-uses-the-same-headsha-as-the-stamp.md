# 46addc1a — review-spawn `forkFrom` passes the already-resolved `headSha`, never `reviewForkFrom.branch`

Folded into card `56c10535` (Code Review `9483d176`, item 8). `spawnWorker`'s review-spawn path resolves
`reviewForkFrom.headSha` once (the branch's tip at the moment the review target is validated — see
`resolveBranchTip`), then used to pass `reviewForkFrom.branch` (the bare NAME) to `createWorktree`'s own
`forkFrom` argument, which `git worktree add -b <new> <path> <forkFrom>` re-resolves independently at cut
time — a second, separate git read of the same logical value. Two problems: (1) under a planted
same-named tag, real git REFUSES this call outright ("fatal: ambiguous object name") rather than cutting
from the wrong tip — see `docs/decisions/56c10535-*.md`'s own "Do not" on why this failure mode was left
unfixed as a structural, fail-loud residual rather than a silent-wrong one; (2) even without an attack, a
branch that moves between the two reads (the headSha capture and the worktree-add re-resolve) means the
CUT worktree's content and the STAMPED `reviewBaseSha` (also derived from `headSha`, at
`reviewBaseShaToStamp(forkedFromReviewed, reviewForkFrom?.headSha)`) can silently diverge.

## The fix

Pass `reviewForkFrom?.headSha` (already a resolved sha) as `createWorktree`'s `forkFrom` argument instead
of `reviewForkFrom?.branch`. `createWorktree`'s `forkFrom` parameter accepts either a branch name or a
sha; passing the sha means `git worktree add -b <new> <path> <forkFrom>` resolves nothing — the argument
IS the commit. The cut worktree's content and the stamped `reviewBaseSha` now both derive from the
identical single read, with no second resolution in between to diverge.

## Do not

- Do not revert to passing `reviewForkFrom.branch` — that reopens both the ambiguous-tag refusal and the
  two-reads-of-one-value divergence this fix closes.
- Do not assume this closes the review-spawn `forkFrom` path's OWN ambiguity finding generally — a bare
  branch NAME passed to `forkFrom` from some OTHER, not-yet-identified caller would still hit the same
  class of issue; this fix closes `spawnWorker`'s review-spawn `createWorktree` call specifically.
  **Superseded (card `56c10535` Round 3, item 5):** the SAME `spawnWorker` method's OWN
  `reviewDiffNeedsBuild(reviewForkFrom.repo.path, reviewForkFrom.branch, ...)` call (service.ts ~`:9554`,
  right before the `createWorktree` call this record fixes) was a second, independent instance of the
  identical two-reads-of-one-value hazard — fixed too, by passing `reviewForkFrom.headSha` via
  `diffBranch`'s new `DiffBranchDeps.resolvedTip` field instead of re-resolving `.branch` by name. Do not
  assume EVERY `reviewForkFrom.branch` reference in `spawnWorker` has been swept this way — these two are
  the ones found; a future caller of either value must still be checked on its own.

## Tests

`packages/daemon/test/review-spawn-tag-ambiguity.mjs` — a planted same-named tag on the reviewed branch;
the review spawn must succeed and cut from the REAL branch's tip (not refuse, and not cut from the tag).
