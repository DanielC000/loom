# 98039b36 — one shared, case-folded repoKey-name helper, never two independent comparisons

Code Review `b0369501` of card `98039b36`'s own fix (rejecting case-only-distinct `repos` registry keys)
found a real, reproduced bug the fix itself didn't cause but needed to close: two different functions in
`git/worktrees.ts` each compared a repoKey NAME against the registry with their own hand-written logic,
and those two comparisons had silently drifted apart.

## The drift

`isRegisteredRepoKeyAxisDir` was fixed (same card, earlier round) to fall back to a win32-only
case-folded scan when the exact `.has(repoKey)` lookup misses. `listStaleAsideWorktrees`'s own inline
registry check (`repoKeys?.has(entry.name)`) was never updated the same way — it stayed a plain exact
match.

The premise that let this slide was: "a registered key's on-disk dir name always exactly equals one of
its own stored spellings, because Loom itself creates that dir from the literal key string." That premise
is false in one case: `validateRepoRegistry` only guards key COLLISIONS within a single validation call
(two entries in the same array folding to the same lowercase form); it was never meant to, and does not,
restrict a case-only RENAME of a single key against the project's own history (stored key "Svc" PATCHed
to "svc" — one entry, no collision to catch). That rename is legitimate and stays allowed — it is not a
new bug surface, and this card adds no new validator rule to block it.

On win32, NTFS is case-insensitive but case-PRESERVING: the physical directory created under the OLD
spelling ("Svc") survives a registry rename untouched, still named "Svc" on disk, even though the
registry's current spelling is now "svc". After such a rename:

- `listStaleAsideWorktrees`'s unfolded `repoKeys.has("Svc")` against a registry now holding only `{"svc"}`
  returns `false` — the live axis dir is wrongly treated as UNREGISTERED. Any real `.stale-<ts>` leftover
  nested one level under it is then never enumerated, and so never offered for reclaim — permanently
  invisible, permanently un-reclaimable, silently consuming disk.
- For a repoKey shaped like a stale suffix itself (e.g. stored as "Svc.stale-1", exempted via
  `existingKeys`, then renamed to "svc.stale-1"), the same miss causes the opposite mistake: the LIVE axis
  dir (still named "Svc.stale-1" on disk) falls through to the basename-shape check, which matches, and
  the live dir is wrongly LISTED as a reclaimable leftover. The actual reclaim call is still refused — by
  `isRegisteredRepoKeyAxisDir`'s own fold, independently — so this specific case never destroys data, but
  the listing itself is wrong and misleading.

Code Review `b0369501` reproduced both shapes against `dist`.

## The fix

Extracted ONE shared, unexported helper, `isRegisteredRepoKeyName(name, keys)`, in `git/worktrees.ts`:
exact match first, then — win32 only — a case-folded linear scan of `keys`. Both
`listStaleAsideWorktrees`'s registry check and `isRegisteredRepoKeyAxisDir`'s own lookup now call this
ONE function instead of each writing (and silently drifting from) their own comparison.

## Do not

- Do not re-introduce a second, independently-written repoKey-name comparison anywhere in
  `git/worktrees.ts` (or elsewhere) — route every "is this name a registered repoKey" question through
  `isRegisteredRepoKeyName`, or the next edit to one side can silently drift from the other exactly as
  happened here.
- Do not add a validator rule in `validateRepoRegistry` to block a case-only RENAME of a single key
  against history. That is NOT this card's fix — the rename stays allowed; `isRegisteredRepoKeyName`
  being shared and folded on win32 is what makes it safe to allow.
- Do not assume a registered key's on-disk dirent name always exactly matches one of its CURRENT stored
  spellings — a case-only rename is the counterexample, and it is a legitimate, unrestricted operation,
  not an edge case to validate away.
- Do not export `isRegisteredRepoKeyName` unless a second module genuinely needs to call it — both
  current callers (`listStaleAsideWorktrees`, `isRegisteredRepoKeyAxisDir`) live in `git/worktrees.ts`.

## Source

Card `98039b36`, Code Review `b0369501` (finding 1 of that review). Tests:
`test/stale-worktree-leftovers.mjs` (the case-only single-key-rename scenario, both the
plain-leftover-visibility shape and the stale-suffix-shaped-key shape), `test/repos-registry-rest.mjs` /
`test/repos-registry-rebind-conflict.mjs` (payload-ordering and PATCH-adding-a-collision cases, finding 2
of the same review).
