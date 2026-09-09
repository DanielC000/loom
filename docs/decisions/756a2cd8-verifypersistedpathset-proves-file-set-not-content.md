# 756a2cd8 — `verifyPersistedPathSet`: proves the SAME FILE SET landed, never the same content

## Narrative

`verifyPersistedPathSet` verifies a squash commit's persisted `Loom-Worker-PathSet` claim purely from the commit's OWN ancestry — `sha` and its parent `sha^`, both permanently reachable from HEAD once landed, so unlike a branch-tip check this needs no branch ref and survives `git gc` indefinitely (empirically confirmed: a genuine match still holds after `git branch -D` + `git reflog expire --expire=now --all` + `git gc --prune=now`; see `test/merge-pathset-deleted-branch.mjs`). FAILS CLOSED, same asymmetry as `branchContentLandedInCommit`: any git error, or the digests genuinely disagreeing, returns `false` — NOT VERIFIED. A false `false` costs one redundant, idempotent merge attempt; a false `true` is the exact silent-data-loss bug this whole check exists to close.

WHAT A `true` HERE ACTUALLY PROVES, AND WHAT IT DOESN'T: only that the landed commit touched the SAME SET OF FILES the trailer declares — NOT that it carries the same CONTENT (see [[f621f185-path-set-digest-not-content-hash-for-the-deleted-branch-residual]] for why a content check doesn't survive a concurrent main advance). Two DIFFERENT branches whose diffs happen to touch the exact same path set produce IDENTICAL digests, and a content swap between them would pass this check. Not a hypothetical on this repo: cards cluster hard on a handful of hot files (e.g. `pty/host.ts`), so two concurrently-worked branches confined to the same one or two hot files are realistic, not exotic. Accepted deliberately because it strictly dominates the pre-`f621f185` answer (trailer presence alone, no path check) and never introduces a false positive it wouldn't already have produced — but a caller must not read a `true` here as "content verified" the way `branchContentLandedInCommit`'s `true` (an actual content check) is.

`baseOverride`, when supplied (the commit's own `Loom-Worker-Base` trailer, if present — card `d62dad73` phase 2 for a BATCHED landing's tip commit, card `756a2cd8` for a SOLO squash commit), is used as the base instead of `sha^`. Load-bearing for a batched tip whose own `sha^` only spans its LAST cherry-picked commit; redundant-but-uniform for a solo squash, whose `sha^` already IS that same base by construction. Omitted (every pre-`756a2cd8` solo-squash commit, and every pre-phase-2 batched commit), this is BYTE-IDENTICAL to the original `sha^`-only behavior.

## Do not

- Do not read a `true` result as "content verified" — it only proves the same FILE SET was touched, never the same content.
- Do not assume two branches sharing an identical path set are distinguishable by this check alone — accepted, deliberate tradeoff.

## Consequences

A caller can verify a landed squash's path-set claim without needing the (possibly-deleted) branch ref, at the cost of a check that proves file-set identity, not content identity.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `verifyPersistedPathSet`'s own doc comment, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
