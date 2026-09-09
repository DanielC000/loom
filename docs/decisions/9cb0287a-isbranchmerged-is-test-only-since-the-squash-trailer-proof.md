# 9cb0287a — `isBranchMerged` is test-only since boot-reconcile switched to positive squash-trailer proof

## Narrative

`isBranchMerged` checks whether `branch` is already fully merged into `base` (default: the repo's current HEAD — the canonical branch `confirmWorkerMerge`'s `git merge` lands onto). Card `9cb0287a` (2026-08-29): boot-reconcile Pass A no longer calls this — under squash it now requires POSITIVE proof of a landed squash via the `Loom-Worker-Branch` trailer instead (see `worktreeHasWork`'s own doc for the full history). This function currently has ZERO production call sites (test-only); it is kept for now pending card `0f965ab7`'s review of the fail-safe siblings that reference it.

Detection is via `git branch --merged <base> --list <branch>` membership — exit-0 with a non-empty line only when the branch both exists AND is fully reachable from `base`. This deliberately does NOT use `merge-base --is-ancestor`: simple-git's raw doesn't reject on its exit-1 "not-ancestor" signal, so a try/catch around it would read every branch as merged. It returns `false` when the branch ref is gone (a completed merge deletes it), which keeps the reconcile idempotent. It is BOUNDED like every other reconcile op (block-timeout + `withTimeout`); a timeout-throw is caught and read as "not merged" (`false`) — the safe default a caller can rely on without itself acting on a bad signal.

## Do not

- Do not use `merge-base --is-ancestor` as a substitute detection here — simple-git's raw doesn't reject on its exit-1 "not-ancestor" signal, so a naive try/catch would misread every branch as merged.
- Do not remove this function as "dead code" without first resolving card `0f965ab7`'s pending review of the fail-safe siblings that still reference it.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `isBranchMerged`'s own doc comment (~line 1255), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
