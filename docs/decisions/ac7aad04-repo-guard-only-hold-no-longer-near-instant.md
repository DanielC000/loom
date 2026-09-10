# ac7aad04 — a repo-guard-only hold is no longer near-instant; it can now run a real reap + merge + diff while held

## Narrative

Code Review correction, card ac7aad04: `acquireRepoGuardOnly`'s hold used to be near-instant in practice — the `db9b0130` inert-diff skip that holds it used to make a bare `mergeBranch` call before releasing. Since card `ac7aad04`'s post-guard reclassification, a HOLDER can also perform a reap + a real `git merge` + a `git diff` (`isInertMergeDiff`) while holding this same guard, before it ever reaches squash — measured ~1.5s typical, bounded worst-case by the caller's `gitOpMs` (15s default, `GIT_OP_TIMEOUT_MS` in `git/worktrees.ts`) per git call. Still bounded and safe, just no longer sub-second.

This matters to anyone reasoning about how long a same-repo `repoGuardOnlyWaiters` queue wait can run: it is no longer safe to assume the holder ahead of you settles near-instantly. A repo-guard-only wait remains bounded by, at worst, another op's own squash (or, since this card, its reap + merge + diff), never a full gate run.

## Do not

- Do not assume a repo-guard-only hold settles near-instantly when reasoning about queue wait — since card `ac7aad04`, a holder can run a real reap + `git merge` + `git diff` while holding it, measured ~1.5s typical, bounded by `gitOpMs` (15s default) worst-case.

## Source

Inline comment in `packages/daemon/src/orchestration/gate-semaphore.ts` (`repoGuardOnlyWaiters`'s own doc, lines 546-551), commit `e4fa83a97`, as of `beeeb7c2`. Relocated by card `772735d2` (tranche 2); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
