# ceeb188b — `reclaimWedgedWorktreePathForSpawn` checks for a nested live worktree before renaming aside

Follow-up to `c994ffeb` (Code Review of commit `367d53f6`, finding 2 of that review). `createWorktree`'s
own reverse backstop refuses to rename aside a dir that is really a repo-axis dir holding live secondary-
repo worktrees — but `reclaimWedgedWorktreePathForSpawn` (`sessions/service.ts`), called immediately
BEFORE `createWorktree` at both real spawn sites (`startNew`'s worker-spawn path, `merge_batch`'s batch
worktree cut), renamed a wedge-tracked path aside unconditionally, with no such check.

## The failure

A compound precondition: a primary task T's worktree path P is wedge-tracked (a prior removal attempt
against P failed and recorded it). Separately — most plausibly via a grandfathered 12-hex `repoKey`
equal to `taskKey(T)` that predates `c994ffeb`'s registry-level rejection — a secondary task T2's live
worktree has since been cut nested at `P/<taskKey(T2)>`, with its own valid `.git` link FILE and real
uncommitted work. On a respawn of T, `reclaimWedgedWorktreePathForSpawn` finds P wedge-tracked and still
on disk, and (pre-fix) unconditionally renamed the WHOLE of P aside — taking T2's live worktree with it.
T2's bytes survive (rename-aside never deletes), but T2 becomes operationally orphaned: its own
`session.worktreePath` and git's own worktree admin record (`.git/worktrees/<id>/gitdir`) both still
point at the original, now-moved path. `git worktree list` in T2's repo subsequently shows that worktree
as `prunable`. Reproduced hermetically against pre-fix `dist` (worker checkpoint, 2026-10-06) before
implementing the fix.

## Why the background wedge-sweep was NOT also exposed

The other consumer of a wedge entry, `sweepWedgedWorktreesOnce` → `gcWorktreeDir`, was already safe:
`gcWorktreeDir` calls `findNestedGitRepos` before ever force-removing, and that scan's existence check
(`fs.promises.access(path.join(full, ".git"))`) detects a `.git` FILE exactly like a `.git` DIRECTORY —
verified directly against the same nested-worktree shape. A nested live worktree there yields
`nested-repo-blocked`, retaining the dir. The gap was isolated to `reclaimWedgedWorktreePathForSpawn`'s
own direct `renameWorktreeDirAside` call, which is a rename (not a removal) and so never goes through
`gcWorktreeDir`/`findNestedGitRepos` at all.

## The fix

`findNestedWorktreeLikeChild` (`git/worktrees.ts`, the exact predicate `c994ffeb` introduced for
`createWorktree`'s own reverse check) is now exported and consulted a second time, inside
`reclaimWedgedWorktreePathForSpawn`, immediately before its unconditional rename-aside. On a hit, the
reclaim throws descriptively (naming the found child, and what unblocks it — the nested worktree being
merged/stopped and removed, since the refusal otherwise repeats on every respawn attempt), self-releases
the in-flight path claim, and leaves the wedge DB entry INTACT. This mirrors the existing rename-aside-
failure branch in the same function exactly (same self-release-then-throw shape, same "keep the wedge
entry for a later retry" posture) — not a new failure shape, the same one callers already handle.

The check is gated on the SAME test seam as `createWorktree`'s own reverse check
(`__setWorktreeCollisionBackstopForTest` / its read-only counterpart `isWorktreeCollisionBackstopEnabled`)
— a single switch governs both rename-aside backstops, by deliberate review decision (card `ceeb188b`),
rather than a second seam specific to the reclaim side.

## Why this is not `needsHuman`

Unlike a genuinely permanent refusal (e.g. `worktreeRemovalRefusal`'s structural cases), this condition
is self-resolving: once T2's own worktree is naturally cleaned up (its task merges, or is stopped and its
worktree removed), the nested child disappears and a later respawn of T proceeds normally — no human
action is structurally required, only the ordinary lifecycle of the colliding task. Marking this
`needsHuman` would wrongly disarm the retry loop for a condition that resolves on its own.

## Do not

- Do not go back to an unconditional rename-aside in `reclaimWedgedWorktreePathForSpawn` — it must consult
  `findNestedWorktreeLikeChild` first, exactly as `createWorktree`'s reverse check does.
- Do not add a second test seam for this check — gate it on the existing
  `isWorktreeCollisionBackstopEnabled()` / `__setWorktreeCollisionBackstopForTest` pair; a second switch
  would let the two rename-aside backstops drift independently in tests.
- Do not clear the wedge DB entry on this refusal, and do not call `markWorktreeNeedsHuman` for it — see
  "Why this is not needsHuman" above; it must stay retryable.
- Do not gate this check on `repoKey` (forward vs. reverse) the way `createWorktree` gates its OWN two
  separate checks — this one check applies unconditionally to whatever `worktreePath` a reclaim is about
  to rename aside, regardless of which axis it's on.

## Source

Card `ceeb188b`. Code Review of commit `367d53f6` (finding 2 of that review, tracked separately from
`c994ffeb`'s finding 1). Tests: `packages/daemon/test/createworktree-wedge-reclaim.mjs`.
