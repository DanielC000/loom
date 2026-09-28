# 42daa283 — a batch candidate whose branch moved after assembly is RETAINED and HELD, and released only by a real landing

A `merge_batch` lands what it assembled from each candidate branch, then finalizes it (`finalizeMerge`: stop the worker, remove the worktree, move the task, delete the branch). A commit a worker adds to a candidate branch WHILE the batch gate runs is not in the batch HEAD and was never gated, yet finalize used to destroy it under a batch reporting "landed".

The batch now records each candidate's assembled tip; a moved or unreadable tip at finalize RETAINS the branch, worktree and worker, flags `branchAdvancedDuringGate` on the landed row and files a durable `batch_merge_branch_retained` event (`{opId, branch, assembledTip, liveTip, phase, landedSha}`). A retained branch is then HELD (`SessionService.isBranchHeld`, the ONE definition).

## The hold

- **Keyed on the BRANCH (scoped to its repo, see "The hold is scoped to (branch, repo)" below)**, not the worker session id: `worker_recycle` mints a new session id on the same branch/worktree, and boot Pass A finalizes by branch.
- **Durable**: read from the event log, so it survives a re-fire, a mixed batch and a daemon restart (never from the process-local verdict cache).
- **Held means**: never assembled, never fallback-confirmed (`runFallback` reports it `started:false`), never finalized or deleted by ANY path — batch assembly, `runFallback`, boot Pass A, `finishAlreadyMerged`, `finalizeMerge`, the boot branch-ref sweep. Held candidates count toward neither K nor the `< 2` check and are not batch members.
- **Released by exactly two arms** (the latest retain event for the branch):
  1. a `merge_done` for the branch NEWER than it and NOT `detail.reconciled` (boot Pass A2 fabricates a reconciled one for a card merely sitting in the terminal column, so it must not release); or
  2. the GIT FACT: the retain records the batch's own landed sha (`landedSha`) and main carries a `Loom-Worker-Branch: <branch>` commit STRICTLY AFTER it (`findLaterBranchSquash`). Only the merge code writes those, and a held branch is never re-assembled, so a later one is a deliberate confirm's real squash. This closes the crash window in which that squash is on main but `finalizeMerge` never got to append its `merge_done`. A legacy retain row without `landedSha` has only arm 1.
- **Fail closed**: a git read that errors or times out keeps the branch HELD, flagged `gitUnverified`; the next boot or confirm retries.
- `confirmWorkerMerge`'s Green path (a real new squash of the live tip) passes `releaseHold` — the one in-band release.

## Do not

- Do not key the hold on the worker session id or on the process-local verdict cache — a recycle successor and a restart would drop it.
- Do not release on a MISSING branch, on further tip movement, or on a branch probe: a ref probe reads a transiently locked ref as "missing", a pre-stop retain keeps the worker live so every later commit is equally unreviewed, and a hand-deleted branch is harmless to keep reporting.
- Do not release on a `detail.reconciled` merge_done (boot Pass A2 fabricates it).
- Do not read a failing git read as "no later squash, so released" (or the reverse): an error is neither — the branch stays held.
- Do not add a second, site-local definition of "held": every finalize/delete site calls `isBranchHeld`.
- Do not move `finalizeMerge`'s `merge_done` append earlier to shrink the crash window: `hadPriorMergeDone`/`alreadyFinalized` use "any prior merge_done for this worker" to decide whether the real finalize moves the task and reingests, so an early one makes it skip both. The git-fact arm already releases at the instant the squash lands.
- Do not let the CAS ref delete (`git update-ref -d`, unlike `branch -D`) run while the worktree was not removed: it would delete a branch still checked out in a live worktree.

## Bound on the git-fact arm

"Only the merge code writes a `Loom-Worker-Branch` commit" is a claim about PRODUCERS, not a proof. A HUMAN commit carrying the trailer (e.g. re-cherry-picking the batch commit onto main) would falsely release a hold. That is accepted, because every destructive site stays independently content-guarded — boot Pass A's `branchContentLandedInCommit`, the `--merged`-only branch-ref sweep, and `finishAlreadyMerged` (only reached after an empty squash) — and because a batch landing is itself gated. The arm is a crash-recovery anchor, not the only safety.

## Landing a held branch

A held branch is reviewed and landed by the range it still owes main, `assembledTip..liveTip` (card 13fc5227; see `13fc5227-a-held-branch-is-reviewed-and-landed-by-its-late-range.md`). This replaced an earlier known limit: a late commit that only reverted part of the branch's own change squashed to NOTHING against the fork point, so `worker_merge_confirm` could only refuse it with cherry-pick guidance. The refusal remains for a range that cannot be determined (fail closed) and for the already-landed finish paths.

