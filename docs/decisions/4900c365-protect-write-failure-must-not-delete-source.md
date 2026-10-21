# 4900c365 — a failed protective copy must leave its source file alone, never be followed by the delete it was guarding against

Minor 2 from Code Review `972343bd` of `d2582692` (`324c9df1`) — a pre-existing fail-OPEN pattern, now
also present on the tmp-residue path `d2582692` itself introduced.

## The bug

`protectOccupantContentBeforeDelete` is the shared tail every clear-side "protect a foreign occupant's
content before destroying it" helper calls. When its own durable write (`writePendingDivertFile`) fails,
it logged an error and returned — `void`. Every caller ignored this and proceeded exactly as if the copy
had landed:

- `deleteMergeQuarantineLatchByKey`'s own `fs.unlinkSync(final)` ran unconditionally, regardless of
  whether `protectDegradedOccupantBeforeDelete`/`protectUnincorporatedOccupantBeforeDelete`/the
  `foreignPending` branch had just failed to copy a genuinely foreign occupant's content off of `final`.
- `protectForeignTmpResidueBeforeSweep` likewise ignored a per-file failure, so
  `sweepTmpResidueForHashIfUnreferenced`'s own unconditional unlink destroyed that exact tmp residue right
  after.

The occupant's in-memory record is typically already gone by this point too (the caller's own
`keysToLift`/`activeQuarantines.delete` already ran before `deleteMergeQuarantineLatchByKey` is reached),
so a failed protective copy lost the occupant both durably AND in memory — a genuine fail-open on a
disk-write-failure path. The log line claiming the occupant "stays enforced in-memory only... a later
boot can retry" was false: there was by then nothing left to retry from.

## The fix

`protectOccupantContentBeforeDelete` (and its two wrappers, `protectDegradedOccupantBeforeDelete` /
`protectUnincorporatedOccupantBeforeDelete`) now return a `boolean`: `true` for every "nothing to
protect" case (missing/corrupt/non-entry-shaped `final`, or a genuinely successful write), `false` only
when real foreign content was found and its durable copy failed to write.

- `deleteMergeQuarantineLatchByKey` ANDs the result of every protect call that targets `final` into one
  `finalProtectOk` flag and skips `fs.unlinkSync(final)` entirely when it is `false` — the original file
  stays on disk, so the normal boot-time recovery path (which re-reads every file in the quarantine
  directory regardless of what any in-memory bookkeeping believes) finds it again.
- `protectForeignTmpResidueBeforeSweep` now returns the `Set<string>` of tmp filenames whose protective
  copy failed; `deleteMergeQuarantineLatchByKey` threads that set into `sweepTmpResidueForHashIfUnreferenced`
  as a new, optional `excludeFilenames` parameter, which skips unlinking exactly those filenames.
- The failure log line no longer claims the occupant "stays enforced in-memory only" — it now states
  plainly that the caller keeps the original file on disk instead, so nothing is lost either way.

## Tests

`packages/daemon/test/merge-quarantine-protect-write-failure.mjs` — two fault-injected scenarios
(`fs.openSync` intercepted to throw `EACCES` for the pending-divert tmp write, same technique
`merge-quarantine-failed-migrate-latch-owner.mjs` already uses):

- **final-path**: a foreign, unresolvable occupant's content lives directly at `final` (no tmp residue
  involved) and is reached via `protectDegradedOccupantBeforeDelete`'s own `differentUnresolvableOccupantRepoPathAt`
  check. With the write injected to fail, `final` survives on disk, the occupant's token is still
  reachable via `assertRepoNotQuarantined`, and a reboot still recovers it. A clean (non-injected) run of
  the same fixture is the positive control — the file IS swept away normally when the write succeeds.
- **tmp-path**: reuses the `d2582692`-style R/D fixture (`R`, a real resolvable repo; `D = R/gone-subdir`,
  a nonexistent subdir whose tautological primary arm occupies `R`'s own key, with its own content backed
  only by a `.tmp-<pid>` residue). Clearing `R` while the tmp-divert write for `D` is injected to fail
  must leave `D`'s tmp residue on disk, with `D`'s token still blocking and surviving a reboot. The
  clean-write run (no injection) is the positive control, matching the pre-existing `d2582692-clear-
  resolvable-protects-foreign-occupant` scenario's own assertions.

