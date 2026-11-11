# 05a3b6ad — a file holding only a cleared claimant's record is not kept for an active entry's claim on it (fresh write target or armed-key hash)

## Shape

An active entry E is armed at key K1, but its fresh write target `<hash(K2)>.json` is a pending claimant Y's `sourceFile` and
holds ONLY Y's record. A human clear of Y removes Y in memory. `physicalOwnerRepoPaths` still credited E as the file's owner
(the fresh-write-target half; its armed-key half, `<hash(K)>.json` for a key E is armed at, is the same shape: an arm proves no
content, and both halves are settled by the rule below), because `differentUnresolvableOccupantRepoPathAt` is called without `protectResolvableToo`: a
RESOLVABLE Y whose tokens no surviving entry holds (it was just cleared) returns "none". So `sweepOwnLatchFileUnlessOwnedElsewhere`
kept the file, the result disclosed E as content-kept with "will re-divert", and a fresh boot re-armed Y, the claimant the human
had just cleared. The keep also set `pendingAnyKept`, which withheld Y's durable tombstone. Found by the c4f0d786 round-5 review.

## Decision

E's fresh-write-target claim is aspirational: E's content is not in that file. `sweepOwnLatchFileUnlessOwnedElsewhere` now settles
an owner claim (and unlinks via `unlinkLatchFileConfirmed`) only when `activeOwnerClaimIsSettledByCoverage` proves ALL of:
- every owner is an active-entry claim (fresh write target or armed-key hash): no pending entry names the file as its `sourceFile`
  (`survivingSharedClaimRepoPaths` is also checked, defensively; it is subsumed by that pending check and is not an independent condition);
- a fresh read parses, the record's tokens are non-empty and each is in the clearing call's `candidateTokens` or already tombstoned
  for the record's identity (`markedFinalFullyCoveredByClear`);
- the record's identity is none of the owners' (an owner's OWN record is never settled).
A missing file (an earlier sweep in the same call removed it) is settled too: nothing is left to keep, so no claim can hold it.
Anything unprovable (unreadable, corrupt, an uncovered token, a different claimant) KEEPS the file, exactly as before.
This extends the rule already in the keptUnreadable branch (proven coverage may settle the active-armed-key / fresh-write-target
half, never a pending `sourceFile`).
The by-token pending-clear site now passes `live.entry.tokens` (its "remove" branch lifts the whole set); without them that route
could not prove coverage and kept the file.

## Behaviour measured per route (probe shape `res`, covered content)

by-recorded-path, by-path, by-id, by-token: before, the file stayed, Y re-armed after a boot; after, the file is removed, no
`latchKept` / E-referenced claim, Y not re-armed. by-id first removed the file but still claimed it kept for E, because a second
sweep re-checked the already-deleted file; the missing-file clause fixes that false claim.

## Read-to-unlink window

The decision reads the file TWICE (the helper's own identity read, then `markedFinalFullyCoveredByClear`'s re-read), then unlinks, all
one synchronous stretch inside this process, so no other code in this process runs between them. The window runs from the FIRST
read to the unlink. A write by ANOTHER process landing E's real content in that file inside it is NOT closed: this module
holds no cross-process lock for latch files at this point. Accepted residual: the daemon is the only writer of this directory, and
E's content is rewritten from memory on its next write. Not covered by a test.

## Do not

- Do not settle a claim when a pending entry's `sourceFile` is the file, when `survivingSharedClaimRepoPaths` is non-empty, or when the
  content is an owner's own record (see the NOT-covered controls in the test).
- Do not treat an unreadable or corrupt file as covered.
- Do not report a kept file for an owner after the file was removed.
- Do not settle the armed-key half either when the content is that owner's own record (same own-record check as the fresh-write-target half).

## Tests

`merge-quarantine-05a3b6ad-fresh-target-covered-clear.mjs` (the four routes, uncovered/corrupt/own-record/shared-claimant controls, the
unresolvable control). Updated pins of the old keep: `merge-quarantine-613e4592-route-id-releases-exactly-claimant.mjs` [E]/[E2],
`merge-quarantine-c4f0d786-shared-tmp-residue-kept.mjs` [H covered]/[H2 not covered], `merge-quarantine-clear-by-path.mjs` (AI) (the
fixture's file now holds R's own record, so R's claim stays real). Not exercised: a failed unlink (EPERM/EBUSY) on this path.
