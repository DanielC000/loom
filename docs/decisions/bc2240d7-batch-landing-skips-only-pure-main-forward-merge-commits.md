# bc2240d7 — A batched landing skips a merge commit only when it is a pure main-forward; every drop carries its own reason

## Context

A solo `worker_merge_confirm` commits a union-forward (`mergeMainIntoWorktree`, `git merge --no-edit main`) onto the
WORKER'S OWN branch at confirm start, before the gate queue. Cancelling the queued confirm does not undo that
commit. `merge_batch` used to drop any branch whose range held a merge commit, so the natural recovery
(cancel the fallbacks, re-batch) dropped every branch (2026-09-23 specimen: 4 of 4, and an earlier batch's
`c1840ffd`-shaped drop). The drop reasons also never reached the manager: the all-dropped path replaced every
candidate's own reason with the batch-level "every candidate was dropped".

## Decision

- `landBranchCommitsIndividually` skips a merge commit in `mergeBase..tip` when BOTH hold: (i) every non-first
  parent is an ancestor of the batch HEAD, and (ii) `git diff-tree --cc` is empty (a clean automatic merge — no
  hand-resolved conflict content). The branch's non-merge commits then cherry-pick as before.
- A merge failing (i) or (ii) drops the branch with a reason naming the sha, which condition failed, and
  "rebase onto main". More than `MAX_MERGE_COMMITS_CHECKED` merges drops unexamined.
- Each candidate's own drop reason is carried into `fallback[].reason`, both `[loom:merge-batch-*]` nudges
  (bounded list), a `batch_merge_dropped` event per drop (durable, written even when the batch never gates) and
  a daemon log line carrying the batch opId.

## Do not

- Do not relax either skip condition, and do not skip on the merge subject alone: (ii) is what stops a
  hand-resolved conflict's content being silently lost, (i) what stops a merge of something not on main landing
  as if it were.
- Do not put the union-forward on a scratch ref or roll it back on cancel as a substitute: the gate runs in the
  worker's worktree, so the merged tree must live on the branch, and a rollback races with worker commits.
- Do not replace a candidate's own drop reason with the batch-level reason.
- Do not test "is an ancestor" with `git merge-base --is-ancestor` through `simple-git`'s `raw()`: it resolves a non-zero exit with empty stderr as SUCCESS, so exit-1 ("no") reads as "yes" and the foreign-parent check fails OPEN. Compare `merge-base <parent> <head>` output to the parent's full sha (proven RED by `batch-merge-merge-commits.mjs` (4)).