Both scenarios proven RED on pre-fix code and GREEN after, via `scripts/negative-control.mjs`. All
`merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards (`pnpm --filter
@loom/daemon guards`) re-verified green.

## Round 2 (Code Review `66eab845` of `0e189a83`) — round 1 kept the file but left the occupant unenforced

Round 1 only kept the source file on disk. Two further gaps, both found live against round 1's own
`tp-fail` probe fixture (R/D, D's content only in a `.tmp-999` residue):

1. **(a)** Right after the failed clear, D's own tokens were `[]` and `assertRepoNotQuarantined(d).ok`
   was `true` (NOT blocked) — the occupant's in-memory record (already lifted by the caller before
   `deleteMergeQuarantineLatchByKey` ever runs) was never re-established, so round 1's log line claiming
   "nothing was lost, in memory or on disk" was false: the file survived, but enforcement did not, until
   a reboot re-read the surviving file from disk.
2. **(b)** In that same window, a wholly DIFFERENT, independently-reached call
   (`clearMergeQuarantineLatchFile(<the shared hash id>)`) returned `{ok:true, wasQuarantined:false,
   liftedRepoPaths:[]}` — as if nothing happened — while its own unconditional tmp sweep (reached via
   its "no entry matches this id" raw fallback, since D had no record to match) silently unlinked D's
   kept `.tmp` residue anyway. D was then genuinely lost after a reboot.

### The fix

`protectOccupantContentBeforeDelete`'s failure branch now ALSO re-establishes an in-memory
`pendingUnresolvedQuarantines` record that OWNS the kept file AT ITS OWN CURRENT NAME
(`finalBasename` — the final `.json` or the tmp residue's own basename, whichever this call targeted),
self-referencing that basename in the record's own `orphanLatchFiles`. This single mechanism closes both
gaps at once, with no new plumbing needed anywhere else:

- **(a)** `assertRepoNotQuarantined`/`activeMergeQuarantineFor` (via `ownIdentityEntryFor`/
  `findPendingIndicesFor`'s own direct-identity tier, which scans `pendingUnresolvedQuarantines` by
  `directPathIdentity` with no key/resolvability precondition) now find this record immediately — the
  occupant blocks IN THIS PROCESS, not only after a reboot.
- **(b)** `sweepTmpResidueForHashIfUnreferenced`'s existing, UNMODIFIED ownership check (`orphanLatchFiles
  ?.includes(f)`) and `physicalOwnerRepoPaths`' existing, UNMODIFIED `sourceFile`-equality check now find
  this record too, from ANY call path — not just the one that hit the failure. The round-1 exclude-set
  plumbing (`protectForeignTmpResidueBeforeSweep` returning a `Set<string>`,
  `sweepTmpResidueForHashIfUnreferenced`'s `excludeFilenames` param) is now redundant and was removed;
  both functions are back to their pre-round-1 signatures.

Verified live (round-1-vs-round-2 diff, both phases): with this fix, the SAME
`clearMergeQuarantineLatchFile(<shared hash id>)` call during the window no longer takes the "no entry
matches" raw fallback at all — the id now legitimately, unambiguously identifies D's own self-owned
record (R's own file is already gone by then), so the call takes the ordinary pending-match path and
genuinely lifts D, reporting `{ok:true, wasQuarantined:true, liftedRepoPaths:[d]}`. This is NOT "D stays
blocked after this call" — a caller holding D's own reported latch id is entitled to clear D by it, and
now correctly can, honestly. What round 2 actually closes is the DISHONEST shape: round 1 reported
`wasQuarantined:false` (nothing happened) while silently destroying data; round 2 either reports a
truthful, accounted lift, or (for any id that does NOT resolve to this occupant) leaves the file
untouched exactly as round 1 already did via the kept-on-disk mechanism.

### Scope note — the final-path fixture had to change

The original round-1 test's final-path scenario (D's content written directly to `final`, no
`resolvedKey` field) does NOT reproduce the "in-memory record already removed" bug shape at all: boot
NEVER arms an unresolvable repoPath's `.json` final directly into `activeQuarantines` without an explicit
`resolvedKey` field confirming it — it always defers to `pendingUnresolvedQuarantines` instead (matched
back by direct identity, unaffected by any later `activeQuarantines`-only eviction). The fixture was
updated to add `resolvedKey: Kr` to D's own `.json` content, which boot genuinely ARMS (confirmed via
`armedKeys` being non-empty) — only then does `clearMergeQuarantineByKey`'s `keysToLift`/
`activeQuarantines.delete` eviction actually remove D's only in-memory record, correctly reproducing (and
distinguishing pre/post round-2 fix for) the bug this round's own point (a) describes. Also corrected: the
scenario's own inline comment named the wrong protect function (`protectDegradedOccupantBeforeDelete`) —
the call actually reached in this exact shape is the `foreignPending`-gated direct
`protectOccupantContentBeforeDelete` call inside `deleteMergeQuarantineLatchByKey` (the `clearingRepoPath`
passed to `protectDegradedOccupantBeforeDelete` is itself `undefined` whenever `clearMergeQuarantineByKey`'s
own `entry` lookup for this key is `undefined`, which it is here before `resolvedKey` makes the entry
genuinely armed).

### Known gap tracked separately — read-side errors

`protectOccupantContentBeforeDelete`'s own `fs.readFileSync`/`JSON.parse` failure branches return `true`
("nothing to protect") for ANY read/parse error, including a non-ENOENT one (e.g. EACCES, EIO) where the
file genuinely exists with real content that simply couldn't be read right now — the same fail-open
SHAPE as the write-side bug this card fixes, just on the read side. Deliberately NOT fixed here — tracked
on a separate follow-up card. A future fix there should not assume this card's own write-side contract
(this function's boolean return) covers it; the read-side failure happens before any content is even
parsed, so there is nothing yet to protect-write in the first place.

### Known, accepted residual — the clearer can be re-blocked by the occupant's own token

After a `tp-fail`-style window (the occupant's write failed, kept and self-owned at its own key) and a
reboot, the ORIGINAL CLEARER (e.g. `R` in the fixtures above) can itself read as re-quarantined at that
same key by the occupant's own surviving token, if a later query for the clearer's own identity ever
walks through that key again. This is fail-closed (never a silent re-opening of a mutation window the
clearer believed was safe) and a repeat clear of the clearer's own identity resolves it the same way any
other stale-occupant-at-a-shared-key case already does in this module. No response-shape change.

### Known gap, NOT this card's scope — `enterMergeQuarantine`'s own two RAISE-side protect calls

Every claim in this record ("kept on disk", "stays enforced", the self-owned-record mechanism) is scoped
to the CLEAR-side callers this card actually fixed: `deleteMergeQuarantineLatchByKey` and
`protectForeignTmpResidueBeforeSweep`. `enterMergeQuarantine` has its OWN two bare
`protectDegradedOccupantBeforeDelete`/`protectUnincorporatedOccupantBeforeDelete` calls (around the
`existing`-branch raise and the brand-new-entry raise), which still silently discard a `false` return —
a write-side (overwrite-before-raise) occurrence of the identical shape this card closed on the
clear-side (delete-before-overwrite). PRE-EXISTING, not introduced or touched by this card, and
deliberately NOT fixed here — tracked as its own, separate follow-up card.

## Round 3 (Code Review `2dd131b4` of `1fa865f5`) — blocker B1: the failure branch bled a sibling's token

The round-2 fix at `protectOccupantContentBeforeDelete`'s own failure branch built the kept record as
`unionQuarantineEntries(priorAtFinal, toPersist)` — exactly the pattern `@decision c9114934 (round 3,
MAJOR #2)` forbids 9 lines above it, in the SAME function, for the SUCCESS path's own `toWrite`: a prior
pending ref found via `atFinalBasenameIdx` can be a LIVE REFERENCE to a boot-time
`armQuarantineKey`-unioned object a colliding, currently-RESOLVABLE sibling's own token was already bled
into (`armQuarantineKey`'s own union is unconditional, independent of whether any write ever succeeds —
see c9114934's own narrative). Unioning FROM it re-bleeds that sibling's token into the occupant's own
kept record, in-memory, on the very first failed protect call — no second collision needed.

**The fix:** the kept record's own base is `toPersist` ALONE, matching the success path's own discipline
exactly — never `unionQuarantineEntries(priorAtFinal, toPersist)`. The existing `atFinalBasenameIdx` slot
(when found) is still overwritten in place with this clean content (never left holding the stale,
possibly-contaminated object), same as the success path already does for its own analogous slot.

### Tests

`c9114934-no-token-bleed-on-failed-protect` (`merge-quarantine-protect-write-failure.mjs`) reuses card
`c9114934`'s own "in-memory-twin" X/Y fixture (`merge-quarantine-pass1-migrate-union.mjs`'s own
`in-memory-twin-clear-destroys-degraded-file`) with the pending-divert write injected to fail. Asserts,
in-process (no reboot, no successful write ever): X's kept record does not carry `y-token`. Then, after
`clearMergeQuarantineByToken(x, "x-token")` plus a reboot: neither `x` nor the already-cleared `y` reads
as blocked. All three proven RED on `1fa865f5` (pre-B1-fix) and GREEN after, via
`scripts/negative-control.mjs`; tree restored byte-identical.

## Do not

- **(Round 2)** Do not let a caller of `protectOccupantContentBeforeDelete` (or either of its two
  wrappers) assume the occupant is ALSO re-enforced in memory without checking — it is, as of round 2
  (a self-owned pending record), but that enforcement lives entirely inside this shared tail function;
  do not re-derive or duplicate it at a call site.
- **(Round 2)** Do not re-add an exclude-set/filtered-sweep PARAMETER to `sweepTmpResidueForHashIfUnreferenced`
  or a `Set<string>`-shaped EXCLUSION LIST return to `protectForeignTmpResidueBeforeSweep` "to be safe" —
  the self-owned pending record this round introduced already makes every reference-aware sweep in this
  module honour a failed protect's kept file, from any call path; a second, parallel SWEEP-GATING
  mechanism would only rot independently. **(Amended, card 182c01cc round 3, nit1)** — this bullet is
  about a sweep-gating mechanism, never about reporting. Card 182c01cc round 2 DID change this function's
  return to `Array<{repoPath, sourceFile}>` (a list of what it relocated) — that is REPORTING-ONLY, feeding
  the clear's own `stillBlockedCoOccupants`, and never consulted by any sweep to decide what to skip. The
  two are not the same change; this bullet does not forbid the reporting one.
- **(Round 2)** Do not write (or trust) a final-path fixture for this bug shape without an explicit
  `resolvedKey` field confirming the occupant was genuinely ARMED (`armedKeys` non-empty) before the
  clear — an unresolvable repoPath's bare `.json` final with no `resolvedKey` is deferred to
  `pendingUnresolvedQuarantines` at boot and never touched by `activeQuarantines`-only eviction, so such
  a fixture passes "both pre- and post-fix" for the wrong reason (it never exercises the eviction at all).
- **(Round 3)** Do not build the failure branch's own kept record by unioning with whatever
  `atFinalBasenameIdx` currently points at (`unionQuarantineEntries(priorAtFinal, toPersist)`) — that ref
  can be a live, boot-time `armQuarantineKey` union a colliding, currently-resolvable sibling's own
  token was already bled into. Use `toPersist` alone, exactly like the success path 9 lines above it.
- Do not let a CLEAR-side caller of `protectOccupantContentBeforeDelete` (or either of its two wrappers
  — `deleteMergeQuarantineLatchByKey`/`protectForeignTmpResidueBeforeSweep`, the only callers this card
  touched) proceed to delete/unlink/sweep the source it just asked to protect without checking the
  returned boolean — a `false` means genuine foreign content existed and the durable copy failed; the
  source must be left in place. (`enterMergeQuarantine`'s own two RAISE-side calls are a separate,
  pre-existing, not-yet-fixed occurrence of this same shape — see the dedicated section above; do not
  conflate the two when reasoning about what this card actually closed.)
- Do not read `true` as "a protective copy was made" — it also covers the overwhelmingly common
  "nothing foreign here, no copy needed" case. Only `false` is actionable.
- Do not revert the failure log line to claim the occupant "stays enforced in-memory only" — since this
  fix, the occupant's own source file is deliberately kept on disk instead; the old wording was already
  false before this fix (the in-memory record is normally already gone by the time this log fires) and
  would be newly misleading now that the real mitigation is "the file never got deleted."