## The hold is scoped to (branch, repo) (card a5be590f)

The branch name (`loom/` + sha256(taskId)[:12]) is unique per task but has NO repo axis, so a task retargeted to a second repo (a `repoKey` change) and re-spawned is cut onto the SAME branch name there. Keyed on the branch alone, that had two effects: repo 2 inherited repo 1's hold (a false hold; measured RED in `batch-merge-hold-repo-scoped.mjs` on the pre-fix code: repo 2's confirm was refused as HELD), and, once repo 2 could land, repo 2's `merge_done` would have released repo 1's still-held branch and exposed its late commit to boot Pass A's content-fooled finalize.

Chosen fix: option (a) — carry `repoKey` on the events and match on it inside the ONE `isBranchHeld(branch, repoPath, repoKey)`, not option (b), refusing a `repoKey` retarget while held. (b) would have left every other same-name collision (a hand-made branch, a task re-cut in a second repo without a retarget) and would have needed its own hold check on the retarget path — a second, divergent definition of "held". (a) is one predicate and needs no new refusal surface.

- `batch_merge_branch_retained`, `merge_branch_retained` and `merge_done` details carry `repoKey` (`null` = the primary repo, the same convention as `merge_request`); every caller of `isBranchHeld` states its repo scope (the session's stamped `repoKey`, not the task's current one).
- Only events in the caller's scope count, for the retain AND for the release. A LEGACY row with no `repoKey` key at all (written before this card) matches any scope, i.e. by branch only — an absent key is distinct from `repoKey: null`.
- The boot branch-ref sweep asks under every `repoKey` that names the swept path (primary → `null`, registered repos → their key) and keeps the branch if any scope holds it.
- Boot Pass A's held-branch skip is now counted in the reconcile result (`mergesHeld`) and the boot log line, not only a `console.warn`.
- Reachability: pre-fix, only the false hold was reachable end to end — it blocked repo 2's confirm before any repo-2 `merge_done` could exist. The release half became reachable the moment the inherit half was fixed in isolation, so the test proves it with a negative control: leaving the `merge_done` filter unscoped turns four checks red (repo 2's `merge_done` releases repo 1's hold, and boot Pass A then finalizes it).

### Do not (repo scope)

- Do not read or write a hold event without its `repoKey`, and do not add a second, repo-aware check beside `isBranchHeld`.
- Do not treat an absent `repoKey` key as `null`: absent means a legacy row that matches any repo, `null` means the primary repo.
- Do not scope only the retain and leave the `merge_done` release unscoped: that reopens the cross-repo release.
- Do not make `repoKey` optional again on a `merge_done` writer (`finalizeMerge`, `finishAlreadyMerged`): an omitted one writes a legacy-shaped row that releases the hold in every repo. It is a required `string | null` argument, so an omission is a compile error.

## Uncommitted work is a separate retain, and is NOT a hold

The tip guard above sees only COMMITTED work. An UNCOMMITTED edit in the candidate worktree (untracked file or modified tracked file) made while the gate ran is guarded separately by card 6796c9ea (see `6796c9ea-finalize-retains-a-worktree-holding-uncommitted-work.md`): `finalizeMerge`'s worktree removal keeps a dirty (or unreadable) worktree and the landed row carries `worktreeRetainedDirty`. It is a sibling field, not a new phase of `branchAdvancedDuringGate`, and files no `batch_merge_branch_retained` event, because that event is what `isBranchHeld` reads and a dirty worktree at an unmoved tip must not hold the branch.

## The solo path

The solo `worker_merge_confirm` half of this guard landed in card cc9bce38 (see `cc9bce38-solo-finalize-deletes-the-branch-only-at-the-landed-tip.md`), reusing this finalize check, the compare-and-swap delete and `isBranchHeld`. Its event kind stays `merge_branch_retained` (`source:"solo"`), distinct from the batch's `batch_merge_branch_retained`.

## Test coverage of the batch finalize guard

`batch-merge-branch-advanced-during-gate.mjs` drives the "tip moved to another sha" arm. `batch-merge-finalize-guard-edges.mjs` (card a498cc3c) covers the other two: an UNREADABLE live tip fails closed (retained with `liveTip:null`, at the batch's pre-stop check and at `finalizeMerge`), and a NOOP (already-in-ancestry) landing is guarded like a fresh one (unmoved finalizes, moved is retained). Each was shown red by mutating the guard (fail-open on unreadable; noop exempted) and green on restore.
