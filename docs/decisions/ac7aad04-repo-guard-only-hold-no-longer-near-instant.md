# ac7aad04 — a repo-guard-only hold is no longer near-instant; it can now run a real reap + merge + diff while held

## Narrative

Code Review correction, card ac7aad04: `acquireRepoGuardOnly`'s hold used to be near-instant in practice — the `db9b0130` inert-diff skip that holds it used to make a bare `mergeBranch` call before releasing. Since card `ac7aad04`'s post-guard reclassification, a HOLDER can also perform a reap + a real `git merge` + a `git diff` (`isInertMergeDiff`) while holding this same guard, before it ever reaches squash — measured ~1.5s typical, bounded worst-case by the caller's `gitOpMs` (15s default, `GIT_OP_TIMEOUT_MS` in `git/worktrees.ts`) per git call. Still bounded and safe, just no longer sub-second.

This matters to anyone reasoning about how long a same-repo `repoGuardOnlyWaiters` queue wait can run: it is no longer safe to assume the holder ahead of you settles near-instantly. A repo-guard-only wait remains bounded by, at worst, another op's own squash (or, since this card, its reap + merge + diff), never a full gate run.

## The original finding: re-derive after the guard, not before

Card ac7aad04, Code Review finding on `b9e07a4a`: `inertSkip`/`gateBaseMainHead` are captured BEFORE the repo-guard-only wait, so a same-repo sibling that lands DURING it leaves this op holding a stale `gateBaseMainHead` the moment the guard is finally granted — `mergeBranch`'s own `requireCanonicalHead` re-check would then deterministically refuse with `gate_base_invalidated`, forcing a manager re-confirm for a merge that could otherwise have just landed. Re-checking after the guard is granted, now that the op exclusively holds the repo (no other same-repo op — real gate or another inert-skip — can be admitted until it releases), turns that guaranteed rejection into either a landed merge or a real gate, never a stale skip.

Originally this re-derivation covered the main endpoint only; card `db413510` later closed the identical gap for the branch endpoint (see `db413510`'s own record) — the short-circuit now re-derives whenever EITHER `postWaitHead !== gateBaseMainHead` (main moved) OR `postWaitBranchHead !== preWaitBranchHead` (branch moved, e.g. a still-active worker committing further while its own merge waits on this guard, which can run minutes). Both conditions route into the same reclassification: `isInertMergeDiff` diffs against `branch` BY NAME, not by a captured sha, so re-entering it after a branch-only move already re-resolves the branch's current tip for free.

## Do not

- Do not assume a repo-guard-only hold settles near-instantly when reasoning about queue wait — since card `ac7aad04`, a holder can run a real reap + `git merge` + `git diff` while holding it, measured ~1.5s typical, bounded by `gitOpMs` (15s default) worst-case.
- Do not assume the post-guard re-derivation `ac7aad04` introduced covers only `gateBaseMainHead` — since `db413510`, it also re-derives the branch tip; skipping the branch check would let a same-repo sibling's stale main-only proof ride through a branch that moved during the wait.

## Source

Inline comment in `packages/daemon/src/orchestration/gate-semaphore.ts` (`repoGuardOnlyWaiters`'s own doc, lines 546-551), commit `e4fa83a97`, as of `beeeb7c2`. Relocated by card `772735d2` (tranche 2); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. Also `packages/daemon/src/sessions/service.ts` (`confirmWorkerMerge`, the "RE-DERIVE AFTER THE GUARD" doc block), commit `e4fa83a97` (original finding) and `339eda110` (branch-endpoint extension), as of `0ffb1755`. Condensed: wrapped source lines joined into flowing paragraphs and `//` markers stripped.
