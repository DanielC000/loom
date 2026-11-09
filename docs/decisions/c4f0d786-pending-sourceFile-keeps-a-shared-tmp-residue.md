# c4f0d786 — a surviving pending entry's sourceFile keeps a shared tmp / safety-tmp latch residue

Found by `7d767b90`'s investigation. A shared CORRUPT `<hash>.json.tmp-…` / `.tmp-safety-…` residue fanned out to
pending claimants w1, w2 (, w3). A pending-path clear of w1 ran `sweepTmpResidueForHashIfUnreferenced`, which decided
"is this file owned" ONLY from `orphanLatchFileOwners` (`orphanLatchFiles` of active and pending entries). w2 / w3
name the residue as their `sourceFile`, not in `orphanLatchFiles`, so nothing owned it, w1's tokens covered it, and
it was unlinked. w2 / w3 stayed blocked in memory, but a restart rebuilds from disk: nobody re-armed, and their
quarantine was silently lost (fail-OPEN). The shared `<hash>.json` shape never had this: it is swept through
`sweepOwnLatchFileUnlessOwnedElsewhere`, whose `physicalOwnerRepoPaths` counts a pending `sourceFile`.

## The fix

- `pendingSourceFileOwners(f, exempt)`: every SURVIVING pending entry whose `sourceFile === f` owns the residue
  (true parity with `physicalOwnerRepoPaths`' pending half; not limited to `sharedCorruptLatch` / placeholder
  entries — keeping a file another live claimant names is the fail-closed direction). The sweep unions it with
  `orphanLatchFileOwners` at BOTH owner checks (same-hash and cross-hash loops) via a sweep-local `ownersOfResidue`.
