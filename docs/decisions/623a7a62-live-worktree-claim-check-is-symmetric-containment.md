# 623a7a62 — `findLiveSessionClaimingWorktreePath` refuses on symmetric overlap, not exact-path equality

## Narrative

Code Review `c1929951` of card `04e4262d` found that `findLiveSessionClaimingWorktreePath`
(`sessions/service.ts`) — the "is this path currently claimed by a live session?" check shared by
`gcWorktreeDir`'s `staleKnowledge` guard (the wedge-retry sweep, both boot-reconcile Pass B GC sites) and
`reclaimStaleWorktreeLeftover` (the host-delete stale-leftover POST reclaim) — compared paths with plain
equality (`normForCompare(a) === normForCompare(b)`). A reclaim/delete target that sits INSIDE a live
session's worktree (a descendant), or that CONTAINS one (an ancestor), was not caught by this check at
all. `04e4262d` round 4 closed the one known path that reached a descendant case (an unregistered-axis
probe descending into a primary task worktree missing its `.git`, confirmed to delete real content one
level below a live worktree — see `docs/decisions/ad34efb5-*`'s Round 4), but that fix lives in the
*enumeration* (`listStaleAsideWorktrees`'s `TASK_KEY_SHAPE_RE` skip); the claimant check itself — the
last line of defence every one of these callers relies on — still only caught an exact match.

The fix is `pathsOverlap(a, b)` (`git/worktrees.ts`), a SYMMETRIC predicate: `true` when `a` equals `b`,
`a` is a descendant of `b`, OR `a` is an ancestor of `b`. Both directions matter — a target that is an
ANCESTOR of a live worktree would delete that worktree recursively, just as surely as one that sits
inside it. It reuses the exact realpath + win32-case-fold normalisation `worktreeRemovalRefusal` already
used for its own (different) containment check against registered repo paths — extracted to a shared
`containmentForms` helper so the two can't drift. `findLiveSessionClaimingWorktreePath` now calls
`pathsOverlap` for both of its checks: the in-memory `claimedWorktreePaths` in-flight-spawn set, and
every live/starting session's `worktreePath`.

Audited (both directions) against every real caller before shipping: worktree paths are always
deterministic, disjoint SIBLING leaves (`resolveWorktreePath`: `WORKTREES_DIR/<projectId>/<repoKey>?/
<taskKey>`), never nested under one another. No `gcWorktreeDir(staleKnowledge:true)` caller's target, and
no `listStaleAsideWorktrees` entry (a leaf by construction — the probe only ever reports a
`.stale-<ts>`-suffixed leaf, never the axis/container dir it descends through), can legitimately be an
ancestor OR a descendant of a currently-live worktree. Every real overlap this check can now catch is the
hazard class `04e4262d` found, not a false positive against a legitimate reclaim.

## Round 3 — Code Review `44cac5fd` follow-ups

Three small gaps, all against the round-1/2 shape above:

1. `gcWorktreeDir`'s `staleKnowledgeGuard` treated every claim the same way — an EXACT match (the
   confirmed respawn-at-the-same-path shape) and a mere OVERLAP (never actually seen; worktree paths are
   deterministic sibling leaves, so a real overlap hit is a structural anomaly) both dropped the wedge
   entry and walked away. For an exact match that's correct — the path is now genuinely owned by whatever
   claims it. For an overlap that ISN'T exact, dropping the entry means the only trace that something was
   ever wrong with that path vanishes with no human ever seeing it. `findLiveSessionClaimingWorktreePath`
   now returns which kind of hit it found (`pathOverlapKind` — "exact" or "nested"); an exact hit keeps
   the drop, a nested (overlap-but-not-equal) hit instead calls `markWorktreeNeedsHuman` and returns
   `needs-human-skip`, so the entry stays tracked and visible instead of silently disappearing.
2. `reclaimWedgedWorktreePathForSpawn`'s mutual-exclusion check against `removingWorktreePaths` (card
   `a5d9c458`) compared by exact normalized string only, while the claim side it guards against
   (`findLiveSessionClaimingWorktreePath`) had already moved to symmetric overlap — an asymmetry: a
   removal in flight against a path that merely OVERLAPS (rather than exactly equals) a spawn's target
   could race it. It now iterates `removingWorktreePaths` with `pathsOverlap` too.
3. `normForCompare` folds a Windows extended-length (`\\?\` / `\\?\UNC\`) prefix to its ordinary
   drive/UNC form before resolving. `fs.realpathSync` can hand back either form for the exact same path
   depending on length and the API that produced it; without the fold, `containmentForms` treats the two
   forms as unrelated paths, so BOTH `pathsOverlap` and `worktreeRemovalRefusal` (which share
   `containmentForms`) failed OPEN for a long-path-prefixed target — exactly the "err toward refusing"
   guarantee the second `Do not` bullet below exists to protect, silently defeated for that one path
   shape.

## Do not

- Do not go back to exact-path equality (`normForCompare(a) === normForCompare(b)`) in
  `findLiveSessionClaimingWorktreePath` — it misses both the descendant case (`04e4262d`'s confirmed
  incident) and the ancestor case (an ancestor delete destroys the live worktree recursively).
- Do not make `pathsOverlap` one-directional ("is `a` contained by `b`") — it must check BOTH
  `isStrictlyUnder(a, b)` and `isStrictlyUnder(b, a)`, in addition to equality. A target that CONTAINS a
  live worktree is exactly as fatal as one that sits inside it.
- Do not skip the resolved form when realpath fails — the resolved (`normForCompare`) form must always
  be checked regardless of existence, so a target that doesn't (yet, or any longer) exist on disk still
  gets compared; `fs.realpathSync` only ever ADDS a form when it resolves, never replaces the
  resolved-form check. This is what makes the guard err toward refusing on a non-existent target rather
  than silently skipping it.
- Do not duplicate the realpath/case-fold normalisation inline again — `containmentForms` is the one
  place `worktreeRemovalRefusal`, `pathsOverlap`, and `pathOverlapKindAgainstForms` all get it from; a
  second ad hoc copy is how they would drift.
- Do not go back to dropping the wedge entry for an OVERLAP (non-exact) claimant hit in
  `staleKnowledgeGuard` — only an EXACT hit means the path is now genuinely owned by its claimant; an
  overlap hit is a structural anomaly (round 3) that must stay tracked (`needsHuman`), never silently
  dropped.
- Do not check `removingWorktreePaths` (or any sibling mutual-exclusion set guarding the same claim
  surface) by exact string match — use `pathsOverlap`, or the asymmetry round 3 fixed reappears.
- Do not strip a Windows extended-length prefix AFTER `path.resolve` — fold it on the raw input first;
  `path.resolve` does not itself collapse the `\\?\` form.

## Source

`packages/daemon/src/git/worktrees.ts` (`normForCompare`, `containmentForms`, `pathOverlapKind`,
`pathOverlapKindAgainstForms`, `pathsOverlap`) and `packages/daemon/src/sessions/service.ts`
(`findLiveSessionClaimingWorktreePath`, `reclaimWedgedWorktreePathForSpawn`) — fixed on card `623a7a62`,
a follow-up from Code Review `c1929951` of card `04e4262d`; round 3 is itself a follow-up from Code
Review `44cac5fd`.
