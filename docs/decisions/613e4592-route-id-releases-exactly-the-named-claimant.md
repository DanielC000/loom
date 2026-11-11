# 613e4592 — a latch id handed out in route / reason text releases exactly the named claimant

Follow-up to `c4f0d786` (which withheld an id that clears only SOME of a pending-only claimant's entries, in
`routeWithFollowableId` alone). Two false disclosures remained: other producers handed out ids with no such guard, and
the bare-hash id is AMBIGUOUS across identities (`<h>.json`, every `<h>.json.tmp-*` share it).

Reproduced before the fix (the c4f0d786 round-6 shape, test I): y's reduced pending entry on `<h>.json.tmp-B`, z1 on
`<h>.json.tmp-A`, a foreign host holding y's key. `clearMergeQuarantine(y)` named y AND z1 with the same id `<h>`;
following it lifted z1, removed y's pending entry, and y stayed blocked by the host. An id offered for one identity
acted on another.

## The rule (one guard: `routeIdsReleaseOnlyClaimant`, `merge-quarantine.ts`)

Handing out `ids` (a route id plus any `alsoClear` id) for the claimant `repoPath` is allowed only when following exactly
those ids releases the claimant and touches nobody else. It is a pure function of the in-memory entries (no latch file is
read or written). All four hold:

1. every entry the ids match is the claimant's. An id with an ACTIVE match takes the by-id clear's active branch and
   matches that first active entry only (a same-id pending entry is NOT removed by it, measured); an id with no active
   match matches every pending entry sharing it (`pendingLatchIdFor`).
2. every active AND pending entry of the claimant is matched (generalises c4f0d786's `idsLeaveOtherPendingEntries`, which
   is deleted; its pending-only behaviour is the special case). Skipped only for a two-step route whose other step is a
   `{repoPath}` clear (a dead id replaced by its repoPath step), which releases every entry of the claimant.
3. the by-id clear would not refuse an id (`routeIdWouldBeRefused`, unchanged).
4. nothing else still blocks the claimant AFTER the matched entries are gone: `stillBlockedEntryFor(repoPath, hit)` names
   no other identity. The lookup takes an exclusion set (threaded through `ownIdentityEntryFor`, the peek and
   `findPendingIndicesFor`, every tier), because evaluated on the CURRENT state an unresolvable claimant's own entry is
   returned first by `ownIdentityEntryFor` and hides a foreign host holding its key (round 2). One notion of "blocked",
   never a parallel check; a contributor fold is seen by the same lookup (`entryNamesIdentityAsContributor`).

Identity is `directPathIdentity` everywhere, the one `classifyKeptRepoPath`, `ownIdentityEntryFor`,
`canonicalSiblingsFor`, `routeIdWouldBeRefused` and the by-recorded-path clear already compare with. A subdirectory
claimant whose `canonicalRepoLockKey` differs from its identity is a DIFFERENT identity from its toplevel (consistent
with those helpers). Contributor strings are normalised with `directPathIdentity` before comparing.

Every producer goes through it (`followableIdFor`): `routeWithFollowableId` (hence `blockedCoOccupant`,
`blockedCoOccupantForReferencer`, `classifyKeptRepoPath`), `blockedCoOccupantBothRoutes` (the union of route + alsoClear),
`classifyKeptRepoPath`'s `blockedBy.id` (claimant = the blocker), and the two TEXT sites `stillQuarantinedReason` and
`assertRepoNotQuarantined`. Those two still PRINT the latch id descriptively; they only OFFER `{"id":...}` when the
guard passes. The two-step routes (`blockedCoOccupantBothRoutes`, `mergeKeptAndRelocatedCoOccupant`) share ONE builder,
`twoStepRoute`, which judges the UNION of the two candidate ids (the merge helper reads each input's raw candidate id
from a `WeakMap`, since each input was judged alone and a two-entry claimant had both ids withheld). A refused id is
replaced by an id-less `{repoPath}` step; the other id is then judged with `repoPathStepFollows` (clause 2 skipped, the
repoPath step releases the rest). `classifyKeptRepoPath` also asks the lookup with the claimant's OWN entries excluded:
a foreign blocker behind them is recorded as `blockedBy` on the claimant (it stays LIVE, see "Blocked-only rule", round 4).

When clause 4 fails the id is withheld and the claimant keeps its id-less `{repoPath}` route; `contentKeptBlockedBy` names the
real blocker beside it. `/internal/merge-quarantine/list` is an inventory of every id,
not a route, and is exempt.

## Do not

- Do not offer an id because "a file with this id exists": a bare hash matches `<h>.json` and every sibling tmp.
- Do not decide liveness from whether an id was offered, nor from physically owning a kept file: liveness is the in-memory
  oracle's answer (`classifyKeptRepoPath`, see "Blocked-only rule").
