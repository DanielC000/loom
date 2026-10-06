# ed2d878e — finalizeMerge's own tail never attempts deleteBranch on a confirmed-gone ref

## Narrative

From Code Review `de9506c6` of `e34d475c` round 5 (2026-10-03, APPROVE-with-minors): round 5 of
`e34d475c` gave `finalizeWorktreeAndBranch` a `skipDeleteWhenBranchGone` flag so Pass A's sibling/own-row
cleanup-only caller would never attempt `deleteBranch` once `expectedBranchTip` is undefined (branch
confirmed gone) — but that round deliberately scoped the fix to the cleanup-only caller only:
`finalizeMerge` never set the flag, so its own gone-branch behaviour (still calling `deleteBranch`, which
runs a plain, unconditional `git branch -D`) stayed byte-identical to before that round.

That left the exact same hazard open for `finalizeMerge`'s own tail: `soloFinalizeTipGuard` returns
`expectedBranchTip: undefined` specifically when the branch is already confirmed gone at lookup time (a
read made well before `finalizeMerge`'s own quarantine/held checks, sibling sweep, worktree removal, and
terminal bookkeeping all run). If a re-task spawn recreates the SAME branch name with new, never-landed
work during that window, `deleteBranch`'s plain `branch -D` (no CAS, since there was no tip to compare
against) deletes it unconditionally — destroying the recreated worker's work.

Reached by three production callers of `finalizeMerge`, all with `expectedBranchTip` potentially
undefined: the solo ALREADY_MERGED finish (`finishSoloAlreadyLanded`/the in-confirm `amGuard` detection,
both via `finishAlreadyMerged`), the `confirmWorkerMergeTracked` catch-recovery path (`crGuard`, re-deriving
an already-landed outcome from git after a throw), and boot-reconcile Pass A's own GENUINE
(non-cleanup-only) finalize. **Not** `confirmWorkerMergeTracked`'s Green path (`soloFinalizeTipGuard` is
called there with no `branchGone` argument at all, so its `expectedBranchTip` can never be undefined) and
**not** `mergeBatchTracked`'s own per-branch batch landing (it retains/warns instead of finalizing
whenever its own `assembledTip` is falsy, so `finalizeMerge` is only ever reached there with a real tip).

## Hermetic repro (checkpoint, pre-fix)

A real temp git repo: squashed a worker's commit onto main with a real `Loom-Worker-Branch` trailer (so
the squash lookup finds `landedSha`), then deleted the branch ref directly with NO `merge_done` recorded
anywhere (the genuine-finalize precondition: `alreadyFinalized=false`, `finalizedElsewhere=false`,
`branchGone=true`). A monkey-patched `Db.appendEvent` recreated the branch — with a brand-new, unrelated
commit, then explicitly checked the repo back out to a detached HEAD so the recreated branch is NOT
checked out anywhere — the instant this worker's own `merge_done` event is appended (the one point
`finalizeWorktreeAndBranch`'s own doc guarantees runs strictly BEFORE `deleteBranch`), modeling a
concurrent process recreating the same branch name as a bare ref in that window. Driven end-to-end via
the real `reconcileOrchestrationOnBoot`: Pass A recorded `mergesFinished: 1` (genuine finalize path, not
a retain), and the recreated branch's new commit was destroyed on pre-fix code.
Permanent regression coverage: `packages/daemon/test/finalize-gone-branch-recreate-race.mjs`.

**Severity, qualified:** a real re-task spawn recreates the branch via `createWorktree`'s `git worktree
add <path> -b <branch>`, which checks the new branch out IN that new worktree atomically with creating
it. `git branch -D` refuses to delete a branch that is checked out anywhere (`deleteBranch`'s catch
swallows that refusal as a false "success", but the ref itself survives). So the window for *actual* data
loss needs the recreated branch to exist as a ref that is NOT (yet, or ever) checked out in a worktree —
narrower than "any concurrent re-task recreation," which is the common case and would NOT lose data
through this specific mechanism (git's own checked-out-branch protection already covers it, incidentally).
The test above models the narrower, genuinely-vulnerable shape explicitly (the deliberate detach step).
The fix is still strictly safer regardless: it no longer depends on git's checked-out protection as an
accidental safety net, and covers the narrower window git's own protection does not.

## Fix

`finalizeMerge`'s own call to `finalizeWorktreeAndBranch` now always passes `skipDeleteWhenBranchGone:
true` — the exact same, already-reviewed mechanism `e34d475c` round 5 built for the cleanup-only caller.
Traced through `skipGoneBranchDelete`'s own boolean (`!!args.skipDeleteWhenBranchGone &&
!args.expectedBranchTip`): the flag only ever matters when `expectedBranchTip` is already undefined, so
every other `finalizeMerge` case (a real tip to CAS against, checked-out retention, nested/dirty
retention) is byte-identical to before this card.

A compare-and-delete inside `deleteBranch` itself (the alternative considered) was rejected: "delete iff
still absent" isn't an operation git's ref-delete primitives express (if a ref is genuinely still absent
at call time there is nothing to delete), so such a check could only ever NARROW the race window (to the
gap between the check and the subprocess call), never close it — and it would require a new opt-in flag
on `deleteBranch` anyway to avoid changing the contract its *other* caller (`deleteBranches`' per-branch
fallback in the bulk `--merged` reclamation sweep, Pass C) relies on, per `@decision 09f268a5`'s own "Do
not perturb `deleteBranch`" rule. Skip-on-gone is strictly less code for a strictly stronger guarantee.

## Do not

- Do not remove `skipDeleteWhenBranchGone: true` from `finalizeMerge`'s own `finalizeWorktreeAndBranch`
  call, or make it conditional on the caller (ALREADY_MERGED finish / catch-recovery / Pass A) — a branch
  confirmed gone has nothing legitimate for THIS finalize call to delete, regardless of which caller
  reached it.
- Do not "fix" this by adding a re-check-then-delete (compare-and-delete) inside `deleteBranch` itself —
  it narrows the race without closing it, and widens `deleteBranch`'s contract against `@decision
  09f268a5`'s explicit "do not perturb `deleteBranch`" rule for its `deleteBranches` bulk-sweep caller.
- Do not assume this closes the window for `deleteBranches`' own per-branch fallback (the bulk `--merged`
  reclamation sweep, Pass C) — that caller is a deliberately separate, unexamined case; this card's fix is
  scoped to `finalizeMerge`'s own tail only.
- Do not thread a new `gitFactory` test seam into `finalizeMerge`'s own deleteBranch call to prove this —
  `finalizeMerge`'s own args type has no `gitFactory` field, and the permanent regression test instead
  asserts the real ref's survival/removal directly (no interception needed).

Tests: `packages/daemon/test/finalize-gone-branch-recreate-race.mjs` (negative control: a late-recreated
branch survives finalize; positive control: a genuinely-present branch with a real `expectedBranchTip`
still gets CAS-deleted as before).
