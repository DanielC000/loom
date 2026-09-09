# 9cb0287a — `isBranchMerged` is test-only since boot-reconcile switched to positive squash-trailer proof

## Narrative

`isBranchMerged` checks whether `branch` is already fully merged into `base` (default: the repo's current HEAD — the canonical branch `confirmWorkerMerge`'s `git merge` lands onto). Card `9cb0287a` (2026-08-29): boot-reconcile Pass A no longer calls this — under squash it now requires POSITIVE proof of a landed squash via the `Loom-Worker-Branch` trailer instead. This function currently has ZERO production call sites (test-only); it is kept for now pending card `0f965ab7`'s review of the fail-safe siblings that reference it.

Detection is via `git branch --merged <base> --list <branch>` membership — exit-0 with a non-empty line only when the branch both exists AND is fully reachable from `base`. This deliberately does NOT use `merge-base --is-ancestor`: simple-git's raw doesn't reject on its exit-1 "not-ancestor" signal, so a try/catch around it would read every branch as merged. It returns `false` when the branch ref is gone (a completed merge deletes it), which keeps the reconcile idempotent. It is BOUNDED like every other reconcile op (block-timeout + `withTimeout`); a timeout-throw is caught and read as "not merged" (`false`) — the safe default a caller can rely on without itself acting on a bad signal.

## `worktreeHasWork` — the guard this superseded for Pass A, and why it still matters for Pass B

`worktreeHasWork` is the SAFE-TO-DISCARD guard for boot-reconcile Pass B — a P0 data-loss fix, 2026-06-05. Does a worktree still hold work we'd LOSE by deleting it? "Work" = EITHER the working tree is DIRTY (real uncommitted/untracked changes — see `worktreeStatusHasWork`, which ignores daemon-injected `.claude/` noise) OR the branch is AHEAD OF `base` (commits not yet reachable from the canonical HEAD — `git rev-list --count base..branch` > 0).

THE BUG IT GUARDS: a `daemon_restart` marks EVERY prior-run session `exited` at boot, so an unrelated manager's LIVE worker is misdetected at boot and its worktree deleted mid-task, pre-commit (confirmed data loss, 2026-06-05). Originally TWO vectors were gated by this single guard: Pass B GC'ing any exited+unprotected worktree (the branch-AHEAD case), and Pass A treating a 0-commit branch as a merged orphan (its tip == HEAD). Card `9cb0287a` (2026-08-29) made the Pass A vector STALE — under squash (see `findLandedSquashCommit`), Pass A no longer calls `worktreeHasWork` at all; it now requires positive proof of a landed squash via the deterministic `Loom-Worker-Branch` trailer before ever finalizing, and deliberately does NOT re-apply this guard (see `reconcileOrchestrationOnBoot`'s own comment on that call). A worker Pass A can't positively confirm landed simply falls through untouched to Pass B, where THIS guard is the sole remaining line of defense — verified (card `9cb0287a`) to be the function's ONLY call site (`git grep -n "worktreeHasWork(" -- packages/daemon/src`).

FAILS SAFE: every op is bounded by the same block-timeout + `withTimeout` guard as the other reconcile ops, so the check itself can never wedge boot; on ANY timeout/error/parse-failure it returns TRUE (assume work) so a wedged or locked check can never CAUSE a delete. Worst case a discardable dir is kept for the next pass — never the reverse. The git seam is injectable (`BoundedGitDeps`) so a test can prove both the work-detection and the fail-safe bound.

## Do not

- Do not use `merge-base --is-ancestor` as a substitute detection in `isBranchMerged` — simple-git's raw doesn't reject on its exit-1 "not-ancestor" signal, so a naive try/catch would misread every branch as merged.
- Do not remove `isBranchMerged` as "dead code" without first resolving card `0f965ab7`'s pending review of the fail-safe siblings that still reference it.
- Do not re-apply `worktreeHasWork` to Pass A on the theory that "more guards can't hurt" — Pass A's positive squash-trailer proof is the stronger, deliberate replacement; re-adding the old guard there would reintroduce a weaker check alongside the strong one, not just an extra one.
- Do not let `worktreeHasWork`'s own failure default to anything but TRUE (assume work) — a wedged/locked check must never be the reason a live worktree gets deleted.

## Consequences

Pass A's orphan-worktree cleanup is now gated on positive squash-trailer proof, closing the 2026-06-05 data-loss vector (a live worker's worktree misdetected as an exited-and-mergeable orphan). Pass B still relies on `worktreeHasWork` as its sole remaining line of defense, so that function's fail-safe-to-TRUE behavior remains load-bearing even though Pass A no longer calls it.

## Source

Inline comments in `packages/daemon/src/git/worktrees.ts`: `isBranchMerged`'s own doc comment (~line 1255, as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`, relocated by card `5b001dde`) and `worktreeHasWork`'s own doc comment (~line 1428, as of this worktree's HEAD before this extraction). Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