- Do not model the by-id clear as "removes every entry sharing the id": the active branch leaves a same-id pending entry.
- Do not add a second identity definition or a second "is it still blocked" helper; reuse `directPathIdentity` and
  `stillBlockedEntryFor`.
- Do not read the guard as proving the `{repoPath}` route releases the claimant: it clears the claimant's own entries
  (identity-scoped) but a foreign host can still block it; that blocker is named by `contentKeptBlockedBy`.

## Tests

`merge-quarantine-613e4592-route-id-releases-exactly-claimant.mjs`: multi-file shapes (sibling tmps, json+tmp,
json+safety-tmp) x 2 and 3 claimants, follows every produced id (and the `{repoPath}` route) and asserts the named
claimant is released and every other claimant keeps its blocked state, pending entries and files; text sites; a unit per
clause with a flipping control; the round-6 sibling-file shape. `merge-quarantine-c4f0d786-shared-tmp-residue-kept.mjs`
test E3 "survives" was updated: y is now a co-occupant with an id-less `{repoPath}` route and the foreign host as its
`contentKeptBlockedBy`, instead of a co-occupant offered the shared id (the false disclosure this card removes).

## Blocked-only rule (resolved, round 3)

`stillBlockedCoOccupants` names ONLY identities the in-memory liveness oracle (`stillBlockedEntryFor` /
`assertRepoNotQuarantined`) says are blocked, with no second predicate. Specimen: c4f0d786's test H / this card's [E], where
E has an ACTIVE entry armed at a stale key and owns the kept file by its fresh write target; measured
`assertRepoNotQuarantined(E).ok === true` and `stillBlockedEntryFor(E) === undefined` before and after the clear. E is
therefore disclosed as the kept file's owner (`latchKept` + `contentKeptRepoPaths`, the existing reclassification target for
a non-blocked referencer), never as a blocked co-occupant and never with a route. `referencingRepoPaths` stays TRUE
in-memory referencers only, so E is not there either. Both clear routes agree: the pending-branch sweep in
`clearMergeQuarantineByRecordedPath` now classifies its referencers with `classifyKeptRepoPath` instead of the bare
`blockedCoOccupant` (25d0d45b's round-4 rule). Do not reintroduce a "physical owner is live" branch in `classifyKeptRepoPath`.

The same rule moved two older specimens, both an unresolvable claimant whose own pending entry sits BEHIND a foreign ACTIVE
entry at the shared key (clearing the claimant cannot release it): `merge-quarantine-b6f573cf-active-co-occupant-route-id.mjs`
S1 (Y/a behind active Y) and `merge-quarantine-raise-protect-failure.mjs` crnit2 (d2 behind r's raise).

## Round 4: blocked AND behind a foreign blocker is both, at once

Round 3 applied the rule backwards for these specimens: it moved a claimant with its OWN live entry (so the un-excluded oracle
names it blocked) into `contentKeptRepoPaths` and out of `stillBlockedCoOccupants`, because a foreign blocker sits behind its
entry. Measured effect: the first clear result named only the blocker's step, following it left the claimant blocked by its own
entry, the claimant's own `{repoPath}` step was never offered, and `contentKeptOnlyReasonFor`'s "arms at the next boot" was false
(the entry is armed NOW).

`stillBlockedCoOccupants` holds EXACTLY the oracle-blocked identities, so such a claimant (`classifyKeptRepoPath`'s foreign
branch) is `{live:true, coOccupant (its id-less {repoPath} route), blockedBy}`: it stays a live co-occupant AND records the foreign
blocker in `contentKeptBlockedBy`, in the same result, never in `contentKeptRepoPaths`. The reason text carries the order
(`liveForeignBlockedOrderClause`): "clear '<blocker>' first, THEN clear '<claimant>'", appended to every reason that names kept
referencers (the by-recorded-path kept and still-quarantined branches, and `clearMergeQuarantineReporting`'s rebuilds).
`reclassifyNonLiveReferencing` and the by-recorded-path sweep folds record `blockedBy` for a live classification; a final pass
(`foreignBlockerBehindOwnEntries`) covers a live referencer a sweep classified without it. Content-kept stays ONLY for a
non-blocked owner such as [E]. Tests follow EVERY offered step in the order given for [F], [I1], [I2], S1 and crnit2 and assert
the claimant ends released with nothing else released.

## Do not (round 4)

- Do not move a claimant the oracle says is blocked into `contentKeptRepoPaths`; a foreign blocker adds a `blockedBy`, it does not
  remove the claimant's own step.

## Known residual

On a seam-built union (test [I2]) `clearMergeQuarantine(sub)` alone returns `liftedRepoPaths: []` with an empty reason although it
is the required first step. Pre-existing, out of scope here.
