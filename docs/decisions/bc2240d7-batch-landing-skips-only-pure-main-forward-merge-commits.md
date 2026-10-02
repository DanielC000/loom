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

## content-check (card f01c219d) — compare the landed tree to the EXPECTED 3-way merge, over the whole tree

**Round 1 — found the bug.** Found by a Code Reviewer's real-git repro on the merge-path review lane
(card `2785fbc2` M2). Condition (ii) above (`diff-tree --cc` empty) was reasoned about ONLY for a merge
that carries resolution content of its own ("ADD" case). It does not distinguish that from a merge whose
resolution REVERTS the branch's own prior change back to a parent's exact content: a revert-to-parent and
a genuine no-op forward both print an empty combined diff for the reverted path, because both make the
result equal one parent exactly.

Repro: branch A adds `n.txt` and changes `f.txt` in a non-merge commit; A then merges main, resolving by
deleting `n.txt` and resetting `f.txt` back to the (unchanged) pre-branch content — a revert. `diff-tree
--cc` on that merge is empty (every path's result equals one parent exactly) and both conditions (i)/(ii)
pass, so the merge is skipped as a pure main-forward. The replay then cherry-picks the EARLIER non-merge
commit — which still adds `n.txt` and changes `f.txt` — re-landing exactly what the merge commit discarded.
The solo squash path is unaffected: it lands the branch's reviewed TIP TREE directly, never replays
individual commits, so it cannot resurrect something the tip itself no longer has.

**Round 1's fix (SUPERSEDED by round 2 below):** content-checked the landed tree against the branch's
reviewed tip, restricted to the paths the landed non-merge commits touched, gated on `mergeShas.length >
0` (needed because that per-path comparison false-positived on an ordinary rename-following cherry-pick —
`batch-merge-robustness.mjs` (7e) — when checked unconditionally).

**Round 2 (Code Review `1fa8814c`) — the round-1 design had two more bugs, both reproduced with real git:**
1. False DROP: comparing whole files at the branch's own paths against the RAW `branchTip` breaks whenever
   main later changes one of those files in a SEPARATE hunk after the branch's own forward merge from main
   — the ordinary case on a hot file, undoing much of round 1's own fix.
2. False NEGATIVE: "paths the branch's own non-merge commits touched" misses a merge-only path whose
   resolution took the BRANCH's own side — the batch lands main's side instead, silently differing from
   both the reviewed tip and what the solo squash would land. Round 1's own `Do not` section asserted the
   opposite of this.

**Round 2's fix:** compare the landed tree, over the WHOLE tree, against the EXPECTED 3-way merge —
`git merge-tree --write-tree <batchHeadBefore> <branchTip>` (`landedTreeDivergesFromExpected`, this file).
`merge-tree`'s own merge-base inference resolves to the branch's last-synced-with-main point, the SAME
ancestor the solo squash path's own union-forward used, so this is exactly the tree landing the branch is
SUPPOSED to produce — not an approximation of it. A merge-tree conflict drops the candidate, same
"drop, don't fail" posture as every other failure in this function (and the same rollback). This also
RESOLVES round 1's accepted sibling-overlap false positive rather than merely tolerating it: a sibling
landed earlier in the same batch that touches one of this branch's own files in a DIFFERENT hunk now
merges cleanly (both land); only a genuine overlapping-hunk conflict drops the candidate.

Runs UNCONDITIONALLY — the `mergeShas.length > 0` gate round 1 needed is GONE. The 3-way merge correctly
absorbs the rename-following case that forced that gate (re-verified against `batch-merge-robustness.mjs`
(7e) before removing it) because it's a real 3-way merge, not a raw-tip path comparison — git's own
rename-following logic resolves the 3-way diff onto the renamed path exactly as the real cherry-pick did.

Needs git >= 2.38 (`merge-tree --write-tree`'s introduction); the owner's host is 2.47 and CI runs
`ubuntu-latest`, both well above the floor, and Loom documents no lower minimum anywhere else. An older
git's unsupported-option error surfaces as an ordinary git failure at this call and already fails closed
(drops the candidate) — no separate preflight check was added or is needed.

### Do not

- Do not read the comparison's exit code — `git merge-tree --write-tree` exits 1 on a conflict WITHOUT
  throwing through simple-git (the same non-zero-exit-reads-as-success gotcha `bc2240d7`'s own ancestor
  check above already works around for `--is-ancestor`): the resulting tree oid is the first line
  regardless of exit status, with conflict info following it on a real conflict. Read the OUTPUT instead —
  exactly one oid line means clean, anything else means a conflict.
- Do not reintroduce the `mergeShas.length > 0` gate without first re-proving `batch-merge-robustness.mjs`
  (7e) RED — the 3-way merge is what makes the unconditional check safe; round 1's raw-tip path comparison
  was not.
- Do not go back to comparing per-touched-path text against the raw `branchTip` — that is round 1's design,
  replaced for both of round 2's reasons above.
