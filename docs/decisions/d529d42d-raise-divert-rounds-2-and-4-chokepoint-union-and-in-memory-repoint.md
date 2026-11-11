# d529d42d — rounds 2 and 4 of the raise-divert card (chokepoint union; the tombstone/fold regressions)

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Round 2 (Code Review 96a39432, B1) — the union lived only inside `enterMergeQuarantine`; a DIFFERENT writer reaching the same marked basename still lost it

Round 1's own union lived only inside `enterMergeQuarantine`'s raise-write call sites. A DIFFERENT writer
reaching the SAME marked basename — `consumeMatchedPendingsIntoArmedEntry`'s own call to
`writeMergeQuarantineLatch`, reached via lazy GRADUATION (`activeMergeQuarantineFor`, with
`skipDegradedOccupantGuard` FALSE — a graduation is never a raise) — renamed over it with only the
graduated entry's own in-memory tokens, losing whatever ORIG token only `final`'s own bytes still held.

Repro (Code Review's own):
1. R real; D=R/gone-subdir; `<Krhash>.json={D,[ORIG],Kr}`; boot.
2. Fail only the 1st read of `final`; `clearMergeQuarantineReporting(R)` — D evicted from memory, no
   pending record created (the `63e49ee2` accepted residual), `final` survives with ORIG still on disk.
3. `mkdirSync(D)`.
4. Fail EVERY read of `final`; `t2=enterMergeQuarantine(D)` — this card's own round-1 fix correctly
   diverts, leaving `final` untouched; restore reads.
5. `activeMergeQuarantineFor(D)` — this triggers lazy graduation of the diverted pending record (`t2`
   only). Pre-round-2: the write renames `{D,[t2]}` over `final`, losing ORIG outright.
6. Reboot, with NO clear at all: ORIG is lost.

### The fix — move the decision into `writeMergeQuarantineLatch`'s own chokepoint

**Manager ruling:** move the marked-basename decision INTO the `writeMergeQuarantineLatch` chokepoint, so
EVERY rename onto a marked basename goes through it — raise, graduation, sibling-consume, and
partial-clear rewrites alike.

`reconcileMarkedBasenameBeforeWrite(final, entry)` is the new, single implementation: when `final`'s
basename is marked, it re-reads `final` directly and returns `entry` UNIONED with its own on-disk tokens
(same identity), `entry` unchanged (different identity — the pre-existing guard/protect rules already
govern that; ENOENT/corrupt/different-but-resolvable — nothing to protect), or the literal string
`"unreadable"` (a genuinely unreadable FILE right now). `writeMergeQuarantineLatch` calls it, right after
its own pre-existing `wouldOverwriteDifferentUnresolvableOccupant` guard, for EVERY caller:
- A non-raise caller (`skipDegradedOccupantGuard` false) that gets `"unreadable"` REFUSES the write —
  exactly like the pre-existing guard already does for a confirmed-different-unresolvable occupant. The
  entry stays enforced in-memory only; its own existing pending/divert file is untouched.
- A raise (`skipDegradedOccupantGuard` true) never refuses (`e1cb7d33`) on `"unreadable"` — but by
  construction `enterMergeQuarantine`'s own pre-write divert decision (`resolveRaiseOverwrite`) already
  prevents reaching this function at all in that state; this is a defensive fallback, never the primary
  mechanism, for a raise.

`resolveRaiseOverwrite` no longer carries forward on-disk tokens itself — it ONLY decides divert vs.
proceed now; the union is `reconcileMarkedBasenameBeforeWrite`'s job alone (one mechanism, never two).

### Keeping in-memory consistent with the newly-durable bytes

Folding the union only into the bytes `writeMergeQuarantineLatch` writes would leave the CALLER's own
in-memory `activeQuarantines` entry stale the instant the write succeeds (the caller already placed its
own, pre-union object there before calling the write). `foldInOnDiskTokensIfMarked(final, entry)` is the
raise-side (and `consumeMatchedPendingsIntoArmedEntry`-side) convenience over the SAME
`reconcileMarkedBasenameBeforeWrite` — called by `enterMergeQuarantine` itself (never a parallel
reimplementation) right before an entry is armed into `activeQuarantines`, and by
`consumeMatchedPendingsIntoArmedEntry` itself (covering EVERY one of its own callers — raise,
lazy-graduation, and sibling-absorb alike) right before its own `armed` object is set there. Skips the
read entirely when the basename isn't marked (the same fast path the chokepoint itself takes).

### Nitpick 4 — `divertRaiseEntry` must union into EVERY same-identity pending record

Rewritten to collect every matching index via `collectPendingIndices` (mirroring `188b145f`'s own "collect
every identity-matching index, never just the first" rule), not a single `findIndex` — a second,
independently-tracked record for the same identity would otherwise be left stranded. Built by hand, same
reason `mergeTokenIntoPendingEntries` already is: `unionQuarantineEntries` always stamps `armedKeys` as an
array (never `undefined`), which would leave a cosmetic-but-needless `armedKeys: []` on a record with
nothing to carry there.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **b1** — the Code Review's own repro, verbatim. Asserts graduation carries ORIG forward both IN-PROCESS
  (`activeMergeQuarantineFor(d)`) and in the durable bytes at `final`, and that both tokens survive a
  reboot with no clear at all. Proven RED against round 1's own committed code (`9afda0c2`) and GREEN
  after, via `scripts/negative-control.mjs`.
- **b1-grad (graduation variant)** — identical setup, but `final` is STILL unreadable at the moment
  graduation runs (never restored before the query). The PRE-EXISTING degraded-occupant guard already
  refuses this write outright — this scenario is a CONTROL, not a discriminator (it passes on BOTH round 1
  and round 2's code, confirmed directly): it documents that the refusal path was already correct and
  remains so, and that both tokens still survive a reboot via the diverted pending record's own
  durability once reads are restored.

All 33 `merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green.

## Round 4 (Code Review 45de2406) — two FURTHER Critical regressions in round 3's own new code

CR3 confirmed B1/B2 fixed, ONE READ PER WRITE holding, and all 33 files + guards green on `f8a9debb`
(round 3's own commit) — but found two Critical blockers in round 3's own new code, both with a repro
that PASSES on `d1c88668` (round 2) and FAILS on `f8a9debb`.

- **BLOCKER 1 (fail-open), "Y".** Round 3's own tombstone — inside `deleteMergeQuarantineLatchByKey`'s
  successful-unlink branch, gated on `finalProtectOk` — fired on EVERY `finalProtectOk === true` outcome,
  but that covers BOTH "nothing foreign here" AND "a foreign occupant's content was successfully
  protect-copied aside and is STILL durably enforced" (`d2582692`'s own shape: a clear of R can find a
  wholly foreign D sharing R's own degraded key, copy D's content aside, and unlink `final` — "unlinked"
  there means "relocated", not "destroyed"). Tombstoning on that branch destroyed D's own tracking the
  instant R's FIRST clear succeeded, well before D's content was ever actually gone — so a LATER clear
  that genuinely could not confirm D's content (a real read failure) silently lost it for good instead of
  correctly keeping it until a reboot or a later successful read.
- **BLOCKER 2 (fail-closed resurrection... of an orphan, not a token), "X".** `consumeMatchedPendingsIntoArmedEntry`'s
  own round-3 raise-divert branch (`if (skipDegradedOccupantGuard) { divertRaiseEntry(armed); return
  {…diverted:true} }`) ran AFTER the matched pendings were already spliced out of
  `pendingUnresolvedQuarantines` and their `sourceFile`s stripped from `armed.orphanLatchFiles` (line
  ~1096, computed BEFORE the branch even checks `folded`). Nothing tracked those files any more once
  diverted — a SIBLING pending entry consumed alongside the raiser (a DIFFERENT identity sharing the
  raiser's own canonical key, via `collectCrossTierSiblingIndices`) was orphaned on disk with nothing
  left referencing it, and re-armed itself after a reboot.

### The fix

1. **`tombstoneIfNotSurviving(tokens, touchedFinalBasenames?)`** (merge-quarantine.ts) — THE ONE place any
   token is ever added to `clearedTokens`; every clear site calls this now, never `clearedTokens.add`
   directly. Tombstones a token ONLY IF, at the moment it's called: (a) no surviving record — active OR
   pending — currently holds it (a fresh scan of BOTH structures' CURRENT state, so every caller must call
   this AFTER its own mutations to both are already applied), AND (b) none of `touchedFinalBasenames` —
   every physical final this clear's own write path touched — is still marked `keptUnreadableLatchFiles`
   right now. (a) alone closes BLOCKER 1's own "copied aside, still enforced" shape (the copy's own fresh
   pending record is already visible to the scan by the time this runs). (b) closes the DIFFERENT shape
   (a) cannot see on its own: a clear that KEEPS a final because a READ failed (never confirming whose
   content it holds, never copying anything aside, never creating any new record) still evicts the
   in-memory entry — (a)'s scan alone would then wrongly read "nothing surviving" and tombstone content
   that is still physically, unconfirmed, sitting at that exact kept file.
2. **Every clear site now collects its own candidate tokens AND touched basenames, and calls the helper
   exactly ONCE, at its own end** — `clearMergeQuarantineByKey`, the pending-only drop loops in
   `clearMergeQuarantineByRecordedPath`/`clearMergeQuarantineLatchFile`, and the by-token routes
   (`clearActiveEntryTokenAtKey`/`clearPendingEntryByToken`, which still go through this SAME helper —
   calling it right after their own in-memory token-removal, before arming any write, so the scan
   correctly finds nothing surviving for a process-unique UUID; they pass no `touchedFinalBasenames`,
   since a by-token clear's own write is never the degraded read-failure-kept shape (b) describes).
   `deleteMergeQuarantineLatchByKey` itself NO LONGER tombstones anything — it only unlinks or keeps.
3. **`consumeMatchedPendingsIntoArmedEntry`'s raise-divert branch now folds every matched entry's own
   `sourceFile` into `armed.orphanLatchFiles` BEFORE calling `divertRaiseEntry`** — mirroring the
   non-raise branch's own pre-existing `toFold` logic a few lines below it. Excludes only
   `pendingDivertFilenameFor(armed.repoPath)` (the divert's own LIKELY write target) explicitly, rather
   than relying on the same-identity coincidence that happens to exclude most matched entries already
   (CR3's own note 3): a SIBLING's own `sourceFile` is a different identity and is never excluded by that
   coincidence, which is exactly what orphaned it pre-fix.

### Accepted residual (CR3 note 4) — never changed by this card

When a full clear KEEPS `final` because a read failed, the clearing entry's own tokens are NOT
tombstoned (per the fix above), and a later same-identity raise can union them back from `final`'s own
still-kept bytes. This is fail-closed and matches the pre-existing, documented "kept until a reboot or a
later successful read" rule (`63e49ee2`) — explicitly NOT a bug, and not touched by this card. See the
`round4-y` test's own later step (after the SECOND clear, with a genuine read failure) for where this
shows up directly.

### Tests

Ported CR3's own `zz-cr3-scratch.mjs` repros (Y and X) into `merge-quarantine-raise-protect-failure.mjs`
as `round4-y` and `round4-x` — the scratch file itself was deleted, never committed. `round4-y` asserts
orig survives in-process, on disk, and after a fresh-import reboot, across BOTH a successful
protect-copy clear (step 1) AND a genuine read-failure-kept clear (step 3) — and that
`clearByToken(d, t2)` afterward still leaves D enforced via orig. `round4-x` asserts the sibling's own
`sourceFile` is never an untracked orphan (gone, or named in some entry's own `orphanLatchFiles`) and
that neither the sibling's nor the raiser's own token re-arms after a reboot once both are cleared
in-process; its sibling's own `sourceFile` is a FIXED, arbitrary literal (never derived from either
identity's own hash), making it the dedicated "distinct sourceFile" case CR3 asked for — not a
same-identity coincidence.

Both proven RED on `f8a9debb` (round 3's own commit) and GREEN after, via `scripts/negative-control.mjs
--ref f8a9debb`. All 33 `merge-quarantine*.mjs` files re-verified individually, each exit 0. All static
guards (`pnpm --filter @loom/daemon guards`) re-verified green.

## Do not

- **(Round 2)** Do not add a SECOND, independent implementation of the marked-basename union/refuse
  decision at a new write call site — every caller of `writeMergeQuarantineLatch` already gets it for
  free via that function's own chokepoint; a raise-side caller that also needs its OWN in-memory entry to
  reflect the union calls `foldInOnDiskTokensIfMarked` (never re-reads `final` itself by hand).
- **(Round 2)** Do not assume folding `writeMergeQuarantineLatch`'s own chokepoint union into the durable
  bytes is enough — the CALLER already placed its own, pre-union object into `activeQuarantines` before
  calling the write; without `foldInOnDiskTokensIfMarked` (or `consumeMatchedPendingsIntoArmedEntry`'s own
  internal fold), the in-memory record goes stale relative to the disk the instant the write succeeds.
- **(Round 2)** Do not build `divertRaiseEntry`'s own merge via `unionQuarantineEntries` — it always
  stamps `armedKeys` as an array, never `undefined`, which is wrong for a record with nothing to carry
  there (the exact reason `mergeTokenIntoPendingEntries` already hand-builds its own merge too).
- **(Round 2)** Do not read the `b1-grad` (graduation-while-still-unreadable) test as proof of ANYTHING
  round-2-specific — verified directly that it passes unchanged on round 1's own code too; it is a
  control documenting the pre-existing guard's refusal, not a discriminator for this round's fix.
- **(Round 4, CR3 BLOCKER 1)** Do not tombstone inside `deleteMergeQuarantineLatchByKey`'s own
  successful-unlink branch (`finalProtectOk === true`) — that branch covers BOTH "nothing foreign here"
  AND "foreign content successfully copied aside, still enforced elsewhere." Tombstoning is now
  EXCLUSIVELY `tombstoneIfNotSurviving`'s job, called once at the end of the TOP-LEVEL clear function,
  never from inside this lower-level helper — it has no visibility into the clear's own full outcome.
- **(Round 4)** Do not call `tombstoneIfNotSurviving` with only the "surviving record" scan and skip
  `touchedFinalBasenames` — a clear that KEEPS a final because a read failed (never copying anything
  aside, never creating any new record) evicts the in-memory entry too, and the surviving-record scan
  alone cannot distinguish that from a genuine destroy. Every clear site that calls
  `deleteMergeQuarantineLatchByKey` (directly, or via a pending entry's own `armedKeys` loop) must
  collect that key's own final basename into `touchedFinalBasenames` and pass it through.
- **(Round 4)** Do not call `tombstoneIfNotSurviving` BEFORE every one of the clear's own mutations to
  `activeQuarantines`/`pendingUnresolvedQuarantines` (deletes, filters, splices) is already applied — the
  helper's own "surviving" scan reads CURRENT, live state; calling it early (e.g. right after `entry` is
  looked up, before `keysToLift` is even deleted) would see the entry still "surviving" via its own
  about-to-be-removed slot and never tombstone anything.
- **(Round 4; CORRECTED by Follow-up `d6efbc9b`)** Moved: this bullet (the prohibition against removing
  `clearActiveEntryTokenAtKey`'s own SECOND, unconditional `tombstoneIfNotSurviving` call) now lives, verbatim,
  in `d6efbc9b`'s own `## Do not` section (`docs/decisions/d6efbc9b-by-token-release-of-the-owners-last-token-tombstone.md`).
- **(Round 4, CR3 BLOCKER 2)** Do not let `consumeMatchedPendingsIntoArmedEntry`'s raise-divert branch
  call `divertRaiseEntry` without first folding `sourceFiles` (every matched entry's own source file,
  computed BEFORE this branch even runs) into `armed.orphanLatchFiles` — `matched` was already spliced
  out of `pendingUnresolvedQuarantines` earlier in this same function, so nothing else tracks those
  files once diverted. A SIBLING pending entry consumed via `collectCrossTierSiblingIndices` (a
  DIFFERENT identity than the raiser, sharing only the canonical key) is the shape this closes — it is
  never excluded by the same-identity coincidence that happens to cover the raiser's own matched entry.
- **(Round 4)** Do not exclude a matched `sourceFile` from that fold by assuming it shares the raiser's
  own identity — explicitly compute and exclude `pendingDivertFilenameFor(armed.repoPath)` (the divert's
  own LIKELY write target) instead. Folding it in too would be harmless (a redundant orphan reference to
  a file that's about to become the new record itself), but excluding the WRONG filename by assumption
  is how a sibling's own, genuinely distinct `sourceFile` goes untracked in the first place.
