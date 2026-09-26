# bbccf470 — a commit added after the manager's `worker_merge` review must not land unreviewed

`reviewWorkerMerge` records the branch tip it reviewed on the `merge_request` event (`detail.tip`, `null` when unreadable, plus `detail.repoKey`). Every consumer goes through ONE resolver, `SessionService.reviewedTipVerdict`:

- `confirmWorkerMerge` checks at confirm START (before any git/gate work and before the union-merge) AND again right before the squash, against the PINNED landing tip (`expectedTipForLanding(landingPin)`, or — for a no-gate-configured landing, which has no pin — the tip read there, which the squash is then pinned to). The second check closes the window where a commit is made while the op waits in the gate queue and is folded into the gated tip.
- `mergeBatchTracked` checks at assembly. A moved candidate is left out of the batch and reported in `fallback[]` with `started:false`; `runFallback` skips it exactly like a held (42daa283) candidate, so no caller path (the `<2`, gate-off and no-gate returns included) ever solo-confirms it. A candidate that passes carries the tip that was checked (`BatchCandidate.tip`); `landBranchCommitsIndividually` cherry-picks exactly that sha and never re-reads the branch ref, so 42daa283's `assembledTip` retention holds any later commit.

## What counts as "still reviewed"

The latest `merge_request` event for the BRANCH and repoKey (a `worker_recycle` successor shares the branch, so the predecessor's review binds; a re-review replaces it). A stale review from an earlier incarnation of a branch fails the walk-back below and refuses; a re-review clears it. The verdict is STRUCTURAL, derived from git alone by `verifyReviewedTipChain` (git/worktrees.ts): walk back from the tip being judged; a step prev→cur is a Loom advance only if (a) `cur` is on canonical main and the reviewed tip is an ancestor of `cur` (a fast-forward through main — the stale-base forward of a branch with no own commits), which ends the walk, or (b) `cur` is a merge commit whose parents are exactly [prev, M], M on canonical main, and `cur`'s tree equals `git merge-tree --write-tree prev M` (exactly what `mergeMainIntoWorktree`'s `git merge` yields). Reaching the reviewed tip ⇒ unmoved; anything else ⇒ moved. The walk is bounded (`REVIEWED_TIP_WALK_MAX_HOPS`; beyond it ⇒ moved) and any git error ⇒ moved (fail closed).

## Deliberate limits

- OUT OF SCOPE (a separate card tracks it): a worker DELIBERATELY writing shared .git state — a merge driver in the shared config plus `info/attributes`, replace refs used some other way, `update-ref` on refs — to launder content through the walk. That is sabotage, a class the repo's shared-worktree model does not defend (a worker with a shell can `update-ref refs/heads/main` outright). This card guards against an ordinary worker's LATE commits.
- A merge whose tree is not EXACTLY one clean `git merge-tree --write-tree` of [prev, M] is treated as moved: `merge-tree` exits 1 on a conflict without throwing through the git wrapper (conflicted tree oid first, conflict info after), so the walk requires exactly ONE output line, an oid equal to the commit's tree. The merge-tree run uses `--attr-source=<prev>` so a branch-side `.gitattributes` (e.g. `merge=union`), which the daemon's union used in the worktree, is honoured here too; the refusal wording says "could not be verified as a clean union", not that a worker commit exists.
- A worker that was never reviewed (no `merge_request` event for this branch+repo, or one filed before this card with no `tip` key) is NOT refused. The rule is "no unreviewed commits after a review", not "a review is mandatory".
- The refusal is its own never-cached outcome (`reviewed-tip-moved`): a re-review changes the answer.
- The review's diff is read by branch name, after the tip is recorded. A commit landing between the two reads is under-covered (later refused), never recorded as reviewed.

## Do not

- Do not store an "advanced to" record of any kind (a git ref under `refs/loom/`, a file, an event) to mark daemon-authored advances. `refs/loom/*` is shared by every worktree, so a worker can write it — that forgery landed an unreviewed commit in review (an earlier version of this card used exactly that). The GUARANTEE is narrower and exact: the verdict is derived from git objects (commit parents, trees, reachability from canonical main), with no daemon-trusted side store to forge, overwrite or clean up. Every git call of the walk runs with `--no-replace-objects`, so a `refs/replace/*` ref cannot rewrite the history it judges.
- Do not classify "any merge commit since the reviewed tip" as daemon-authored: a worker can author a merge that carries real conflict-resolution content. The tree-equality check is what makes (b) safe.
- Do not add a second reader of "the reviewed tip" or a hand-written check at a call site — a rule enforced in N places drifts into N rules.
- Do not route a moved batch candidate into the solo fallback, on any path: it would gate and land the unreviewed commit.
- Do not let the batch re-read the branch ref after the check; pass the verified sha.
- Do not treat a never-reviewed worker as refusable here without a new decision.
