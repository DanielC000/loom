# b6f573cf — a clear never hands out an `{id}` route the by-id clear refuses

Found by the probe of card `c4357c8e`. Y is a real repo with absent subdirs `a` and `b`; a corrupt `{` sits at
`hash(Key(Y)).json`. Boot re-entry of `[Y/a, Y/b]` diverts both to pending placeholders sharing that file F, and
an ACTIVE entry for Y is then armed at the same hash. `clearMergeQuarantine(Y/b)` returned
`stillBlockedCoOccupants` for Y and Y/a, both with `route.id = pendingLatchIdFor(F)`. Following that id through
`clearMergeQuarantineLatchFile` is refused (fd189d91: the id matches an active entry AND a pending entry of a
different repo), so the `{id}` route was dead for both; only `{repoPath}` worked.

## Why the card's proposed fix was not enough

The card proposed routing `sweepResult.referencingRepoPaths` through `blockedCoOccupantForReferencer`. That
function's first line returns the bare pending id for any physical owner of F — and Y IS a physical owner —
and Y's own `quarantineLatchFileIdsFor` id is the SAME 24-hex string (`hash(Key(Y))`). Swapping the call
site changes nothing for this shape. The id string is shared, so the id is dead for EVERY co-occupant of F
while the active/pending collision stands, the pending sharer Y/a included.

## Fix

Ids are built at several sites, not one. `routeWithFollowableId` / `followableIdOrUndefined` omit `id` when
`latchIdIsAmbiguousActiveVsPending(id)` — the same check `clearMergeQuarantineLatchFile` makes (first active
match by hash, pending of a different `directPathIdentity`). Through them now:

- `blockedCoOccupant` (every bare pending-id route) and the own-entry branch of `blockedCoOccupantForReferencer`.
- `classifyKeptRepoPath`'s rebuilt own-entry route and its `blockedBy.id` disclosure.
- `blockedCoOccupantBothRoutes` and `mergeKeptAndRelocatedCoOccupant` (a dead kept id drops the ID, never the
  STEP: `alsoClear` stays, id-less). Clear-by-path `{repoPath}` does NOT lift both latches for such an identity
  (checked with a real reboot: the OLD file survives and the identity re-quarantines), so
  `relocatedCoOccupantsReason` renders the two-step warning in every id / no-id combination. For a dead kept
  id the second step is stated factually (the OLD file's id is shared with another identity and cannot be
  followed by id; this identity re-quarantines on the next restart until that file is cleared; inspect it via
  `GET /internal/merge-quarantine/list` first). It never tells a human to clear the OTHER identity: that
  quarantine may be legitimately held, and lifting it is the over-lift this card exists to prevent.

Deliberately not changed: `mergeKeptAndRelocatedCoOccupant`, whose inputs are already built by the sites above
(an id-less kept route already falls back to the relocated route alone). `relocatedCoOccupantsReason` now
words an id-less route as "clear by repoPath" instead of printing `undefined`.

In `classifyKeptRepoPath`, an id-less route from `blockedCoOccupantForReferencer` means EITHER "no entry of the
repoPath's own" OR "its own entry, id ambiguous"; the `stillBlockedEntryFor` fallback distinguishes them, so
classification is unchanged. A pure pending sharer (no active owner) keeps its working id.

## Do not

- Do not hand out `route.id` for a co-occupant without checking the by-id clear would act on it; the id is a
  property of the shared FILE, so it is dead for every co-occupant of that file, not just the active one.
- Do not "fix" this by only swapping a call site to `blockedCoOccupantForReferencer` — its physical-owner
  shortcut returns the same pending id.
- Do not drop the id for a pure pending sharer; the unmarked shared-file id route lifts it
  (`merge-quarantine-b6f573cf-active-co-occupant-route-id.mjs`, S2).

## Not covered

The `classifyKeptRepoPath` own-entry route and `relocatedCoOccupantsReason` id-less wording have no fixture:
the active-owner shapes tried (`clearMergeQuarantine` on Y/a, Y/b, Y; `clearMergeQuarantineByRecordedPath`;
`clearMergeQuarantineReporting`) never reach them, and a source mutant reverting that route to the raw id
passes the test. Reaching it needs a pending entry that owns live armed keys.

Other reasons the by-id clear refuses an id (sibling/contributor/unknown-provenance ambiguity via
`ambiguousIdentitiesFor`, the pending-contributor refusal) can still leave a dead id; this record covers only
the active-vs-different-repo-pending collision.

The by-id clear's own pending branch (`clearMergeQuarantineLatchFile`, bare `blockedCoOccupant` on its own-file
sweep) cannot reach the active-owner shape: the same collision refuses the call before that branch runs (S3).