- ONLY the optional trailing `ownIdentityExempt` param exempts a pending owner, and only the two write sites pass it
  (`writeMergeQuarantineLatch`'s `sweepOtherTmpsOnSuccess`, and the active partial clear). `excludeIdentities` does
  NOT exempt (round 2): every pending-tier clear splices its removed entries out BEFORE the sweep, so any pending
  entry still in the list naming the file was not removed by this call and needs it — including a SURVIVING entry of
  the very identity being cleared (a by-id clear removes only the entries of the id it matched; the identity's
  other file's entry survives).
- (Round-1 error, corrected) exempting the whole removed IDENTITY lost the safety-tmp on a by-id clear of the json id
  (and the json on a clear of the safety id): in-memory blocked, disk empty, fresh boot armed nobody.
- The last claimant's release removes the residue (nothing names it any more): no leak.
- `routeWithFollowableId` omits an `id` that would clear only SOME of a pending-only claimant's pending entries (a
  shared `<hash>.json` beside a safety-tmp: the safety-tmp id leaves the json entry pending), so the route falls
  back to `{repoPath}`, which clears all of them. An identity with an active entry keeps its id. The check counts
  EVERY id handed out for the claimant (round 3): `blockedCoOccupantBothRoutes` hands out route + `alsoClear`, and
  following both may release it (the `8e8bc0be` D1 control); only when both still leave a pending entry does it
  collapse to the plain `{repoPath}` route.
- 7d767b90's removed-residue disclosure (`refsWhoseLatchFilesWereRemoved`, `sharedResidueRemovedReasonFor`) became
  unreachable and was deleted; the shared-tmp shapes now take the ordinary kept-latch / MAY RE-DIVERT text.

## Caller census (the sweep's call sites)

Splice-before-sweep, verified per caller (the removed entries are out of `pendingUnresolvedQuarantines` before the
sweep runs, so NO pending-owner exemption is passed): clear-by-id pending branch (`filter(!matchedPending.includes)`),
by-key pending loop (`splice` per removed entry, sweep after the loop), `tryClearMergeQuarantineByOwnIdentity` pending
branch (`filter(!matchedPending.includes)`, including `pendingSweep:"unreduced"`, where entries the active loop
reduced stay pending and DO still need the file), `clearTokenFromPendingIndices` remove branch (`splice(live)`).
Each now keeps a residue ANY surviving pending entry names, even one of the same identity.

`deleteMergeQuarantineLatchByKey` trailing sweep (round 3, replaces round 2's identity exemption): does NOT splice
first. The invariant "an identity-wide clear removes every same-identity pending entry later in the call" is FALSE
(a) in `clearMergeQuarantineByKey`, which ties only some pending entries — an untied or "reduce"-planned one survives;
(b) on `clearMergeQuarantine`'s ordinary and "none" routes, which call ByKey(…,true) with no pending pass after;
(c) in `tryClearMergeQuarantineByOwnIdentity`'s pending branch, which runs after its splice and, in "unreduced" mode,
leaves reduced same-identity entries pending. So the exemption is by ENTRY OBJECT, never identity or flag:
`pendingBeingRemoved` = the entries ByKey's `pendingPlan` marks "remove" (computed before the active loop) plus, for
`pendingSweep:"broad"` only, the outer set `tryClearMergeQuarantineByOwnIdentity` hands in (`outerPendingToRemove`).
"unreduced" / "none" hand in nothing; the pending-branch call at the end of `tryClear…` (already spliced) passes
nothing. NOTE (round 4): "unreduced" still REMOVES its untouched same-identity entries later in the SAME call (its
own pending pass), so ByKey's trailing sweep, which ran first, can keep a tmp and name the clearer as a referencer
that the pending pass then deletes. After the pass (beside `dropContentKeepsWhoseFilesAreGone`) the body runs
`dropDelegatedReferencersNoLongerLive` (round 6). Two earlier versions were WRONG: round 4 asked "does a file with this
route id exist on disk" (a plain tmp's id is the bare hash, shared with `<hash>.json` and every sibling tmp, so another
identity's file kept the clearer named); round 5 asked "does a live entry of the identity back this route ID in memory"
(an owner's keep id is the FILE's id, but `physicalOwnerRepoPaths` also counts an active entry armed at a different key
as the owner of its fresh write target, whose `quarantineLatchFileIdsFor` never contains that id, so a live owner whose
file is still on disk was dropped, and `clearMergeQuarantineByRecordedPath` and `clearMergeQuarantine` disagreed on one
state). The rule now carries the FILE and asks ByKey's own question: each delegated ByKey keep is carried into the body
with the exact `sourceFile` it was kept for (`ClearByKeyResult.keptSourceFiles`, set from ByKey's own repoPath ->
sourceFile map), and after the pending pass it is kept iff `classifyKeptRepoPath(rp, sourceFile).live` — the SAME
function ByKey's `reclassifyNonLiveReferencing` calls. Precisely: a referencer stays live iff it physically owns
`sourceFile` (`physicalOwnerRepoPaths`) OR still has its own followable entry; the file only decides when the
referencer has no own entry. Decided from MEMORY; otherwise the disclosure is dropped (nothing of this identity names
that file any more; the file itself is judged by the sweep, never by this check — it may still be on disk for another
identity).
Both routes therefore agree by construction. Only an entry that is still the very object the delegated call returned is
considered, so keeps the pending pass itself computed afterwards are never second-guessed. It only removes a disclosure.

The ByKey plan-"remove" half of `pendingBeingRemoved` is load-bearing for the DURABLE TOMBSTONE (round 5; round 4's
"undiscriminated" note was false): if a tied same-identity pending entry were not exempt, the trailing sweep would keep
its tmp early and ByKey's unpruned `keptReferencingRepoPaths` would feed `nonFailureOk`, so the cleared-tokens sidecar
(`merge-quarantine-cleared-tokens.dat`) is never written for the cleared token. Pinned by test G (both `armedKeys`
variants); a mutant emptying the half goes red. Why `14bdcb2f` P6 stays green: it clears via `clearMergeQuarantineByRecordedPath` -> "broad", so its Q is in
`outerPendingToRemove`, ByKey's trailing sweep stops counting Q as an owner (no early keep, so no withheld tombstone),
and the pending branch then removes Q. Without Q in the set the early keep would withhold the tombstone.
Raw fallback (no entry matches the id): a pending entry naming the file would have matched the id, so unchanged.

Write sites (`ownIdentityExempt = {entry identity}`): no existing test or reachable shape discriminates the exemption
(a dual-tracked twin is absorbed by the write's own graduation before the sweep runs). It is safe and must not be
deleted as dead: the exempt identity always still has a durable final latch (the just-written superset, or the
reduced latch at key `k`) that re-arms it at boot, and any tmp the exemption releases is either covered by the content
check against `entry.tokens` / `updated.tokens` or is corrupt and holds no tokens.

`4900c365` round 2 says not to add a sweep-gating parameter. `ownIdentityExempt` / `exemptPendingEntries` are
COMPATIBLE with that intent: they only NARROW the existing owner check (they can make the sweep treat fewer pending
entries as owners) and add no keep path of their own. But each is a fail-OPEN lever — a wrong exemption deletes a
file a live claimant needs — so every caller must prove its invariant (above) and no new caller may pass one without
doing the same.

## Do not

- Do not widen `orphanLatchFileOwners` itself: the graduated-clear shared-latch disclosure (`c755eac8`) shares it.
- Do not exempt a pending owner by IDENTITY on a pending-tier path (round 2): a by-id or "unreduced" clear leaves the
  same identity's other entries pending, and they still need the file. If a caller ever stops splicing first, exempt
  by the removed entry OBJECTS.
- Do not drop the write sites' `ownIdentityExempt` without re-proving the durable-final argument above.
- Do not restrict the owner to `sharedCorruptLatch` / placeholder pending entries (the narrower
  `survivingSharedClaimRepoPaths` rule): an evicted non-placeholder entry's `sourceFile` still re-arms at boot.
- Do not exempt the trailing sweep by identity or by `identityWideHumanClear` (round 3): exempt exactly the entry
  objects the call removes.
- Do not hand out a route `id` for a pending-only claimant that has pending entries under ids not handed out.
- A test that checks a tmp survived must read the file BEFORE any `activeMergeQuarantineFor` call: that lookup
  lazily graduates a resolvable pending entry and unlinks its source, masking what the clear did.
- Do not reintroduce a "removed from disk / blocked IN THIS PROCESS ONLY" disclosure without a reachable shape.

Test: `merge-quarantine-c4f0d786-shared-tmp-residue-kept.mjs` (4 shapes x 2/3 claimants x 3 by-path routes, two
boots, release-to-last, empty-dir no-leak, by-id, single-claimant control, write path). Mutants: dropping the
pending-owner union, dropping the partial-id guard.
