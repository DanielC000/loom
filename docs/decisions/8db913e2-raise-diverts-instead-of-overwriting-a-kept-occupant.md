# 8db913e2 — a raise diverts to a pending record instead of overwriting a kept occupant's physical file

A pre-existing follow-up from Code Review `2dd131b4` of `4900c365`, refined by three triage notes (Code
Review `91b49a21`, `b1d4614c`, and `fe4bb9ef`, all against `63e49ee2`) into three concrete repro shapes.
`enterMergeQuarantine`'s own raise-write call sites skip the degraded-occupant guard unconditionally
(`e1cb7d33`: a raise must persist, never refuse) with no fallback protection of their own:

1. `protectDegradedOccupantBeforeDelete`/`protectUnincorporatedOccupantBeforeDelete`'s own `false`
   return (a confirmed foreign occupant whose protective copy failed, or a non-ENOENT read failure with
   nothing to copy aside from) was IGNORED at every raise-write call site — the guard-skipped write then
   overwrote the kept occupant's file outright.
2. Even a `true` ("none") return can be STALE: `final`'s basename can be marked
   `keptUnreadableLatchFiles` from an EARLIER read failure that evicted the in-memory record without ever
   creating a pending one (`63e49ee2`'s own accepted residual) — a later raise of the SAME identity's own
   fresh, successful read proves only that THIS read worked, not that nothing was lost from memory.
3. A same-identity re-raise's rename SUCCEEDS but overwrites `final` without UNIONING whatever token(s)
   were already outstanding there.

## The fix

Design ruling (option (a) from the card's own triage): never refuse the raise's write (`e1cb7d33` still
holds) — instead DIVERT it to a pending-divert record when `final` cannot be safely written to, union
on-disk tokens forward when it can.

Two new functions in `merge-quarantine.ts`:

- `resolveRaiseOverwrite(final, ownRepoPath, ownTokens, protectOk)` — the single decision point every
  raise-write call site threads its own protect call's return through. `protectOk === true` with `final`'s
  basename NOT marked is the fast path (no-op for the overwhelming majority of raises). Otherwise this
  function re-reads `final` itself: `ENOENT`/`EISDIR` ⇒ proceed (nothing real there — see the EISDIR note
  below); any other read error ⇒ divert (a real file exists that cannot be read); a successful read with
  the SAME identity ⇒ carry its on-disk tokens forward; a different identity already covered by token
  overlap (the existing-branch's own `unincorporatedOccupantRepoPathAt` exemption, re-derived here so a
  prior union's own winning-side leftover is never spuriously re-protected) ⇒ unchanged; a different,
  still-unresolvable identity ⇒ durably protect it via `protectOccupantContentBeforeDelete` before the
  write proceeds, diverting only if THAT protect call also fails; corrupt or a different-but-resolvable
  identity ⇒ unchanged (today's existing, deliberately-unprotected case).
- `divertRaiseEntry(entry)` — unions `entry` into whatever pending record already matches its own identity
  (durably rewriting it in place), or mints a brand-new `pending-<24hex>.json` record otherwise, mirroring
  `enterMergeQuarantine`'s own pre-existing `!verified` brand-new-divert branch. Never touches `final`.

Wired at every raise-write call site in `enterMergeQuarantine`: the `existing`-truthy branch's own
`protectUnincorporatedOccupantBeforeDelete` call, and the `verified`-gated `protectDegradedOccupantBeforeDelete`
call in the "no existing" region (covering both the pending-merge write and the brand-new-entry write,
since the divert decision runs before either is reached).

### The EISDIR trap (round 1 of this card) — a regression against `merge-quarantine-boot-hardening.mjs`

A first version of `resolveRaiseOverwrite` diverted unconditionally whenever `protectOk` was `false`,
without re-reading `final` itself. This reproduced, on the RAISE side, the EXACT mistake `63e49ee2` round
4 already made and reverted on the CLEAR side: `merge-quarantine-boot-hardening.mjs`'s own
WRITE-FAILURE-RESIDUE scenarios (`WFR-1`, `PCWF`) deliberately create a DIRECTORY at a latch's own final
path to force a deterministic rename failure — reading a directory throws `EISDIR`, which the existing
detectors already classify as `"unknown"` (by design, unchanged — see `63e49ee2`'s own round-5 "Do not"),
so `protectOk` was `false` for a reason that has nothing to do with lost foreign content: a directory can
never hold valid latch JSON in this module. Diverting here rerouted the raise to a pending-divert record
instead of letting the pre-existing, already-tested tmp-residue-on-failed-rename mechanism run, breaking
both scenarios' own hardcoded tmp-file expectations.

**The fix:** `resolveRaiseOverwrite` always re-reads `final` itself (never short-circuits on `protectOk`
alone) and classifies `EISDIR` the same as `ENOENT` — nothing real to protect, proceed with the ordinary
write. Only a genuinely unreadable FILE (EACCES/EPERM/EMFILE/...) diverts. Verified directly: reverting
just this EISDIR carve-out reproduces the `WFR-1`/`PCWF` regression; restoring it, and nothing else,
fixes both.

## Tests

`packages/daemon/test/merge-quarantine-raise-protect-failure.mjs` (new) — three scenarios, each with its
own reboot assertion, measuring the TOKEN directly (never `assertRepoNotQuarantined`):

- **shape 1** ("fp:reraise") — a confirmed, pure-pending (no `resolvedKey`) foreign occupant D sits at R's
  own key; D's final is left persistently unreadable (EACCES) when R raises. Asserts D's own content
  survives byte-for-byte, R's own raise still persists in-process (diverted), and both tokens survive a
  reboot. Its own positive control (no injection) confirms today's existing, legitimate-overwrite path
  (D safely relocated, R's write lands at `final`) is unchanged.
- **shape 2** ("no-fault") — a transient read failure marks `final`'s basename kept and evicts D's
  in-memory record (no pending record is ever created on an "unknown" read); D becomes resolvable and
  raises itself again (same identity). Asserts the re-raise carries D's ORIGINAL token forward, both
  in-process and across a reboot. Its own control (no injection) confirms the bug is read-failure
  specific, not the scenario shape itself.
- **existing-branch** — the SAME decision wired at `enterMergeQuarantine`'s OTHER raise-write site (the
  `existing`-truthy region): D2 is armed directly at boot (its own `resolvedKey`), so R2's own raise into
  D2's already-armed entry reaches `existing` truthy with a persistently-unreadable final. Asserts
  `final`'s own original bytes are untouched and both D2's and R2's tokens survive, in-process and across
  a reboot.

`round5-rename-unmarks` in `merge-quarantine-protect-read-failure.mjs` (rewritten in place — this is shape
3's own dedicated fixture, not duplicated in the new file): asserts the re-raise now carries the ORIGINAL
token forward, that a partial clear of only the fresh token leaves the file on disk with the original
still active (in-process AND across a reboot), and that clearing the original token too finally unlinks
the file. The file's own stale `KNOWN GAP` note (naming this card) is removed.

All three new assertions (shape 1, shape 2, existing-branch) and `round5-rename-unmarks`'s new assertions
proven RED against `HEAD` (pre-fix) and GREEN after, via `scripts/negative-control.mjs` — including the
EISDIR regression: `merge-quarantine-boot-hardening.mjs` passes clean on BOTH sides, confirming it was
never a discriminator for this card's own fix (it was a REGRESSION this card's round 1 caused and round 1
fixed in the same pass, before any of this was reported as `done`). All 33 `merge-quarantine*.mjs` files
re-verified individually, each exit 0. All static guards (`pnpm --filter @loom/daemon guards`)
re-verified green.

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

## Round 3 (Code Review 1da7261f) — two FURTHER regressions round 2's own chokepoint union introduced

Code Review `1da7261f` found two Critical blockers in round 2's own fix, both regressions of round 2:

- **B1, fail-closed RESURRECTION.** A partial clear's own write (`clearActiveEntryTokenAtKey`) hits
  `final`'s own MARKED basename, so `writeMergeQuarantineLatch`'s chokepoint re-reads `final` and unions
  its on-disk tokens forward — but a STALE pre-clear copy of those bytes can still carry the EXACT token
  this clear just durably removed, resurrecting it. Repro: `t1=enter(R); t2=enter(R)`; fail reads #1-#2 of
  `final` during `t3=enter(R)` (diverts, carrying `t1,t2,t3` forward in a pending twin, `final` untouched
  at `[t1,t2]`); restore reads; `clearByToken(R,t1)` — the chokepoint's own union reads `final`'s still-
  `[t1,t2]` bytes and re-adds `t1`, even though this exact write just durably removed it.
- **B2, FAIL-OPEN.** `foldInOnDiskTokensIfMarked` (the caller's own reconciliation, run before arming) and
  `writeMergeQuarantineLatch`'s own chokepoint each read `final` SEPARATELY for the SAME write. A
  transient failure between the two could let memory and disk diverge (one succeeds, one fails) — or,
  when BOTH fail, the chokepoint's own `skipDegradedOccupantGuard` branch proceeded BLIND ("should be
  unreachable in practice, safe either way"), overwriting `final` outright and losing the on-disk
  occupant's content immediately.

### The fix

1. **`clearedTokens`** (`merge-quarantine.ts`) — a process-wide `Set<string>` of every token this process
   has deliberately cleared: by-token (`clearActiveEntryTokenAtKey`/`clearPendingEntryByToken`, tombstoned
   BEFORE either function's own write, since tokens are random v4 UUIDs never re-minted and that write's
   own chokepoint union must see the tombstone to correctly exclude the token it is dropping), and every
   token of an UNCONDITIONAL full clear's own successfully-destroyed copy (see point 2 — never at a bare
   "an entry occupies this key" lookup). Subtracted from `reconcileMarkedBasenameBeforeWrite`'s own union
   of on-disk tokens — the one shared chokepoint every write-time union runs through. In-memory only; a
   reboot resets it, safely, because a reboot re-reads disk fresh and the clear's own durable write already
   removed the token from that entry's file before the process exited.
2. **Tombstone only on a CONFIRMED destroy, never on a bare key-occupancy lookup.** `clearMergeQuarantineByKey`
   can legitimately find an entry armed at the key being cleared and then KEEP its physical file,
   fail-closed, when protection is uncertain (`d2582692`'s own shape — a degraded, walked-up key can be
   occupied by a wholly foreign entry). Tombstoning at that bare lookup (the FIRST implementation tried
   here, which turned the `b1` test from round 2 red for the wrong reason) would wrongly suppress that
   entry's own later, legitimate reconciliation from its still-physically-present bytes. The fix:
   tombstone ONLY inside `deleteMergeQuarantineLatchByKey`'s own successful-unlink branch (`finalProtectOk`
   true, via `clearedEntry.tokens`), and ONLY after a pending-entry sweep (`sweepOwnLatchFileUnlessOwnedElsewhere`)
   reports `kept:false` for that entry's own `sourceFile` — never before either outcome is known.
3. **ONE READ PER WRITE.** `foldInOnDiskTokensIfMarked` now returns `MergeQuarantineEntry | "unreadable"`
   (never silently swallowing `"unreadable"` into the unchanged entry, as round 2 did) — the SAME result
   the caller already computed before arming is passed into `writeMergeQuarantineLatch` via a new
   `reconciledAlready` parameter, which skips the chokepoint's own independent re-read entirely when set.
   Every raise call site (`enterMergeQuarantine`'s two direct write sites, `consumeMatchedPendingsIntoArmedEntry`)
   now does the reconciliation ONCE and reuses it for both the in-memory entry and the durable write.
4. **An "unreadable" result at a raise now diverts, never proceeds blind.** When the caller's own
   fold-in reconciliation is `"unreadable"`, a raise diverts via `divertRaiseEntry` INSTEAD of arming or
   writing at all (e1cb7d33 still holds — the raise persists via the divert). The chokepoint's own
   defensive fallback (for a raise reaching it un-pre-reconciled, which no current call site does) also
   diverts rather than "proceeding anyway" — the stale comment claiming that was safe either way is gone.
5. **`consumeMatchedPendingsIntoArmedEntry`'s own silent write-failure.** `activeMergeQuarantineFor`'s
   `direct`-truthy sibling-absorb call site discarded this function's own `writeSucceeded` with no log at
   all — fixed to log the same way its OTHER call site (the no-`direct` branch) already does.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **b1-resurrection** — `t1=enter(R); t2=enter(R)`; fail reads #1-#2 of `final` during `t3=enter(R)`
  (diverts); restore; `clearByToken(R,t1)` — asserts `final` durably EXCLUDES t1 (not merely that it's
  gone in-process). A SECOND, independent transient read failure during a fresh `t4=enter(R)` proves the
  tombstone survives more than the one failure that exposed the bug. Clearing t2/t3/t4 afterward asserts R
  is fully lifted, never left permanently stuck on a resurrected t1 — in-process, on disk, and after a reboot.
- **b2-r3** / **b2-r3r4** — the card's own B2 repro (D's raise while `final`'s marked basename is still
  unreadable), run twice: failing only read #3 (`foldIn`'s own read) and failing reads #3 AND #4 (the
  pre-fix chokepoint's own now-unreachable second read) — both must produce the identical, fixed outcome
  (diverted, `final` untouched, ORIG correctly rejoins at the next graduation, survives a partial clear and
  a reboot).

Both proven RED on `d1c88668` (round 2, this card's own `9afda0c2`→`d1c88668` state) and GREEN after, via
`scripts/negative-control.mjs`. B2 is structurally inapplicable to round 1 (`9afda0c2`): that commit has
NEITHER `reconcileMarkedBasenameBeforeWrite` NOR `foldInOnDiskTokensIfMarked` at all (zero occurrences) —
`writeMergeQuarantineLatch` had no marked-basename chokepoint whatsoever, so there is no "two separate
reads of the same write" shape to pose the same way; not independently run against it.

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

## Follow-up d6efbc9b (CR4 of this card, finding 1) — a by-token release of the owner's LAST token could leave it un-tombstoned

CR4 found that `clearActiveEntryTokenAtKey`'s last-token branch (the owner releases its only remaining
token) hands off ENTIRELY to `clearMergeQuarantineByKey`, whose own `tombstoneIfNotSurviving` call is
gated by condition (b) on `touchedFinalBasenames` for the PHYSICAL FINAL it's deciding whether to
destroy. If that final's read fails during this exact clear, (b) correctly keeps the final (fail-closed —
`63e49ee2`'s own accepted residual) and returns early WITHOUT tombstoning — but the token the owner just
RELEASED is a separate fact from the final's own fate, and it was never tombstoned either.

Repro (CR4's own scratch probe Z3, commit `cb461f56`, ported as `d6efbc9b-z3` in
`merge-quarantine-raise-protect-failure.mjs`):
1. `t1 = enterMergeQuarantine(R)` — R's only token.
2. Fail read #1 of R's own `final`; `clearMergeQuarantineByToken(R, t1)` — R is lifted IN-PROCESS (the
   last-token branch's own in-memory removal), but `final` is kept-and-marked, still physically holding
   `[t1]`, and `t1` is never tombstoned.
3. `t2 = enterMergeQuarantine(R)`, no injection — the fold-in reads `final`'s still-kept, still-`[t1]`
   bytes and re-unions the released `t1` back in, both in-process and on disk.
4. `clearMergeQuarantineByToken(R, t2)` — R stays quarantined by `t1`, which nobody holds, until a human
   clears it by hand.

### The fix

After `clearMergeQuarantineByKey(key, entry.repoPath)` returns in `clearActiveEntryTokenAtKey`'s
last-token branch, call `tombstoneIfNotSurviving([token])` unconditionally (no touched list) — matching
`clearPendingEntryByToken`'s own last-token branch (which already does this directly). This is not a
second, special-cased rule: it is `tombstoneIfNotSurviving`'s one invariant, applied a second time to a
second question. `clearMergeQuarantineByKey`'s own call answers "is the physical final destroyed, and if
not, why" (gated by (b) on the final's own kept-marked state); this call answers "is the owner's own
`token` gone" (tokens are process-unique UUIDs, so (a)'s surviving-record scan is sufficient on its own —
the final's fate is irrelevant to whether `token` itself survives anywhere). Both corrected doc comments
(`tombstoneIfNotSurviving`'s own jsdoc, and this record's own round-4 "Do not" bullet below) previously
claimed every by-token clear site passes no `touchedFinalBasenames` and never special-cases — true of
`clearPendingEntryByToken` and of the non-last-token branches, but not of this one delegated call.

### Tests

`d6efbc9b-z3` in `merge-quarantine-raise-protect-failure.mjs` — asserts R is lifted in-process after the
read-failure-gated release, that a fresh same-identity re-raise does NOT resurrect the released token
in-process, that releasing the second token fully lifts R in-process, and that neither token is
resurrected after a reboot through a fresh module import (never `assertRepoNotQuarantined`). Proven RED
on `d529d42d` (this card's own rounds 1-4, squashed) and GREEN after, via `scripts/negative-control.mjs`. CR3's own
`round4-y` scenario (a clear that successfully protect-copies a FOREIGN occupant aside must never
tombstone it) re-verified green, unaffected by this change — it exercises `clearMergeQuarantineByKey`'s
own full-clear path directly, never the by-token last-token branch this follow-up touches. All 33
`merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green.

## Follow-up dd34da46 (Code Review 96a39432, Minors 1-3) — three fail-closed residuals left by this card

Manager ruling on three Minor findings from the Code Review of this card. All three are fail-closed (no
fail-open); none regress any "Do not" bullet above.

### Item 1 — a full clear that provably holds every token in a stale-marked `final` may unlink it

An existing-branch divert (the `existing`-truthy call site's own `mustDivert` branch) never touches
`final` — so a `keptUnreadableLatchFiles` mark set by an EARLIER, now-resolved transient read failure
stays set indefinitely (nothing durable ever writes to clear it). A LATER full clear of the same merged
identity (e.g. `clearMergeQuarantineByRecordedPath`) used to keep `final` unconditionally because of that
stale mark alone (round 5 of `63e49ee2`'s own unconditional check), even though reads have since recovered
and a fresh read proves every token physically there is already one this exact clear is dropping. Pre-fix,
the cleared token comes back once after a reboot (PASS 1 re-reads the now-readable, still-kept file).

**The fix:** `markedFinalFullyCoveredByClear(final, candidateTokens)` — a fresh, direct content read of
`final` RIGHT NOW, proving every on-disk token is already in `candidateTokens`. ENOENT/EISDIR (nothing
real there) and corrupt JSON (nothing usable) are trivially covered; any OTHER read failure, or a real
on-disk token not in `candidateTokens`, cannot be proven safe and keeps today's behavior. Wired into
`deleteMergeQuarantineLatchByKey`: when the mark is the ONLY reason `finalProtectOk` would go false, this
check decides whether to drop the mark (and proceed to unlink) or keep `final` exactly as before. This is
NOT the detector-result trust round 5 forbids (`differentUnresolvableOccupantRepoPathAt`/
`unincorporatedOccupantRepoPathAt`'s own identity-only "none") — it is a dedicated, content-level
containment check, gated on `finalProtectOk` already being true from every OTHER protect call (a genuine
foreign-occupant finding from those calls is never overridden here).

### Item 2 — a shape-1 divert plus a query leaves `clearMergeQuarantineLatchFile(id)` correctly refusing; no code change

Investigated directly (empirical probe against the real compiled module, matching shape 1's own fixture):
a shape-1 divert (D pure-pending at R's own real key, R's raise diverts) followed by a QUERY
(`activeMergeQuarantineFor(r)`, triggering lazy graduation) leaves R armed IN-MEMORY at the same key, but
R's own durable write there is REFUSED by the pre-existing degraded-occupant guard (D's content genuinely,
unresolvably occupies that exact physical file). R's own exposed latch id (`quarantineHashForKey`'s own
value for its armed key) therefore coincides EXACTLY with D's own physical file id — R has NO durable
backing at this id at all, while D is the confirmed physical owner, yet `quarantineLatchFileIdsFor`
reports this id for BOTH.

`clearMergeQuarantineLatchFile(id)` ALREADY refuses this case (the pre-existing `differentRepoPending`
check, from card `9a55fb90`/era): it finds the active match (R) AND a pending entry for a DIFFERENT repo
(D) sharing this exact id via `pendingLatchIdFor`, and refuses rather than guessing, naming BOTH
candidates' own `repoPath` and the precise `clear-by-path` remedy (`POST
/internal/merge-quarantine/clear-by-path` with either one). Verified directly: the refusal text already
names `r`, `d`, and the exact route; nothing is cleared by the refused attempt.

**Ruling: smaller safe option, already in place — no code change.** Full disambiguation is NOT safely
achievable here: the ambiguity is genuine, not an implementation gap — BOTH identities are legitimately
reported under this one id (R via its in-memory `armedKeys` claim with no physical backing, D via its
actual physical bytes), so a human's intent cannot be inferred from the id alone. Resolving "in favor of
whoever physically owns the bytes" would silently clear the WRONG identity whenever a human's intent was
actually the OTHER one — exactly the harm `9a55fb90`/`c9114934` exist to prevent. A regression/lock-in
test (`dd34da46-item2` in `merge-quarantine-raise-protect-failure.mjs`) pins this already-correct
behavior; no RED state exists to demonstrate since no source line changed for this item.

**Correction (Round 2, Code Review d42418af, Minor 1, card `95ea8d3f`) — FIXED, see "Follow-up 95ea8d3f"
below.** Following the refusal's own `clear-by-path` remedy, the remedy used to last for R but NOT for
D — a `clear-by-path(D)` after a shape-1 divert plus a query cleared D in-process but did not durably
persist that clear, so D's own token came back after a reboot. Fixed by card `95ea8d3f`; see that
section for the root cause and the fix.

### Item 3 — a double fault (the divert's own pending write ALSO fails) now falls back to a safety-tmp residue

`divertRaiseEntry`'s own `writePendingDivertFile` call, on failure (e.g. ENOSPC), only ever logged —
`entry` stayed enforced IN-PROCESS ONLY (the in-memory push already happened) and was silently LOST after
a reboot, with no durable trace anywhere.

Checked first (per the ruling): `writeSafetyTmpResidueAtHash`'s own output (a `.json.tmp-safety-<pid>-
<hex>` file) IS ALREADY recovered at boot — `reenterMergeQuarantinesAtBoot`'s dedicated safety-tmp
recovery pass (`97cff6db`, round 2) reads every such file and arms/diverts it exactly like an ordinary
latch, recomputing `canonicalRepoLockKey(entry.repoPath)` itself rather than trusting the hash embedded in
the filename — so the hash passed to this fallback need not be "correct" for any given degraded/collided
shape, only distinct from an unrelated `final`.

**The fix:** `attemptDivertSafetyTmpFallback(entry)` — calls `writeSafetyTmpResidueAtHash(quarantineHashFor
(entry.repoPath), entry, true)` as a best-effort fallback, ONLY when the primary pending-divert write
already failed. Wired at both of `divertRaiseEntry`'s own failure branches (the fresh-divert branch, and
the merge-into-existing-pending branch — passing `merged`, the object this process's own in-memory
bookkeeping now tracks, never the raw `entry`). `selfReference: true` bakes the tmp's own basename into the
written bytes' `orphanLatchFiles`, matching every other safety-tmp writer in this module (`ef651188`,
round 2, CRITICAL 1). No new boot-recovery machinery was built — this only reuses the existing recovery
pass. On a TRIPLE fault (the safety-tmp write ALSO fails), this logs loudly and the quarantine genuinely
will not survive a restart — an accepted residual, not chased further by this card.

### Tests

All three items in `merge-quarantine-raise-protect-failure.mjs`:
- **`dd34da46-item1`** — the existing-branch-divert setup (mirrors `s3`/existing-branch), then a LATER
  `clearMergeQuarantineByRecordedPath(d2)` with reads restored. Asserts `final` is unlinked (not kept),
  both tokens lift in-process, and neither resurrects after a reboot through a fresh module import.
- **`dd34da46-item2`** — the shape-1 setup, a query (`activeMergeQuarantineFor(r)`), then
  `clearMergeQuarantineLatchFile(Krhash)`. Asserts the refusal, that it names both repoPaths and the
  precise clear-by-path remedy, and that nothing was actually cleared. No RED state (no code change).
- **`dd34da46-item3`** — the shape-1 setup PLUS an injected `fs.openSync` failure (ENOSPC) targeting the
  divert's own deterministic pending-divert filename. Asserts the raise still persists in-process despite
  the double fault, that a safety-tmp residue carrying the token was written, and that the token survives
  a reboot through a fresh module import.

Items 1 and 3 proven RED on `HEAD` (pre-this-follow-up) and GREEN after, via `scripts/negative-control.mjs`
— item 2 stays green in both phases, as expected for a no-code-change item. All 33 `merge-quarantine*.mjs`
files re-verified individually, each exit 0. All static guards (`pnpm --filter @loom/daemon guards`)
re-verified green (30/30).

## Round 2 (Code Review d42418af of commit `c5c17d17`) — one Major regression, three nitpicks

Items 1 and 2 were judged sound as landed. One Major BLOCKER in Item 3's own fix, plus three nitpicks.

### BLOCKER — `attemptDivertSafetyTmpFallback`/`divertRaiseEntry` wrote the safety-tmp but never re-pointed the in-memory record at it

`writeSafetyTmpResidueAtHash`'s own `selfReference: true` bakes the tmp's own basename into the WRITTEN
BYTES' `orphanLatchFiles` — but round 1's version of the fallback only called this and logged; it never
updated the pending record `divertRaiseEntry` had already pushed, which kept pointing at the
`pending-<hash>.json`/`base.sourceFile` that was never actually written (or is now stale). So an
IN-PROCESS `clearMergeQuarantineByToken`/`clearMergeQuarantineByRecordedPath` swept only that
missing/stale file (a no-op, or a partial rewrite of stale bytes) and left the real safety-tmp an
untracked orphan on disk — a later boot's own recovery pass still finds and re-arms it regardless of the
clear, resurrecting the token.

Repros (both PASS on the parent `c5c17d17`, proving this is a genuine round-2 regression, never present
before Item 3's own fix existed):
- **P3b** (fresh-divert branch) — shape-1 setup, then `enterMergeQuarantine(r)` with every read of `final`
  failing plus an injected ENOSPC on the `pending-<hash>.json` open. `clearMergeQuarantineByToken(r, t)`
  lifts `t` in-process, but the safety-tmp stays on disk, untracked, and `t` comes back after a
  fresh-import reboot.
- **P3g** (the `merged` branch) — `t1` diverts normally (its own pending-divert file is actually written);
  `t2`'s own divert merges into `t1`'s existing pending record, but THAT rewrite fails. Releasing `t1` and
  `t2` in-process sweeps only the STALE pre-existing pending file (still holding just `t1`, untouched by
  the failed rewrite) — both tokens come back after a reboot.

**The fix:** `attemptDivertSafetyTmpFallback` now RETURNS the tmp's own basename (`string | false`) instead
of `void`, and never touches `pendingUnresolvedQuarantines`/`activeQuarantines` itself — purely a write
primitive. Both of `divertRaiseEntry`'s own failure branches, on a successful fallback, now mirror boot
Phase 0's own established pattern (`ef651188`, ~L4163): fold the tmp's own basename into the entry's
`orphanLatchFiles`, `replaceEntryEverywhere` (reaching an ALREADY-ARMED twin too, e.g. the existing-branch
divert's own `baseEntry`), and push the PENDING record at the tmp's own basename — never the
unwritten/stale original filename. The merge-into-existing-pending branch ALSO sweeps the now-superseded
`base.sourceFile` via `sweepOwnLatchFileUnlessOwnedElsewhere` (ownership-checked, never a bare unlink) —
its bytes are stale (the rewrite that would have updated them is exactly what failed) and fully
superseded by the safety-tmp. **Correction (Round 3, Code Review 765f5453, Minor 1):** this sweep is
NOT needed for the committed P3g scenario itself — CR measured that P3g still passes with the sweep call
removed, because a FULL (last-token) release's own `orphanFilesToSweep` loop in `clearPendingEntryByToken`
already sweeps every `orphanLatchFiles` entry (which includes `base.sourceFile`, folded in alongside the
safety-tmp basename) once nothing remains outstanding. The sweep's own real job is a PARTIAL release —
releasing only one of several merged tokens, which never reaches that full-clear loop at all — where
`base.sourceFile`'s stale bytes would otherwise survive on disk, untracked, until something unrelated
happened to fully clear the entry. See `dd34da46-p3g-v1`'s own test for the scenario that actually pins
it. A TRIPLE fault (the safety-tmp write ALSO fails) keeps the pre-existing, accepted-residual shape
(push at the original filename) — unchanged, never chased further.

### N2 — the two new helpers sat between an existing function's jsdoc and its own definition

`markedFinalFullyCoveredByClear` was inserted between `deleteMergeQuarantineLatchByKey`'s own jsdoc
(7 `@decision` anchors) and the function itself; `attemptDivertSafetyTmpFallback` likewise sat between
`divertRaiseEntry`'s own jsdoc and its function. Both helpers (with their own jsdoc) are now moved ABOVE
the jsdoc of the function they precede, so each doc comment attaches to the function it actually
documents again.

### N3 — item3's "a SAFETY-TMP residue was written" check was vacuous

The shared `MERGE_QUARANTINE_DIR` can already hold OTHER scenarios' own safety-tmp residues by the time
item3 runs (this file runs every scenario in one process), so a bare `safetyTmpFiles.length > 0` check
passes regardless of whether item3's OWN fallback ever ran. Fixed to select by r's OWN key hash prefix
(`${Krhash}.json.tmp-safety-` — `quarantineHashFor(r) === Krhash` since `r` is fully resolvable), with the
content check (`includes(rToken)`) kept as a second, independent confirmation.

### N4 — item 1's keep-mark was dropped BEFORE the unlink it was supposed to license, not after

Round 1's `markedFinalFullyCoveredByClear`-based override dropped `keptUnreadableLatchFiles` as soon as
coverage was proven, then attempted the unlink — so an EPERM/EBUSY-shaped unlink failure (silently
swallowed by the pre-existing `catch { /* ENOENT is the common case */ }`) left `final` physically on disk
with the mark ALREADY cleared, and nothing to stop the caller's own `tombstoneIfNotSurviving` from
tombstoning the tokens too (its own gate only checks whether the mark is STILL set).

**The fix:** the unlink attempt now classifies its own outcome (`unlinkConfirmed`: `true` for a genuine
success or ENOENT, `false` for any other error code); the proven-coverage mark is dropped ONLY when
`unlinkConfirmed` is true. An unconfirmed removal leaves the mark set — fail-closed — which, via the
PRE-EXISTING `tombstoneIfNotSurviving` gate (unchanged), also means the tokens are never tombstoned while
the mark survives.

### Tests

`dd34da46-item3`'s own two checks were tightened per N3 (see above). Two new scenarios added to
`merge-quarantine-raise-protect-failure.mjs`: `p3b` (the fresh-divert branch's own BLOCKER repro) and
`p3g` (the merged-branch's own BLOCKER repro, verbatim per the Code Review) — both asserting the token
lifts in-process, the safety-tmp residue is actually SWEPT (never left an untracked orphan) by the clear,
and the token does not resurrect after a fresh-import reboot. Both proven RED on `c5c17d17` (the parent
commit, NOT `HEAD` — the BLOCKER postdates item 1/2's own landing) and GREEN after, via
`scripts/negative-control.mjs --ref c5c17d17`. All 33 `merge-quarantine*.mjs` files re-verified
individually, each exit 0. All static guards (`pnpm --filter @loom/daemon guards`) re-verified green
(30/30). Line endings re-verified CR==LF via `working-tree-eol-guard.mjs` (no `sed -i` used this round).

## Follow-up dd34da46, Round 3 (Code Review 765f5453) — CR2 shipped; test/doc-only follow-up, no src change

CR2 passed Round 2's own fix as SHIP. Three test/doc gaps found in review, closed WITHOUT touching any
source file.

### `dd34da46-p3g-v1` — pins the `base.sourceFile` sweep for a PARTIAL release

CR2 measured that the committed `p3g` scenario passes even with the `base.sourceFile` sweep call (Round 2,
~L1832 at the time) removed — because `p3g` releases BOTH merged tokens, and a full (last-token) release
already sweeps every `orphanLatchFiles` entry (which includes `base.sourceFile`) via
`clearPendingEntryByToken`'s own `orphanFilesToSweep` loop, regardless of whether the EXPLICIT sweep ran
earlier. The sweep call's own real job is a PARTIAL release: releasing only ONE of several merged tokens
takes the partial-clear branch instead, which never looks at `orphanLatchFiles` at all — so without the
explicit sweep, `base.sourceFile`'s stale bytes (still holding only the FIRST token, never rewritten since
that rewrite is what failed) would survive on disk, untracked, and a later reboot re-arms the released
token from them.

`dd34da46-p3g-v1` reproduces the committed `p3g` setup exactly (t1 diverts normally; t2's own divert
merges into t1's pending record, whose rewrite fails) but releases t1 ONLY, then reboots. Asserts: the
stale original pending-divert file is ALREADY swept proactively (at write time, before any clear ever
runs); t1 is lifted in-process and does not resurrect after the reboot; t2 — never released — stays fully
enforced, in-process and after the reboot; d's own unrelated token survives throughout.

Proven RED via a SCRATCH commit (never landed, discarded after use) that removed ONLY the
`sweepOwnLatchFileUnlessOwnedElsewhere(base.sourceFile)` call (a valid, buildable one-line removal) —
`scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-raise-protect-failure.mjs --ref <scratch-sha>` reported the RED
phase (that scratch content) failing exactly `dd34da46-p3g-v1`'s own checks with the build still
succeeding, and the GREEN phase (the real, current content) passing, tree restored byte-identical. The
scratch commit was then discarded — it never reached this branch's real history.

### `dd34da46-n4` — the item1 shape, with the licensed unlink itself failing (EPERM)

Mirrors `dd34da46-item1`'s exact setup (an existing-branch divert leaving `final`'s own degraded entry
D2 kept-and-marked), but patches `fs.unlinkSync` to throw EPERM for `final`'s own path during
`clearMergeQuarantineByRecordedPath(d2)`, restoring it immediately after. Asserts: nothing throws; `final`
stays on disk, byte-for-byte unchanged; D2's own token — backed ONLY by `final`'s own kept bytes — SURVIVES
a fresh-import reboot (the documented, pre-existing "kept until reboot or a later successful read" residual,
`63e49ee2`); R2's own token, which has a SEPARATE durable backing (its own pending-divert record, never
`final` itself, from the existing-branch divert) is unaffected by the failed unlink and is fully,
successfully lifted both in-process and durably. This is the N4 ordering fix's OWN direct test — the
unlink-outcome classification (`unlinkConfirmed`) added in Round 2 is what keeps the mark (and so the
tokens) untouched on this exact failure shape; no separate RED proof was requested or performed for this
scenario, since N4 itself was already proven RED→GREEN in Round 2's own negative-control run.

### Correction — the sentence crediting the sweep with P3g's own survival was wrong

See the corrected paragraph under Round 2's own Item-3 "The fix" section above: the sweep is not what
P3g itself needs (CR2 measured this directly); it is what a PARTIAL release needs, which `p3g-v1` now
pins.

### Tests

`dd34da46-n4` and `dd34da46-p3g-v1` added to `merge-quarantine-raise-protect-failure.mjs`. All 33
`merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green (30/30). Line endings re-verified CR==LF via
`working-tree-eol-guard.mjs`. No source file was touched this round.

## Follow-up 7a7e041b (Code Review of d6efbc9b, reviewer 00513d54) — `protectOccupantContentBeforeDelete`'s own on-disk token read never subtracted `clearedTokens`

Pre-existing, fails closed (not a regression — it fails the same way on `d529d42d`).
`protectOccupantContentBeforeDelete` (merge-quarantine.ts) copies a degraded foreign occupant's final
aside using the on-disk `tokens` exactly as parsed, never subtracting `clearedTokens` — unlike its
sibling reader `reconcileMarkedBasenameBeforeWrite`, which already does. So when a kept final whose
`repoPath` names a different, now-unresolvable identity still physically holds a token this process has
already deliberately cleared, that token rides back in — as a brand-new pending-divert record for the
degraded identity — the next time a DIFFERENT raiser's own raise reaches this copy-aside.

Repro (P3, the reviewer's own, ported verbatim as `7a7e041b-p3` in `merge-quarantine-raise-protect-failure.mjs`
— the reviewer's own scratch probe `zz-cr5-probe.mjs` was never committed):
1. `d` = `R`/sub-d, a resolvable subdirectory of `R`; `canonicalRepoLockKey(d) === Kr`.
2. `d1 = enter(d)`.
3. `t1 = enter(R)` — takes the existing branch (longest-outstanding raise wins the identity), so the
   entry has `repoPath: d`, `tokens: [d1, t1]`.
4. `clearByToken(d, d1)` — a partial clear. The final now holds `{repoPath: d, tokens: [t1]}`.
5. `rm -r sub-d`.
6. `clearByToken(R, t1)`, with read #1 of the final failing — the last remaining in-memory token on
   that entry. `clearMergeQuarantineByKey` keeps the final (fail-closed), but `d6efbc9b`'s own fix still
   tombstones `t1` unconditionally. `R` is lifted in-process.
7. `t2 = enter(R)` — a fresh raise, no injection at all. The still-marked final physically holds `[t1]`
   (kept by step 6), and `d`'s own identity is unresolvable, so this hits the "different, still-
   unresolvable identity" branch and calls `protectOccupantContentBeforeDelete(final, d, R)`. Pre-fix: it
   parses `[t1]` straight off disk and copies it aside into a BRAND-NEW pending `d` record — a pending
   sub-d record now holds `t1` again.
8. `clearByToken(R, t2)` — `t1` still survives via that pending record, and comes back after a reboot.

### The fix

1. **One shared on-disk-token reader.** `readSurvivingOnDiskTokens(parsed)` — parses `tokens`/`token`
   (same fallback shape both readers already used) and subtracts `clearedTokens`, returning BOTH the raw
   on-disk array and the surviving (post-subtraction) one. `reconcileMarkedBasenameBeforeWrite` now calls
   it instead of re-deriving the same filter inline; `protectOccupantContentBeforeDelete` calls it too —
   the two readers can no longer drift apart, which is exactly how this card's own bug happened in the
   first place (one reader was fixed in round 3, the other never was).
2. **Skip the copy-aside entirely when every real on-disk token is already tombstoned.**
   `protectOccupantContentBeforeDelete` now checks `rawTokens.length > 0 && survivingTokens.length === 0`
   right after validating `final`'s own shape, and returns `true` (the same "nothing to protect"
   contract its ENOENT/corrupt branches already use) WITHOUT building `toPersist`, writing a
   pending-divert file, or pushing anything onto `pendingUnresolvedQuarantines` — never a record with an
   empty `tokens` array, and never one backed by a freshly-minted random token standing in for content
   that no longer has an owner.
3. **Why skipping is safe (the card's own ruling).** File ownership holds: nobody still holds any of
   those on-disk tokens — each one was deliberately released through its own normal clear path
   (`tombstoneIfNotSurviving`), which already durably removed its own record before this copy-aside ever
   ran. Eviction never discards: there is nothing left for this copy-aside to discard in the first place
   — the content it would have protected was already, correctly, released by its own owner; skipping is
   not a NEW loss, it is recognizing a loss that already legitimately happened. The one-read-per-write
   rule (round 3) is unaffected — this is a NEW reader (`protectOccupantContentBeforeDelete` never shared
   a read with `writeMergeQuarantineLatch`'s own chokepoint to begin with), not a second independent read
   of the same file for the same write.
4. **A genuine MIXED on-disk token set carries forward only the survivor.** When `rawTokens` holds some
   tokens already tombstoned and at least one that was never cleared, `readSurvivingOnDiskTokens`' own
   `surviving` array — never the raw one — is what gets persisted into `toPersist.tokens` (falling back
   to a freshly-minted token only when `rawTokens` itself is empty, the pre-existing legacy-shape
   fallback, unchanged by this card). The tombstoned token is dropped silently; the still-owed one is
   protected exactly as before.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`7a7e041b-p3`** — P3 above, ported verbatim. Doubles as the card's own "all-tokens-tombstoned"
  scenario: by the time the copy-aside runs, the only token physically on `final` (`t1`) has already
  been tombstoned, so the fix must skip the copy-aside outright. Asserts `t1` is never resurrected by
  `R`'s own re-raise (in-process and across a reboot), that NO pending record for `d`'s own identity is
  ever minted, and that `R` lifts fully and stays lifted.
- **`7a7e041b-mixed`** — a genuine mix: `final` physically holds two tokens, one already tombstoned (via
  a wholly unrelated repo's own raise, fully cleared, reusing the identical token string — the tombstone
  set is keyed on the string alone, exactly as it is in production) and one never cleared at all. Hits
  the SAME call site as P3 (`protectDegradedOccupantBeforeDelete`'s own "no existing"/brand-new-entry
  region — nothing is ever armed in-memory for the degraded identity in this scenario, so there is no
  "existing"-branch identity-exemption to route around). Asserts the tombstoned token is dropped from the
  copy-aside, the still-owed token survives it (in-process and across a reboot), and the raiser's own
  fresh token is enforced too.

Both scenarios measure tokens directly via `listActiveMergeQuarantines().flatMap(q => q.tokens ?? [])`,
never `assertRepoNotQuarantined`, and both check a reboot through a fresh module import. Proven RED on
`HEAD` (pre-fix, this card's own uncommitted working-tree edit) and GREEN after, via
`scripts/negative-control.mjs` — the RED phase fails exactly the seven new assertions these two scenarios
add (both scenarios' own `*** THE FIX ***`-labeled checks), with the build succeeding on both sides, so
the RED is behavioral, not a build failure. All `merge-quarantine*.mjs` files re-verified individually,
each exit 0. All static guards (`pnpm --filter @loom/daemon guards`) re-verified green.

## Follow-up 95ea8d3f (Code Review d42418af of `dd34da46`, Minor 1) — a diverted occupant's clear-by-path never durably persisted

Fixes the gap recorded by "Follow-up dd34da46, Item 2"'s own Round-2 correction above: following the
refusal's own `clear-by-path` remedy, `clearMergeQuarantineByRecordedPath(d)` lifted D in-process but D's
`<Krhash>.json` final stayed on disk unchanged, so D's token came back after a reboot. The identical
remedy applied to R (the raiser) already survived a reboot — the bug was specific to clearing the
diverted OCCUPANT, not the raiser.

### Two independent causes, found by instrumenting the real compiled module (empirical probe, not guessed)

`clearMergeQuarantineByRecordedPath(d)`'s own matched-pending loop sweeps D's own `sourceFile` (`final`,
since D sits at R's own real key) via `sweepOwnLatchFileUnlessOwnedElsewhere` — which, pre-fix, had TWO
separate reasons to wrongly keep the file, both confirmed by reverting the fix one piece at a time:

1. **A stale `keptUnreadableLatchFiles` mark.** R's own earlier raise left `final`'s basename marked
   (its read failed at that time). The query's own lazy graduation later re-read `final` successfully
   (reads were restored) and correctly refused to overwrite it (the pre-existing degraded-occupant
   guard) — but nothing ever CLEARED the mark, since it is only ever cleared by a successful rename-over
   or a `markedFinalFullyCoveredByClear`-proven unlink, neither of which happened here.
   `sweepOwnLatchFileUnlessOwnedElsewhere` trusted the mark unconditionally (`if
   (keptUnreadableLatchFiles.has(filename)) return { kept: true, ... }`), with no re-check at all —
   `dd34da46`'s own `markedFinalFullyCoveredByClear` containment proof was wired only into
   `deleteMergeQuarantineLatchByKey`, never into this pending-sweep sibling, exactly as the card's own
   "Likely cause" predicted.
2. **`physicalOwnerRepoPaths` reporting R as an "owner."** Fixing (1) alone (re-proving coverage, then
   falling through to the ordinary ownership check) was NOT sufficient — empirically confirmed: the clear
   then returned `latchKept: true, referencingRepoPaths: [r]` and `final` stayed on disk. R is ARMED at
   this exact key in-memory (the query's own graduation arms it regardless of whether the durable write
   succeeded, per `e1cb7d33`), so `physicalOwnerRepoPaths`'s key-hash match reports R as a current
   "owner" of this filename — even though R's own write to it was REFUSED and nothing of R's is
   physically backed there (R's real durable backing, when the write fails, is its own separate
   `pending-<hash>.json` file, folded into `orphanLatchFiles` by `consumeMatchedPendingsIntoArmedEntry`'s
   own failure branch — untouched by D's clear either way).

### The fix

`sweepOwnLatchFileUnlessOwnedElsewhere(filename, candidateTokens?)` gains an optional `candidateTokens`
parameter (every pre-existing caller omits it, so their behavior is byte-identical to before):

1. When `filename`'s basename is marked, `candidateTokens` (when passed) is checked against `final`'s
   own current content via the SAME `markedFinalFullyCoveredByClear` content-containment proof
   `deleteMergeQuarantineLatchByKey` already uses — never a second, independent re-derivation. Coverage
   NOT proven (no `candidateTokens`, or a real on-disk token not covered) keeps the pre-existing
   unconditional "kept" behavior exactly as before.
2. **(SUPERSEDED BY ROUND 2 — see that section below.)** Proven coverage settled BOTH the mark AND
   `physicalOwnerRepoPaths` in one step — the ownership check was skipped ENTIRELY, never merely re-run.
   This argument is sound for `physicalOwnerRepoPaths`'s own aspirational-claim half (an armed-but-never-
   durably-written owner's own tokens would already be on disk, breaking coverage) — but Round 2 found it
   is NOT sound as a license to skip `physicalOwnerRepoPaths` WHOLESALE: its pending-sourceFile half can
   name a genuinely DIFFERENT claimant (card 882d6cff) sharing this exact file with nothing in its own
   (corrupt/unparseable) content to disambiguate — skipping that half too destroyed a sibling's only
   backing as collateral. The unlink's own confirm-before-mark-drop ordering (N4) is UNCHANGED by Round 2.
3. Wired at the ONE call site this card's own repro reaches: `clearMergeQuarantineByRecordedPath`'s
   matched-pending loop, passing `p.entry.tokens` (the exact tokens this specific pending entry's own
   clear is dropping) as `candidateTokens`. Every OTHER call site of `sweepOwnLatchFileUnlessOwnedElsewhere`
   (`divertRaiseEntry`'s own safety-tmp-supersede sweep, `clearPendingEntryByToken`'s last-token branch,
   `clearMergeQuarantineByKey`'s own sourceFilesToSweep loop, `clearMergeQuarantineLatchFile`'s raw
   fallback) is left passing no `candidateTokens` — out of this card's own scope; each is a candidate for
   the identical fix if a future card finds the same gap reachable through it.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`95ea8d3f-p2d`** — the card's own repro, ported verbatim (shape-1 divert, a query, then
  `clearMergeQuarantineByRecordedPath(d)`). Asserts the clear reports plain success (no shared-latch
  warning), d's token lifts in-process, r's own raise is unaffected, and — the discriminating check —
  d's token does NOT come back after a fresh-import reboot while r's own raise still does survive
  (`e1cb7d33`).
- **`95ea8d3f-p2r`** — the card's own control (P2r): the identical remedy applied to R, pinning that this
  fix did not change R's own, already-correct clear-by-path behavior (it never reaches the marked-basename
  branch at all, since R's own sourceFile is its `pending-<hash>.json`, never `final`).
- **`95ea8d3f-adversarial`** — the same shape-1-plus-query setup, but `final`'s own physical bytes are
  directly rewritten to ALSO carry a token not in D's own in-memory tokens (a still-owed token this clear
  must never destroy as collateral). Asserts `final` is KEPT, byte-for-byte unchanged, and that the
  uncovered token survives a reboot — proving the fix's coverage check correctly REFUSES to settle the
  mark when a real on-disk token is not accounted for.

All three measure tokens directly via `listActiveMergeQuarantines().flatMap(q => q.tokens ?? [])`, never
`assertRepoNotQuarantined`, and check a reboot through a fresh module import. `95ea8d3f-p2d`'s own reboot
assertion proven RED on `HEAD` (pre-fix) and GREEN after, via `scripts/negative-control.mjs` — the RED
phase fails exactly that one assertion, with the build succeeding on both sides, so the RED is
behavioral, not a build failure. All 33 `merge-quarantine*.mjs` files re-verified individually, each exit
0. All static guards (`pnpm --filter @loom/daemon guards`) re-verified green (30/30). Line endings
re-verified CR==LF (no `sed -i` used).

## Round 2 (Code Review `c9af122d` of `d78087d4`) — Round 1's own wholesale ownership-skip was itself a Critical fail-open regression

Round 1 (commit `d78087d4`) shipped NOT SHIP: Round 2's own "proven coverage skips `physicalOwnerRepoPaths`
entirely" let a SECOND, genuinely-pending claimant's own file be destroyed as collateral, and
`markedFinalFullyCoveredByClear` counted corrupt/unparseable content as "covered" — a corrupt latch at one
degraded hash can be diverted ONCE PER CLAIMANT (card `882d6cff`): several distinct, genuinely-pending
identities can share ONE physical `sourceFile` with nothing in the file's own (unparseable) content to
tell them apart.

### Repro (the reviewer's own, reproduced directly before any fix)

1. `r` is a real repo; `d1=r/gone-a` and `d2=r/gone-b` are both unresolvable.
2. Write `{ this is not json` to `<Krhash>.json` (the hash both `d1` and `d2` degrade to).
3. `reenterMergeQuarantinesAtBoot([d1, d2])` — TWO pure-pending placeholders, both `sourceFile=Krhash.json`
   (`882d6cff`'s own "divert one deferred entry PER claimant" mechanism).
4. `enterMergeQuarantine(r, ...)` with reads of `Krhash.json` failing EACCES throughout — `r`'s own raise
   diverts to its OWN separate `pending-<hash>.json` file (never touching `Krhash.json`), marking
   `Krhash.json`'s basename kept-unreadable.
5. Restore reads; `clearMergeQuarantineByRecordedPath(d1)`.
6. Fresh-import reboot, `reenterMergeQuarantinesAtBoot([d1, d2])`.

On `d78087d4`: `Krhash.json` is unlinked outright at step 5, and `d2` is NOT quarantined after the reboot.
On the parent (`57143a90`): `d2` survives (Round 1's own bug never existed there — this is purely a Round
1 regression).

### Manager's ruling

1. **Proven coverage may override ONLY the active-armed-key / fresh-write-target half of
   `physicalOwnerRepoPaths`** (the genuinely-sound argument Round 1 made) — **it must NEVER override a
   surviving `pendingUnresolvedQuarantines` entry's own `sourceFile`, or any entry's `orphanLatchFiles`,
   naming this file. Such a file is KEPT.**
2. **Corrupt/unparseable content is NOT "covered"** on this sweep path — fail closed and keep the file.
3. Check whether the SAME shared-corrupt-latch, two-claimant shape fails open through
   `deleteMergeQuarantineLatchByKey`'s own `provenCoverage` (`dd34da46`'s own fix), which also counted
   corrupt as covered — and if it does, apply the same two rules there too. Either way, test it.
4. Nitpick: an unconfirmed unlink (EPERM/EBUSY) must surface `latchKept:true`/`kept:true`, never plain
   success.

### The fix

1. **`markedFinalFullyCoveredByClear`** (shared by both `sweepOwnLatchFileUnlessOwnedElsewhere` and
   `deleteMergeQuarantineLatchByKey`) no longer treats corrupt/unparseable JSON as covered — its
   `JSON.parse` catch branch now returns `false` (ENOENT/EISDIR, "nothing real there," are unaffected).
   This alone closes rule 3's own question for `deleteMergeQuarantineLatchByKey`'s marked-and-corrupt
   case, since `provenCoverage` requires this function's own `true`.
2. **`survivingSharedClaimRepoPaths(filename)`** (new) — repoPaths of every entry STRUCTURALLY depending
   on `filename`, independent of its content: a GENUINE PLACEHOLDER pending entry's own `sourceFile`
   (gated on `entry.placeholder` — see the correction below), or any entry's (active or pending)
   `orphanLatchFiles`. Deliberately narrower than, and never a substitute for, `physicalOwnerRepoPaths`.
3. **`sweepOwnLatchFileUnlessOwnedElsewhere`**: when the basename is marked and coverage is proven, it now
   checks `survivingSharedClaimRepoPaths` BEFORE ever bypassing `physicalOwnerRepoPaths` — a non-empty
   result keeps the file (`kept:true`, naming the claimants), never reaching the unlink at all.
4. **`deleteMergeQuarantineLatchByKey`**: now ALSO computes `survivingSharedClaimRepoPaths(finalBasename)`
   unconditionally (never gated on `marked`/`provenCoverage` at all — rule 1 is general) and forces
   `finalProtectOk = false` when it finds anyone, closing rule 3's own question for the `dd34da46` path
   independently of rule 2's corrupt-handling fix. Its own return type changed from `void` to `string[]`
   (the shared claimants that kept the file, empty otherwise) so every caller (`clearMergeQuarantineByKey`'s
   two call sites, `clearMergeQuarantineByRecordedPath`'s matched-pending armedKeys lift,
   `clearPendingEntryByToken`'s last-token branch) can fold it into its own `latchKept` reporting; the last
   of those four leaves it unthreaded (that function returns `void` overall, unrelated to this card).
5. **Nitpick (rule 4).** `unlinkLatchFileConfirmed` (renamed from the round-1 `unlinkLatchFile`, which now
   delegates to it) returns whether the unlink was CONFIRMED (success or ENOENT); both
   `sweepOwnLatchFileUnlessOwnedElsewhere` branches now report `kept: !unlinkConfirmed` instead of an
   unconditional `kept:false`. Threading this all the way to the TOP-level `latchKept` field needed a
   SECOND fix: the pre-existing aggregation in `clearMergeQuarantineByKey`/`clearMergeQuarantineByRecordedPath`
   only ever populated its `keptReferencingRepoPaths` Set from a NON-EMPTY `referencingRepoPaths` array —
   an anonymous "kept, nothing to name" result (this EPERM case, or the pre-existing marked-but-unprovable
   case) silently vanished. A new `anyKeptUnattributed` boolean, OR'd in at every `sweepResult.kept`/
   `deleteMergeQuarantineLatchByKey` call site across both functions, now also triggers `latchKept:true`
   (with an empty `referencingRepoPaths`) when nothing has a name but something was genuinely kept.

### Correction — `survivingSharedClaimRepoPaths`'s own `sourceFile` check is gated on `entry.placeholder`

The first version checked ANY `pendingUnresolvedQuarantines` entry's `sourceFile`, unconditionally — this
broke `merge-quarantine-pass1-degraded-union-guard.mjs`'s own pre-existing `round5-own-raise-lifts-past-
inferred-evictee` scenario (board card `883e29bc`/`d163aef5`): a REAL, non-placeholder entry evicted from
a tautological collision gets a PURELY DEFENSIVE `sourceFile` inference — `armCurrentKeyUnlessDegradedCollision`'s
own eviction path, finding no tracked pending reference for the evicted entry, infers its "real source
file" as the KEY's current physical file (never its own true backing, which the test's own precondition
proves is already safe elsewhere) — "never discarding it either way" (card `d163aef5`, round 3). Treating
that inferred guess as a hard veto wrongly blocked clearing the UNRELATED winner's own, separately-verified
content. Gating the check on `entry.placeholder` (only a GENUINE `882d6cff`-shape fail-closed marker, which
has NOTHING else to go on — its `sourceFile` IS the only physical content that might be its own) excludes
the inferred-eviction shape while still catching the real repro.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`95ea8d3f-r2-shared`** — the reviewer's own repro, ported verbatim. Asserts `final` is KEPT (never
  unlinked), the clear reports `latchKept:true` (via `anyKeptUnattributed` — `final`'s own corrupt content
  means no specific claimant can be named here), `d1`'s token lifts in-process while `d2`'s and `r`'s are
  unaffected, and — the discriminating check — `d2` SURVIVES a fresh-import reboot (its own token is NOT
  asserted byte-identical across boots: a generic placeholder mints a fresh `randomUUID()` per boot, since
  nothing usable was ever parsed; only its repoPath/identity surviving is the real guarantee).
- **`95ea8d3f-r2-ddpath`** — rule 3's own `dd34da46`-path variant: `d1` is made resolvable (a bare
  directory, no own `.git`, so its canonical key still walks up to `r`'s own real key) and queried while
  `final` is unreadable — the graduation write is refused but `d1` is armed IN-MEMORY anyway
  (`armedKeys=[Kr]`), `final` stays physically corrupt and marked. Clearing `d1` (now ACTIVE) reaches
  `clearMergeQuarantineByKey` → `deleteMergeQuarantineLatchByKey`. Asserts `final` is KEPT, the clear
  reports `latchKept:true` naming `d2` by repoPath (this path's own `survivingSharedClaimRepoPaths` check
  runs unconditionally, so it names the claimant even though `sweepOwnLatchFileUnlessOwnedElsewhere`'s own
  sibling scenario above could not), and `d2` survives the reboot.
- **`95ea8d3f-r2-eperm`** — rule 4's own nitpick: the SAME shape as `p2d` (valid JSON, genuinely covered),
  but the licensed unlink itself fails with EPERM. Asserts nothing throws, `final` stays on disk, and —
  the discriminating check — the clear surfaces `latchKept:true` (via `anyKeptUnattributed`) rather than
  plain success; `d`'s own token (backed only by the kept `final`) and `r`'s own raise both survive a
  reboot.
- `95ea8d3f-p2d`/`p2r`/`adversarial` (Round 1's own tests) re-verified green, unchanged.

All four new scenarios measure tokens/claimants directly via `listActiveMergeQuarantines()`, never
`assertRepoNotQuarantined`, and check a reboot through a fresh module import. Proven RED on `d78087d4`
(Round 1's own commit) and GREEN after, via `scripts/negative-control.mjs --ref d78087d4` — the RED phase
fails exactly the 7 new Round-2 assertions (build succeeding on both sides, so the RED is behavioral, not
a build failure). All 33 `merge-quarantine*.mjs` files re-verified individually, each exit 0 — including
`merge-quarantine-pass1-degraded-union-guard.mjs`, which the FIRST version of this round's own fix broke
(see the correction above) and which now passes clean again. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green (30/30). Line endings re-verified CR==LF (no
`sed -i` used; no new files this round).

## Round 3 (Code Review `4e500b66` of `8b9e3451`) — Round 2's own "any orphanLatchFiles" wording was ITSELF a Major fail-closed regression

**This section SUPERSEDES Round 2's own wording** ("any entry's (active or pending) `orphanLatchFiles`"
— both in "The fix" step 2 above and in the Round-2 `survivingSharedClaimRepoPaths` doc comment at the
time): that check directly conflicted with `9cabd143` ("never gate [a cleared entry's own file] on check
(1) — another entry's `orphanLatchFiles` merely LISTING the filename") — and `9cabd143` wins. A cleared
entry's own file must never be kept alive by a DIFFERENT entry's stale, unrelated cross-reference to it.

### Repro (the reviewer's own, reproduced directly before any fix)

1. Write corrupt `{not valid json` to `<hash(B)>.json` (B's own real, direct hash — no degradation).
2. `reenterMergeQuarantinesAtBoot([A])` — registering ONLY `A`. The corrupt file matches NO registered
   repo's hash (neither `A`'s own fresh hash nor any degraded walk-up), so PASS 2's own pre-existing
   "every registered repo's entry references an unmatched orphan" broadcast mechanism (round 7, M2 — see
   `reenterMergeQuarantinesAtBootImpl`'s own PASS 2) folds this filename into **`A`'s own
   `orphanLatchFiles`** — purely defensively, so a human can eventually clear it by clearing every
   referencing repo; `A` has no genuine structural dependency on this file at all.
3. `enterMergeQuarantine(B)` — the corrupt content at `<hash(B)>.json` is "nothing usable," so B's own
   raise write proceeds and durably overwrites it with B's own real latch.
4. `clearMergeQuarantine(B)`.
5. Fresh-import reboot, `reenterMergeQuarantinesAtBoot([A, B])`.

On `8b9e3451` (Round 2's own commit): step 4 returns `latchKept:true, referencingRepoPaths:[A]` — B's own
clear is wrongly BLOCKED because `A`'s `orphanLatchFiles` happens to name B's physical file, even though
`A` has no `sourceFile` of its own pointing there. B is re-quarantined after the reboot. On `57143a90`
and `d78087d4` (the two commits that predate Round 2's own regression), B stays cleared.

### Corrected ruling

- **Keep the placeholder-`sourceFile` half of `survivingSharedClaimRepoPaths` unconditional.** The CR
  confirmed this half closes a genuinely PRE-EXISTING fail-open: `95ea8d3f-r2-ddpath`'s own shape (`d2`
  losing its backing) reproduces identically on the PARENT commit too, not just on Round 1's own code.
- **Narrow the `orphanLatchFiles` half.** An orphan hit counts ONLY when that SAME entry's own
  `sourceFile === filename` — covering the genuine SELF-referencing shapes (`4900c365`'s kept entry,
  `ef651188`'s safety-tmp, both of which re-point their OWN `sourceFile` at the exact basename they also
  fold into their OWN `orphanLatchFiles`). A stale orphan reference from a DIFFERENT entry (PASS 2's own
  broadcast, or any other cross-reference) must never keep a cleared entry's own file alive, per `9cabd143`.
- **Fix `clearMergeQuarantineByRecordedPath`'s reason text for a named keep** so it describes the actual
  keep cause, rather than asserting "sharing this exact degraded key" — true only for the `882d6cff`
  shared-corrupt-latch shape, not for a self-referencing protected-copy/safety-tmp keep.

### The fix

1. `survivingSharedClaimRepoPaths`'s `orphanLatchFiles` loop is now gated on `p.sourceFile === filename`
   (the SAME pending-entry wrapper's own `sourceFile`) — never a bare "does ANY entry's `orphanLatchFiles`
   include `filename`" scan. The ACTIVE-entries loop is DROPPED entirely: an active `MergeQuarantineEntry`
   has no `sourceFile` field of its own to self-reference against, and every genuine self-referencing
   example the manager named (`4900c365`, `ef651188`) is a PENDING-entry shape.
2. `clearMergeQuarantineByRecordedPath`'s own named-keep `reason` text no longer asserts "sharing this
   exact degraded key" unconditionally — it now says the kept claimant(s) "still structurally depend on
   it," with the degraded-key-sharing clear-by-id remedy offered CONDITIONALLY ("if they share this exact
   degraded key... otherwise, clear each one by its own repoPath").

### On the sweep-path structural veto's own discriminating test

The CR separately observed that `sweepOwnLatchFileUnlessOwnedElsewhere`'s own placeholder-`sourceFile`
check (inside its `provenCoverage`-gated branch) has no fixture that actually exercises it as the
discriminating reason. Investigated directly rather than guessed: it is **structurally unreachable** in
that exact position, and this is stated here as the honest answer rather than manufacturing a misleading
fixture. The reasoning: reaching `survivingSharedClaimRepoPaths` inside that branch at all requires
`provenCoverage` to be `true` — which (per Round 2's own corrupt-is-never-covered fix) requires `final`'s
CURRENT content to be successfully parseable, VALID JSON whose tokens are all already `candidateTokens`'
own. A placeholder's own `sourceFile`, by construction, points at a file that was unparseable WHEN the
placeholder was created; for the placeholder-sourceFile check to ever be the thing that stops the unlink,
`final` would need to be SIMULTANEOUSLY provably-covered valid JSON (to reach the check at all) and still
genuinely needed by an entry whose own defining trait is "nothing usable was ever parsed there" — these
two conditions are in direct tension, and nothing found in this module can intentionally construct a
fixture satisfying both without contradicting one or the other. The check is DEFENSIVE-ONLY in this
position (it is never a no-op — it still matters inside `deleteMergeQuarantineLatchByKey`, which runs the
unconditional check independent of `provenCoverage`, and `95ea8d3f-r2-ddpath` already exercises it there).

**Correction (Follow-up `0dc514dc`, Code Review item 2) — FALSE, empirically.** The "direct tension"
argument above silently assumed "provably-covered valid JSON" means a GENUINE latch (real `repoPath`/
`tokens`). It doesn't: `markedFinalFullyCoveredByClear`'s own `onDiskTokens.every(...)` is **vacuously
true** for an EMPTY on-disk token array — and a `final` holding merely `{}` (valid JSON, zero tokens,
but missing `repoPath`/`branch`/`reason`) is ALSO exactly what PASS 1's own boot-time classification
treats as "corrupt" for the purpose of minting a placeholder (`generic placeholder` creation is gated on
"nothing usable was ever parsed," not on "JSON.parse threw"). So `final` CAN simultaneously be
provably-covered (vacuously, via zero on-disk tokens) and still be a genuine `882d6cff` placeholder's own
`sourceFile` — the two conditions this record called "in direct tension" are not actually in tension at
all. See `crnit2` in `merge-quarantine-raise-protect-failure.mjs` for the fixture, and this card's own
Follow-up section below for where it is proven reachable, naming the surviving sibling.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`95ea8d3f-r3-orphanref`** — the reviewer's own repro, ported verbatim. Asserts clearing B reports
  plain success (A's own broadcast orphan reference never vetoes it), B's own `final` is actually
  unlinked, B's own token lifts in-process, and — the discriminating check — B's own token does NOT come
  back after a fresh-import reboot (registering both A and B), with A's own fail-closed orphan placeholder
  unaffected. Note: this file runs many scenarios in one shared `MERGE_QUARANTINE_DIR` — by the time this
  scenario's own reboot runs, some OTHER, unrelated scenario's own leftover corrupt/safety-tmp residue can
  already be sitting in that same directory, and PASS 2's own broadcast mechanism (the very thing this
  round's fix is about) can attach such an unrelated orphan onto B too, incidentally, at that later
  reboot. So "does B show up in the list at all" is not the right discriminating check (and would flake
  on shared test-file pollution); "is B's own REAL raise durably gone" is — asserted directly via its own
  token, plus a check that any entry that DOES show up for B is not backed by B's own real latch data.
- `95ea8d3f-r2-shared`/`r2-ddpath`/`r2-eperm`/`p2d`/`p2r`/`adversarial` (Rounds 1-2's own tests)
  re-verified green, unchanged. Re-run three times in a row with no flakes.

Proven RED on `8b9e3451` (Round 2's own commit) and GREEN after, via `scripts/negative-control.mjs --ref
8b9e3451` — the RED phase fails exactly the 4 new Round-3 assertions (build succeeding on both sides, so
the RED is behavioral, not a build failure). All 33 `merge-quarantine*.mjs` files re-verified
individually, each exit 0. All static guards (`pnpm --filter @loom/daemon guards`) re-verified green
(30/30). Line endings re-verified CR==LF (no `sed -i` used; no new files this round).

## Do not

- Do not let a raise-write call site ignore its own protect call's (`protectDegradedOccupantBeforeDelete`/
  `protectUnincorporatedOccupantBeforeDelete`) `false` return — thread it into `resolveRaiseOverwrite`.
- **(SUPERSEDED BY ROUND 2)** The original text of this bullet said a `true` ("none") protect result,
  when `final`'s basename is marked, must be re-derived inside `resolveRaiseOverwrite` itself. Round 2
  moved that re-derivation into `reconcileMarkedBasenameBeforeWrite`, run from `writeMergeQuarantineLatch`'s
  own chokepoint (every writer, not just a raise) — `resolveRaiseOverwrite` no longer carries forward
  on-disk tokens at all; it only decides divert vs. proceed. Do not re-add that logic to
  `resolveRaiseOverwrite` — the same "same identity is not same content" lesson `63e49ee2` round 5 learned
  on the clear side still applies, just at the one shared chokepoint now, never duplicated per call site.
- Do not treat `EISDIR` as "divert" on the raise side — a directory can never hold valid latch content in
  this module; treat it exactly like `ENOENT` (nothing real there, proceed) and let the pre-existing
  tmp-residue-on-failed-write mechanism handle an actual directory blocker. See the "EISDIR trap" section
  above for the regression this closes and the two tests (`WFR-1`, `PCWF` in
  `merge-quarantine-boot-hardening.mjs`) that catch a reversion of it.
- Do not use an identity-only check (mirroring `differentUnresolvableOccupantRepoPathAt`) inside
  `resolveRaiseOverwrite` for the existing-branch call site without ALSO checking token overlap first —
  `entry`'s own physical final can legitimately differ from the new raiser's identity while already being
  fully accounted for (a prior union's own winning side, `e0192ffb`'s own established exemption); skipping
  the overlap check would spuriously divert already-incorporated content into a duplicate pending record.
- Do not invent a second copy-aside primitive for the "different, still-unresolvable identity" branch —
  `resolveRaiseOverwrite` calls `protectOccupantContentBeforeDelete` directly, reusing its existing
  re-point/union logic.
- Do not assert `assertRepoNotQuarantined` as the discriminating check for a NEW test on this shape — as
  with every other card in this module, assert on the real TOKEN set (`listActiveMergeQuarantines().flatMap(q => q.tokens ?? [])`)
  directly.
- Do not construct a test fixture for the "no existing" raise-write region with a `resolvedKey` field on
  the foreign occupant — that arms it DIRECTLY into `activeQuarantines` at boot, routing any later raise
  at that same key into the `existing`-truthy region instead (a structurally different branch, already
  safe-by-construction there via token accumulation) rather than the brand-new-entry write this card's
  shape-1/shape-2 repros actually target. Leave `resolvedKey` off to keep the occupant pure-pending.
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
- **(Round 3)** Do not tombstone a token at a BARE "an entry occupies this key" lookup
  (`clearMergeQuarantineByKey`'s own `activeQuarantines.get(key)`, or an equivalent pending-entry filter
  match) — that entry can be a wholly FOREIGN occupant this exact clear ends up KEEPING, fail-closed,
  when protection is uncertain (`d2582692`'s shape). Tombstone ONLY once the actual outcome is known: a
  confirmed successful unlink (`deleteMergeQuarantineLatchByKey`'s own `finalProtectOk` branch) or a
  confirmed non-kept sweep (`sweepOwnLatchFileUnlessOwnedElsewhere`'s own `kept:false`). This was the
  FIRST implementation tried here, and it turned the pre-existing `b1` test (round 2's own repro) from
  PASS into a DIFFERENT failure — caught only by re-running the full corpus, not by this card's own new
  scenarios, which never happened to exercise a degraded-key eviction.
- **(Round 3)** Do not let `clearActiveEntryTokenAtKey`/`clearPendingEntryByToken`'s own by-token
  tombstone wait for their OWN write to succeed first — tombstone `token` BEFORE calling that write, or
  the write's own chokepoint union (when `final`'s basename happens to be marked) cannot see the
  tombstone and will re-include the very token this write is deliberately dropping. This is safe (not a
  second instance of the bare-lookup mistake above): by construction, THIS write is the one genuinely
  removing `token`, not a bystander clear that merely happens to occupy the same key.
- **(Round 3)** Do not have `writeMergeQuarantineLatch`'s chokepoint re-read `final` when the caller
  passes `reconciledAlready:true` — that flag means the caller already ran the SAME reconciliation this
  write needs, and a second, independent read of the same file for the same write is exactly the CR2 B2
  shape (a transient failure between two reads letting memory and disk diverge).
- **(Round 3)** Do not restore the chokepoint's old "proceed anyway, should be unreachable, safe either
  way" comment/behavior for an `"unreadable"` result at a raise (`skipDegradedOccupantGuard` true) — call
  `divertRaiseEntry` instead, even though every current raise call site already pre-reconciles and
  diverts itself before ever reaching this function in that state (this is a defensive fallback, not the
  primary mechanism — see CR2 B2 for what happens when the two reads disagree with no fallback at all).
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
- **(Round 4; CORRECTED by Follow-up `d6efbc9b`)** The original text of this bullet said neither by-token
  route ever needs a second, unconditional `tombstoneIfNotSurviving` call, since each already calls the
  shared helper right after its own in-memory token-removal. That is still true of
  `clearPendingEntryByToken`'s own last-token branch — but FALSE of `clearActiveEntryTokenAtKey`'s own
  last-token branch, which hands off entirely to `clearMergeQuarantineByKey` and never calls the helper
  itself at all; that delegated call's own `touchedFinalBasenames`-gated tombstone can leave the
  owner-released token un-tombstoned (see "Follow-up d6efbc9b" above). Do not remove that branch's own
  SECOND, unconditional call (no touched list) on the theory that it duplicates the shared helper's
  single invariant — it is the same invariant, correctly applied twice, to two different questions.
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
- **(Follow-up dd34da46, Item 1)** Do not let `markedFinalFullyCoveredByClear` run before every OTHER
  protect call at that site has already had its say — only attempt it when `finalProtectOk` is still
  true going in (nothing else already flagged a confirmed foreign occupant to keep). It is a NARROW,
  content-containment proof, never a general override of round 5's unconditional mark check.
- **(Follow-up dd34da46, Item 2)** Do not "fix" `clearMergeQuarantineLatchFile`'s ambiguous-id refusal
  into an auto-resolve for the shape-1-divert-plus-query collision — the ambiguity is genuine (BOTH
  identities are legitimately exposed under the same id; R has no durable physical backing at all, D
  does), not a gap to close. Resolving in favor of whichever identity happens to physically own the
  bytes would silently clear the wrong one whenever a human's actual intent was the other identity.
- **(Follow-up dd34da46, Item 3)** Do not build new boot-recovery machinery for `divertRaiseEntry`'s own
  double-fault shape — `writeSafetyTmpResidueAtHash`'s own output is ALREADY recovered by
  `reenterMergeQuarantinesAtBoot`'s pre-existing safety-tmp recovery pass; reuse it
  (`attemptDivertSafetyTmpFallback`), never a parallel reimplementation.
- **(Follow-up dd34da46, Item 3)** Do not pass the raw raiser `entry` to the safety-tmp fallback at
  `divertRaiseEntry`'s merge-into-existing-pending branch — pass `merged` (the object this process's own
  in-memory bookkeeping actually tracks going forward), or the fallback durably persists a token set this
  process has already moved past.
- **(Round 2, BLOCKER)** Do not let a safety-tmp fallback write succeed without re-pointing the CALLER's
  own pending record at it — writing the bytes (even with `selfReference: true`) is not enough; a stale
  in-memory `sourceFile` still pointing at the unwritten/stale original leaves the real tmp an untracked
  orphan a later boot still re-arms regardless of an in-process clear. Mirror boot Phase 0's own
  established pattern (`ef651188`, ~L4163): fold the tmp's basename into `orphanLatchFiles`,
  `replaceEntryEverywhere`, and push/rewrite the pending record's own `sourceFile` at the NEW basename.
- **(Round 2, BLOCKER)** Do not leave a merge-into-existing-pending fallback's own `base.sourceFile`
  behind once its content is superseded by a safety-tmp — its bytes are stale (never rewritten, since
  that rewrite is exactly what failed) and a later boot reads it independently of whatever the safety-tmp
  says. Sweep it via `sweepOwnLatchFileUnlessOwnedElsewhere` (ownership-checked, never a bare unlink).
- **(Round 2, N2)** Do not insert a new helper function between an EXISTING function's own jsdoc and that
  function's definition — move the new helper (with its own jsdoc) above the existing jsdoc instead, or
  the existing doc comment silently attaches to the wrong function.
- **(Round 2, N4)** Do not drop `keptUnreadableLatchFiles`' mark before confirming the unlink it licenses
  actually succeeded (or hit ENOENT) — an EPERM/EBUSY-shaped failure (silently swallowed by the
  pre-existing catch-all) must leave the mark set, fail-closed, so the caller's own
  `tombstoneIfNotSurviving` gate (which checks only whether the mark is still set) correctly refuses to
  tombstone the tokens too.
- **(Round 2, N3)** Do not assert "a SAFETY-TMP residue was written" by checking for ANY file matching the
  safety-tmp filename shape in `MERGE_QUARANTINE_DIR` — a multi-scenario test file can already hold OTHER
  scenarios' own residues by the time a later scenario runs. Select by the specific identity's own key
  hash prefix (or content), never a bare existence check.
- **(Round 3)** Do not credit a fix's own write-time side effect (the `base.sourceFile` sweep) with a
  scenario's survival (`p3g`) without first checking whether that scenario still passes with the side
  effect removed — a DIFFERENT code path (the full-clear's own `orphanFilesToSweep` loop) can already
  cover the committed scenario, making the credited mechanism untested until a scenario is written that
  genuinely cannot reach that other path (a PARTIAL release, `p3g-v1`).
- **(Round 3)** Do not assume a scenario's own preconditions hold at the SAME point in the scenario a
  SIBLING scenario's preconditions do — `p3g-v1` mirrors `p3g`'s own setup, but the write-time sweep
  being pinned runs PROACTIVELY, during the divert itself, not only at clear time; a precondition check
  asserting the swept file "still exists" right after the divert is checking the WRONG moment on the
  fixed code (it's already gone) — assert what the fix actually guarantees at that point instead.
- **(Follow-up 7a7e041b)** Do not let `protectOccupantContentBeforeDelete` parse its own on-disk
  `tokens`/`token` independently of `reconcileMarkedBasenameBeforeWrite` — route BOTH through the shared
  `readSurvivingOnDiskTokens`, or the two readers can drift apart again exactly as they did here (one
  subtracted `clearedTokens`, the other never did).
- **(Follow-up 7a7e041b)** Do not persist an empty-`tokens` or freshly-minted-random-token pending record
  when every real on-disk token is already tombstoned — skip the copy-aside entirely and return `true`
  ("nothing to protect"). Every one of those tokens was deliberately released by its own holder before
  this copy-aside ever ran; there is nothing left to protect, and inventing a record to protect it with
  would itself be the fail-open bug.
- **(Follow-up 95ea8d3f)** Do not trust `sweepOwnLatchFileUnlessOwnedElsewhere`'s own
  `keptUnreadableLatchFiles` mark unconditionally forever — re-prove coverage via the SAME
  `markedFinalFullyCoveredByClear` content-containment check `deleteMergeQuarantineLatchByKey` already
  uses before trusting a mark that outlived the transient read failure that set it.
- **(Follow-up 95ea8d3f)** Do not fix only the mark check and assume `physicalOwnerRepoPaths` will then
  correctly let the file go — an entry ARMED at a key (but whose own write there was refused) reports as
  an "owner" purely from in-memory state, with no physical backing at all. Proven content coverage must
  settle BOTH checks together, never the mark alone — see the decision record's own two-cause narrative
  for why skipping the ownership check in that exact state is sound, not merely convenient.
  **(SUPERSEDED BY Follow-up 95ea8d3f, Round 2 — see its own bullets below.)** "BOTH checks together" is
  TOO BROAD: proven coverage may settle ONLY `physicalOwnerRepoPaths`'s aspirational armed-but-unwritten
  half, never its pending-`sourceFile` match or any entry's `orphanLatchFiles` — a Critical fail-open
  regression, found by Code Review `c9af122d`.
- **(Follow-up 95ea8d3f)** Do not drop a settled mark before the unlink it licenses is CONFIRMED (success
  or ENOENT) — same N4 ordering rule as `deleteMergeQuarantineLatchByKey`; an EPERM/EBUSY-shaped failure
  must leave the mark set, fail-closed.
- **(Follow-up 95ea8d3f, Round 2)** Do not let a content-containment proof (`markedFinalFullyCoveredByClear`)
  bypass `physicalOwnerRepoPaths` WHOLESALE — only its active-armed-key/fresh-write-target half is an
  aspirational, never-durably-written claim; its pending-`sourceFile` match can name a GENUINELY different
  claimant (card `882d6cff`'s shared-corrupt-latch, multiple-placeholder shape) with nothing in the file's
  own unparseable content to disambiguate. Check `survivingSharedClaimRepoPaths` separately, and never
  skip it, regardless of proven coverage. **(SUPERSEDED BY Follow-up 95ea8d3f, Round 3 — see its own
  bullets below.)** The original text of this bullet also said "...and any entry's `orphanLatchFiles`" —
  TOO BROAD: that is `9cabd143`'s own forbidden check-1 shape (a DIFFERENT entry's stale cross-reference,
  including PASS 2's own defensive broadcast onto every registered repo) and must never veto a clear.
- **(Follow-up 95ea8d3f, Round 2)** Do not treat corrupt/unparseable JSON as "covered" in
  `markedFinalFullyCoveredByClear` — a corrupt latch can genuinely back SEVERAL distinct claimants at
  once; only ENOENT/EISDIR ("nothing real there") are trivially safe.
- **(Follow-up 95ea8d3f, Round 2)** Do not gate `survivingSharedClaimRepoPaths`'s `sourceFile` check on
  ANY pending entry — gate it on `entry.placeholder`. A real, non-placeholder entry evicted from a
  tautological key collision can carry a PURELY DEFENSIVE `sourceFile` inference (card `d163aef5`, round
  3's own "no tracked pending reference — infer the key's current physical file," with that entry's real
  backing already safe elsewhere) — treating that inferred guess as a hard veto wrongly blocks clearing
  an unrelated, legitimate winner. See `merge-quarantine-pass1-degraded-union-guard.mjs`'s own
  `round5-own-raise-lifts-past-inferred-evictee` scenario — the regression this correction fixed.
- **(Follow-up 95ea8d3f, Round 2)** Do not assume `deleteMergeQuarantineLatchByKey`'s own `provenCoverage`
  is exempt from the shared-claimant check just because it already gates on `marked` — compute
  `survivingSharedClaimRepoPaths` UNCONDITIONALLY there too (rule 1 is general, not marked-only), or a
  non-marked path to the same shared-corrupt-latch shape would reopen the identical collateral loss.
- **(Follow-up 95ea8d3f, Round 2)** Do not aggregate a sweep/delete call's own `kept`/`referencingRepoPaths`
  result by checking `referencingRepoPaths.length > 0` alone before deciding whether to surface
  `latchKept` — `kept:true` with an EMPTY array (an unconfirmed EPERM/EBUSY unlink, or a marked-but-
  unprovable-coverage keep) still means something was genuinely kept; track it via a separate
  `anyKeptUnattributed` flag, OR'd in alongside the named-repoPath Set, or the anonymous case silently
  reports plain success.
- **(Follow-up 95ea8d3f, Round 3)** Do not let `survivingSharedClaimRepoPaths`'s `orphanLatchFiles` check
  count a hit from ANY entry whose `orphanLatchFiles` names `filename` — gate it on that SAME entry's own
  `sourceFile === filename` (a genuine self-reference). A DIFFERENT entry's stale cross-reference —
  including PASS 2's own "every registered repo's entry references an unmatched orphan" broadcast — is
  `9cabd143`'s own forbidden check-1 shape and must never veto clearing an unrelated entry's own file.
- **(Follow-up 95ea8d3f, Round 3)** Do not keep an ACTIVE-entries `orphanLatchFiles` loop in
  `survivingSharedClaimRepoPaths` at all — an active `MergeQuarantineEntry` has no `sourceFile` field of
  its own to self-reference against, and every genuine self-referencing example (`4900c365`, `ef651188`)
  is a PENDING-entry shape. Re-adding one reopens exactly this round's own regression.
- **(Follow-up 95ea8d3f, Round 3)** Do not assert "sharing this exact degraded key" in a named-keep
  `reason` string unconditionally — that framing is true only for the `882d6cff` shared-corrupt-latch
  shape, not for a self-referencing protected-copy/safety-tmp keep (`4900c365`/`ef651188`), which has
  nothing to do with key-sharing at all. State the keep cause generically and offer the clear-by-id
  remedy CONDITIONALLY ("if they share this exact degraded key...").
- **(Follow-up 95ea8d3f, Round 3; CORRECTED BY Follow-up `0dc514dc`)** The original text of this bullet
  said never to manufacture a fixture proving `sweepOwnLatchFileUnlessOwnedElsewhere`'s own placeholder-
  `sourceFile` check fires as the discriminating reason, since reaching that branch "cannot, by
  construction" coincide with a genuine placeholder. FALSE — `markedFinalFullyCoveredByClear`'s own
  vacuous "every on-disk token already covered" result for an EMPTY token array, combined with a `final`
  holding valid-but-field-missing JSON (e.g. `{}`, which PASS 1 ALSO treats as corrupt enough to mint a
  placeholder), makes the branch genuinely reachable. See `crnit2` in
  `merge-quarantine-raise-protect-failure.mjs` and this card's own Follow-up section below.

## Follow-up `0dc514dc` — two latches a surviving entry still needed, on clear and on raise; CONTENT-based, never reference-based (`9cabd143`)

Round-3 Code Review `22bca242` of `95ea8d3f` found two further FAIL-OPEN findings, both pre-existing on
main (not a regression of `95ea8d3f` itself): a clear, and a raise, could each destroy a latch file that
is a SURVIVING entry's only durable backing — with NOTHING structural (`orphanLatchFiles`/`sourceFile`)
pointing at it from either side, so neither the pre-existing structural veto (`survivingSharedClaimRepoPaths`,
banned by `9cabd143` from considering a bare reference) nor any identity check already in place could
ever have caught it. The CR's own direction: use a CONTENT-based check instead — before destroying a
latch, read its own on-disk tokens via a shared reader, and if any of them is still held by a surviving
active or pending entry OTHER than the one being cleared or raised, protect the content.

### Repro A (clear path) — `deleteMergeQuarantineLatchByKey` had no token-overlap backstop when `entry` is undefined

1. Write `<Krhash>.json` = `{repoPath: r/gone-subdir (D), tokens:[d-token], resolvedKey: Kr}`.
2. `reenterMergeQuarantinesAtBoot([])` — PASS 1 arms D under its own recorded `resolvedKey` (Kr), trusting
   it despite D itself being unverifiable.
3. `clearMergeQuarantineReporting(r)`, with D's own pending-divert write failing — D ends up a self-owned
   pending entry, with `sourceFile = Krhash.json` (`final` itself, untouched; this step's own protect call
   already keeps the file correctly, by the PRE-EXISTING token-overlap-aware protect machinery).
4. Make `r/gone-subdir` its own real git repo — D becomes resolvable, at its OWN key `Kd != Kr`.
5. `activeMergeQuarantineFor(D)` — lazy graduation to ACTIVE at `Kd`, but the write there fails (injected).
   D's only durable backing stays at `Krhash.json` (folded into D's own `orphanLatchFiles`), and its
   pending twin is consumed.
6. `clearMergeQuarantine(r)` — **r has NO quarantine of its own at `Kr` at all.** `entry =
   activeQuarantines.get(Kr)` is `undefined`, so `clearingRepoPath`/`clearedEntry` are BOTH `undefined` —
   neither `protectDegradedOccupantBeforeDelete` nor `protectUnincorporatedOccupantBeforeDelete` even
   runs, and `survivingSharedClaimRepoPaths` finds nothing (D's pending twin was already consumed in step
   5 — nothing in `pendingUnresolvedQuarantines` references `Krhash.json` any more). Pre-fix:
   `Krhash.json` is unlinked outright. d-token is lost after a reboot.

### Repro B(a) (raise path) — `mergeTokenIntoPendingEntries` unconditionally overwrote a shared `sourceFile`

1. Write corrupt `<Krhash>.json` F (or, see the correction above, valid-but-field-missing `{}`).
2. `reenterMergeQuarantinesAtBoot([d1, d2])` — TWO pure-pending placeholders (card `882d6cff`'s own
   shared-corrupt-latch shape), both with `sourceFile = F`.
3. `enterMergeQuarantine(d1)`, while d1 is STILL unresolvable — this reaches `mergeTokenIntoPendingEntries`
   (never `enterMergeQuarantine`'s own `verified` raise-write branches), which durably rewrote `base.sourceFile`
   (here, `F`) with d1's OWN merged content UNCONDITIONALLY, with no check for whether a DIFFERENT,
   surviving pending entry (d2) also depends on that exact file. Pre-fix: F is overwritten with valid JSON
   naming d1 alone. After a reboot d2 is gone, with no clear at all.

### Repro B(b) (raise path) — `differentUnresolvableOccupantRepoPathAt`'s own "resolvable ⇒ safe" shortcut assumed the occupant's real backing lives at its OWN key

In shape A above, after step 5 (D ACTIVE at its own key `Kd`, but with NO physical backing there — its
graduation write failed, so its ONLY durable copy is still `Krhash.json`): `enterMergeQuarantine(r)`
reaches the "no existing" raise-write branch's own `protectDegradedOccupantBeforeDelete` call, which
read `Krhash.json`, found D's own content, and — because D is now RESOLVABLE — took
`differentUnresolvableOccupantRepoPathAt`'s pre-existing "a different identity that is CURRENTLY
RESOLVABLE is also safe" branch (`state: "none"`), on the theory that a resolvable occupant's own real
backing lives at ITS OWN key and whatever sits here is stale, safely-overwritable leftover. That theory
is false in exactly this shape: D's real backing is STILL this exact file. Pre-fix: `r`'s raise overwrites
`Krhash.json` outright (`protectOk` stays `true`, nothing marks the basename, `resolveRaiseOverwrite`'s own
fast path proceeds with no read at all). d-token is lost after a reboot, with no clear at all.

### The fix

Two new shared primitives in `merge-quarantine.ts`:

- `readFinalOnDiskSurvivingTokens(final)` — `final`'s own on-disk SURVIVING tokens (via the existing
  shared `readSurvivingOnDiskTokens`), or `[]` for ENOENT/EISDIR, any other read failure, or corrupt JSON
  — every one of those cases is already governed by this module's other, identity/reference-based checks;
  this helper feeds ONLY the new content-based check below.
- `survivingTokenHolderRepoPaths(tokens, excludeIdentity)` — repoPaths of every SURVIVING active or
  pending entry, OTHER than `excludeIdentity` ({@link directPathIdentity}), that currently holds ANY of
  `tokens`. Purely content-based — unlike `survivingSharedClaimRepoPaths`, this never looks at
  `orphanLatchFiles`/`sourceFile` at all (`9cabd143` bans a reference-based veto). Excludes by IDENTITY
  (never by object reference), so every record sharing the clearer/raiser's own identity is correctly
  treated as "the one being cleared or raised," never as a foreign survivor of itself — this is what
  keeps the check from firing on `95ea8d3f-r3-orphanref` (bToken is held only by B, which is being
  cleared: excluding B's own identity leaves nothing else holding it).

**Repro A's fix — `deleteMergeQuarantineLatchByKey`:** `contentClaimants` is computed ONCE, at the TOP of
the function, BEFORE any protect call runs — **not** at the end, alongside `sharedClaimants`, as a first
draft of this fix tried. Two reasons, both found only by running the full corpus, not by this card's own
new scenarios:
1. **Timing (the TOCTOU-shaped regression).** A protect call that SUCCEEDS during this SAME invocation
   (relocating a genuinely foreign occupant's content into a fresh pending-divert copy) leaves `final`'s
   OLD bytes physically unchanged until the unlink actually runs. A content check computed AFTER that
   protect call would read those stale bytes and find the SAME tokens ALSO present in the fresh copy it
   just created — a transient, self-inflicted "duplicate" that wrongly blocks a legitimate unlink
   (`in-memory-twin-clear-destroys-degraded-file`'s own precondition: "Y legitimately owns Ky now"
   regressed to `FAIL` under the naive end-of-function placement). Computing it BEFORE any protect call
   runs in this invocation sees the world as it was independent of this clear's own actions.
2. **Read-count fragility.** Several existing tests (`merge-quarantine-protect-read-failure.mjs`'s
   `round4-b1`/`round4-lifecycle`) inject a read failure keyed to a specific call NUMBER (e.g. "fail only
   the 1st read of `final`"). An unconditional extra read anywhere ahead of the EXISTING protect call's
   own read silently steals that slot, letting the protect call's own read see success one call later
   than the test expects — turning a correctly-marked-kept file into a wrongly-unlinked one. **The fix is
   gated** — `contentClaimants` is only ever computed when NEITHER `clearingRepoPath` NOR `clearedEntry`
   is given (this card's own Repro A shape: `entry` is `undefined`, so neither protect call would ever
   read `final` anyway) — so it never adds a read ahead of one that already exists. This is a narrower
   scope than "every clear," by design: it closes exactly the gap Repro A demonstrates, not a general
   content scan on every clear.
3. **Correction (Round 2, CR `582ce5a9`).** This section previously claimed "a token already in
   `clearedEntry.tokens` is excluded, in addition to the identity exclusion" — FALSE, no such code
   exists. `contentClaimants` is gated OFF entirely whenever `clearedEntry` is given (point 2 above), so
   there is never a call where BOTH a `clearedEntry` and a non-empty `contentClaimants` scan coexist —
   nothing to exclude its tokens from in the first place. The identity exclusion (`clearIdentity`) alone
   is what this gate's one reachable shape (Repro A: `clearedEntry` undefined) needs, and is all the
   code does.

**Repro B(a)'s fix — `mergeTokenIntoPendingEntries`:** before writing `merged` to `base.sourceFile`, check
`survivingSharedClaimRepoPaths(base.sourceFile)` (the EXISTING structural check, reused — not a new
content check: a placeholder's own tokens never appear in its file, so content cannot discriminate this
shape at all, exactly the card's own ruling). `matched`'s own entries are already spliced out of
`pendingUnresolvedQuarantines` earlier in the same function, so this sees only a genuinely OTHER surviving
claimant. A non-empty result diverts via `divertRaiseEntry(merged)` instead of writing to the shared file
— reusing `divertRaiseEntry` rather than inventing a second copy-aside primitive.

**Repro B(b)'s fix — `differentUnresolvableOccupantRepoPathAt`'s own "resolvable" branch:** no longer
unconditionally returns `{state:"none"}` for a different, currently-resolvable identity. It now re-reads
that identity's own on-disk tokens (reusing the SAME read this function already performed — never a
second read) and checks `survivingTokenHolderRepoPaths(surviving, directPathIdentity(ownIdentityRepoPath))`;
only when NOTHING else still holds those tokens does it fall through to `"none"`. Otherwise it returns
`{state:"occupant", repoPath: existing.repoPath}` exactly like a genuinely unresolvable occupant would —
which routes through the SAME pre-existing `protectOccupantContentBeforeDelete` copy-aside the unresolvable
branch already uses, **not** a divert of the raiser's own write. This mirrors shape 1's own
protect-then-overwrite pattern: D's content is durably relocated to its own pending-divert file BEFORE
r's write proceeds, and `final` legitimately ends up holding r's own content afterward — d-token is never
lost, but `final`'s bytes are **not** expected to stay byte-for-byte unchanged (an earlier draft of this
card's own test asserted exactly that, and had to be corrected once the real behavior was observed).

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`carda`** — Repro A, ported verbatim. Asserts `final` SURVIVES the clear, the clear reports
  `latchKept` naming D, and d-token is enforced both in-process and after a fresh-import reboot — measured
  directly via `listActiveMergeQuarantines().flatMap(q => q.tokens ?? [])`, never `assertRepoNotQuarantined`.
- **`cardba`** — Repro B(a), ported verbatim. Asserts F's own corrupt content is UNCHANGED by d1's raise,
  d1's own raise persists, and d2 survives a fresh-import reboot (d2's own token is not expected
  byte-identical across boots — a generic placeholder mints a fresh `randomUUID()` per boot, since
  nothing usable was ever parsed; only its identity surviving is the real guarantee, same discipline as
  `95ea8d3f-r2-shared`).
- **`cardbb`** — Repro B(b), ported verbatim. Asserts d-token is NEVER LOST (found via
  `listActiveMergeQuarantines`, not a `final`-content byte-compare) both immediately after r's raise and
  after a fresh-import reboot, and that r's own raise persists too.
- **`crnit2`** — the Code Review item 2 correction's own fixture (the `{}`-content variant of B(a)'s
  shared-latch setup, plus a transient read failure on `r`'s own raise to mark the basename kept). Asserts
  the clear's own `latchKept` result names d2 SPECIFICALLY (`referencingRepoPaths` non-empty) — the
  discriminating proof that `survivingSharedClaimRepoPaths`'s own veto, not the generic unattributed-kept
  bucket, is what kept the file — and that d2 survives a fresh-import reboot.

`cardba` and `crnit2` both hard-reset `MERGE_QUARANTINE_DIR` at their own start (`fs.rmSync` +
`fs.mkdirSync`, mirroring `merge-quarantine-migrate-source-owner-durable.mjs`'s own precedent) — this file
runs 30+ scenarios sharing one directory, and both of these repros are sensitive to an unrelated, earlier
scenario's own leftover orphan residue being broadcast onto their own `d1`/`d2` by PASS 2's "every
registered repo's entry references an unmatched orphan" mechanism. Every OTHER new scenario in this card
does not need the reset — their own precondition checks don't depend on exact file content/count.

**Correction (Round 2, CR `582ce5a9`) — the original "all four new scenarios proven RED" claim was
imprecise.** `negative-control`'s own verdict is for the WHOLE test FILE (a single exit code), not
per-assertion — it genuinely proves "something in this file regresses on the reverted source," never
"every new scenario's every check goes RED." Measured precisely, per scenario:
- `carda`: genuinely RED pre-fix (`final` gets unlinked outright) and GREEN after.
- `cardba`: the IN-PROCESS checks (F's content unchanged, d1's own raise persists) already pass
  pre-fix too — `mergeTokenIntoPendingEntries`'s own overwrite doesn't touch d1's own in-memory state,
  only d2's durable backing. It goes RED **only at the reboot assertion** (d2 does not survive).
- `cardbb`: same shape as `cardba` — the in-process "d-token is NEVER LOST" check already passes
  pre-fix (D's own in-memory active entry is untouched by what happens to `final`'s physical bytes); RED
  is at the reboot assertion only.
- `crnit2`: GREEN on the parent too, by design — see the correction inserted at the "sweep-path
  structural veto" section above. This fixture pins already-correct, pre-existing (`95ea8d3f`) behavior
  and corrects the record's own wrong claim about it; it was never expected to discriminate this card's
  own code change, and does not.

All `merge-quarantine*.mjs` files re-verified individually, each exit 0. `95ea8d3f-r3-orphanref`
re-verified green, unaffected — bToken is excluded by the identity-exclusion rule, never because the
content check happens not to run.

## Round 2 (Code Review `582ce5a9`) — a two-path asymmetry: `resolveRaiseOverwrite`'s own independent
slow-path re-read of the SAME "resolvable ⇒ safe" shortcut was untouched by Round 1

Round 1 relaxed `differentUnresolvableOccupantRepoPathAt`'s own "resolvable ⇒ safe" shortcut (for Repro
B(b)). `resolveRaiseOverwrite`'s own slow path has an INDEPENDENT copy of that same shortcut
(`if (isRepoPathCurrentlyResolvable(parsed.repoPath)) return false;`), reached whenever a protect call's
own `protectOk` return is `false` — including a DOUBLE FAULT, where the detector correctly flags D (Round
1's own fix) but D's own protect-copy write ALSO fails, so there is nowhere durable for D's content to
land. `protectOccupantContentBeforeDelete` falls back to keeping `final` as D's own self-owned pending
record (its OWN write never attempted a different file) and returns `false` — `resolveRaiseOverwrite`
then independently re-reads `final`, sees D is resolvable, and (pre-this-round) blindly proceeds anyway.

### Repro P3 (the reviewer's own, verbatim)

1. Run Repro A steps 1-5 (`carda`'s own setup): D kept as a self-owned pending via a failed divert write,
   then graduates to ACTIVE at its own key Kd (graduation write there ALSO fails).
2. Inject an `openSync` failure on `pending-<hash(D)>.json`, then call `enterMergeQuarantine(r)`.
3. The detector flags D (Round 1's own fix). `protectOccupantContentBeforeDelete` fails to write the
   copy-aside, so it keeps `Krhash.json` as D's own self-owned pending and returns `false`.
4. `resolveRaiseOverwrite` re-reads, sees D is resolvable, and (pre-fix) proceeds. r's write overwrites
   `Krhash.json`.
5. `clearMergeQuarantine(r)` gives `latchKept:[D]`, keeping a file that now holds r's data.
6. Fresh-import reboot (pre-fix — reproducible on `4dba1d37`, this card's own parent, AND still on
   `f89cfbd2`, Round 1's own commit): d-token is LOST — a pre-existing fail-open this round CLOSES, not
   an accepted residual — and r's own CLEARED token RESURRECTS (the regression Round 1's own content
   check introduced, since it reaches this far without ever being consulted by this slow path).

### The fix

`resolveRaiseOverwrite`'s own `isRepoPathCurrentlyResolvable(parsed.repoPath)` branch now runs the SAME
content check, reusing `parsed` (never a second read) — but gated on `!protectOk` ONLY, which also
CLOSES the pre-existing d-token loss above (diverting instead of proceeding means D's content is never
overwritten in the first place). `protectOk === true` reaching this branch at all requires `marked` to
ALSO be true (the fast path above already returns for `protectOk && !marked`), and means ONE of two
things: either the protect call durably copied a genuine occupant's content aside for THIS SAME
invocation, or the detector found nothing to protect at all (`differentUnresolvableOccupantRepoPathAt`'s
own `"none"`). A content check reached there would double-count the FIRST case's own fresh copy (the
transient-duplicate false positive this card's own Do-not list already warns about) — and the SECOND
case needs no such check either: a stale mark on this SAME (same-identity) basename is already correctly
handled by the write's own chokepoint (`reconcileMarkedBasenameBeforeWrite`/`foldInOnDiskTokensIfMarked`),
which unions any genuinely on-disk tokens forward for THIS exact write before it ever proceeds. Every
`protectOk === false` path reaching this branch, by contrast, never durably writes a fresh copy of
anything (a read-failure mark, or a self-owned-pending fallback that points at `final` itself, never a
different file) — so there is nothing to double-count, and nothing else already covers it.

### Open question — `wouldOverwriteDifferentUnresolvableOccupant` (non-raise writers) shares the SAME
detector Round 1 touched, and a quick repro confirmed it IS a real, new fail-closed

`differentUnresolvableOccupantRepoPathAt` is shared by `protectDegradedOccupantBeforeDelete` (raise +
clear) AND `wouldOverwriteDifferentUnresolvableOccupant` (a NON-raise writer's own degraded-occupant
guard — graduation, sibling-absorb). Round 1's own content check, applied uniformly via the shared
detector, can flag a GENUINELY STALE leftover of an occupant that is ALREADY durably, independently
backed elsewhere (its own real key, properly migrated) — purely because the stale leftover's own bytes
still carry the SAME token the occupant's CURRENT, real record also holds. Confirmed empirically: D
raises fresh and writes successfully to its own key Kd; a stale leftover of D (same repoPath, same
token) is placed at a DIFFERENT key Kr; E (an unrelated, unresolvable entity walking up to Kr) raises,
then becomes resolvable and queries — the lazy-graduation write at Kr (guard ACTIVE, unlike a raise) was
refused, verified by reverting only this round's own exclusion and re-running: `Krhash.json` was left
unchanged, still holding D's stale data (the write was durably refused). **Correction (CR2 `a5b84e8e`):**
`eActive?.armedKeys` is NOT the discriminator here — an entry is armed IN-MEMORY unconditionally, whether
or not the durable write itself succeeds (e1cb7d33: enforcement for this process must not wait on disk
I/O), so `armedKeys` is non-empty on BOTH sides. `Krhash.json`'s own CONTENT (does it hold D's stale
bytes, or e's own) is the real discriminator. Restoring the fix, E's write durably succeeds.

**The fix:** `confirmedDurableBackingElsewhere(entry, token, excludeFinalPath)` — `true` iff `entry` has
an INDEPENDENT, confirmed-on-disk backing for `token` at one of its OWN `armedKeys` OTHER than
`excludeFinalPath` (a real file exists there right now, names the SAME identity, and still carries
`token`). Never checks `excludeFinalPath` itself — that would tautologically "confirm" a stale leftover
using its own soon-to-be-destroyed/overwritten bytes. `survivingTokenHolderRepoPaths` gained an optional
`excludeFinalPath` parameter: when given, an ACTIVE entry whose every MATCHED token is already confirmed
durably backed elsewhere is excluded from the result. Every existing caller that omits the parameter
(the clear path, both `resolveRaiseOverwrite` uses) keeps today's behavior byte-identical — this is
additive, and does not reopen Repro A/B(b)/P3, since in every one of those shapes the occupant's own
`armedKeys` target has NO durable backing at all (confirmed by the injected write failures that define
those repros) — `confirmedDurableBackingElsewhere` only ever EXCLUDES a genuinely safe case, never
re-includes an unsafe one. `differentUnresolvableOccupantRepoPathAt`'s own resolvable branch passes
`final` as `excludeFinalPath`.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`p3`** — the reviewer's own repro, ported verbatim. Asserts `final` is NEVER overwritten (D's own
  content survives byte-for-byte — a double fault has nothing safe to divert TO, so proceeding would be
  the only alternative to diverting), r's own raise persists (diverted), the clear reports `latchKept`
  naming D, and — the discriminating check — after a fresh-import reboot, d-token SURVIVES and r's own
  CLEARED token does NOT resurrect (unchanged from the parent commit's own behavior for that half).
- **`openq`** (the open question's own repro) — D raises fresh to its own key Kd; a stale leftover of D
  (same token) is placed at a DIFFERENT key Kr; E raises while unresolvable (walking up to Kr), then
  becomes resolvable and is queried (lazy graduation, guard ACTIVE). Asserts `Krhash.json` now holds e's
  own content (the real discriminator — `armedKeys` non-empty is asserted too, but labeled as NOT
  discriminating: it passes on `f89cfbd2` as well, per the correction above) and D's own token is
  unaffected throughout. **Reboot leg (CR2 `582ce5a9`/`a5b84e8e`):** the card's own real failure mode here
  is a CLEARED-TOKEN RESURRECTION, not merely a refused write — `clearMergeQuarantineByToken(d, dToken)`,
  then a fresh-import reboot, asserting D's own cleared token does NOT resurrect and e's own raise
  survives. Proven RED on `f89cfbd2` and GREEN after, via `negative-control --ref f89cfbd2` — both the
  content-match assertion and the reboot assertion discriminate against that exact ref; every other
  `openq` check (including the relabeled `armedKeys` one) passes on both sides.

Both `p3` and `openq` proven RED on `f89cfbd2` (Round 1's own commit) and GREEN after, via
`negative-control --ref f89cfbd2` against the whole test file. All `merge-quarantine*.mjs` files
re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green (30/30).

## Do not

- **(Round 2)** Do not leave `resolveRaiseOverwrite`'s own slow-path "resolvable ⇒ safe" shortcut
  unguarded by a content check just because `differentUnresolvableOccupantRepoPathAt` already has one —
  the two are INDEPENDENT re-reads at two different call sites; fixing one does not fix the other (P3's
  own regression).
- **(Round 2)** Do not gate `resolveRaiseOverwrite`'s own new content check on anything other than
  `!protectOk` — the slow path only reaches this branch with `protectOk === true` when `marked` is ALSO
  true, meaning either a protect call JUST durably copied something aside for THIS SAME invocation (a
  content check there would double-count that fresh copy — the exact transient-duplicate false positive
  this card's own Do-not list already warns about) or there was nothing to protect at all, in which case
  the write's own chokepoint (`reconcileMarkedBasenameBeforeWrite`) already correctly unions any
  genuinely on-disk tokens forward — never assume the first case is the ONLY reason `protectOk` can be
  `true` here, or the safety argument is incomplete.
- **(Round 2)** Do not assume fixing `differentUnresolvableOccupantRepoPathAt`'s own "resolvable" branch
  is safe for EVERY one of its callers without checking which ones share it — `wouldOverwriteDifferentUnresolvableOccupant`
  (non-raise writers) shares the identical detector, and Round 1's own content check, applied there
  unguarded, created a genuine new fail-closed: a stale leftover of an occupant ALREADY durably backed
  elsewhere got wrongly flagged, refusing an unrelated entity's own legitimate write. Add
  `confirmedDurableBackingElsewhere` rather than assuming the fix is universally safe.
- **(Round 2)** Do not check `excludeFinalPath` itself inside `confirmedDurableBackingElsewhere` — a
  stale leftover's own bytes trivially "confirm" themselves if the exclusion is dropped, defeating the
  entire point of the check (it exists specifically to require an INDEPENDENT, different physical
  backing, not a tautological self-match).
- **(Round 2, CR2 `a5b84e8e`)** Do not assert `armedKeys` non-empty as proof a durable write succeeded —
  an entry is armed IN-MEMORY unconditionally the instant it's constructed, whether or not the physical
  write behind it ever lands (e1cb7d33: enforcement for this process must not wait on disk I/O). It
  passes on BOTH sides of a refused-vs-succeeded write; the file's own CONTENT is the only thing that
  actually discriminates. `openq`'s own `armedKeys` check is kept, but labeled as non-discriminating.
- **(Round 2)** Do not claim "all N new scenarios proven RED" from a single `negative-control` run's
  overall exit code — that proves the FILE regresses somewhere, never that every individual assertion in
  every new scenario does. State which specific assertion(s) discriminate (often only the reboot check;
  an in-process check can legitimately pass on both sides, since an in-memory active entry is untouched
  by what happens to a physical file's own bytes) and which scenarios are deliberately GREEN on the
  parent by design (a documentation-only correction with no code change, like `crnit2`).
- **(Round 2)** Do not claim a content-check exclusion exists in code without grepping for it — this
  record's own Repro A section once claimed `clearedEntry.tokens` was excluded "in addition to the
  identity exclusion"; no such code exists, because the content check there is gated OFF entirely
  whenever `clearedEntry` is given. See the correction inserted at that section.

- **(Follow-up `0dc514dc`)** Do not compute a new content-based read of `final` unconditionally, or at
  the END of a clear function alongside an existing structural check — a protect call that SUCCEEDS
  earlier in the SAME invocation leaves `final`'s stale bytes physically present until the unlink runs,
  and a content check reading them AFTER that protect call will find its own fresh copy as a false
  "survivor." Compute it BEFORE any protect call in the same function can run, or gate it to the exact
  shape where no protect call would run at all.
- **(Follow-up `0dc514dc`)** Do not add a content-based read of `final` anywhere a test in this corpus
  injects a read failure keyed to a specific call NUMBER, without re-checking every such test — an extra
  read ahead of an existing one silently shifts which call sees the injected failure. Gate narrowly
  (this card's own fix: only when neither `clearingRepoPath` nor `clearedEntry` is given) rather than
  widen a content check's reach "while you're in there."
- **(Follow-up `0dc514dc`)** Do not exclude only by `directPathIdentity` when deciding whether a token
  found on disk is "owed elsewhere" on the CLEAR path — also exclude any token already present in
  `clearedEntry.tokens` itself. A degraded dual-arm union can carry a different contributor's own token
  under the entry actually being cleared, with that contributor's own bare `repoPath` never matching
  `clearIdentity` — excluding by identity alone re-flags content the clearer's own bookkeeping already
  safely accounts for.
- **(Follow-up `0dc514dc`)** Do not add a content-based veto to `mergeTokenIntoPendingEntries` for the
  B(a) shape — a placeholder's own tokens never appear in its on-disk content, so a content check would
  be a silent no-op there. Reuse the EXISTING structural check (`survivingSharedClaimRepoPaths`), never a
  parallel content-based mechanism that cannot discriminate this shape at all.
- **(Follow-up `0dc514dc`)** Do not "fix" B(b) by adding a content check inside `resolveRaiseOverwrite`'s
  own fast path (`protectOk && !marked`) — a first draft of this fix did exactly that, and it reproduces
  the IDENTICAL transient-duplicate false positive as computing Repro A's own check too late: a
  successful protect-then-overwrite (shape 1's own established pattern) leaves `final`'s stale bytes
  physically present until the write runs, and the fast-path check would find its own fresh copy as a
  false "survivor," wrongly diverting a write that should legitimately proceed
  (`merge-quarantine-raise-protect-failure.mjs`'s own `fp:reraise` positive control regressed under this
  draft). Fix the ROOT detector (`differentUnresolvableOccupantRepoPathAt`'s own "resolvable ⇒ none"
  shortcut) instead, reusing the read it already performs — never add a second, independent read at a
  DIFFERENT call site for the same decision.
- **(Follow-up `0dc514dc`)** Do not assert that `final`'s own bytes stay byte-for-byte unchanged as the
  discriminating proof for B(b)'s own fix — the actual fix routes D through the SAME protect-then-overwrite
  pattern shape 1's own positive control already exercises (content durably relocated, then `final`
  legitimately overwritten by the raiser). Assert that D's own token is never lost (present in
  `listActiveMergeQuarantines`'s own flattened tokens), in-process and after a reboot — the same
  discipline every other card in this module already uses, not a new, stricter claim this fix never made.
- **(Follow-up `0dc514dc`)** Do not trust `markedFinalFullyCoveredByClear`'s own "provably covered" result
  as proof that `final` holds a GENUINE latch — it is vacuously `true` for a `final` holding valid JSON
  with ZERO on-disk tokens (e.g. `{}`), which is simultaneously exactly what PASS 1's own boot
  classification treats as corrupt enough to mint a `882d6cff` placeholder. The Round-3 "direct tension"
  argument that the sweep-path placeholder veto is structurally unreachable assumed otherwise, and was
  wrong — see the correction inserted at that section above, and `crnit2`'s own fixture.

## Follow-up 5b55149b (Code Review of 7a7e041b, reviewer 47f5c0e3) — the shared reader never fell back to the legacy `token` field when `tokens` was an EMPTY array

Both minor, non-blocking, fail-closed.

1. **Legacy token lost.** `readSurvivingOnDiskTokens`'s own array-type guard — `Array.isArray(parsed.tokens)
   && parsed.tokens.every(...)` — treats `tokens: []` as a VALID (if empty) string array, so it never fell
   through to the `token` singular fallback at all; that fallback only ever fired when `tokens` was missing
   or malformed. For `{tokens: [], token: "x"}`, `raw` came back `[]`. The one caller that matters most here
   is `protectOccupantContentBeforeDelete`: its own skip condition (`rawTokens.length > 0 &&
   survivingTokens.length === 0`) never fires when `rawTokens` is itself empty, so it fell through to
   `tokens = survivingTokens.length > 0 ? survivingTokens : [randomUUID()]` and minted a BRAND-NEW random
   token standing in for the real legacy one — `x`'s own holder can no longer clear it by token, and only a
   human full-clear can lift it. Reachability was essentially nil (no current writer emits `token:` or
   `tokens: []`), but the fallback shape itself was simply wrong.
2. **Test overstated its coverage.** `7a7e041b-mixed`'s own narrative (this record, Follow-up `7a7e041b`,
   Tests section) claimed keepTok survives "in-process and across a reboot" — but every reboot check in
   that scenario ran AFTER keepTok was already cleared, so survival across a reboot while still held was
   never actually asserted.

### The fix

1. `readSurvivingOnDiskTokens` (merge-quarantine.ts) now requires `parsed.tokens.length > 0` as part of
   the array-type guard, so an empty array falls through to the `token` singular fallback exactly like a
   missing or malformed one — the `clearedTokens` subtraction is unchanged.
   **Correction (card `25f6a7dc`) — this was NOT "both existing callers."** At the time this fix landed,
   SIX call sites already routed through the shared reader and got this fix for free, since none
   re-derives the parse itself: `differentUnresolvableOccupantRepoPathAt` (~L712),
   `readFinalOnDiskSurvivingTokens` (~L825, itself called by `survivingTokenHolderRepoPaths`),
   `tombstoneIfNotSurviving` (~L847), `foldInOnDiskTokensIfMarked`/`reconcileMarkedBasenameBeforeWrite`
   (~L928), `protectOccupantContentBeforeDelete` (~L1658), and `resolveRaiseOverwrite`'s own
   "resolvable ⇒ safe" branch (~L1852). THREE further inline parsers — `unincorporatedOccupantRepoPathAt`
   (~L751), `markedFinalFullyCoveredByClear` (~L1318), and `resolveRaiseOverwrite`'s own "already
   incorporated" check (~L1856) — re-derived the SAME parse independently and so did NOT get this fix for
   free; they drifted from the shared reader's own `length > 0` fallback until card `25f6a7dc` routed all
   three through it too (see "Follow-up 25f6a7dc" below).
2. `merge-quarantine-raise-protect-failure.mjs`'s `7a7e041b-mixed` scenario gained a fresh-import reboot
   check — BEFORE either token is cleared — asserting keepTok is present (with `repoPath === d`) and
   deadTok is absent, closing the coverage gap in finding 2.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`7a7e041b-b2`** — the reviewer's own probe B2: `final` hand-written as `{tokens: [], token:
  "legacy-live-tok-..."}`(the legacy singular shape with an empty array, never the array form). Asserts
  the legacy token survives `protectOccupantContentBeforeDelete`'s own copy-aside (never replaced by a
  freshly-minted random token), survives a fresh-import reboot BEFORE any clear, and is still clearable BY
  TOKEN afterward — in-process and after a second reboot.
- **`7a7e041b-mixed`** — unchanged setup; added a fresh-import reboot check right after the raise (before
  either `clearMergeQuarantineByToken` call) asserting keepTok is present with `repoPath === d` and deadTok
  is absent, per finding 2 above.

Both of `7a7e041b-b2`'s own new assertions proven RED on `HEAD` (pre-fix) and GREEN after, via
`scripts/negative-control.mjs` — the RED phase fails exactly those two assertions with the build
succeeding on both sides, so the RED is behavioral, not a build failure. All 33 `merge-quarantine*.mjs`
files re-verified individually, each exit 0. All static guards (`pnpm --filter @loom/daemon guards`)
re-verified green (30/30). Line endings re-verified CR==LF via the `tr -dc` recipe.

## Follow-up 25f6a7dc (Code Review of 5b55149b) — three inline token parsers still bypassed the shared reader; one FAILS OPEN

Pre-existing, not introduced by `578b6d5a`. Reachability was roughly nil (no current writer emits
`tokens: []`), but one of the three fails open. Three inline token parsers re-derived the SAME
`tokens`/`token` parse `readSurvivingOnDiskTokens` already centralizes, and so never got `5b55149b`'s own
`length > 0` legacy-fallback fix — each lacked both halves of the shared reader's contract: the legacy
fallback AND the `clearedTokens` subtraction.

- **`markedFinalFullyCoveredByClear` (~L1309), FAIL-OPEN.** `[].every(...)` is vacuously `true`. A marked
  `final` holding a legacy token X (`{tokens:[], token:X}`) not in `candidateTokens` read as "fully
  covered" — its callers (`deleteMergeQuarantineLatchByKey`, `sweepOwnLatchFileUnlessOwnedElsewhere`) then
  unlinked a file boot recovery would have re-armed with X.
- **`unincorporatedOccupantRepoPathAt` (~L734) and `resolveRaiseOverwrite`'s own "already incorporated"
  check (~L1833), FAIL-CLOSED.** The same missing legacy fallback meant a legacy-shaped `final` whose
  token was ALREADY part of the clearer/raiser's own in-memory tokens never matched the "already
  incorporated" token-overlap exemption — falling through to `{state:"occupant"}` and minting a redundant
  protect copy-aside for a token that needed none.

### The open question, and the ruling

The card asked whether `markedFinalFullyCoveredByClear`'s own coverage proof should test `raw` or
`surviving` (does a cleared-but-still-on-disk token count as covered?). **Ruling: test the RAW on-disk
tokens, minus nothing** — a raw token is covered only if it is in `candidateTokens` (being cleared by THIS
clear) OR already in `clearedTokens` (deliberately released earlier this process). This is numerically
identical to `surviving.every(candidateTokens.includes)` (every raw token is either tombstoned, and so
absent from `surviving`, or present in `surviving` and must then satisfy `candidateTokens`) — the explicit
raw-plus-OR form is preferred because it states the "or already cleared" reasoning at the call site instead
of hiding it inside a pre-filtered array a future reader could mistake for "nothing subtracted." Empty raw
tokens with no legacy token (`{tokens:[]}` / `{}`) still read as vacuously covered under this rule — this
is NOT a regression: nothing is lost (there is no token to lose), and the `crnit2` fixture (Follow-up
`0dc514dc`, Round 3) already established that a `{}`-content placeholder's own structural dependents are
protected separately, by `survivingSharedClaimRepoPaths`'s own `sourceFile` check, which `deleteMergeQuarantineLatchByKey`
runs UNCONDITIONALLY after `provenCoverage` and which a vacuous content-coverage result never overrides.
**This disjunct is also an intentional fix, not merely a side effect, for an ORDINARY non-empty marked
`final` whose on-disk array mixes a still-owed token with one already tombstoned** — without it, the stale
tombstoned entry alone kept the file on disk fail-closed, and BOTH tokens resurrected from its own stale
bytes after a reboot (Code Review `6dac0fe9`'s own probe A). It is sound under the tombstone invariant:
`tombstoneIfNotSurviving` only ever tombstones a token once no surviving record — active or pending —
holds it, so `clearedTokens.has(t)` being true is itself the proof that nothing still needs `t` protected.

### The fix

All three sites now call `readSurvivingOnDiskTokens` instead of re-deriving the parse:
- `unincorporatedOccupantRepoPathAt` and `resolveRaiseOverwrite`'s "already incorporated" check both use
  `.raw` — an overlap/containment check that already excludes by identity (or, for `resolveRaiseOverwrite`,
  compares against `ownTokens`) has no further use for the `clearedTokens` subtraction; `.raw` is what a
  legacy-shaped file's own real on-disk content actually is.
- `markedFinalFullyCoveredByClear` uses `.raw` too, per the ruling above, with the `candidateTokens.includes(t)
  || clearedTokens.has(t)` OR explicit at the call site rather than relying on `.surviving`'s own silent
  subtraction.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`25f6a7dc-l1318`** — the FAIL-OPEN repro: same shape as `95ea8d3f-adversarial`, but the still-owed
  extra token rides the LEGACY singular `token` field behind an empty `tokens` array rather than the array
  form. Asserts `final` is KEPT (coverage not proven), byte-for-byte unchanged, and the legacy token
  survives a fresh-import reboot.
- **`25f6a7dc-l751`** / **`25f6a7dc-l1856`** — the FAIL-CLOSED repro, once for each site: a resolvable
  subdirectory `d` raises first (takes the existing-branch identity), then `final` is hand-rewritten to a
  stale leftover naming a DIFFERENT, unresolvable identity `z` (sharing the same degraded key) but still
  holding `d`'s own real token in legacy singular form. `l751` reaches `unincorporatedOccupantRepoPathAt`
  directly (no injected failure); `l1856` forces past `resolveRaiseOverwrite`'s own fast path via an
  UNRELATED transient read failure on only the FIRST read of `final` (classified `"unknown"` by the
  existing-branch's own `protectUnincorporatedOccupantBeforeDelete` call), so its OWN direct re-read — not
  that first, already-failed one — is what reaches the "already incorporated" check. Both assert NO
  pending-divert record is ever minted for `z` (`pendingDivertFilenameFor(z)` never exists on disk), and
  that the token does not resurrect under `z`'s own bogus identity after a reboot.
- **`25f6a7dc-tombstoned`** — `{tokens:[], token:X}` with X already tombstoned (released via a wholly
  unrelated scratch raise+clear). A PIN, not a discriminator: `protectOccupantContentBeforeDelete`'s own
  pre-existing (`7a7e041b`) skip-when-fully-tombstoned logic already handles this correctly downstream of
  either site, with or without this card's fix — reachable through the SAME existing-branch shape as
  `l751`/`l1856`. Asserts no pending record survives for the stale identity and X is never resurrected.
- **`25f6a7dc-no-token`** — `{tokens:[]}` with NO legacy token at all. Another PIN: `readSurvivingOnDiskTokens`'s
  own `raw` stays genuinely empty either way (nothing to recover), so `protectOccupantContentBeforeDelete`'s
  pre-existing random-token fallback (`survivingTokens.length > 0 ? survivingTokens : [randomUUID()]`)
  still fires, unchanged. Asserts a pending record IS minted (the stale identity's own `repoPath`/`branch`/
  `reason` are genuine content worth protecting) carrying a freshly-minted token, never an empty array.
- **`25f6a7dc-probeA`** (Code Review `6dac0fe9`'s own probe A) — proves the disjunct ALSO matters for an
  ORDINARY non-empty array, not just the empty-array legacy shape. A resolvable identity `dA` raises first
  (existing-branch); a second raiser unions into it while `final`'s read fails transiently (marking the
  basename, same shape as `l751`/`l1856`); `final`'s own stale bytes are then hand-rewritten to mix the
  still-owed token (`A-d`) with a token (`T`) already tombstoned via a wholly unrelated scratch raise+clear.
  Asserts `final` is UNLINKED (not kept) once cleared, and that neither `A-d` nor `T` resurrects after a
  fresh-import reboot. The raiser's own merged token is NOT a discriminator here — it diverted to its own
  separate pending-divert file (the same shape `l751`/`l1856` exercise) and is swept through that mechanism
  regardless of this disjunct, so its own reboot check passes on both sides, as expected, and is kept as a
  control rather than removed.

`25f6a7dc-l1318`'s three discriminating assertions, `25f6a7dc-l751`/`25f6a7dc-l1856`'s two discriminating
assertions each, and `25f6a7dc-probeA`'s three discriminating assertions (ten total) proven RED on `HEAD`
(pre-fix; `25f6a7dc-probeA` proven RED on `HEAD~1`, since it postdates the initial commit — see below) and
GREEN after, via `scripts/negative-control.mjs` — the RED phase fails exactly those ten assertions with the
build succeeding on both sides, so the RED is behavioral, not a build failure. `25f6a7dc-tombstoned` and
`25f6a7dc-no-token` pass on both sides, as expected for a pin, not a discriminator. All 33
`merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green (30/30). Line endings re-verified CR==LF (no
`sed -i` used; every edit was an in-place `Edit` call, which preserves existing endings).

## Follow-up 6c04633d (CR4 of this card, finding 2 plus the note on finding 3) — a divert union's arbitrary
identity winner stranded the raiser's own tokens; a by-token clear now sweeps by token, not identity alone

CR4 found (scratch probe `zz-cr4-probe.mjs`, commit `cb461f56`, never committed — deleted after use) that
`consumeMatchedPendingsIntoArmedEntry`'s own raise-divert branch (round 4's own fix, above) unioned EVERY
matched pending entry — the raiser's own plus every sibling sharing the canonical key via
`collectCrossTierSiblingIndices` — into ONE divert record, keyed to whichever matched entry
`unionQuarantineEntries` judged OLDEST. That is an ARBITRARY winner with no relation to who is actually
raising: an older SIBLING's identity could win outright, folding the raiser's own tokens under a record
`clearMergeQuarantineByToken` — which matches pending entries by identity alone — could never again reach
by the raiser's own repoPath.

### Z1 (the reviewer's own repro, reviewer `4c732a8c`)

1. R raises (t1), succeeds normally. A SIBLING S = R/sib-subdir has an OLDER pending entry (`enteredAt`
   far in the past), not yet existing on disk.
2. R raises again (t2) while `final`'s reads fail — diverts, carrying `t1,t2` forward under R's OWN
   identity (no sibling involved yet, since S does not yet resolve to R's own canonical key).
3. S now exists on disk — its own canonical key degrades (walks up, since it has no `.git` of its own) to
   R's real key.
4. R raises a third time (t3); only the fold-in read inside `consumeMatchedPendingsIntoArmedEntry`'s own
   sibling-absorb fails. Pre-fix: S (older) wins the union, so the new pending record carries identity S
   but holds R's `t1`, `t2` AND `t3`.
5. `clearMergeQuarantineByToken(r, t1)` matches pending entries by `directPathIdentity(r)` alone, so it
   can never find `t1` sitting in a record whose own `repoPath` is S. R stays blocked after every one of
   its own tokens is released, including across a reboot.

### Also from CR4

- **(a)** A PARTIAL by-token clear of a record with folded `orphanLatchFiles` left stale tokens in those
  orphan files — the `ae79d492` dual-tracked-twin rewrite only ever covered ONE reference-tracked pending
  twin, never the general `orphanLatchFiles` list. They re-armed after a reboot.
- **(b)** In the consume-divert fold, excluding `pendingDivertFilenameFor(armed.repoPath)` from the folded
  `orphanLatchFiles` assumed `divertRaiseEntry` always overwrites that exact file. When `divertRaiseEntry`
  instead reuses an unmatched same-identity pending's own `base.sourceFile` (a different physical file),
  the excluded file goes untracked — fail-closed at reboot (the content is never lost, merely left
  unreferenced, since nothing else writes to it either — but it is also never swept, surviving
  indefinitely as an unreferenced, undiscoverable file).

### Manager's ruling

A divert union keeps the RAISER's own identity for the raiser's own tokens — never fold one identity's
tokens into a record keyed to a different identity. If both must persist, each identity gets its own
record, even when that means two files. `clearMergeQuarantineByToken` additionally sweeps a token from
EVERY record that holds it, whatever that record's own identity: tokens are unique `randomUUID`s, so a
token match IS an exact identity of its own holder — a token-held-by-another-identity record is clearable
by its own owner regardless.

### The fix

1. **Identity-preserving divert** (`consumeMatchedPendingsIntoArmedEntry`'s raise-divert branch). Instead
   of unioning every matched entry into one blob, `matched` is partitioned by `directPathIdentity`: the
   RAISER's own group (`extra`'s identity, plus every matched entry sharing it — a legitimate same-identity
   merge) is unioned and diverted via `divertRaiseEntry` under the raiser's own identity; every OTHER,
   genuinely foreign identity's own matched entries are unioned ONLY within that identity (never across)
   and either re-inserted into `pendingUnresolvedQuarantines` unchanged (a single matched entry — content
   genuinely didn't change) or durably rewritten at the oldest one's own `sourceFile` (more than one
   matched entry for that foreign identity). A foreign identity is never consumed into, or written through,
   `divertRaiseEntry` at all — it was never the raiser's write to make.
2. **(b) Unconditional fold.** The raiser's own group's `ownSourceFiles` are folded into the diverted
   record's `orphanLatchFiles` UNCONDITIONALLY — no more comparing against the assumed
   `pendingDivertFilenameFor` target. A self-reference (the file about to be written IS one of the folded
   sourceFiles) is the same established, legitimate shape `survivingSharedClaimRepoPaths` already
   recognizes elsewhere in this module.
3. **(a) General, OWNERSHIP-GATED orphan-rewrite on partial clear.** `rewriteOrphanLatchFilesAfterPartialClear(updated,
   skip)` — generalizes the `ae79d492` dual-tracked-twin rewrite to EVERY file `updated.orphanLatchFiles`
   names (skipping whatever the caller's own write loop already wrote, and whatever no longer exists on
   disk), but ONLY once `orphanRewriteOwnershipConfirmed` POSITIVELY confirms the file is genuinely this
   same entity's own — a `keptUnreadableLatchFiles`-marked basename, a `physicalOwnerRepoPaths`/
   `survivingSharedClaimRepoPaths` credit to a DIFFERENT identity, or a read/parse failure, each fail
   closed (the file is left stale, UNTOUCHED, rather than written). Round 1 shipped this gate missing —
   see Round 2, B1, below for the regression and the fix. Wired at the end of both
   `clearActiveEntryTokenAtKey` and the shared pending-clear body (below) — every partial by-token clear
   keeps every CONFIRMED-OWN folded orphan file in sync with the reduced token set, never leaving one
   stale for a later boot to re-arm from — and never touches one it cannot confirm.
4. **Universal by-token sweep.** `clearMergeQuarantineByToken` no longer stops at `repoPath`'s own
   identity/key: `clearPendingEntryByToken`'s per-index body is factored into a shared
   `clearTokenFromPendingIndices(indices, token)`, and the top-level function now (a) sweeps every
   NON-TWIN pending entry — of ANY identity — still holding `token`, FIRST, then (b) sweeps every active
   entry still holding `token`. A genuine `883e29bc` dual-tracked TWIN (a pending entry that is the SAME
   object reference as an active one) is deliberately EXCLUDED from step (a) — it stays
   `clearActiveEntryTokenAtKey`'s own job, in its own established `ae79d492` order (write the armed key's
   final first, then decide whether the twin needs its own rewrite); running the universal pending sweep
   on a twin BEFORE that order got a chance to run regressed two pre-existing `merge-quarantine-degraded-
   occupant-guard.mjs` scenarios (`dual-same-file-shape-preserves-provenance-tracked`,
   `dual-pass1b-tmp-shape-does-not-resurrect-swept-tmp`) during this card's own development — caught only
   by re-running the full corpus, not by this card's own new scenarios.

   **Why pending-before-active, for the non-twin case specifically:** a pending write
   (`writePendingDivertFile`) never re-reads or unions on-disk bytes — it just writes `updated` directly.
   An active write (`writeMergeQuarantineLatch`) DOES, via its own marked-basename chokepoint. If the
   active side clears first while a SEPARATE (non-twin) pending copy of the same token still exists,
   `tombstoneIfNotSurviving`'s own scan (called from inside the active clear) finds that pending copy
   still "surviving" and skips tombstoning — so the active write's own chokepoint union, reading a
   STALE, never-updated physical final, re-absorbs the token it was supposed to drop. Clearing every
   non-twin pending copy first means the tombstone fires correctly before any active write that could
   re-absorb a stale on-disk token ever runs.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`6c04633d-z1`** — Z1, ported directly (R raises three times, the third absorbing the now-resolvable
  sibling S via the sibling-absorb branch). Asserts no record keyed to S's own identity ever holds any of
  R's own tokens, that `clearMergeQuarantineByToken` lifts each of R's own tokens in-process AND on disk
  (measured by scanning every file in `MERGE_QUARANTINE_DIR`, never just `listActiveMergeQuarantines`),
  that R is fully lifted once every one of its own tokens is released, and that none of R's tokens (nor
  the sibling's own, separately released) resurrect after a fresh-import reboot.
- **`6c04633d-a`** — finding (a). D has a pre-existing, legacy-named pending entry (never
  `pendingDivertFilenameFor(d)`) holding its own token; a later raise's own sibling-absorb (reaching the
  `existing` branch, since D is armed via a `resolvedKey`-carrying boot-time latch) folds it into the
  raiser's OWN record (same identity, per the 6c04633d identity rule), making the legacy file a genuine,
  non-self-referencing orphan. A PARTIAL clear releasing the exact token that orphan file itself
  originally carried (other tokens remain outstanding) must rewrite that file's own bytes too — asserted
  directly against the file's own on-disk content, and that the released token does not resurrect after a
  fresh-import reboot while the still-outstanding token does survive it.
- **`round4-x`** (pre-existing, this round's own regression-shape update) — S is a genuinely different
  identity than the raiser D, so under the 6c04633d identity rule it is no longer folded into D's own
  divert record at all; it is pushed back untouched, under its own identity. The scenario's own check is
  widened to accept this as a third valid state (live and correct, never an orphan, never gone) alongside
  the pre-existing two (gone, or named in some entry's own `orphanLatchFiles`) — the underlying invariant
  the check protects (the sibling's own content is never silently lost) is unchanged; only which of three
  valid shapes satisfies it differs now.

`6c04633d-z1` and `6c04633d-a` proven RED on `HEAD` (pre-fix) and GREEN after, via
`scripts/negative-control.mjs`. All 33 `merge-quarantine*.mjs` files re-verified individually, each exit 0
(including `merge-quarantine-degraded-occupant-guard.mjs`, which the FIRST version of this card's own
universal-sweep fix broke — see the pending-before-active note above — and which now passes clean again).
All static guards (`pnpm --filter @loom/daemon guards`) re-verified green (30/30). Line endings
re-verified CR==LF via the `tr -dc` recipe; the scratch probe file was deleted, never committed.

### Do not (6c04633d)

- Do not rewrite an orphan-referenced file inside `rewriteOrphanLatchFilesAfterPartialClear` without first
  proving, via `orphanRewriteOwnershipConfirmed`, that it is this SAME entity's own current physical
  content — `existsSync` alone is never enough. A stale `orphanLatchFiles` reference can name a file that
  is now a wholly DIFFERENT, live entity's own latch (`9cabd143`'s bug class); Round 1 of this card shipped
  exactly this blind-write regression — see Round 2, B1, below.

## Round 2 (Code Review `e8c78d98` of commit `b49ab498`) — one Critical regression in Round 1's own new
code, plus three Majors/nitpicks

Round 1 shipped NOT SHIP. CR found a real, reproduced Critical fail-open regression in the orphan-rewrite
fix (B1), plus three correctness/hygiene findings (M2-M4) in Round 1's own new code.

### B1 CRITICAL — `rewriteOrphanLatchFilesAfterPartialClear` blind-wrote by filename alone, never by
ownership, reopening `9cabd143`'s bug class as a WRITE instead of a wrongful unlink

Round 1's own fix checked only `existsSync` before calling `writePendingDivertFile(orphanFile, updated)` —
`writePendingDivertFile`'s own doc states it is safe ONLY for "this SAME entity's own existing file, never
a different one." `9cabd143` already records that an `orphanLatchFiles` reference can name a file that is
now a DIFFERENT, live entity's own latch (PASS 2's own defensive "unmatched orphan broadcast onto every
registered repo" mechanism, `9a55fb90`/`882d6cff`-era) — Round 1 never checked for this on the write side.

**Repro (the reviewer's own, reproduced directly):**
1. A corrupt `<hashB>.json` exists; boot with `[A]` registered — the corrupt, unmatched latch forces A
   fail-closed quarantined, and PASS 2 folds the orphan reference into A's own `orphanLatchFiles` (mirrors
   `95ea8d3f-r3-orphanref`'s own established setup).
2. B raises for real — the corrupt content is "nothing usable," so B's own write proceeds and durably
   overwrites `<hashB>.json` with B's own real latch.
3. A raises AGAIN (its own identity — reachable in production via a GitWriter op, which lacks
   `assertRepoNotQuarantined`), adding a second token.
4. `clearMergeQuarantineByToken(A, tA)` — a PARTIAL clear (A's own fail-closed token remains outstanding)
   reaches `rewriteOrphanLatchFilesAfterPartialClear`, which (pre-fix) blind-writes A's own record into
   `<hashB>.json`, destroying B's real content. After a fresh-process reboot, B is NOT quarantined.

On the true pre-card parent (`1dbb558a`), this exact code path (`rewriteOrphanLatchFilesAfterPartialClear`)
does not exist at all — the regression is specific to Round 1's own new commit (`b49ab498`), reproduced
there via `negative-control.mjs --ref b49ab498`.

### Manager's ruling

Gate EVERY orphan rewrite on ownership, fail-closed. Skip (never write) a file that
`physicalOwnerRepoPaths`/`survivingSharedClaimRepoPaths` credits to a different entity, or whose ownership
cannot be determined, or that is in `keptUnreadableLatchFiles` (its unreadable-second-shape mark must be
respected — never bypass `writeMergeQuarantineLatch`'s own marked-basename reconcile chokepoint, which
would contradict Round 1's own "every write goes through the chokepoint" and `63e49ee2`). A skipped,
left-stale orphan file is an accepted fail-CLOSED residual: a stale record keeps its OWN repo quarantined
and can never un-quarantine anyone else as a side effect.

### The fix

`orphanRewriteOwnershipConfirmed(orphanFile, updated)` — `false` (skip, leave stale) if: `orphanFile`'s
basename is `keptUnreadableLatchFiles`-marked; OR `physicalOwnerRepoPaths(orphanFile)`/
`survivingSharedClaimRepoPaths(orphanFile)` names ANY repoPath whose `directPathIdentity` differs from
`updated`'s own; OR a fresh `quarantineFileRepoPathIdentity` read of the file's own on-disk content returns
`undefined` (ENOENT/EISDIR/corrupt/no `repoPath` field) or an identity different from `updated`'s own.
Returns `true` (safe to write) ONLY when the structural checks name nobody but `updated`'s own identity
AND the content check positively confirms the same identity — belt-and-suspenders, not either check alone.
`rewriteOrphanLatchFilesAfterPartialClear` calls this immediately before every `writePendingDivertFile`
call and logs-and-skips (never throws) on a `false`.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`6c04633d-b1`** — the reviewer's own repro, ported directly. Asserts `<hashB>.json` is NEVER
  overwritten with A's own record (B's real content survives byte-for-byte, checked via both `bToken`'s
  presence and `A`'s own basename's ABSENCE in the file), that A's own `tA` is correctly lifted in-process
  despite the skip, and that B stays quarantined after a fresh-process reboot (never silently un-quarantined
  as a side effect of A's own, unrelated clear).
- **`6c04633d-b1-kept`** — the keptUnreadable variant: the same A/B/corrupt-boot setup, but `<hashB>.json`'s
  own basename is ALSO `keptUnreadableLatchFiles`-marked (via a throwaway raise on an unresolvable subdir
  of B, which degrades to B's own canonical key and hits a transient read failure) at the moment A's
  partial clear runs. Named honestly: this does NOT isolate the `keptUnreadableLatchFiles` check from the
  cross-identity content check (B's real content also differs from A's identity here, so either check
  alone would skip this write) — it is a combined regression guard for the overall fail-closed outcome,
  not a unit proof of which specific check fired.

Both proven RED on `b49ab498` (Round 1's own commit) and GREEN after, via `scripts/negative-control.mjs
--ref b49ab498`. All 33 `merge-quarantine*.mjs` files re-verified individually, each exit 0. All static
guards (`pnpm --filter @loom/daemon guards`) re-verified green (30/30).

**Card `a9174861`:** neither the `keptUnreadableLatchFiles.has(orphanFile)` skip above NOR the M2 stamp
below (see that section) had a test isolating it from its own other layers — `merge-quarantine-round2-pins.mjs`
adds both, each proven RED by a single-line mutation of the exact fixed line and GREEN after restore.

### M2 — the raiser's own divert record silently lost its pre-existing field set

Round 1's `raiserUnion` (built from `extra` + `ownGroup`) carried no `resolvedKey`, no `armedKeys` entry
for `key`, and no `provenanceTracked`, unlike the PRE-Round-1 `armed` object this function always diverted
(which stamped all three — `500e307a`'s own documented, deliberate invariant: "`consumeMatchedPendingsIntoArmedEntry`'s
own `armed` result" is one of only two true runtime origin points for a `resolvedKey`-bearing entry, and
the lazy-graduation/query tier matches a still-unresolvable entry by its own trusted `resolvedKey`).
Checked first, per the manager's own instruction: neither `500e307a`'s own record nor `8db913e2`'s own
text states a raise-divert must NOT carry `resolvedKey` — no conflict found. **Ruling: preserve the field
set** — this card is about identity partition, never about what a divert record carries. `raiserUnion` now
also gets `resolvedKey: key`, `armedKeys` unioned with `key`, and `provenanceTracked: true`, stamped
immediately after the union, mirroring the pre-Round-1 `armed` object exactly (for the raiser's own group
only — a genuinely foreign identity's own record never gets these, since it was never armed at `key` at
all).

### M3 — `round4-x`'s own third disjunct didn't tie the entry to `sibFile` itself, and read it at the wrong time

The disjunct compared `listActiveMergeQuarantines()`'s own `repoPath`/`tokens` fields, never `sibFile`
itself — a check that could pass even if some OTHER mechanism had moved the sibling's content to a
different physical file. Fixed to read `sibFile`'s own on-disk bytes directly, asserting they still name
S and `sibToken` verbatim. Caught in the process (not by the CR, by re-running the suite after fixing the
label): the read must happen at the SAME pre-query snapshot as `filesAfterRaise`/`referencedOrphansX`
(captured right after the raise) — `activeMergeQuarantineFor(d)`, called by the very next check, is a
QUERY whose own lazy-graduation tail can ITSELF trigger a pre-existing, unchanged, out-of-this-card's-scope
successful consolidation of D+S once reads succeed again (the SAME "oldest identity wins" shape Z1
complains about, but on the SUCCESS path, which this card deliberately never touches) — deleting `sibFile`
out from under a content read taken any later than that.

### M4 — `clearPendingEntryByToken` was dead code; `clearMergeQuarantineByToken`'s `repoPath` param is now unused

Deleted `clearPendingEntryByToken` (no remaining callers once the universal sweep replaced its one call
site) and fixed every jsdoc `{@link clearPendingEntryByToken}` reference plus every LIVE test comment
describing it as still-called (`merge-quarantine-runtime-provenance-stamp.mjs`,
`merge-quarantine-unverified-raise-divert.mjs`, `merge-quarantine-raise-protect-failure.mjs`,
`merge-quarantine-degraded-occupant-guard.mjs`) to name `clearTokenFromPendingIndices` (or describe the
universal sweep) instead. Historical decision records documenting `clearPendingEntryByToken`'s own
introduction/history are left untouched — out of this card's scope, and rewriting another card's own
historical narrative is not what this finding asked for. `clearMergeQuarantineByToken`'s own `repoPath`
parameter is renamed `_repoPath` (kept for call-site/signature stability; genuinely unused now that the
clear is process-wide by token alone) and its own doc comment states this plainly.

## Follow-up 29fe2372 — `orphanRewriteOwnershipConfirmed` checked same IDENTITY, never same ENTITY

Traced by a Code Reviewer, NOT executed (card `29fe2372`) — a worker then built a hermetic repro and
confirmed it live. `6c04633d`'s own round-2 fix (`orphanRewriteOwnershipConfirmed`, this file's "Follow-up
6c04633d" section above) checks `directPathIdentity` equality only. `d4b25feb` round 2 established that
one identity can legitimately hold TWO independent records at once (one active-only, one pending-only,
disjoint tokens) — the ownership gate's own identity-only check cannot tell "this file is `updated`'s OWN
backing" apart from "this file is a DIFFERENT, independent record that merely shares `updated`'s
identity." The manager's ruling: the gate must check same ENTITY, not same identity.

### The repro

`X` raises twice while resolvable (`tA1`, `tA2`, active `A` at `Kx`) — a second token so a later clear can
be PARTIAL. `X` is deleted (unresolvable); a third raise (`tP`) — per `d4b25feb`'s own "the `existing`
lookup only runs when verified" fix, this never looks at `A` at all, and diverts to a wholly INDEPENDENT
pending record `P` (`sourceFile = pending-<sha256(directPathIdentity(X))>.json`). Two distinct entry
objects for one identity, confirmed directly via `listActiveMergeQuarantines()`.

`A`'s own durable file is then hand-edited to add `orphanLatchFiles: [P's own sourceFile]` — standing in
for the real production path (an "existing"-branch sibling-absorb whose own durable write fails,
`consumeMatchedPendingsIntoArmedEntry`'s own `else` branch, ~1321-1330): EMPIRICALLY CHECKED, reusing this
module's own `injectOpenSyncFailureForPrefix` seam — that real path instead CONSUMES `P` into ONE merged
entity (safe: `P`'s own token is already accounted for by the merge), never leaving two genuinely
independent records sharing one orphan reference. Reaching that exact shape through 100% production code
additionally requires the separately-carded, still-unguarded fresh-divert write (`divertRaiseEntry`
~1964-1966 / `enterMergeQuarantine` ~2206-2218, `writePendingDivertFile` with no occupant read) — SPLIT
OUT of this card's own scope by Lead ruling; see that follow-up card's own repro once filed.

A fresh-process reboot (re-reading both files from disk) reconstructs the SAME two-entry shape. A PARTIAL
clear of `A` (`tA2`; `tA1` remains outstanding) reaches `rewriteOrphanLatchFilesAfterPartialClear`, whose
pre-fix `orphanRewriteOwnershipConfirmed` wrongly confirmed ownership of `P`'s own file (same identity,
content identity also matched) and overwrote it with `A`'s own reduced content — destroying `tP`'s on-disk
record. `P`'s own in-memory record (in `pendingUnresolvedQuarantines`, untouched by `A`'s clear) kept
reporting `tP` as enforced regardless. A SECOND fresh-process reboot, with `tP` NEVER cleared by anyone,
showed `tP` completely gone — silently released, with no clear ever issued for it: FAIL-OPEN.

### The fix — two further layers, both required

1. **`anotherLiveEntryOwnsFile(filename, updated)`** — `true` iff some entry OBJECT other than `updated`
   itself (active or pending, ANY identity, including `updated`'s own) still physically depends on
   `filename` as its own current backing. A stronger, OBJECT-reference-aware restatement of
   `physicalOwnerRepoPaths`'s own two loops (fully subsumed: both of its match conditions are strict
   subsets of the ones here, each additionally gated on `!== updated`).
2. **`orphanFileTokensAccountedForByUpdate(orphanFile, updated, clearedToken)`** — `true` iff every REAL
   token physically present in `orphanFile`'s own on-disk content right now is already in
   `updated.tokens ∪ {clearedToken}` (the token this SAME partial clear just dropped). Mirrors
   `markedFinalFullyCoveredByClear`'s own content-containment pattern (`dd34da46`/`95ea8d3f`) rather than
   inventing a parallel one. A read failure or corrupt/unparseable JSON can never be proven safe.

`orphanRewriteOwnershipConfirmed` now requires ALL of: the pre-existing identity-only structural check,
layer (1), the pre-existing content-identity check, AND layer (2) — fail-closed if any one of them does
not hold. `clearedToken` is threaded through from both callers of `rewriteOrphanLatchFilesAfterPartialClear`
(`clearActiveEntryTokenAtKey`, `clearTokenFromPendingIndices`), which already have the token being cleared
in scope.

**Why content-based (layer 2) was chosen over a purely reference-based alternative, and why both are kept
together anyway:** the card's own alternative direction — refuse whenever any OTHER pending entry (by
object reference) names this `sourceFile`, regardless of identity — is layer (1) alone. This module's own
repeated lesson (`63e49ee2` round 5's "same identity is not same content"; `0dc514dc`'s own "CONTENT-based,
never reference-based" title) is that a reference/identity-only check alone has repeatedly proven
insufficient, so layer (2) is kept as an independent, content-based backstop — it also catches a stale
on-disk file with no live in-memory competitor at all (this module has hit that shape before, e.g.
`63e49ee2`'s own "evicted the in-memory record without ever creating a pending one" residual), which a
bare reference scan can never see.

### Tests

Three new scenarios in `merge-quarantine-raise-protect-failure.mjs`:
- **`29fe2372`** — the repro above, verbatim. Proven RED via `scripts/negative-control.mjs --ref
  d55a10418697ce3be952068c3306fddb8f708245` (the absolute pre-fix ref — `merge-quarantine.ts` there is
  byte-identical to main's own tip at that point; `HEAD` alone no longer reproduces anything once the fix
  itself is committed) and GREEN after — tree restored byte-identical.
- **`29fe2372-isolate-b`** — an isolating case for layer (2) alone: NOTHING in memory references the
  orphan file at all (it is written to disk only AFTER boot, never classified by PASS 1), so layer (1)
  would have passed on its own; only layer (2), reading a genuinely foreign token physically on disk,
  refuses. Ablation-verified directly (layer (1) temporarily short-circuited to never fire, rebuilt, this
  scenario's own discriminating check goes RED, layer (2) alone still catches it; restored).
- **`29fe2372-isolate-a`** — an isolating case for layer (1) alone: a GENUINE, LIVE, independent pending
  entry `P2`, reconstructed at boot from its own valid but token-LESS content, shares the orphan file as
  its own `sourceFile` — layer (2) finds zero real on-disk tokens and would VACUOUSLY pass on its own
  (nothing to object to); only layer (1), seeing `P2` as a genuinely separate surviving object, refuses.
  Ablation-verified directly (layer (2) temporarily short-circuited to always return `true`, rebuilt, this
  scenario's own discriminating check goes RED, layer (1) alone still catches it; restored).

All 33 `merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green (30/30).

### Do not

- Do not gate an orphan rewrite on IDENTITY alone, even layered with a content-identity check — same
  identity is not same ENTITY (`d4b25feb`'s own "two independent records, one identity, disjoint tokens"
  shape is exactly what an identity-only gate cannot distinguish). Require both an OBJECT-reference-aware
  ownership check (`anotherLiveEntryOwnsFile`) and a TOKEN-content-aware check
  (`orphanFileTokensAccountedForByUpdate`) — either alone has a reproduced, ablation-confirmed blind spot
  the other one covers.
- Do not reach for a purely reference-based fix here "because it's simpler" without also keeping a
  content-based layer — a reference check alone cannot see a stale on-disk file with no live in-memory
  competitor (the `29fe2372-isolate-b` shape); a content check alone cannot see a live, independent,
  token-less (or coincidentally-already-accounted-for) competitor (the `29fe2372-isolate-a` shape).
  **Scope of layer (2)'s own protection in the `isolate-b` shape** (Code Review `9d6dc6b8`): it protects
  ONLY against the REWRITE this card fixes. A later FULL clear still deletes that same file via
  `sweepOrphanLatchFileIfUnreferenced` (~:2660), which is content-blind — the CR reproduced the loss being
  DEFERRED, not prevented, for that exact shape. Not reachable from production today (a file physically
  present at boot becomes a live, PASS-1-classified owner, closing the gap this specific isolate-b
  fixture manufactures by writing the file only AFTER boot) — tracked as a known residual, carded
  separately; not fixed by this card.
- Do not conflate this card's own scope with the separately-carded fresh-divert write
  (`divertRaiseEntry`'s `indices.length === 0` branch, `enterMergeQuarantine`'s own direct
  unresolvable-brand-new-divert) — `writePendingDivertFile` there still has NO occupant read at all before
  overwriting a deterministic filename; this card's own fix does not touch it.

## Follow-up 495fd320 — a `null`-content latch (or orphan) file made two "never throws" helpers throw

A SEPARATE finding from the SAME Code Review `9d6dc6b8` of card `29fe2372` — reproduced by that reviewer,
then independently confirmed by a worker's own hermetic repro before any fix was written. Both
`quarantineFileRepoPathIdentity` and `orphanFileTokensAccountedForByUpdate` (Follow-up `29fe2372` above)
document themselves as fail-closed/"Never throws" — but `JSON.parse("null")` succeeds and returns the
bare value `null`, and every `JSON.parse(raw)` call site in this module only ever guards the PARSE call
itself with a try/catch; nothing guarded the very next `parsed.repoPath`/`parsed.tokens` property read.
That read throws a `TypeError` ("Cannot read properties of null (reading 'repoPath')") for `null`, and
only for `null` — every other top-level JSON value (array, number, string, boolean) is already safe to
property-access, returning `undefined` for a missing field rather than throwing.

### The repro

`R` raises `t1`, `t2` (one entry, two outstanding tokens). `R`'s own final latch file is hand-edited to
fold in an orphan reference `O` via `orphanLatchFiles: [O]`. A fresh boot (PASS 1 never reads an orphan
reference's own content, only a final's) is followed by writing the bare literal `null` into `O`. A
PARTIAL clear (`clearMergeQuarantineByToken(R, t2)`, `t1` remains outstanding) reaches
`rewriteOrphanLatchFilesAfterPartialClear` → `orphanRewriteOwnershipConfirmed` →
`quarantineFileRepoPathIdentity(O)`, which throws. `orphanFileTokensAccountedForByUpdate` has the
identical hole, reached via the same gate's own layer (2) — PRE-FIX, always shadowed by the identity
check above throwing first.

**Effect, worse than a merely-skipped orphan rewrite:** every caller of `clearMergeQuarantineByToken`
inside `packages/daemon/src/git/worktrees.ts` and `git/batch-merge.ts` is an `onTreeDeathSettled` closure,
invoked from inside `git/bounded.ts`'s `rawViaDirectSpawn`/`rawViaWinJobLauncher`, each inside a
`void`'d async IIFE with no surrounding try/catch of its own. The throw escapes as an UNHANDLED
REJECTION, and the `reject(...)` a few lines below it NEVER runs — so the bounded git promise this
callback is nested inside never settles at all. On this Node version (default `--unhandled-rejections`
behavior) that is not merely a hang: it crashes the whole daemon process. See the matching bounded.ts
Follow-up in `docs/decisions/24c0bdba-kill-confirm-canonical-merge-commits.md` for that half of the fix.

### The fix

A new shared guard, `isReadableLatchRecord(value): value is Record<string, unknown>` (returns
`typeof value === "object" && value !== null`), placed immediately after EVERY `JSON.parse(raw)` call in
this module whose result then has a property read off it — never only at the two helpers the CR named by
name. Audited and fixed (all reachable from runtime clear/raise/protect paths, never boot-time PASS 1/
1b/safety-tmp — those already wrap the full parse-and-validate block in a try/catch that treats ANY throw,
including this one, as corrupt/fail-closed, by pre-existing design):
`quarantineFileRepoPathIdentity`, `differentUnresolvableOccupantRepoPathAt`,
`unincorporatedOccupantRepoPathAt`, `confirmedDurableBackingElsewhere`, `readFinalOnDiskSurvivingTokens`,
`reconcileMarkedBasenameBeforeWrite`, `markedFinalFullyCoveredByClear`, `protectOccupantContentBeforeDelete`,
`resolveRaiseOverwrite`, `orphanFileTokensAccountedForByUpdate`, `protectForeignTmpResidueBeforeSweep`.

A guarded `isReadableLatchRecord(parsed) === false` is treated exactly like the pre-existing
corrupt-JSON catch branch at each site (return the same fallback that branch already returns) — never a
new, differently-shaped outcome. `rewriteOrphanLatchFilesAfterPartialClear`'s own pre-existing
fail-closed logging (`"keeping ${orphanFile} UNTOUCHED (left stale)..."`) now fires for a `null`-content
orphan exactly as it already did for genuinely corrupt JSON, rather than throwing.

### Round 2 (Code Review `a45e4011`) — a documentation gap, not a code defect

The CR confirmed the production code correct and complete at all 11 sites, all 3 `git/bounded.ts` settle
call sites, and the crash claim — but found this record's own first-draft wording overclaimed. `isReadableLatchRecord`
excludes `null` (the only value that THROWS on property access) but, since its check is
`typeof value === "object"`, it ALSO rejects a bare scalar (number/string/boolean) — never a throw risk,
but a REAL, separate behavior change at exactly the two sites that read on-disk tokens with no OTHER
check ahead of it: `markedFinalFullyCoveredByClear` and `orphanFileTokensAccountedForByUpdate`. A latch
whose content used to be a bare scalar made `readSurvivingOnDiskTokens` return an empty token array,
which both callers' own `.every(...)` then read as VACUOUSLY covered/accounted-for (fail-OPEN) — now
rejected before that reader is ever reached, so both instead return "cannot prove this" (fail-CLOSED,
strictly safer, never a regression — just not something to leave undocumented as a side effect of the
null-crash fix). Every OTHER guarded site already had its own `typeof parsed.repoPath === "string"`
check ahead of any token read, which a scalar already failed identically before this guard existed, so
those nine sites see no behavior change at all; an array or `{}` passes unchanged everywhere, pre- and
post-fix. `isReadableLatchRecord`'s own doc comment (merge-quarantine.ts) and both affected functions'
own `@decision 495fd320` notes now state this precisely, and the test file's header does too. No source
behavior changed in round 2 — only documentation.

### Tests

`test/merge-quarantine-null-latch-guard.mjs` (new file — this bug's own concern is orthogonal to this
card's own `-raise-protect-failure.mjs` home, so it gets its own): the repro above, plus a second orphan
reference `O-valid` on the SAME record (same identity, tokens a subset of `R`'s own) listed FIRST-after
`O-null` in `orphanLatchFiles`, proving `O-null`'s own poison never aborts the REST of the per-file loop
— `O-valid` still gets durably rewritten to the reduced token set. A negative control repeats the same
shape with genuinely corrupt (unparsable) JSON instead of `null`, proving the new guard changes nothing
for the case that already worked. Proven RED via `scripts/negative-control.mjs --ref 43a65f27` (absolute,
pre-fix) and GREEN after, tree restored byte-identical.

All 33 `merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green.

### Do not

- Do not guard only the two helpers the Code Review named by name — audit EVERY `JSON.parse(raw)` site in
  this module whose result feeds a subsequent property read; this card found nine further ones with the
  identical hole (`differentUnresolvableOccupantRepoPathAt`, `unincorporatedOccupantRepoPathAt`,
  `confirmedDurableBackingElsewhere`, `readFinalOnDiskSurvivingTokens`, `reconcileMarkedBasenameBeforeWrite`,
  `markedFinalFullyCoveredByClear`, `protectOccupantContentBeforeDelete`, `resolveRaiseOverwrite`,
  `protectForeignTmpResidueBeforeSweep`) that the CR's own report never named.
- Do not add the guard to the boot-time PASS 1/1b/safety-tmp recovery loops (`reenterMergeQuarantinesAtBoot`'s
  three inline parsers around lines ~4094/4335/4465) — those already wrap their own full parse-and-validate
  block in a try/catch that treats ANY throw (this one included) as corrupt/fail-closed; adding a second,
  redundant guard there is dead code, not a fix.
- Do not harden `readSurvivingOnDiskTokens` (the shared on-disk-token chokepoint, `7a7e041b`) itself
  instead of its callers — every call site that could pass it a `null` already returns before reaching it,
  once ITS OWN `typeof parsed.repoPath` guard (or, for the two sites with no such guard —
  `readFinalOnDiskSurvivingTokens`/`orphanFileTokensAccountedForByUpdate` — the new
  `isReadableLatchRecord` check directly) is in place; a second guard inside the chokepoint itself would be
  an unreachable, unverifiable duplicate of the real fix.
- Do not describe `isReadableLatchRecord` as excluding only `null` — it excludes every non-object JSON
  value, which includes a scalar too; say so explicitly, and name the two sites
  (`markedFinalFullyCoveredByClear`, `orphanFileTokensAccountedForByUpdate`) where that incidental
  exclusion is an actual fail-open→fail-closed behavior change, not merely a crash fix (round 2).

## Follow-up 8a79dd31 — the fresh-divert write itself had no occupant read, at EITHER of its two call sites

The 29fe2372 card's own "Do not" section (above) flagged this as explicitly OUT of its own scope:
`divertRaiseEntry`'s `indices.length === 0` branch and `enterMergeQuarantine`'s own direct unresolvable
brand-new-divert branch both called `writePendingDivertFile(pendingDivertFilenameFor(repoPath), entry)`
with ZERO read of whatever currently occupies that deterministic filename first — `writePendingDivertFile`'s
own jsdoc states plainly it has "no degraded-occupant guard". If that file is currently another live
record's own latch for the SAME identity (e.g. a same-identity record's file left behind by a failed
graduation write, or a kept-unreadable file), its tokens were silently destroyed, with zero in-memory
signal, surviving only until the next reboot discards them for good — a FAIL-OPEN.

### The repro (first reported `blocked`, before any production edit)

Two hermetic scenarios in `merge-quarantine-raise-protect-failure.mjs`, each hand-crafting an independent
occupant record at `pendingDivertFilenameFor(identity)` that THIS PROCESS's own in-memory
`pendingUnresolvedQuarantines` never scanned (standing in for the card's own "left behind by a failed
graduation write, or a kept-unreadable file" shape — `collectPendingIndices` matches only by object
presence in that array, never by reading the directory, so an out-of-band file reaches
`indices.length === 0` / `pendingIndices.length === 0` exactly the same way):
- **`8a79dd31-fresh-divert`** — `enterMergeQuarantine`'s own direct unresolvable brand-new-divert branch.
- **`8a79dd31-divert-raise-entry`** — `divertRaiseEntry`'s own `indices.length === 0` branch, reached via
  `resolveRaiseOverwrite`'s `mustDivert` decision at the OTHER named call site.

Both proven RED on `HEAD` at report time (the occupant's own content, and token, destroyed outright,
confirmed gone after a fresh-process reboot with no clear ever issued) before any fix was written.

### Manager's ruling — route through ONE chokepoint first, then fix it there

A duplicated writer is exactly the divergence this module keeps paying for: `enterMergeQuarantine`'s own
brand-new-unresolvable branch carried an INLINE copy of `divertRaiseEntry`'s own `indices.length === 0`
mint logic, rather than calling through it.

**Step A (refactor-only, commit `da810900`):** extracted the shared mint logic into `mintPendingDivert`,
called by both `divertRaiseEntry`'s own branch and `enterMergeQuarantine`'s own branch. Verified
behaviour-preserving via a direct A/B: with ONLY the hoist applied (no occupant-check yet), the 323
pre-existing checks in `merge-quarantine-raise-protect-failure.mjs` stayed green and the 4 new 8a79dd31
checks stayed RED, byte-identical to the pre-refactor baseline. Incidentally, this consolidation also gave
`enterMergeQuarantine`'s own call site the double-fault safety-tmp fallback (`attemptDivertSafetyTmpFallback`)
it had never had — its own prior inline copy omitted it entirely.

**Step B (the fix, inside that one chokepoint):** `reconcilePendingDivertTargetBeforeMint(entry)`, called
by `mintPendingDivert` before ever writing — reads the primary filename's CURRENT content fresh:
- ENOENT → nothing real there, write `entry` unchanged at the primary filename (today's fast path,
  unchanged for the overwhelming majority of mints).
- The SAME identity already occupies it → union its on-disk tokens into `entry` (via
  {@link readSurvivingOnDiskTokens}, which already subtracts `clearedTokens` — never resurrecting an
  already-cleared token), never dropping one — mirrors `reconcileMarkedBasenameBeforeWrite`'s own
  identity+token-union pattern, still written at the SAME primary filename (one merged record, not two).
- A DIFFERENT identity, OR an unreadable/corrupt/EISDIR file → ⛔ never overwrite it AND never move it
  (relocating it could break whatever else still references its own path) — `entry` is written UNCHANGED
  to a distinct `pendingDivertCollisionFilenameFor` filename instead (`pending-<24hex>-collision-<8hex>.json`),
  leaving the occupant byte-untouched. `mintPendingDivert` also keeps the caller's own in-memory
  `activeQuarantines` placement in sync with the reconciled (possibly unioned) object via
  `replaceEntryEverywhere`, the same "keep in-memory consistent with the newly-durable bytes" discipline
  round 2 of this card already established for `writeMergeQuarantineLatch`'s own chokepoint.

**Boot discovery of the collision filename — verified, not assumed.** `reenterMergeQuarantinesAtBootImpl`'s
PASS 1 scans every file ending in `.json` (`files = all.filter((f) => f.endsWith(".json"))`) and classifies
by CONTENT, never by filename shape — the same generic mechanism that already recovers an ordinary
`pending-<24hex>.json` file despite its basename never matching any registered repo's own key hash. A
collision-suffixed name needs no scan change. `pendingLatchIdFor` (the id-derivation chokepoint for a
human-facing listing/clear-by-id) DOES need one: a new `PENDING_DIVERT_COLLISION_RE` is added to its
hash-the-whole-basename dispatch, alongside `PENDING_DIVERT_RE`/`PENDING_DIVERT_TMP_RE`.

**Correction (Round 2, Code Review `ddb58ffa`) — the generic fallback id is NOT usable, for either shape.**
The paragraph above originally claimed the generic `.indexOf(".json")` fallback "would still produce a
stable, unique id... just an unusually long, unhashed one" — WRONG. `clearMergeQuarantineLatchFile`
validates its own `id` argument against a 24-hex shape and REJECTS anything else outright as an "invalid
latch id" — a non-hex fallback string is not merely inelegant, it is a latch that can never be cleared by
id at all. See Round 2 below for the real bug this left in place (the crash-left TMP residue of a
collision filename, which `PENDING_DIVERT_COLLISION_RE` alone does not match).

### Tests

Four scenarios in `merge-quarantine-raise-protect-failure.mjs`:
- **`8a79dd31-fresh-divert`** / **`8a79dd31-divert-raise-entry`** — the original repro shapes, now
  asserting the FIX: the occupant's content survives, the union lands at the SAME primary filename
  carrying BOTH tokens (one record, not a diverted-elsewhere pair), and both tokens survive a
  fresh-process reboot as one record.
- **`8a79dd31-different-identity-diverts`** — a GENUINELY different identity (a true hash-of-identity
  collision stand-in) occupies the primary filename; asserts the occupant's file is byte-identical
  afterward, the raiser's own entry lands at a distinct collision-suffixed file (regex-matched), and after
  a fresh-process reboot BOTH survive as two separate entries (never merged).
- **`8a79dd31-unreadable-occupant-stays-byte-identical`** — the primary filename holds a foreign
  identity's own real bytes, but every read of it fails persistently (an "unknown" read failure, per
  `63e49ee2` — never ENOENT) during the raise; asserts the occupant's bytes are byte-identical once
  readable again (never touched despite the read failure), the raiser diverts to a collision file, and
  both survive a reboot.

All four proven RED against commit `da810900` (Step A, the pure refactor with no occupant-check) and
GREEN with the fix applied, via `scripts/negative-control.mjs` (tree restored byte-identical). All 34
`merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green (30/30). Line endings re-verified CR==LF via the
`tr -dc` recipe on both touched files.

## Round 2 (Code Review `ddb58ffa`) — SHIP, plus a real bug in this card's own new code, anchor/test follow-up

CR `ddb58ffa` shipped the fix as fail-closed, all 34 `merge-quarantine*.mjs` files green, and the wiring
proven (14 of the new checks above RED under a dist-stripped build before being fixed, confirming they
actually exercise the real compiled module). Found, and fixed in this same round: one real bug the
original round introduced, two documentation/anchor gaps, and several untested divert branches.

### Real bug — a crash-left collision-tmp residue could never be cleared by id

`pendingLatchIdFor` recognized the CLEAN collision shape (`PENDING_DIVERT_COLLISION_RE`) but not its own
crash-left torn-write residue — `pending-<24hex>-collision-<8hex>.json.tmp-<pid>-<hex>`
(`writePendingDivertFile`'s own tmp-then-rename, interrupted before the rename, exactly the same shape
`PENDING_DIVERT_TMP_RE` already covers for the ORDINARY (non-collision) pending-divert file). It fell
through to the generic `.indexOf(".json")` fallback, which — per the correction above — produces a
non-24-hex id that `clearMergeQuarantineLatchFile` then rejects outright: the latch could never be cleared
by id at all, reproduced against the real compiled dist before any fix was written.

**The fix:** `PENDING_DIVERT_COLLISION_TMP_RE` (`merge-quarantine.ts`), mirroring `PENDING_DIVERT_TMP_RE`'s
own shape with the `-collision-<8hex>` infix, added to `pendingLatchIdFor`'s hash-the-whole-basename
dispatch alongside the other three. No boot-side change needed — PASS 1b's own pre-existing, content-based
"no resolvedKey, unresolvable" branch already recovers it with zero code changes, same reason
`PENDING_DIVERT_TMP_RE` itself needed none.

### Anchors — `@decision 8a79dd31` resolved to no record file

Every `@decision 8a79dd31` anchor this card's own first round added was retargeted to
`@decision 8db913e2 (Follow-up 8a79dd31)` — the same shape the existing `dd34da46` anchors already use for
a follow-up section living inside this SAME record file — so the guard extract actually injects one. The
older `29fe2372`/`495fd320`/`6c04633d` anchors are untouched (a separate, already-filed concern).

### Tests

Five more scenarios in `merge-quarantine-raise-protect-failure.mjs`, closing `reconcilePendingDivertTargetBeforeMint`'s
own untested divert branches plus one lifecycle gap:
- **`8a79dd31-corrupt-json-diverts`** — the primary filename holds genuinely unparseable bytes (not JSON
  at all). Asserts the garbage is byte-identical afterward and the raiser diverts to a collision file.
- **`8a79dd31-null-and-no-repopath-divert`** — two isolated shapes, each its own identity: the bare literal
  `null` (`495fd320`'s own null-latch class), and a syntactically valid object with no `repoPath` field at
  all. Both must divert, never overwrite.
- **`8a79dd31-eisdir-diverts`** — a DIRECTORY sits at the primary filename. Unlike `8db913e2`'s own round 1
  EISDIR trap on the ACTIVE-final side (where EISDIR means "nothing real, proceed"), this card's own ruling
  explicitly groups a PENDING mint target's own EISDIR with "never overwrite, never move" — asserts the
  directory survives untouched and the raiser diverts to a collision file.
- **`8a79dd31-different-identity-diverts`** (extended) — a new LIFECYCLE assertion: releasing the raiser's
  own (last, only) token sweeps its own collision-suffixed file off disk, and the foreign occupant's own
  entry is unaffected.
- **`8a79dd31-collision-tmp-residue-clearable-by-id`** — the real-bug repro above: a hand-crafted
  crash-left collision-tmp residue is recovered at boot, `quarantineLatchFileIdsFor` now derives a valid
  24-hex id for it (not the raw, non-hex basename), and `clearMergeQuarantineLatchFile` on that id succeeds
  (`ok:true`) and sweeps the residue off disk.

A test-hygiene note, not a module bug: the three corrupt/null/no-repoPath garbage fixtures above have no
identity attached and are never swept by anything in the module itself — each scenario now explicitly
unlinks its own garbage file afterward, or it would pollute a LATER scenario's own fresh boot scan of this
SAME shared `MERGE_QUARANTINE_DIR` as a spurious "orphan corrupt latch matching no registered repo"
(caught the hard way: it fail-closed-quarantined an UNRELATED later scenario's own clean repo).

All new assertions proven RED/confirmed against the pre-this-round code and GREEN after. All 34
`merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green (30/30).

### Do not

- Do not let a fresh-mint write site (`divertRaiseEntry`'s own `indices.length === 0` branch,
  `enterMergeQuarantine`'s own direct unresolvable brand-new-divert branch) call `writePendingDivertFile`
  directly — route through `mintPendingDivert`, the ONE chokepoint, or a future call site reopens this
  exact duplicated-writer divergence. **(Widened by Follow-up 6451a749 below)** — this rule is NOT scoped
  to "a fresh mint": `protectOccupantContentBeforeDelete` was a THIRD writer of this SAME deterministic
  path, reached from a COPY-ASIDE rather than a mint, that bypassed this chokepoint entirely and
  rediscovered the identical bug. The rule is "every writer of `pendingDivertFilenameFor`'s own
  deterministic path, whatever its own reason for writing there, routes through ONE shared,
  occupant-aware chokepoint" — see Follow-up 6451a749 for the generalized helper.
- Do not treat a different-identity (or unreadable/corrupt/EISDIR) occupant at the primary filename as
  something to relocate — leave it BYTE-UNTOUCHED and divert the NEW entry to a distinct collision filename
  instead. Moving the occupant can break whatever else still references its own path (the same "never move
  what you can't confirm is safe to move" posture `8db913e2`'s own round 1 EISDIR trap already taught).
- Do not add a new specially-shaped pending filename to this module without also registering it in
  `pendingLatchIdFor`'s own dispatch — every other shape (`PENDING_DIVERT_RE`, `PENDING_DIVERT_TMP_RE`,
  `SAFETY_TMP_RE`) hashes its whole basename there rather than relying on the generic `.json`-index fallback.
- Do not register only a new filename's CLEAN shape and assume its own crash-left `.json.tmp-<pid>-<hex>`
  residue is covered by the same regex — `PENDING_DIVERT_COLLISION_RE` matching the clean collision shape
  did NOT also match its own torn-write residue (Round 2's own real bug); a new shape needs BOTH its clean
  and its tmp-residue regex registered, mirroring the `PENDING_DIVERT_RE`/`PENDING_DIVERT_TMP_RE` pair.
- Do not assume the generic `.indexOf(".json")` fallback in `pendingLatchIdFor` is merely "unhashed but
  usable" for an unregistered shape — `clearMergeQuarantineLatchFile` rejects any non-24-hex id outright, so
  an unregistered shape's latch can never be cleared by id at all, not just inelegantly.
- Do not leave an identity-less garbage fixture (corrupt JSON, bare `null`, a repoPath-less object) behind
  in `MERGE_QUARANTINE_DIR` after a test scenario — nothing in the module itself ever sweeps it, and a
  LATER scenario's own fresh boot scan of this SAME shared directory can fail-closed-quarantine an
  unrelated, otherwise-clean repo as a side effect of the orphan-broadcast mechanism finding it. Unlink it
  explicitly at the end of the scenario that created it.

## Follow-up 6451a749 — a THIRD writer of the pending-divert path, with no occupant read at all

The 8a79dd31 Round 2 "Do not" section (above) named exactly two fresh-mint call sites as the ones routed
through `mintPendingDivert`. Code Review `ddb58ffa` of that round found a THIRD writer of the SAME
deterministic `pendingDivertFilenameFor(...)` path that bypassed the chokepoint entirely:
`protectOccupantContentBeforeDelete` (reached from `protectDegradedOccupantBeforeDelete`/
`protectUnincorporatedOccupantBeforeDelete` when a RAISE's own guard-skipped write, `e1cb7d33`, is about
to clobber a foreign/degraded occupant's physical `final` — its job is to copy that occupant's content
aside, durably, before letting the write through). Its only union source was the IN-MEMORY
`pendingUnresolvedQuarantines` lookup (`atFilenameIdx`); it never read whatever currently occupied that
deterministic filename ON DISK, reopening the exact 8a79dd31 bug shape at a third location:

1. **Never-scanned same-identity occupant.** An on-disk record for the SAME identity, physically sitting
   at `pendingDivertFilenameFor(occupantRepoPath)` but never scanned into THIS process's own
   `pendingUnresolvedQuarantines` (e.g. left by an earlier raise's own divert in a DIFFERENT process, or a
   kept-unreadable file), was silently overwritten and its own token destroyed outright — surviving only
   until the next reboot discards it for good.
2. **Collision-file blind spot.** Once an identity's own record had already been diverted to a
   `-collision-` file (because a genuinely different identity occupies the primary `pendingDivertFilenameFor`
   slot — 8a79dd31's own rule), `protectOccupantContentBeforeDelete`'s primary-name-only lookup could
   never find that collision record. The next time this SAME identity was discovered as a foreign degraded
   occupant at some OTHER key's `final`, protect's blind write to the PRIMARY filename destroyed the very
   occupant 8a79dd31's own reconcile had specifically refused to touch there.

### The repro (first reported `blocked`, before any production edit)

Two hermetic scenarios in `merge-quarantine-raise-protect-failure.mjs`, each confirmed RED against
`HEAD` (before any fix) and the fresh-process reboot assertion this card's own DoD required:

- **`6451a749-never-scanned`** — a hand-crafted, same-identity occupant record at
  `pendingDivertFilenameFor(d)`, never scanned into this process's memory, is destroyed by R's own raise
  discovering D as a foreign occupant at R's own key.
- **`6451a749-collision-file`** — D's own record already lives at a `-collision-` file (because `foreign`,
  a genuinely different identity, occupies D's own primary slot); a LATER raise (R2) discovering D as a
  foreign occupant at R2's own key overwrites `foreign`'s own primary file outright.

### Manager's ruling — one shared, generalized chokepoint; carry every field forward; converge collisions

1. **ONE shared occupant-aware helper, generalized from `reconcilePendingDivertTargetBeforeMint`, used by
   BOTH `mintPendingDivert` and `protectOccupantContentBeforeDelete`. No third copy.**
2. **The same-identity union carries tokens AND `orphanLatchFiles`/`contributorRepoPaths`/
   `provenanceUnknown`/`provenanceTracked`, matching `unionQuarantineEntries`**, so
   `protectOccupantContentBeforeDelete`'s own PRE-EXISTING in-memory-match union (which already called
   `unionQuarantineEntries` and so already carried all four fields) is never silently narrowed by routing
   through the generalized helper instead.
3. **Union into an EXISTING same-identity collision file rather than minting a fresh one each time** — the
   collision name's 24-hex prefix is deterministic per identity, so scan `MERGE_QUARANTINE_DIR` for
   `pending-<thatprefix>-collision-*.json` (never a tmp residue), union into the first one that is both
   readable and genuinely the same identity, and mint a fresh collision file only when none qualifies.
   Otherwise repeated collisions against the same foreign primary occupant would proliferate records
   without bound.
4. Widen 8a79dd31's own "Do not" rule (see the edit to that section, above) to cover EVERY writer of
   `pendingDivertFilenameFor`'s own deterministic path, not just a fresh mint.

### The fix

- **`readPendingDivertFileAt(filePath)`** (`merge-quarantine.ts`) — reads a pending-divert filename's own
  CURRENT on-disk content right now and reconstructs a `MergeQuarantineEntry` from it, via the SAME
  explicit field whitelist (`82032b5c`/`db0a9db0`) every other reader of a parsed latch record in this
  module already trusts. Returns `"enoent"` / `"unsafe"` / `{state:"entry", entry}` — the caller decides
  what either non-entry state means for its own write.
- **`unionIntoOnDiskPendingEntry(onDisk, entry)`** — unions via `unionQuarantineEntries` ITSELF (never a
  hand-rolled re-implementation), answering the open question from the card: yes, carry every field
  forward, not just tokens. Normalizes `unionQuarantineEntries`'s own always-an-array `armedKeys` back to
  `undefined` when empty, mirroring `divertRaiseEntry`'s own "never a cosmetic `armedKeys: []`" rule — a
  pending-only record is never armed anywhere.
- **`findExistingSameIdentityCollisionFile(repoPath)`** — scans `MERGE_QUARANTINE_DIR` for an existing
  `-collision-` file sharing `repoPath`'s own deterministic prefix, returning the first one that is both
  readable and genuinely the same identity (sorted for determinism). Never matches a crash-left tmp
  residue (`PENDING_DIVERT_COLLISION_TMP_RE`'s own shape).
- **`reconcilePendingDivertTarget(entry)`** — the renamed, generalized `reconcilePendingDivertTargetBeforeMint`.
  ENOENT → primary, unchanged. Same identity at the primary → union there via
  `unionIntoOnDiskPendingEntry`. Different identity, or unreadable/corrupt/EISDIR/no-repoPath → never
  overwrite, never move — union into an EXISTING same-identity collision file if
  `findExistingSameIdentityCollisionFile` finds one, else mint a brand-new collision filename. Called by
  BOTH `mintPendingDivert` (unchanged call shape, just the new name) and `protectOccupantContentBeforeDelete`
  (new).
- **`protectOccupantContentBeforeDelete`** now builds `toPersist` exactly as before (unchanged field
  carry-forward from `final`'s own parsed content), then calls `reconcilePendingDivertTarget(toPersist)`
  instead of deriving `priorEntry`/`toWrite` from the in-memory `atFilenameIdx` lookup alone. Its own
  `atFilenameIdx`/`atFinalBasenameIdx` in-memory re-pointing logic (keeping a stale boot-time pending
  reference in sync with the new durable bytes) is unchanged in SHAPE, just now computed against the
  RESOLVED `filename` the helper returns rather than the raw, un-reconciled primary name. Its own
  double-fault fallback (the safety write ALSO fails) now unions from `toWrite` — the already-reconciled
  result of a FRESH disk read at `filename`, a file disjoint from `final` — rather than `toPersist` alone;
  `c9114934`'s own "never use `atFinalBasenameIdx`'s own live entry as a union source" rule is untouched
  by this (that rule was never about `toWrite`, which was never derived from it).

### Tests

Three scenarios in `merge-quarantine-raise-protect-failure.mjs`:
- **`6451a749-never-scanned`** — asserts the never-scanned occupant's own token (AND its own
  branch/reason, proving the field-carry-forward survives, not just tokens) now SURVIVES, unioned at the
  same primary filename, both in-process and across a fresh-process reboot.
- **`6451a749-collision-file`** — asserts the foreign occupant's own primary file stays BYTE-IDENTICAL
  (never overwritten) and its own token survives a fresh-process reboot. The in-process-only assertion
  from the initial repro report was corrected: the foreign occupant's own token was never scanned into
  this process's memory by construction (the whole point of the fixture), so `listActiveMergeQuarantines()`
  — a purely in-memory read — was never going to report it either before or after the fix; the
  byte-identical and reboot checks are what actually discriminate.
- **`6451a749-collision-reuse`** (manager's own point 3) — two INDEPENDENT degraded records for ONE
  identity X, discovered via two separate resolvable repos' own clears, each reach
  `protectOccupantContentBeforeDelete`. Asserts exactly ONE collision file exists for X's own identity
  after both (never two), that one file carries BOTH tokens, and both survive a fresh-process reboot as
  one record. `findExistingSameIdentityCollisionFile` is a pure disk scan with no in-memory dependency, so
  this is exercised identically whether or not the SAME process happened to track the first collision file.

All three proven RED against the pre-fix `protectOccupantContentBeforeDelete` (the `6451a749-never-scanned`/
`6451a749-collision-file` shapes; `6451a749-collision-reuse` exercises the NEW collision-reuse rule, which
did not exist before this round at all) and GREEN after. All 34 `merge-quarantine*.mjs` files re-verified
individually, each exit 0 — including `merge-quarantine-unknown-provenance.mjs`, whose own
`withDistMutation` anchor text (`PROTECT_WHITELIST_LINE`) hard-coded the exact line that used to follow
`protectOccupantContentBeforeDelete`'s own field-whitelist block (`const filename =
pendingDivertFilenameFor(occupantRepoPath);`) — moved by this card's own refactor to `const finalBasename
= path.basename(final);` — updated to match, same disambiguating-suffix technique as before (a bare
`provenanceTracked: ...` line alone recurs five times in the compiled file; the multi-line anchor,
ending at whatever line genuinely follows in THIS function, is what makes the match unique). All static
guards (`pnpm --filter @loom/daemon guards`) re-verified green (30/30). Line endings re-verified CR==LF
via the `tr -dc` recipe on every touched file.

### Do not

- Do not let ANY writer of `pendingDivertFilenameFor`'s own deterministic path — a fresh mint, a raise
  diverting away from `final`, OR a copy-aside protecting a foreign/degraded occupant before an
  unconditional unlink — derive its own union source from an in-memory lookup ALONE. Route through
  `reconcilePendingDivertTarget`, which re-reads disk fresh every time; a future fourth writer that
  "just this once" trusts memory reopens this exact bug class a third time. **(Corrected by Round 2
  below)** — the reverse mistake is just as real: a caller holding its own in-memory record (e.g.
  `protectOccupantContentBeforeDelete`'s own `atFilenameIdx` match) must union that record INTO the
  chokepoint's disk-based result too, never let the disk read REPLACE it. The rule is "union every
  source you have — disk AND memory — never let either one substitute for the other."
- Do not union a same-identity on-disk occupant by tokens alone — use `unionQuarantineEntries` itself (or
  thread its own result through, as `unionIntoOnDiskPendingEntry` does), carrying `orphanLatchFiles`/
  `contributorRepoPaths`/`provenanceUnknown`/`provenanceTracked` forward too. A token-only union silently
  narrows `protectOccupantContentBeforeDelete`'s own PRE-EXISTING behavior for the in-memory-match case.
- Do not mint a brand-new collision file for an identity that already has one — scan for an EXISTING
  `-collision-` file matching that identity's own deterministic prefix first
  (`findExistingSameIdentityCollisionFile`), and union into the first readable, genuinely-same-identity
  match. Skipping this lets repeated collisions against one foreign primary occupant proliferate records
  without bound.
- Do not assert a hand-crafted occupant's own token appears in `listActiveMergeQuarantines()` (a purely
  in-memory read) when that occupant was deliberately constructed to be "never scanned into memory" — it
  never will be, before OR after any fix, and the assertion is vacuous in both directions. Assert the
  on-disk byte-identity and the fresh-process reboot read instead, which actually scans disk.
- Do not hard-code a `withDistMutation`-style anchor string against a specific trailing line of code
  without re-verifying it's still unique and still present after any refactor touching that function — a
  renamed/moved line silently drops the match count to zero (a loud failure here, but only because this
  module's own `withDistMutation` throws on a non-1 occurrence count; a less careful mutation harness
  could instead match the WRONG site silently).

## Round 2 (Code Review `45c8250c`) — NOT SHIP: Round 1's own "go through the shared helper" ruling quietly REPLACED the in-memory union source instead of ADDING to it

CR `45c8250c` found Round 1's own fix to be a Critical fail-open regression, reproduced, plus one Minor
and two test gaps. The Lead's own ruling (Round 1, above) is partly to blame: "route through one shared,
occupant-aware chokepoint" was correct, but the chokepoint itself only ever reads DISK — it was never
meant to also BE the in-memory union source, and Round 1's own implementation of
`protectOccupantContentBeforeDelete` wired it that way anyway, deleting the pre-existing in-memory lookup
entirely rather than keeping it as a second, additive source.

### CRITICAL — the disk-only chokepoint union silently dropped tokens an in-memory record already held

`protectOccupantContentBeforeDelete`'s Round 1 code computed `toWrite` ENTIRELY from
`reconcilePendingDivertTarget`'s own disk read, then OVERWROTE the in-memory record at `atFilenameIdx`
with that disk-only object. An in-memory pending record can legitimately hold MORE tokens than its own
physical backing file right now — an EARLIER durable write for the SAME identity already failed, leaving
it "quarantined IN THIS PROCESS ONLY" (`mergeTokenIntoPendingEntries`'s own failed-rewrite branch has NO
safety-tmp fallback at all; `mintPendingDivert`'s own triple fault is the analogous shape for a fresh
mint). Replacing that richer in-memory object with the disk-only union silently ERASED the extra tokens
from memory too — not merely failed to add them — so the identity they protected was UNBLOCKED, both
in-process and after a reboot: the exact fail-open this whole card exists to prevent, reintroduced by its
own Round 1 fix.

**The CR's own repro:** raise unresolvable D (`tD1` → mints `pending-<hash>.json`); raise D again with
`fs.openSync` failing on that same file (`tD2` is unioned into memory by `mergeTokenIntoPendingEntries`,
but its own rewrite fails with no safety-tmp fallback — `tD2` survives ONLY in memory, at the pending
entry's own pre-existing `sourceFile`); plant D's own degraded record at R's own key's `final` (same
"degraded occupant" shape every scenario in this file uses); R raises, reaching
`protectOccupantContentBeforeDelete` for D. Pre-fix: the in-memory re-point overwrites memory with the
disk-only union (`tD1` + R's own current token) — `tD2` is gone, from memory AND disk, permanently.

### The fix

Union ALL THREE sources, never just the chokepoint's own disk read: the fresh disk read (inside
`reconcilePendingDivertTarget`, unchanged) ∪ the in-memory record already tracked at `atFilenameIdx`
(still safe to read — `c9114934` forbids only `atFinalBasenameIdx`, a DIFFERENT lookup, as a union source;
that rule is untouched) ∪ `toPersist` (also already folded into the disk read). Concretely:
`protectOccupantContentBeforeDelete` now computes `atFilenameIdx`/`atFinalBasenameIdx` against the
chokepoint's own resolved `filename` (as Round 1 already did), then — when `atFilenameIdx >= 0` — unions
the in-memory record there into the chokepoint's own disk-reconciled result via `unionQuarantineEntries`,
and uses THAT as `toWrite` for both the write and the in-memory re-point. When no in-memory record exists
at `filename` (the common case — nothing to add), `toWrite` is exactly the chokepoint's own result,
unchanged from Round 1.

This is NOT scoped to the primary-filename case alone: the same fold applies uniformly whether
`reconcilePendingDivertTarget` resolved to the primary filename, an EXISTING reused collision file, or a
brand-new one — an in-memory record can in principle be stranded at any of those names, and the fold
doesn't need to know which case it is.

### Minor — the double-fault `kept` fallback must not borrow a foreign `orphanLatchFiles` reference

Round 1's own double-fault branch (the CHOSEN write, to `filename`, ALSO fails) built `kept` by spreading
the newly-folded `toWrite` wholesale, including its `orphanLatchFiles`. Those file references can belong
to WHATEVER OTHER record lives at `filename` — the on-disk occupant the chokepoint unioned in, or (after
the CRITICAL fix above) the folded-in in-memory record — never to `kept` itself, which is self-owned at
`finalBasename`, a DIFFERENT physical file. Carrying them forward risks a LATER clear of `kept` sweeping a
file that other record still legitimately references, destroying content `kept` never owned.

**The fix:** `kept`'s own `orphanLatchFiles` is sourced from `toPersist` alone — `final`'s own parsed
content, which genuinely belongs to `kept`'s own lineage — plus the `finalBasename` self-reference, exactly
as every prior round of this card (`c9114934`, `4900c365`) already established for this branch. Tokens
still carry forward from the folded `toWrite` (fail-closed): only the file-reference field is scoped.
Reachable and pinned directly (see Tests) — not merely a theoretical risk.

### Test gaps — the MINT path's own collision reuse, and a negative control for it

Round 1's only test of the collision-reuse rule (`6451a749-collision-reuse`) drove it exclusively through
`protectOccupantContentBeforeDelete`. `mintPendingDivert` — the OTHER caller of
`reconcilePendingDivertTarget`, reached from a fresh RAISE rather than a copy-aside — was never exercised
against an EXISTING same-identity collision file at all. Separately, nothing proved that
`findExistingSameIdentityCollisionFile`'s own scan correctly SKIPS a collision-suffixed file that happens
to sit at the right deterministic prefix but names a genuinely DIFFERENT identity (8a79dd31's own
"different identity → never reuse, mint fresh" rule, now applied to the collision slot itself, not just
the primary one).

### Tests

Four scenarios added to `merge-quarantine-raise-protect-failure.mjs`:
- **`6451a749-inmemory`** — the CR's own CRITICAL repro, verbatim. Asserts D's own second token (held in
  memory only before R's raise) is now durably written to disk, still tracked in-process, and survives a
  fresh-process reboot — alongside D's first token, D's own newly-discovered current token, and R's own
  token, all four as one record.
- **`6451a749-double-fault-orphan-scope`** — the Minor's own repro: D's pre-existing pending record
  already carries a genuine orphan reference; R's raise forces the chosen write to fail (double fault).
  Asserts `kept` carries BOTH tokens forward (fail-closed) but does NOT inherit the foreign orphan
  reference, that `kept` DOES self-reference `final`'s own basename, and that the foreign orphan file
  itself is untouched on disk throughout.
- **`6451a749-mint-reuse`** — the first test-gap closure: an identity's own collision file, hand-crafted
  and never scanned into memory (mirroring 8a79dd31-fresh-divert's own setup, now at the collision slot),
  is correctly found and unioned into by a fresh RAISE reaching `mintPendingDivert` directly — never
  `protectOccupantContentBeforeDelete`. Asserts exactly one collision file survives, carrying both tokens,
  across a fresh-process reboot.
- **`6451a749-mint-reuse-negative`** — the negative control: a collision-suffixed file sits at the right
  deterministic prefix for identity X, but its own content names a GENUINELY DIFFERENT identity (a true
  hash-of-identity collision stand-in, same technique `8a79dd31-different-identity-diverts` already uses
  at the primary slot). Asserts the scan correctly skips it (byte-identical afterward, never reused) and
  mints a brand-new, distinct collision file for X instead.

All four scenarios proven RED on commit `b393bafa` (this card's own Round 1 commit) and GREEN after, via
`scripts/negative-control.mjs` — exactly 4 failures in the RED phase (3 from `6451a749-inmemory`, 1 from
`6451a749-double-fault-orphan-scope`'s own orphan-scope assertion), confirming both the CRITICAL and the
Minor are genuinely reachable regressions, not theoretical. The two test-gap scenarios
(`6451a749-mint-reuse`/`-negative`) exercise logic Round 1 already shipped correctly and are GREEN in
both phases — closing the gap in coverage, not a regression proof. All 34 `merge-quarantine*.mjs` files
re-verified individually, each exit 0. All static guards (`pnpm --filter @loom/daemon guards`)
re-verified green (30/30). Line endings re-verified CR==LF via the `tr -dc` recipe.

### Do not

- Do not let a shared chokepoint's own disk-based union REPLACE a caller's separate in-memory union
  source — fold both together. `reconcilePendingDivertTarget` deliberately has NO in-memory awareness
  (by design — `mintPendingDivert`'s own callers never have a competing in-memory record for the identity
  they're minting, by construction); `protectOccupantContentBeforeDelete` is DIFFERENT precisely because
  it CAN be reached with a richer in-memory record already present, and must therefore add its own
  `atFilenameIdx` fold on top, not assume the chokepoint already covers it.
- Do not let a double-fault fallback's own self-owned record inherit `orphanLatchFiles` from whatever OTHER
  record it unioned against — only `orphanLatchFiles` ever carries a FILE reference (never just data), and
  a fallback record living at ITS OWN distinct physical name must never claim ownership of a file some
  OTHER still-live record continues to reference. Tokens and other metadata fields carry forward fine;
  `orphanLatchFiles` is the one field that needs scoping to the fallback's own lineage.
- Do not assume testing a shared helper through ONE of its callers proves both — `mintPendingDivert` and
  `protectOccupantContentBeforeDelete` reach `reconcilePendingDivertTarget` under genuinely different
  in-memory preconditions (the latter can find a stranded in-memory record the former structurally never
  will), so a scenario driving the collision-reuse rule through one caller says nothing about the other.

## Follow-up 37452ddd — `protectOccupantContentBeforeDelete`'s own re-point could leave a boot-diverted twin stale

Card 37452ddd, CR of `6451a749`'s own Round 2 fix (the `atFilenameIdx`/`atFinalBasenameIdx` re-point block
added there). `mergeTokenIntoPendingEntries` already knows (`@decision 64283e06`) that a matched pending
entry can be an `883e29bc` boot-diverted TWIN — the SAME object reference ALSO armed in `activeQuarantines`
— and routes its own re-point through `replaceEntryEverywhere` for exactly that reason. The re-point this
card's own block added at `protectOccupantContentBeforeDelete` never did: it reassigned
`pendingUnresolvedQuarantines[atFilenameIdx]` (or `[atFinalBasenameIdx]`) directly to a fresh `toWrite`
object, discarding the OLD reference with no re-point of its own. A twin's `activeQuarantines` entry (and,
for `atFilenameIdx`, any OTHER pending slot still sharing the old reference) was left pointing at the
stale object — missing whatever tokens a LATER same-identity merge (`mergeTokenIntoPendingEntries`) then
added only to the surviving pending slot, since that merge's own `replaceEntryEverywhere` call finds
nothing in `activeQuarantines` matching an object it was never armed under in the first place.

### The repro (first reported `blocked`, before any production edit)

Two hermetic scenarios, GREEN after the Round 1 fix:

- **`37452ddd-twin-repoint`** (`atFilenameIdx`) — TWO independent on-disk latch files for one unresolvable
  identity D, both recording `resolvedKey` as S's own canonical key: one at the ordinary hash-named final,
  one at D's own deterministic pending-divert filename. PASS 1 scans every `.json` file by CONTENT
  (filename-agnostic), so both resolve to the same degraded identity at the same `resolvedKey`;
  `armKeyUnlessDegradedCollision`'s same-identity union (plus its own `degradedDivertsToFlush` rebind)
  converges both onto ONE merged object — armed in `activeQuarantines` AND present in
  `pendingUnresolvedQuarantines` TWICE (once per `sourceFile`): the twin. A THIRD, unrelated occupant file
  for D is written directly to a DIFFERENT repo R's own key (never scanned into this process), and R
  raises — reaching `protectOccupantContentBeforeDelete` via the "no existing" front door, which finds the
  twin at `atFilenameIdx`.
- **`37452ddd-twin-repoint-finalbasename`** (`atFinalBasenameIdx`) — a SINGLE boot-time latch file is named
  as if it belongs to R's own key (`sourceFile = "<Krhash>.json"`) but its own content records
  `resolvedKey` as a DIFFERENT, unrelated repo S's key — PASS 1 arms an entry at its own `resolvedKey`,
  never at a hash derived from its filename, so this produces a twin whose ONLY pending reference sits at
  R's own `final` basename (not the pending-divert path — nothing sits there, so `atFilenameIdx` is `-1`).
  R raises — reaching `protectOccupantContentBeforeDelete` via the same front door, which finds the twin
  via `atFinalBasenameIdx` only.

**Correction (Round 2 CR of commit `01f2ae25`) — Round 1's own claim that both scenarios were
independently proven RED was FALSE for `37452ddd-twin-repoint`.** That scenario's original assertions ran
only AFTER D's own second raise — by then, `mergeTokenIntoPendingEntries`'s own (already-correct,
`64283e06`) `replaceEntryEverywhere` calls had already re-discovered and re-pointed the stale twin via its
OWN surviving pending slot, self-healing the exact staleness the scenario meant to catch. Removing Round
1's fix entirely still left this scenario green; `scripts/negative-control.mjs`'s own file-level RED on
that run came ENTIRELY from `37452ddd-twin-repoint-finalbasename`, which genuinely did (and still does)
discriminate. **Fixed (Round 2): both scenarios now assert in the window BETWEEN R's raise and D's own next
raise** — `activeMergeQuarantineFor` on the twin's own armed-key repo must already show the newly
discovered token, and exactly ONE object for D must exist — before anything downstream gets a chance to
self-heal it. Both scenarios then raise D itself a second time and assert the newest token is visible via
BOTH `activeMergeQuarantineFor` on the twin's own armed-key repo AND on D directly, that exactly ONE D
object exists in `listActiveMergeQuarantines()`, and that every token survives a fresh-process reboot.

### The fix (Round 1)

A `replaceEntryEverywhere(activeQuarantines, <old entry at that index>, toWrite)` call immediately before
each of the two re-point assignments — mirroring `mergeTokenIntoPendingEntries`'s own fix exactly.

## Round 2 (Code Review of commit `01f2ae25`) — Round 1 was incomplete: TWO more unguarded re-points, same shape

Besides the test-discrimination gap corrected above, CR found Round 1's own fix never covered every
re-point it needed to: `replaceEntryEverywhere` re-points `activeQuarantines` AND (by scanning it directly)
every `pendingUnresolvedQuarantines` entry sharing the SAME old reference — but Round 1 called it only
ONCE per branch, using only `atFilenameIdx`'s own entry as `oldEntry`. When `atFilenameIdx`'s entry and
`atFinalBasenameIdx`'s entry are TWO DIFFERENT objects (not the same twin), re-pointing one never touches
the other.

### CRITICAL — branch 1's own splice discarded `atFinalBasenameIdx`'s slot with no re-point at all

`if (atFilenameIdx >= 0) { ...; if (atFinalBasenameIdx >= 0) pendingUnresolvedQuarantines.splice(atFinalBasenameIdx, 1); }`
— reachable on the SUCCESS path, no fault needed, whenever the two indices hold DIFFERENT objects and the
`atFinalBasenameIdx` one is the one ARMED in `activeQuarantines`. **Repro (`37452ddd-branch1-dual-twin`):**
object X — a single latch file named as R's own key but `resolvedKey` = S's key (the SAME single-file twin
shape as `37452ddd-twin-repoint-finalbasename`, ARMED at S's key) — PLUS an INDEPENDENT pending-divert file
for the SAME identity with NO `resolvedKey` (object Y, never armed anywhere). R raises, discovering X's
content at its own final; `atFilenameIdx` matches Y's slot (the deterministic pending-divert filename),
`atFinalBasenameIdx` matches X's slot — branch 1. Pre-fix: the splice discards X's own slot without ever
calling `replaceEntryEverywhere` for it, so `activeQuarantines` keeps the STALE X object forever — `S`'s
own active entry never sees Y's token, D's later raise, or anything added after. Named consequence,
confirmed by the test: `clearMergeQuarantineByToken(d, <X's own token>)` then fail-open-LIFTS `S`'s key
entirely (nothing else is armed there), even though Y's (and D's later) tokens are still outstanding —
exactly the shape this whole card exists to prevent. **Fix:** a SECOND `replaceEntryEverywhere` call,
re-pointing `atFinalBasenameIdx`'s own entry, before that slot is spliced away.

### MAJOR — the double-fault `kept` branch had the IDENTICAL gap

`pendingUnresolvedQuarantines[atFinalBasenameIdx] = { entry: kept, ... }` (the branch reached when the
CHOSEN write, to `filename`, ALSO fails) never went through `replaceEntryEverywhere` either — Round 1's own
new "Do not" bullet (below) already named this exact line as forbidden, and it was reachable the whole
time. **Repro (`37452ddd-double-fault-kept-twin`):** the same single-file twin shape as
`37452ddd-twin-repoint-finalbasename`, with R's raise wrapped in `injectOpenSyncFailureForPrefix` targeting
D's own pending-divert filename so `writePendingDivertFile` fails and the double-fault branch runs.
**Fix:** `replaceEntryEverywhere(activeQuarantines, <atFinalBasenameIdx's own entry>, kept)` before the
slot is overwritten with `kept`.

### ACCEPTED RESIDUAL — `toWrite`/`kept` never carry `resolvedKey` forward, so a reboot can unblock the wrong side

**The concrete consequence (reproduced, not merely argued):** in the `37452ddd-twin-repoint-finalbasename`
fixture, after R raises (triggering `protectOccupantContentBeforeDelete`'s copy-aside) and the process then
reboots, `activeMergeQuarantineFor(s)` is UNBLOCKED (returns nothing) while `activeMergeQuarantineFor(d)`
still correctly returns the full entry (tokens `x`, `d2`, ...). This is a FAIL-OPEN for exactly as long as D
stays unmounted: anything that queries by `s` — R's own real repo — stops seeing D's quarantine at all,
even though D's own identity is still genuinely, durably blocked.

**Cause:** `toPersist`'s own field whitelist (this function's pre-existing, pre-`37452ddd` code) never
carries `resolvedKey` onto the protective copy it writes to `pending-<hash>.json`. On the NEXT boot, PASS 1
reads that file with no `resolvedKey` and no currently-resolvable path, so it takes the "defer to a lazy
re-resolve on first query" branch (never arms anywhere) — and `findPendingIndicesFor`'s own 4th tier
(~L3450, `merge-quarantine.ts`) is gated on `!!entry.resolvedKey`, so it never matches a query for `s`
either. Both the boot-time lazy-re-resolve path and the runtime query-time fallback need `resolvedKey` to
re-derive the connection to `s`, and the protective copy carries neither.

**Pre-existing, not introduced by this diff** — `toPersist`'s whitelist has excluded `resolvedKey` since
before card `37452ddd` touched this function at all; this round's own four `replaceEntryEverywhere` fixes
change WHICH in-memory object is correct and consistent, never WHAT FIELDS that object persists to disk.

**Tried carrying `resolvedKey` forward anyway, and it REGRESSES a different, deliberate, already-tested
invariant** — `merge-quarantine-runtime-union-provenance.mjs`'s own `clear-by-path-still-proceeds-and-protects`
scenario (card `82032b5c`/`c9114934`: "a protective copy must never re-occupy a resolved identity
collision") went RED the moment `resolvedKey` was carried forward from the REPLACED IN-MEMORY OBJECT: that
scenario's own protective copy (minted for a DIFFERENT identity, X, sharing a key with Y only via a genuine
collision) picked up `resolvedKey` from the stale pre-clear armed object it replaced, and a subsequent
reboot re-armed X at Y's own key — the EXACT resurrection `82032b5c` exists to prevent. The two concerns are
in real tension: a SELF-CONSISTENTLY-armed twin (this card's own scenarios) legitimately wants its
`resolvedKey` preserved so the 4th tier can still find it after a reboot; a GENUINE two-identity collision
(`82032b5c`'s own shape) must NOT have its `resolvedKey` preserved, or the losing side resurrects.

**Untested variant, not yet tried:** the regression above came specifically from carrying forward the
REPLACED IN-MEMORY OBJECT's own `resolvedKey` (which can belong to a DIFFERENT identity in the collision
case). A narrower variant — carrying forward the OCCUPANT's OWN on-disk `parsed.resolvedKey` (read directly
off `final`'s own bytes at the top of this function, `toPersist`'s own source) behind a check that this is
genuinely a SELF-CONSISTENT twin rather than a two-identity collision — was never built or measured. It may
avoid the `82032b5c` regression (the occupant's own `resolvedKey`, unlike the replaced object's, can never
belong to a different identity), but "may" is not "proven" — it still needs the same genuine-twin-vs-
collision discrimination the identity-model work (`398f476c`) exists to provide, and a hermetic repro before
trusting it.

**FIXED by card `4b06875f`** ("fix(git): keep a resolvedKey-armed twin blocking its key after a reboot") —
see the "Follow-up 4b06875f" section below for the guarded variant that was actually built, and why it
avoids the regression above. This round (`37452ddd`) did not fix it; `toWrite`/`kept` kept their ORIGINAL
(pre-`37452ddd`) field set, and this round fixed the REFERENCE staleness only (the four
`replaceEntryEverywhere` calls), never the durable field set.

### `armedKeys` — a SEPARATE question from `resolvedKey`, not yet fixed either, open question filed separately

`armedKeys` is NEVER persisted to disk at all (it is purely an in-memory bookkeeping field, rebuilt fresh by
`armQuarantineKey`/`armKeyUnlessDegradedCollision` on every boot) — so, unlike `resolvedKey`, carrying it
forward onto `toWrite`/`kept` is COMPATIBLE with the `82032b5c`/`c9114934` reboot invariant above; it cannot
resurrect anything on reboot because nothing durable reads it back. Its absence here is fail-CLOSED, not
fail-open, IN-PROCESS: when the replaced object was dual-armed (`armedKeys.length > 1`), the replacement
carries no `armedKeys` of its own, so a LATER full clear of the replacement's own (single, newly-armed) key
never learns about the SECOND key the original twin also occupied — that second key stays armed (over-
blocking, the safe direction) rather than silently unblocking. **If this is ever fixed, derive `armedKeys`
from LIVE occupancy scanned fresh AFTER the re-point (which keys in `activeQuarantines` now actually point
at the new object), never from the old object's own `armedKeys` list** — a stale list is exactly the shape
`d4b25feb`'s own "Do not" section already warns against copying forward uncritically.

**Second, separate open question, also not investigated here: card `af948556`** — whether the raise-divert
path inside `consumeMatchedPendingsIntoArmedEntry` can strand a twin's own ACTIVE slot (unverified; filed
as its own follow-up, not explored as part of this card).

### Tests

Three scenarios in `merge-quarantine-raise-protect-failure.mjs`, mirroring the Round 1 pair:
`37452ddd-twin-repoint`/`37452ddd-twin-repoint-finalbasename` (Round 1, test-discrimination fixed per the
correction above), `37452ddd-branch1-dual-twin` (the CRITICAL repro), and
`37452ddd-double-fault-kept-twin` (the MAJOR repro). **Discrimination proof, per call site** (each of the
four `replaceEntryEverywhere` calls this card adds, one at a time: commented out in the TypeScript SOURCE,
rebuilt — which regenerates `dist` from that edited source — re-run against the resulting build to confirm
RED, then the comment-out reverted in source and rebuilt again to confirm GREEN; a bare `dist` edit would
never survive its own rebuild step, so the source is what was actually mutated each time):
1. Branch 1's own `atFilenameIdx` call — RED on `37452ddd-twin-repoint`'s mid-window assertions.
2. Branch 1's own `atFinalBasenameIdx` call (Round 2) — RED on `37452ddd-branch1-dual-twin`'s mid-window
   assertions AND its fail-open-lift assertion.
3. Branch 2's (`atFinalBasenameIdx`-only) call — RED on `37452ddd-twin-repoint-finalbasename`.
4. The double-fault `kept` branch's call (Round 2) — RED on `37452ddd-double-fault-kept-twin`'s mid-window
   and post-second-raise assertions.

All 34 `merge-quarantine*.mjs` files re-verified individually, each exit 0 — including
`merge-quarantine-unknown-provenance.mjs` (the `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` member) and
`merge-quarantine-runtime-union-provenance.mjs` (the scenario the rejected `resolvedKey` carry-forward
regressed, now confirmed green with it reverted). All static guards (`pnpm --filter @loom/daemon guards`)
re-verified green (30/30).

### Do not

- Do not reassign a `pendingUnresolvedQuarantines[idx]` slot in place, inside this function or any sibling
  writer of this module's shared `byRepoKey`/`pendingUnresolvedQuarantines` state, without first asking
  whether the entry CURRENTLY at that index could be an `883e29bc` boot-diverted twin — route the
  replacement through `replaceEntryEverywhere` by default; a hand-rolled direct assignment is the recurring
  shape this bug class keeps reopening (see `d4b25feb`'s own "Do not" section for the earlier instance of
  the identical lesson).
- Do not union `atFinalBasenameIdx`'s own entry into `toWrite` to "fix" this — `c9114934` already forbids
  that (its own tokens may not be fully captured by `toPersist`'s read of `final`); the stale-reference
  hazard this follow-up fixes is orthogonal, and the fix here re-points the REPLACEMENT only, never adds a
  union source.
- Do not assume re-pointing ONE of `atFilenameIdx`/`atFinalBasenameIdx`'s own entries covers the other —
  they can be TWO DIFFERENT objects (one armed, one pending-only, or vice versa); re-point BOTH, every time
  either index is `>= 0`, including in the double-fault `kept` branch (Round 2's own CRITICAL + MAJOR).
- Do not carry `resolvedKey` forward from the REPLACED IN-MEMORY OBJECT onto `toWrite`/`kept` in this
  function — see the "ACCEPTED RESIDUAL" section above for the concrete regression this reopens
  (`82032b5c`/`c9114934`). Card `4b06875f` (see the "Follow-up 4b06875f" section below) instead carries
  the OCCUPANT's OWN `parsed.resolvedKey`, behind a guard — never the replaced object's.
- Do not copy a replaced object's own `armedKeys` list forward uncritically either, if that is ever
  attempted — derive it from live occupancy after the re-point (card `d4b25feb`'s own lesson), and remember
  its absence today is fail-CLOSED (over-blocking), not fail-open, so it is lower priority than the
  `resolvedKey` residual above.
- Do not trust a test's own mid-raise assertions to discriminate a fix if they run only AFTER a SECOND
  same-identity raise — `mergeTokenIntoPendingEntries`'s own (correct) `replaceEntryEverywhere` calls can
  silently self-heal a staleness this module's OTHER writers failed to fix, making the later assertion pass
  for the wrong reason. Assert in the window BEFORE that second raise too.

## Follow-up 4b06875f — carrying the occupant's own on-disk `resolvedKey` forward (Round 1, SUPERSEDED — see Round 2 below)

Card `4b06875f`, closing the "ACCEPTED RESIDUAL" above: `toPersist` (in `protectOccupantContentBeforeDelete`,
`merge-quarantine.ts`) carried the occupant's own on-disk `parsed.resolvedKey` forward, gated by a single
physical-key-equality check — EQUAL (self-consistently filed) ⇒ never carry (the `82032b5c`/`c9114934`
collision shape); DIFFERENT (misfiled twin) ⇒ carry (the `883e29bc` twin shape this card exists to fix).

**Round 2 (Code Review, two findings) proved this guard insufficient — see that section below for the
corrected discriminator, the corrected caller list, and the corrected field-survival trace.** The content
that used to sit here (the single-check "guard" description, a Round-1-only two-direction discrimination,
and a field-survival trace citing `path.basename(final, ".json")`) has been folded into Round 2's own
fuller versions below rather than duplicated — Round 1's own empirical probes (the collision-shape and
twin-shape measurements) still hold as *reported*, but the GUARD they were measuring is no longer the
guard that shipped; read Round 2 for what actually ships.

### Relationship to card `398f476c`

Orthogonal — no sequencing dependency, in EITHER round. `398f476c`'s own scope is the IDENTITY-MODEL
problem of a UNION object representing more than one losing identity's own queryability at once
(token-set-based identity tracking; touches `unionQuarantineEntries`/`armQuarantineKey`/
`activeMergeQuarantineFor`). This card's own union-rule change (Round 2) is narrower: it decides what a
TWO-SIDED union does with ONE scalar field (`resolvedKey`), never which identity wins token-level
ownership of a union overall.

### `armedKeys` — left unfixed (Lead ruling)

Unchanged from the ACCEPTED RESIDUAL section above, in both rounds — still fail-closed (over-blocking),
still lower priority, still not addressed.

## Follow-up 4b06875f, Round 2 — a `liftedKeys` discriminator, a union rule, and a post-union filter

Code Review of commit `7282d183` (Round 1's own landed commit) found two further findings, both before any
Round-2 fix was written:

- **Finding 1** — the physical-key-equality guard asks the WRONG question: "does the occupant's
  `resolvedKey` equal the one key `final` is physically filed under right now" never discriminates a
  SECOND armed key of the SAME dual-armed entry that final's write is protecting. Repro (Probe B,
  `merge-quarantine-runtime-union-provenance.mjs`, scenario `4b06875f-dual-arm-clear-resurrection`): Y
  dual-armed at `[Ky, K2]` (legacy stale-`resolvedKey` shape); X degraded, physically at `hash(K2)`, with
  X's own `resolvedKey = Ky` (the OTHER half of Y's own dual-arm, never the key the protect call is
  physically touching). W raises at K2 (W's own canonical key), hitting Y's `existing` branch — the
  Round-1 guard CARRIES `Ky` into X's own protective copy, even though `Ky` is Y's OWN other armed key,
  the very entry this protect call is protecting X FROM.
- **Finding 2** — `readPendingDivertFileAt`'s own field whitelist (`merge-quarantine.ts:2103` region, as it
  stood at `7282d183`) never read `resolvedKey` back off an on-disk pending-divert file at all, and
  `unionQuarantineEntries`'s bare `{...older}` spread let whichever side was OLDER win for any field not in
  its own explicit list — including `resolvedKey`, which wasn't in that list. So even when the raise-side
  guard correctly decided to CARRY `resolvedKey` forward, that value was silently dropped the instant it
  had to union with an EXISTING, OLDER on-disk pending-divert record for the same identity — age-dependent
  (a NEWER pre-existing pending file did not trigger the drop). Repro: Probe C (described under Round 1's
  own Tests, still present in `merge-quarantine-raise-protect-failure.mjs`) plus a no-raise control and a
  newer-pending-file variant, all confirming the mid-window (pre-reboot) in-memory state was fine — only
  the disk round-trip (write via union, re-read at next boot) lost the field.

### The corrected discriminator — `liftedKeys`, computed by each caller from what it already has in scope

`excludeLiftedResolvedKey(resolvedKey, final, liftedKeys)` (`merge-quarantine.ts:1772`) is the ONE place
that decides whether an occupant's own `resolvedKey` may ride onto a protective copy — called BOTH before
any union (on the freshly-read `toPersist`) and AGAIN after one (on whatever `toWrite` the union
produced), so a union can never reintroduce a key this chokepoint already excluded. It excludes on EITHER
condition:

- `resolvedKey` is a member of `liftedKeys` — every key the CURRENT clear/raise operation is itself
  touching, computed by the caller (see the full list below) — OR
- it names the same key `final` is physically filed under right now, via the SAME cut-at-first-`.json`
  technique `pendingLatchIdFor` already established (card `6237bef6`) for telling an ordinary
  `<hash>.json` final apart from a `<hash>.json.tmp-<pid>` tmp residue, since `protectForeignTmpResidueBeforeSweep`
  reaches this same function with the latter shape, not just the raise side's ordinary `.json` shape. This
  is a **caller-independent fallback**, kept deliberately: it is the one part of the guard that degrades
  safely even if some future caller forgets to thread a complete `liftedKeys`. (**Correction, Finding 3**:
  Round 1's own text here previously stated `path.basename(final, ".json")` — that expression is WRONG for
  a tmp-residue path, since `path.basename(path, ext)` only strips `ext` on an exact trailing match; it
  silently fails to strip `.json.tmp-<pid>`, miscomputing the physical key and incorrectly carrying
  `resolvedKey` forward in a self-consistent shape. This was caught by a REAL regression in
  `merge-quarantine-pass1-degraded-union-guard.mjs`'s `d2582692-clear-resolvable-protects-foreign-occupant`
  scenario during Round-2 verification, not reasoned about in the abstract — see that test for the repro.)

**Every caller, with its own `liftedKeys` computation — re-grep the symbol names below rather than
trusting these line numbers, which have already moved twice across rounds:**

- **Clear side, the TOP-LEVEL clear shares ONE scope** — `deleteMergeQuarantineLatchByKey(key,
  clearingRepoPath, clearedEntry, clearIdentity, liftedKeysOverride?)` (`merge-quarantine.ts:1455`)
  computes `liftedKeys` from `liftedKeysOverride ?? new Set([key, ...(clearedEntry?.armedKeys ?? [])])`
  (`:1460`) and threads it to all four of its own protect calls: the `clearingRepoPath`-gated
  `protectDegradedOccupantBeforeDelete` call, the `foreignPending`-gated
  `protectOccupantContentBeforeDelete` call, the `clearedEntry`-gated
  `protectUnincorporatedOccupantBeforeDelete` call, and (via its own call to
  `protectForeignTmpResidueBeforeSweep`, which forwards to its own `protectOccupantContentBeforeDelete`
  call) the tmp-residue site. `clearMergeQuarantineByKey`'s OWN top-level loop over `keysToLift` (`:3234`
  as of this writing) calls this with NO override — `clearedEntry.armedKeys` IS already the correct,
  non-stale set there (it's the entity actually being cleared, looked up fresh at this function's own
  top, never a snapshot from an earlier collection).
- **Three OUTER loops pass `liftedKeysOverride` explicitly** (Code Review `be296830`, Minor 1, two passes
  — see "Minor 1" under "Round 4" below for the full history, including a direction mistake caught and
  fixed BEFORE landing), each iterating a COLLECTION of entries gathered earlier by identity match:
  `clearTokenFromPendingIndices`'s own loop (`:2712` as of this writing — this one has NO enclosing
  top-level lift, since `clearMergeQuarantineByToken` calls it BEFORE touching any active entry);
  `clearMergeQuarantineByKey`'s OWN matchedPending loop (`:3269` — **CORRECTED attribution**: an earlier
  draft of this record wrongly placed this loop in `clearMergeQuarantineByRecordedPath`; it is the SAME
  function as the top-level loop immediately above, in its own `pendingUnresolvedQuarantines.filter`
  callback); and `clearMergeQuarantineByRecordedPath`'s own separate matchedPending loop (`:3443`, a
  genuinely different function from the previous one, clearing an identity's EVERY matched active entry
  first and then sweeping pending). **Each now computes `liftedKeys = (keys the enclosing operation
  already lifted) ∪ ownedArmedKeys`**, where `ownedArmedKeys = p.entry.armedKeys FILTERED by
  entryStillOwnsKey` — `keysToLift` for `clearMergeQuarantineByKey`'s own loop; a newly-collected
  `activeLiftedKeys` (every key the matched-active phase above it lifted) for
  `clearMergeQuarantineByRecordedPath`'s own loop; nothing additional for `clearTokenFromPendingIndices`,
  which has no enclosing lift at all. `ownedArmedKeys` is snapshotted ONCE, immediately before the loop;
  the per-key ACT decision (whether to delete/protect a given key at all) stays a SEPARATE, PER-ITERATION
  `entryStillOwnsKey` check inside the loop body, unaffected by the snapshot — this is the shape every one
  of these three loops already had BEFORE any of this card's own changes, just now also passing an
  explicit override alongside it. **Why `ownedArmedKeys` must be FILTERED, never the whole list:**
  `excludeLiftedResolvedKey` DROPS a `resolvedKey` that is a member of `liftedKeys` — dropping a
  legitimate binding is what UNBLOCKS a repo after reboot, so naming an UNOWNED key in `liftedKeys` is the
  FAIL-OPEN direction, never a safe over-inclusion; see "Minor 1" below for the full correction and why an
  earlier landed commit (`f6ccb810`) had this backwards. Historical note: BEFORE this fix existed at all,
  each of these three loops passed `p.entry` as `clearedEntry` with NO override — `deleteMergeQuarantineLatchByKey`'s
  own default then derived `liftedKeys` from `p.entry.armedKeys` WHOLESALE (unfiltered AND with no way to
  fold in an enclosing lift), which is the exact under-reporting/over-reporting defect this fix closes.
- **Raise existing-branch** (`merge-quarantine.ts:2393`) — `liftedKeys = new Set(armedKeysForEntry)`, reusing
  the SAME `armedKeysForEntry` the write-every-armed-key loop already computes a few lines above; threaded
  to `protectUnincorporatedOccupantBeforeDelete` and `resolveRaiseOverwrite`.
- **Raise no-existing front door** (`merge-quarantine.ts:2487`) — `liftedKeys = new Set([key])` (nothing
  else is armed yet at this key); threaded to `protectDegradedOccupantBeforeDelete` and
  `resolveRaiseOverwrite`.
- **`resolveRaiseOverwrite`** (`merge-quarantine.ts:2027`) itself takes `liftedKeys` as a parameter and
  forwards it to its own internal `protectOccupantContentBeforeDelete` call — it is reached ONLY from the
  two raise sites above, never independently, so it never computes its own.

**`liftedKeys` is complete only up to `armedKeys` completeness** — every computation above (the top-level
`clearedEntry.armedKeys`, the Round-3/4 `liftedKeysForEntry` unions, `armedKeysForEntry`) assumes the
entry object it reads from carries a complete `armedKeys`. A re-pointed `toWrite`/`kept` object landing in two
slots at once (the double-fault branch this card's own "Follow-up 37452ddd" section documents) can lack
`armedKeys` for a key it nonetheless physically occupies — this is FAIL-CLOSED (the key is simply never
treated as "lifted," never wrongly excluded-as-lifted), the same documented residual as `armedKeys`
itself (see "left unfixed (Lead ruling)" above), not a new gap this round introduces.

Verified by hand against all three shapes: Probe B's existing-branch raise (`liftedKeys={Ky,K2}`, `Ky` ∈
set ⇒ excluded, FIXED); the original `4b06875f` twin (no-existing front door, `liftedKeys={Kr}`, `Ks` ∉ set
⇒ carried, unchanged); the `82032b5c`/`c9114934` collision (`clearedEntry.armedKeys=[ky]`, `liftedKeys={ky}`,
occupant's own tautological `resolvedKey=ky` ∈ set ⇒ excluded, unchanged).

**Why the physical-key check is kept too, alongside `liftedKeys`**: it needs no threading at all — it's
computed purely from `final`'s own bytes, so it's a structural lower bound that holds whenever a caller's
own `liftedKeys` is correctly populated (the physical key being read IS, by construction, one of the keys
the operation touches). A FUTURE call site that forgets to thread `liftedKeys` correctly still gets the
single-key collision case caught by this fallback alone.

### The union rule — `unionQuarantineEntries` (`merge-quarantine.ts:612`), SCOPED (Round 3 correction)

**Correction (Round 3, Code Review `a61d0bec`) — this rule is now OPT-IN, never the function's default.**
The text below describes the EXPLICIT rule exactly as Round 2 shipped it, but Round 2's own mistake was
applying it to EVERY caller of `unionQuarantineEntries` (including `armQuarantineKey`, the chokepoint
every boot-time dual-arm AND migrate-consolidation union reaches) — see "Round 3" below for the
reproduced boot fail-open this caused and the scoping fix. `unionQuarantineEntries` takes an optional
third argument, `{ explicitResolvedKeyRule?: boolean }` (`merge-quarantine.ts:612`), defaulting `false`
(the pre-card `{...older}` semantics — `older.resolvedKey`, unconditionally, regardless of `newer`'s own
value). Only the two protect/pending-divert call sites below pass `true`:

```
const resolvedKey = !options?.explicitResolvedKeyRule ? older.resolvedKey
  : older.resolvedKey === newer.resolvedKey ? older.resolvedKey
  : older.resolvedKey === undefined ? newer.resolvedKey
  : newer.resolvedKey === undefined ? older.resolvedKey
  : undefined;
```

With the explicit rule active: equal (including both undefined) ⇒ keep it. One side undefined ⇒ keep the
other, AGE-INDEPENDENT (this is what makes Finding 2's own age-dependence vanish — verified directly:
Probe C's own "older pending file with no resolvedKey" and its "newer pending file with no resolvedKey"
variant now both correctly preserve the carried key, regardless of which side is older). Both set and
genuinely DIFFERENT ⇒ fail closed (`undefined`) — this function has no `liftedKeys` context of its own to
decide which of two conflicting keys is correct, and guessing risks reopening `82032b5c`. "Fail closed"
here means: the merged record's `resolvedKey` is dropped entirely for this one on-disk generation — no
worse than the pre-`4b06875f` baseline **for the two protect/pending-divert call sites this rule is
scoped to** — until a LATER protect call on the same identity re-reads `final` fresh and re-derives it
correctly (every call recomputes from `final`'s own bytes, so this is not a permanent loss). **This "no
worse than baseline" claim does NOT extend to a caller the rule isn't scoped to** — see "Round 3" below
for the case (a boot-time migrate union landing on `armQuarantineKey`) where applying it WOULD have been
strictly worse than the legacy rule it replaced.

The two scoped call sites are `unionIntoOnDiskPendingEntry` (`merge-quarantine.ts:2163`, called from
`reconcilePendingDivertTarget`, which both `mintPendingDivert` and `protectOccupantContentBeforeDelete`
route through) and the `atFilenameIdx` union inside `protectOccupantContentBeforeDelete` itself
(`merge-quarantine.ts:1856`). Every other caller of `unionQuarantineEntries` — `armQuarantineKey`
(`merge-quarantine.ts:677`, reached from every boot-time dual-arm/migrate union via
`armKeyUnlessDegradedCollision`/`armCurrentKeyUnlessDegradedCollision`),
`consumeMatchedPendingsIntoArmedEntry`'s own `matched`/`raiserUnion`/`foreignUnion` unions, and the boot
safety-tmp `sourcesOnlyUnion` helper — passes no options and gets the legacy rule.

**Correction (Round 3) on the reader claim below** — the ORIGINAL text here (Round 2) claimed the reader
fix (`readPendingDivertFileAt` carrying `resolvedKey` back off disk) was necessary for Probe C's own
"one side undefined" case to work. Round-3 Code Review `a61d0bec` found this claim UNVERIFIED: reverting
*only* the reader line left every committed scenario GREEN, because Probe C's own fixture never puts a
real `resolvedKey` on the side the reader would have to recover — its OLDER pending file carries NO
`resolvedKey` at all, so the reader returning "absent" either way changes nothing there. The reader's
OWN discriminating test is `merge-quarantine-raise-protect-failure.mjs`'s `4b06875f` Probe E (added
Round 3) — see "Round 3" below for why Probe E, not Probe C, is the one that actually needs the reader,
and why the pending file there must be written AFTER boot (never before — see Probe E's own comment for
the "two bugs cancel out" trap that shape avoids).

### The post-union filter — re-applying the SAME exclusion to whatever the union produced

Even with `liftedKeys` correctly excluding a key PRE-union, `reconcilePendingDivertTarget`'s own union
against an on-disk sibling, and/or the `atFilenameIdx` union against an in-memory sibling
(`merge-quarantine.ts:1856-1857` — re-grep `const toWriteUnfiltered` rather than trusting this line number
as this file keeps moving), can still PRODUCE a `resolvedKey` that needs the SAME exclusion applied
again — a union's own job is "combine two records," not "respect what a DIFFERENT function already decided
to exclude." `merge-quarantine.ts:1862-1864` re-applies `excludeLiftedResolvedKey` to whatever
`toWriteUnfiltered.resolvedKey` is, before it becomes `toWrite` — the SAME helper, never a second,
independently-written check, so the two can never drift apart.

**Required repro** (manager's own scenario, Probe D — `merge-quarantine-runtime-union-provenance.mjs`,
scenario `4b06875f-post-union-filter-clear-sticks`): S dual-armed `[Ks, Kr]`; D physically at `hash(Kr)`
(S's own SECOND armed key) with `resolvedKey = Ks` (S's own PRIMARY key); D ALSO has a pre-existing, OLDER
pending-divert file already carrying `resolvedKey = Ks` (simulating an earlier, separate, legitimate
carry). R raises at `Kr`, hitting S's `existing` branch — `liftedKeys = {Ks, Kr}` correctly excludes `Ks`
PRE-union (`toPersist.resolvedKey = undefined`). But the union against D's own older pending file (which
already carries `Ks`) would otherwise let it SURVIVE under "one side undefined → keep the other" — WITHOUT
the post-union filter, `Ks` reintroduced; S then clears its own quarantine, reads unblocked in-process, but
is BLOCKED AGAIN after a reboot (`assertRepoNotQuarantined(s).ok === false`) — the clear-sticks invariant
violated. WITH the filter, `Ks` is excluded again post-union, S's clear genuinely sticks across a reboot,
and D's own identity (its own tokens) stays independently enforced throughout via direct identity.

Committed test-only FIRST (`6d4d2e61`), confirmed RED when ONLY the post-union filter is removed (keeping
the `liftedKeys` pre-union exclusion and the union rule intact) — note that reverting ALL of Round 2 at
once does NOT discriminate this probe: the pre-Round-2 reader gap accidentally masks the carry (the SAME
"two bugs cancel out" phenomenon Probe B's own clear-side attempt hit — see that scenario's own comment),
so the meaningful RED proof is the targeted single-line removal, not a blanket revert.

### Two-direction discrimination, repeated against the FINAL code (all three directions)

1. `excludeLiftedResolvedKey` forced to always return its input unchanged (both call sites, pre- and
   post-union, defeated at once via the one shared helper): `clear-by-path-still-proceeds-and-protects`
   went RED on "Y's OWN clear genuinely STICKS" — the two-layer guard is still load-bearing for the
   `82032b5c`/`c9114934` invariant.
2. `excludeLiftedResolvedKey` forced to always return `undefined`: 4 of the `4b06875f` checks went RED
   (the original twin check, the no-second-raise variant, Probe C's own main assertion, and its
   newer-pending-file variant) — reproducing the original bug exactly, confirming the guard is still what
   carries the key forward at all.
3. Post-union filter alone removed (described above under Probe D): RED on Probe D specifically.
All GREEN restored after each. `pnpm --filter @loom/daemon negative-control` against the real (uncommitted)
diff: RED on `HEAD` (pre-Round-2), GREEN after, tree restored byte-identical.

### A unit-level check of the union rule's three cases, and a residual it found

`merge-quarantine-raise-protect-failure.mjs`'s `4b06875f-union-both-diff` scenario (case 3/3, both SET and
DIFFERENT): confirmed the `S`-side key is correctly excluded. Building it ALSO surfaced a separate,
UN-FIXED residual, reported rather than silently dropped: D's own IN-MEMORY pending-divert entry — loaded
by PASS 1 at BOOT, sitting in `pendingUnresolvedQuarantines`, never touched by the current raise at all —
is a SEPARATE copy from the fresh disk re-read `reconcilePendingDivertTarget` uses for the FIRST union. The
`atFilenameIdx` union (`merge-quarantine.ts:1856-1857`) then unions AGAIN against that STALE copy, which
still carries its own ORIGINAL `resolvedKey` (a wholly UNRELATED third-party key — never in this raise's
own `liftedKeys`, never matching `final`'s own physical key either) completely unfiltered — it was loaded
before this raise ever ran, so `excludeLiftedResolvedKey` never touched it. The first union's own correct
"both different ⇒ `undefined`" verdict is then treated by the SECOND union as "nothing to see here, keep my
own value" rather than "already adjudicated, stay dropped," and the unrelated key survives where the
originally-conflicting key correctly does not. The test itself asserts only what is true (the direct
conflict excludes correctly) and documents the residual inline rather than asserting something false.

## Follow-up 4b06875f, Round 3 (Code Review `a61d0bec`) — scoping the explicit union rule away from boot-time arming

Code Review of commit `e36a5974` (Round 2's own landed commit) BLOCKED it on one CRITICAL finding, one
MAJOR (the reader claim corrected above), and one Minor (the `liftedKeys` precision fix folded into "The
corrected discriminator" section above). This section covers the CRITICAL finding and its fix.

**The finding:** Round 2's own explicit `resolvedKey` union rule applied GLOBALLY — every caller of
`unionQuarantineEntries` got it, because the function had no way to opt out. `armQuarantineKey`
(`merge-quarantine.ts:677`) is the chokepoint every boot-time dual-arm AND migrate-consolidation union
reaches (via `armKeyUnlessDegradedCollision`/`armCurrentKeyUnlessDegradedCollision`), and it is a REAL
production path, not a protect/pending-divert edge case. A dual-armed entry's own legacy
`resolvedKey` field (the `883e29bc` self dual-arm shape: a correctly-filed final whose own stored
`resolvedKey` names a SECOND key to arm at) can collide with an UNRELATED `resolvedKey` a boot-time
MIGRATE union stamps onto a different, co-located latch (a stale-key-filed sibling resolving to the
SAME current key) — both set, genuinely different, so the explicit rule's own "fail closed ⇒ undefined"
branch drops the legacy dual-arm's `resolvedKey` entirely. Unlike the protect/pending-divert case this
rule was designed for, there is no LATER re-derivation here: the dropped value gets durably WRITTEN
(the boot migrate-write pass persists whatever `byRepoKey` ends up holding), so the NEXT boot's own self
dual-arm mechanism has nothing left to re-arm the second key with — a REPRODUCED fail-open, in BOTH
age orders (the migrate branch's own `resolvedKey` stamp is always the migrating file's OWN currentKey,
which differs from the legacy field regardless of which side the union calls "older").

**The fix:** `unionQuarantineEntries` takes the `{ explicitResolvedKeyRule?: boolean }` option described
under "The union rule" above. Only `unionIntoOnDiskPendingEntry` and `protectOccupantContentBeforeDelete`'s
own `atFilenameIdx` union pass `true`. Every other caller — `armQuarantineKey`,
`consumeMatchedPendingsIntoArmedEntry`'s `matched`/`raiserUnion`/`foreignUnion` unions, and the boot
safety-tmp `sourcesOnlyUnion` helper — passes no option and gets the legacy `{...older}` semantics (the
bare `older.resolvedKey`, unconditionally). `consumeMatchedPendingsIntoArmedEntry`'s own `matched` and
`raiserUnion` results are UNAFFECTED either way, since both are immediately overwritten with an explicit
`resolvedKey: key` right after the union — only `foreignUnion` lets whatever the union computed flow
through unmodified, which is exactly why it needed to be confirmed on the legacy side.

**Required repro** (`merge-quarantine-runtime-union-provenance.mjs`, scenario
`4b06875f-migrate-union-drops-dual-arm`): Y dual-armed via the legacy stale-`resolvedKey` shape (Y's own
real file at `hash(Ky)`, its own stored `resolvedKey` is `Kw`, mirroring `buildDualArmFixture`) — Y's own
`enteredAt` is deliberately OLDER. A second latch, filed under a STALE key (never Y's own), with
`repoPath` = Y's own subdirectory (so its CURRENT canonical key resolves to `Ky` too), triggers PASS 1's
own migrate branch, which stamps its in-memory `resolvedKey` to `Ky` and falls through to the SAME
primary-arm code as any ordinary file — unioning into Y's already-dual-armed entry at `Ky`. Boot-0 itself
dual-arms `Ky`/`Kw` correctly (the union's resolvedKey LOSS is invisible in-memory: `armedKeys` is set
directly regardless of what the union computes for the `resolvedKey` field) — only a FRESH REBOOT, which
re-reads the now-corrupted `Ky` file from disk, exposes it. Confirmed RED on `e36a5974` (the global rule)
and GREEN after scoping, via `pnpm --filter @loom/daemon negative-control`. The OPPOSITE age order (the
migrating latch older than Y) is a PRE-EXISTING, separately-carded fail-open under the LEGACY rule too
(board card `48bda567`) — deliberately not fixed or asserted by this scenario.

### Do not (Round 3)

- Do not pass `{ explicitResolvedKeyRule: true }` to `unionQuarantineEntries` from `armQuarantineKey`,
  from `consumeMatchedPendingsIntoArmedEntry`'s `foreignUnion`, or from any OTHER caller reached by
  boot-time dual-arm/migrate consolidation — only the two protect/pending-divert call sites named above.
  Confirmed: applying it globally reproduces a boot fail-open (`4b06875f-migrate-union-drops-dual-arm`).
- Do not trust `readPendingDivertFileAt`'s own resolvedKey field being read back correctly merely because
  Probe C stays GREEN — Probe C's own OLDER pending file never carries a real `resolvedKey`, so it cannot
  discriminate the reader at all (see the correction under "The union rule" above). Use Probe E
  (`merge-quarantine-raise-protect-failure.mjs`) for that, and if either probe is ever rewritten, re-check
  which side of its union genuinely needs a disk-read resolvedKey rather than assuming the existing
  "in-memory boot-loaded copy" fallback will carry it regardless.
- Do not write Probe E's own pre-existing pending file BEFORE the first `reenterMergeQuarantinesAtBoot`
  call (the shape every other probe in this file uses for "a prior protect already happened") — PASS 1's
  own untouched boot-time reader would then load it into `pendingUnresolvedQuarantines`, and the
  `atFilenameIdx` in-memory union would rescue `resolvedKey` regardless of whether
  `readPendingDivertFileAt` itself works, defeating the probe's own purpose silently (it would stay GREEN
  under a reverted reader too). Write it AFTER boot instead, so the only route to its own `resolvedKey` is
  the fresh disk read at reconcile time.

## Follow-up 4b06875f, Round 4 (Code Review `be296830` of commit `fd03e317`) — liftedKeysOverride precision, and Probe E's own realism answered

### Minor 1 — the override under-reported an enclosing clear's own already-lifted keys, and the ownership gate was precomputed

Round 3's own first `liftedKeysOverride` draft (landed in `fd03e317`) computed `actuallyLiftedKeys =
(p.entry.armedKeys ?? []).filter((k) => entryStillOwnsKey(k, p.entry))` ONCE, before the per-key loop, and
passed exactly that filtered set as the override. Code Review `be296830` found two problems with this.

1. **Under-reporting.** `clearMergeQuarantineByKey`'s own top-level loop (`:3209` as of this writing)
   deletes every key in `keysToLift` from `activeQuarantines` BEFORE its own matchedPending loop ever runs.
   `entryStillOwnsKey(k, p.entry)` for any `k` ALSO in `keysToLift` therefore reads `false` regardless of
   whether `p.entry` itself ever held that key — the draft's filter silently dropped it from the override,
   so an occupant discovered via the matchedPending loop could wrongly carry forward a `resolvedKey` that
   named one of those keys, even though THIS SAME overall clear operation was lifting it. The fix unions
   the override with whatever the enclosing phase already lifted (`keysToLift` for
   `clearMergeQuarantineByKey`'s own loop; a newly-collected `activeLiftedKeys` — every key the
   matched-active phase lifted — for `clearMergeQuarantineByRecordedPath`'s own separate matchedPending
   loop; nothing additional for `clearTokenFromPendingIndices`, which has no enclosing top-level lift at
   all, see the discriminator section for why).
2. **Precomputed ownership check.** Filtering `armedKeys` ONCE, before the loop, uses a check that's only
   valid for keys as they stood BEFORE any iteration ran — but `deleteMergeQuarantineLatchByKey`'s own
   protect calls (for an earlier key in the SAME loop) can `replaceEntryEverywhere`, changing what a LATER
   key's own `entryStillOwnsKey` check would see. The PER-ITERATION check (iterate the entry's full
   `armedKeys` directly, `continue` when `entryStillOwnsKey` fails that specific key, right there in the
   loop body) was kept throughout as the gate for whether to ACT on a given key — that part of the
   original draft was already correct and untouched by either correction below.

**Correction (second pass, same finding) — the FIRST fix shipped (commit `f6ccb810`) got the override's
own asymmetry BACKWARDS.** That commit made the override the entry's own FULL, unfiltered `armedKeys`
(unioned with the enclosing lift), reasoning that over-inclusion was the "safe, fail-closed direction."
**That is false, and was caught before landing.** `excludeLiftedResolvedKey` EXCLUDES (drops) a
`resolvedKey` that is a MEMBER of `liftedKeys` — dropping a legitimate binding is EXACTLY what unblocks a
repo after a reboot (the ORIGINAL `4b06875f` fail-open this whole card exists to close). So a key named in
`liftedKeys` that this operation does NOT actually, currently touch causes a WRONGFUL drop — **over-
inclusion is the FAIL-OPEN direction**, not fail-closed; round-2 Code Review `a61d0bec`'s own Minor 1
said exactly this ("its legitimate binding is dropped. That is the fail-open direction"). Under-including
a key, conversely, is FAIL-CLOSED (an over-block that round-3 Code Review `be296830`'s own Minor 1 is
about) — the asymmetry runs the OPPOSITE way from `f6ccb810`'s own stated reasoning.

**The corrected set**: `liftedKeys = (keys the ENCLOSING phase already lifted) ∪ (p.entry.armedKeys
FILTERED by entryStillOwnsKey)` — `ownedArmedKeys`, never the whole list. This is the MINIMAL correct set:
every key it names is one this operation can actually prove it is touching (either the enclosing phase's
own unconditional lift, or a key `p.entry` genuinely, currently owns), so `excludeLiftedResolvedKey` never
drops a binding this operation isn't really retiring. `ownedArmedKeys` is computed ONCE, from the SAME
`entryStillOwnsKey` filter, immediately before the loop — a deliberately separate concern from the
per-iteration ACT gate above: if a key's ownership changes mid-loop (an earlier key's own protect call
re-pointing a later key's slot), the snapshot used for the SET can go slightly stale in either direction.
No repro exists for that staleness in EITHER direction, and none was attempted — the tie-breaker is "prefer
fail-closed" (per the same asymmetry established above), not a claim that the snapshot is race-free.

**"ADD one scenario... RED with mutation (g)... GREEN with the fix" — reported, not fabricated.** I spent
a large, deliberate effort attempting to construct a committed repro for this exact shape (a pending `p`,
genuinely a DIFFERENT object from the entity being cleared, whose own `armedKeys` both (a) names a key
already lifted by the enclosing operation at the TOP level and (b) GENUINELY, CURRENTLY owns at least one
OTHER key — the second condition being necessary to trigger an actual protect call at all). Every
construction method available in this module converges to one of three outcomes, never the needed fourth:
- **Merge** — two same-identity entries colliding at a key, where NEITHER is resolvable (or both are),
  always UNIONS via `armQuarantineKey` rather than staying separate (`armKeyUnlessDegradedCollision`'s own
  "different identity" eviction gate never fires for the SAME identity, and its resolvable-vs-unresolvable
  mismatch gate only ever REFUSES, never preserves a stale multi-key claim — see case 3 below).
- **Trim** — a genuine eviction (`armKeyUnlessDegradedCollision`'s own `remainingKeys.length > 0` branch)
  removes the LOST key from the displaced object's `armedKeys` before pushing it to pending, so the
  displaced copy never retains a stale claim on the key it lost — it retains only what it still, genuinely
  owns.
- **Refuse** — a degraded entity whose `resolvedKey` collides with a DIFFERENT, currently-VERIFIED entry's
  key (the `d163aef5` guard) is refused outright and left standalone with `armedKeys` entirely `undefined`
  — never multi-key.
- A degraded-divert SUCCESS arm (the only way to get a genuinely separate, non-merged, non-refused pending
  object with a REAL, non-empty `armedKeys` at all) is always exactly ONE key (`883e29bc`'s own rule: arm
  ONLY at `resolvedKey`, never also at the degraded walked-up current key) — never two, so it can never
  independently satisfy BOTH conditions (a) and (b) above on its own.
I could not find a combination that escapes this triage. **The fix is applied regardless** — it is correct
by code-read (confirmed by the reviewer's own mutation (g)) and the corrected set (`ownedArmedKeys`,
FILTERED, never the whole list — see "Minor 1" below) is the MINIMAL set this operation can actually
prove it touches, so it carries no systematic bias toward either direction, only the narrow, unreproduced
mid-loop staleness already noted. It defends against a shape that may become reachable under a FUTURE
change even if it is not reachable today. If a reachable path exists that this analysis missed, it is a
finding for the next reader, not one I could locate.

### Q1 — Probe E's own realism, answered: the double-fault `kept` branch

Code Review `be296830` also asked whether ANY runtime path leaves a same-identity pending-divert file on
disk with no in-memory record pointing at it (Probe E's own premise). One exists:
`protectOccupantContentBeforeDelete`'s own double-fault branch (`merge-quarantine.ts:1872`, firing when
`writePendingDivertFile(filename, toWrite)` returns `false`) re-points in-memory tracking for this
identity to `sourceFile: finalBasename` (`:1889`/`:1891`), NEVER to `filename` (the deterministic
`pendingDivertFilenameFor` path) — regardless of whether `filename` already held a PRIOR, durably-written
generation for this SAME identity from an EARLIER, successful protect call. If `filename` already existed
on disk before this failure (a real prior write), its bytes are untouched by the failed write (the
attempt never completed), but NOTHING in memory now points at it — the ONLY route back to its own
`resolvedKey` is a FRESH disk read via `readPendingDivertFileAt`, exactly Probe E's own shape. A LATER
(third) protect call for the same identity reaches `reconcilePendingDivertTarget` fresh, computes the SAME
`filename`, and finds `atFilenameIdx < 0` (nothing tracks it) — so the disk read is load-bearing. This
closes the open question from "Probe E realism" above with a named, cited path rather than a soft
disclaimer; Probe E's own comment and this record both now carry it.
- Do not derive a clear-side loop's own `liftedKeys` from `p.entry.armedKeys` wholesale when a prior
  `entryStillOwnsKey` filter has already excluded some of those keys from being lifted THIS operation —
  pass the SAME filtered set as `deleteMergeQuarantineLatchByKey`'s own `liftedKeysOverride` (see "The
  corrected discriminator" above for the three call sites this applies to).

### Accepted residual — card `050a4428` ("fix(git): stop a second union resurrecting an excluded quarantine resolvedKey")

**Ruling: accepted, not designed in this round.** It only arises after a both-different, fail-closed union
has ALREADY run (the "both SET and genuinely DIFFERENT ⇒ `undefined`" case above), and its effect is an
UNRELATED key surviving — which over-blocks a query at the NEXT reboot (fail-closed: queries that key as
blocked when it should read clear), never fail-open (nothing that should stay blocked ever becomes
unblocked by this). **The shape:** a stale IN-MEMORY pending entry for D — loaded by PASS 1 at boot, never
touched by the current raise — reaches the `atFilenameIdx` union still carrying its own original,
unfiltered `resolvedKey`; that union treats the first union's own deliberate `undefined` as "no opinion
yet" rather than "deliberately excluded, do not resurrect," and keeps the stale entry's value instead.
Closing it needs that exact concept — a `resolvedKey` that is DELIBERATELY EXCLUDED must survive a LATER
re-union against a stale copy, not just the one union that excluded it — which is a bigger change than a
scalar-field guard and is why it is carded separately rather than attempted here.

### Stale-target analysis — does carrying `resolvedKey` ever re-block a key WORSE than before, if the real occupant's own quarantine was legitimately cleared in between?

No — confirmed from the code, not merely argued, and UNCHANGED by Round 2 (the analysis is about what
PASS 1 does with a carried key at the NEXT boot, independent of which round's own guard decided to carry
it). The carried `resolvedKey` is consumed by `reenterMergeQuarantinesAtBootImpl`'s degraded-divert branch
(`merge-quarantine.ts:4426-4439` as of Round 1; re-verify the current line range if this file has moved
again by the time you read this — the mechanism, `armKeyUnlessDegradedCollision`, is what to grep for),
which already fails CLOSED, never worse, in both directions a legitimate intervening clear can leave it in:
- If the carried key is now UNOCCUPIED (nothing currently armed there): the degraded entry arms it
  unopposed — the SAME over-blocking behavior the original (pre-raise) latch already produced at every
  prior boot; this card's fix restores that pre-existing, accepted trade-off of the `883e29bc` mechanism
  across a raise, it does not introduce a new one.
- If the carried key is now occupied by a DIFFERENT, currently-VERIFIED entry (e.g. the real repo
  genuinely re-raised its own fresh quarantine since): `armKeyUnlessDegradedCollision` returns `undefined`
  (the `d163aef5` guard) and the degraded claim is refused outright, left as a standalone pending entry —
  the verified occupant is never touched, unioned, or overwritten.
Either way this is IDENTICAL to what the SAME `resolvedKey` field, consumed by the SAME code, already did
at any boot before the raise — this fix adds no new risk, it only stops the raise from silently disabling
an already-existing, already fail-closed mechanism.

### Field survival, both protect branches, corrected for Round 2 (reader → union → post-union filter → write → boot read)

- **Success path:** `occupantResolvedKey` → `excludeLiftedResolvedKey` (pre-union, `:1822`) → `toPersist.resolvedKey`
  → `diskReconciled.toWrite` (`reconcilePendingDivertTarget` — unchanged on the ENOENT fast path;
  `unionQuarantineEntries`'s own EXPLICIT rule otherwise, SCOPED since Round 3 to this call site via
  `{ explicitResolvedKeyRule: true }` — not the old implicit spread, and not the function's default) →
  `toWriteUnfiltered` (possibly ALSO unioned again, with the SAME explicit option, against the
  `atFilenameIdx` in-memory entry) → `excludeLiftedResolvedKey` AGAIN (post-union) → `toWrite` →
  `writePendingDivertFile`, which strips ONLY `armedKeys` before `JSON.stringify` — `resolvedKey` survives
  serialization intact. (Re-grep `const toWriteUnfiltered`/`const toWrite: MergeQuarantineEntry`/
  `writePendingDivertFile` rather than trusting line numbers here — this file keeps moving.)
- **Double-fault `kept` path:** `kept = { ...toWrite, orphanLatchFiles: [...] }` (re-grep `const kept:
  MergeQuarantineEntry` rather than trusting a line number copied here — stale twice already) spreads the
  ALREADY-POST-UNION-FILTERED `toWrite`, so `kept.resolvedKey` is inherited correctly with no further code
  needed — this is WHY the post-union filter runs before `kept` is built, not after.
- **Boot reader:** PASS 1's primary per-file read loop — `resolvedKey: typeof parsed.resolvedKey === "string"
  ? parsed.resolvedKey : undefined` (3 occurrences in this file as of Round 2: PASS 1 proper, PASS 1b's tmp
  reader, and the safety-tmp recovery reader — grep for this exact literal rather than trusting a single
  line number) is the line that actually consumes it back into memory, feeding the
  `!resolvableNow && !entry.resolvedKey` check and on into the degraded-divert arm-at-resolvedKey branch.

### Tests

`merge-quarantine-raise-protect-failure.mjs`: Round 1's own `37452ddd-twin-repoint-finalbasename` extension
and `4b06875f-no-second-raise` fixture (both still present, now GREEN under the Round-2/3 guard too), plus
Probe C with its no-raise control and newer-pending-file variant (Finding 2's own repro), the union-rule
unit check (case 3/3) described above, and (Round 3) Probe E — the reader's own discriminating test, added
after Round 3's Code Review found Probe C insufficient for that (see the correction under "The union
rule" above). `merge-quarantine-runtime-union-provenance.mjs`: Probe B (Finding 1's own repro), Probe D
(the post-union filter's own repro, the manager's exact Round-2 scenario), and (Round 3)
`4b06875f-migrate-union-drops-dual-arm` (the CRITICAL finding's own boot-union repro). All 34
`merge-quarantine*.mjs` files re-verified individually, each exit 0. `pnpm --filter @loom/daemon
build:native` re-verified. All static guards (`pnpm --filter @loom/daemon guards`) re-verified green.

### Do not

- Do not drop EITHER half of `excludeLiftedResolvedKey`'s own exclusion (the `liftedKeys` membership check
  OR the physical-key-equality fallback) — Finding 1 is what the `liftedKeys` half closes (a sibling armed
  key, never visible to the physical-key check alone); the `82032b5c`/`c9114934` collision shape is what
  the physical-key fallback closes unconditionally, independent of whether a caller threads `liftedKeys`
  correctly. Confirmed directly: disabling the shared helper entirely reopens the collision regression;
  forcing it to always return `undefined` reopens the original fail-open.
- Do not apply `excludeLiftedResolvedKey` ONLY pre-union — Finding 2/the post-union filter exists because a
  union (against an on-disk OR in-memory sibling) can reintroduce a key the pre-union call already
  excluded; apply it again to whatever the union actually produced, via the SAME helper, never a
  second, independently-written check.
- Do not carry forward a REPLACED IN-MEMORY OBJECT's own `resolvedKey` directly (uncritically, with no
  exclusion at all) instead of the occupant's own `parsed.resolvedKey` read off `final`'s bytes — that is
  the ALREADY-REJECTED Round-1 variant, and it fails for a different reason (the replaced object can belong
  to a different identity than what `parsed` actually says). **Correction (Finding 4):** this does NOT mean
  a replaced in-memory object's own `resolvedKey` can never reach `toWrite` at all — `toWrite` is exactly
  `unionQuarantineEntries(diskReconciled.toWrite, pendingUnresolvedQuarantines[atFilenameIdx]!.entry, {
  explicitResolvedKeyRule: true })` when `atFilenameIdx >= 0`, and that SECOND operand IS an in-memory
  entry; its own `resolvedKey` legitimately flows into the union (and is then subject to the SAME
  post-union filter, same as every other source). What stays forbidden is using that in-memory object's
  field as the PRIMARY, unguarded source the way the rejected Round-1 variant did — never bypassing
  `excludeLiftedResolvedKey` for it.
- Do not extend this same guarded carry-forward to `armedKeys` — that field is a SEPARATE question (purely
  in-memory bookkeeping, never persisted) with its own, independent fail-closed/fail-open analysis in the
  ACCEPTED RESIDUAL section above; conflating the two risks treating a lower-priority, already-safe gap as
  though it shared this one's urgency or fix shape.
- Do not trust the union-rule's "one side undefined ⇒ keep the other" case as proof against EVERY possible
  re-union — see "Accepted residual — card `050a4428`" above: a STALE, never-filtered in-memory copy can
  still reintroduce a wholly unrelated key via a SECOND union the first union's own correct "both
  different" verdict never anticipated. ACCEPTED (fail-closed, over-blocks only), tracked on `050a4428`,
  not attempted here.
- **(Round 3)** Do not apply the explicit `resolvedKey` union rule to any caller outside the two scoped
  protect/pending-divert sites — see "Round 3" above and its own "Do not" list for the reproduced boot
  fail-open this causes and the full list of callers that must keep the legacy rule.

## Follow-up 48bda567 — the OPPOSITE age order of "4b06875f-migrate-union-drops-dual-arm", fixed inside `armQuarantineKey` itself

Card `48bda567`, filed from Round 3's own deliberate exclusion above ("The OPPOSITE age order ... is a
PRE-EXISTING, separately-carded fail-open under the LEGACY rule too"). This is a defect in the plain
`{...older}` LEGACY rule itself — it predates `4b06875f` entirely and is NOT caused by Round 3's own
explicit-rule scoping fix.

**The shape:** `armQuarantineKey`'s legacy union takes `older.resolvedKey` unconditionally, with no
regard for WHAT that value means. PASS 1's migrate branch stamps a migrating latch's own `resolvedKey` to
its freshly-computed `currentKey` — a SELF-REFERENTIAL, uninformative value (it just means "no second arm
needed"). When that migrating latch happens to be OLDER than a real dual-arm entry sharing its key, the
legacy rule picks the self-referential value, discarding the dual-arm's own genuine secondary key
outright — even though `armedKeys` itself is still correctly dual-armed in memory THIS boot (the
in-memory arm set was never the broken part). The migrate-write pass then durably persists exactly this
union, so the next boot reads a self-referential `resolvedKey` and never re-arms the lost secondary key —
W (the repo the lost key would have blocked) reads fully unblocked. Measured directly against the real
compiled module (card `48bda567`'s own worker report): at boot-0, BEFORE any reboot, the refusal text
ALSO already stops naming the lost key's own repo, for the identical reason (nothing informative left to
report) — this is not merely a post-reboot symptom.

**The fix:** a small, scoped correction inside `armQuarantineKey` itself (`merge-quarantine.ts`, right
after computing the union, before folding `key` into `armedKeys`): if the union's own `resolvedKey` equals
`key` (self-referential) AND exactly one of `prior.resolvedKey` / `entry.resolvedKey` is defined and
`!== key` (genuinely informative), take that informative one instead. Otherwise the legacy result is left
completely untouched. `armQuarantineKey` has exactly ONE caller in this whole file —
`armKeyUnlessDegradedCollision` — so this reaches precisely "every boot-time dual-arm/migrate union" and
nothing else, mirroring Round 3's own scoping discipline in the opposite direction (Round 3 scoped the
explicit rule AWAY from this chokepoint; this fix is scoped TO it and nowhere else).

### Options weighed (see the card's own body for the full write-up)

- **(a) — SHIPPED.** Preserve the secondary arm's own informative `resolvedKey`, age-independent, inside
  `armQuarantineKey`. Minimal: uses the existing scalar field, touches one call site, no persisted-format
  change.
- **(b) — rejected.** Persist the arm set (`armedKeys`) itself instead of relying on a single scalar
  `resolvedKey` to reconstruct it each boot. `armedKeys` is DELIBERATELY never persisted today
  (`merge-quarantine.ts`'s own comment at the strip-before-write site: "A restart rebuilds it fresh via
  arming, and a stale persisted value from a PRIOR process's keying would be actively misleading to a
  human reading the raw file"). Reversing that would duplicate card `398f476c`'s own identity-model
  redesign scope (that card's body names exactly this kind of change as "a structural rearchitecture ...
  not a scoped bugfix"). Out of proportion for this card.
- **(c)** — nothing better identified; (a) is minimal and provably scoped to exactly the chokepoint this
  bug lives in.

### Effect on named invariants (verified, not merely argued)

- **`82032b5c`/`c9114934`** (a protective copy never resurrects a resolved collision's losing side;
  `clear-by-path-still-proceeds-and-protects` must stay green): orthogonal. `enterMergeQuarantine`'s own
  `existing` branch (the runtime-union mechanism these cards govern) never calls `armQuarantineKey` or
  `unionQuarantineEntries` at all — it hand-builds its own union object directly. Re-ran
  `clear-by-path-still-proceeds-and-protects` and `d2582692-clearing-union-winner-keeps-loser-pending`
  after the fix: both still green.
- **`4b06875f`'s probes B/C/D/E and both age-order variants**: Probes B and D each build their dual-arm
  fixture via a SINGLE file booted alone (`buildDualArmFixture`) — `prior` is `undefined` at that arm, so
  the correction's own guard (gated on a real `prior ? union : entry`) never engages; no union happens
  there at all. Probe E is about the on-disk reader for the (unrelated) explicit-rule call sites. The
  original A-older scenario is a NO-OP under the fix (its own `older.resolvedKey` was already informative,
  `!== key`, so the correction's outer guard never fires) — proven via `negative-control` with ONLY
  `merge-quarantine.ts` reverted: the A-older scenario's own CRITICAL check passes in BOTH the reverted
  (correction absent) and restored (correction present) phases.
- **`d2582692`**: its own mechanism (the safety-tmp recovery pass, `sourcesOnlyUnion`) calls
  `unionQuarantineEntries` directly, bypassing `armQuarantineKey` entirely (that card's own record says so
  explicitly: "instead of a direct `armQuarantineKey` union"). Unreachable from a correction scoped inside
  `armQuarantineKey`.
- **`d163aef5` boot guard** (`armKeyUnlessDegradedCollision`): untouched. The correction sits strictly
  downstream of whatever eviction/collision decision that guard already made — it only ever adjusts the
  `resolvedKey` FIELD of a union the guard already decided was legitimate (same-tier, no eviction); it
  never changes whether an eviction happens or who wins a collision. **Corrected (CR `31ba43b4`):** a
  "same-tier, no eviction" union reached this way is not limited to the migrate-vs-real-dual-arm shape
  this card repros — PASS 1b's own tmp-residue handling can ALSO reach it with two independently
  informative, genuinely different `resolvedKey` values on either side (a `.json` + `.tmp` pair, or two
  tmps, sharing one hash), which d163aef5's guard correctly treats as a legitimate union (both sides
  equally resolvable) rather than an eviction. See the "Do not" bullet below for why this correction stays
  safe there, and card `1e739f4a` for the separate, later masking bug this does NOT fix.

### Overlap

- **`398f476c`** (identity-model redesign): related in spirit (a union losing information about a second
  identity) but far narrower in scope — uses the existing scalar `resolvedKey` field, touches one
  chokepoint, no persisted-format change. The SAME legacy `{...older}` rule also carries
  `repoPath`/`branch`/`reason`/`enteredAt` from the older side — in the B-older order, the union's own
  `repoPath` becomes the migrating latch's own path (e.g. a subdirectory of the real repo) rather than the
  real repo's own path, even at boot-0 before any reboot. That is the exact "a union object can only
  represent one identity's own repoPath at a time" shape `398f476c` already owns. This card's fix does
  NOT touch it, and the new B-older test scenario deliberately does not assert on `repoPath` — only on the
  dual-arm's own `armedKeys`/object identity, which is what this card's own bug actually breaks.
- **`050a4428`**: different call sites entirely (the explicit-rule protect/pending-divert sites' SECOND
  union against a stale in-memory pending copy, never `armQuarantineKey`). No sequencing dependency either
  direction.
- `consumeMatchedPendingsIntoArmedEntry`'s own `foreignUnion` (card `48bda567`'s own body names this) is
  the SAME bug CLASS at a different (runtime, not boot) call site — unreproduced, left out of scope here.

### Do not

- Do not widen this correction beyond `armQuarantineKey`'s own single call site — never a second
  `unionQuarantineEntries` option flag for it (that function already carries one, `explicitResolvedKeyRule`,
  scoped to the two protect/pending-divert sites per Round 3 above; a second flag for a THIRD rule read by
  a THIRD caller set is harder to reason about than arbitration living at the one caller that needs it).
- Do not persist `armedKeys` to fix this instead — see "Options weighed" above; that reverses a deliberate
  existing design decision and duplicates `398f476c`'s own larger scope.
- Do not read the `repoPath`/`branch`/`reason`/`enteredAt` older-side-wins behavior as a defect this card
  fixes or as something still open here — it is `398f476c`'s own documented scope; this card's fix is
  scoped to `resolvedKey` only.
- Do not trust a `repoPath === <expected>` assertion on a B-older (or any age-dependent) dual-arm union
  fixture — assert on `armedKeys` / object identity instead (see the B-older scenario's own comment for
  why the first drafted assertion here was wrong, and failed for a reason unrelated to this card's actual
  bug).
- **CORRECTED (CR `31ba43b4`)** — do NOT read the "both sides genuinely informative and different" shape
  as structurally unreachable. It IS reachable through a real call site: a secondary-arm caller passes
  the PRIMARY arm's own RESULT as `entry`, not the raw parsed entry (`armKeyUnlessDegradedCollision`'s
  `key` argument is the raw entry's own `resolvedKey` field, but its `entry` argument is the primary arm's
  RESULT — if that primary arm itself unioned with an older `prior`, the result's own `resolvedKey` can
  already differ from the raw field used as `key`); separately, PASS 1b primary-arms every tmp residue at
  its own `currentKey`, so a `.json` + `.tmp` pair (or two tmps, per `92c645cc`) sharing one hash can
  collide there with two independently-informative keys. Card `1e739f4a` owns fixing the actual outcome —
  TODAY a later, unconditional tmp-promotion self-stamp masks it. This correction is SAFE there regardless:
  its own outer guard (`merged.resolvedKey === key`) is false whenever both sides are genuinely different
  and informative (the plain legacy result can never equal `key` in that case), so the correction simply
  never fires — see `armQuarantineKeyTestOnly`'s own doc comment and the
  `48bda567-no-fire-both-sides-informative-and-different` scenario, which is a REGRESSION PIN on that
  outer guard (it passes with the correction removed, and with the guard itself deleted too), never
  discrimination evidence that the shape can't occur.

### Tests

`merge-quarantine-runtime-union-provenance.mjs`: `48bda567-migrate-union-drops-dual-arm-b-older` (RED on
the legacy rule, GREEN after the fix — negative-control proven, byte-identical tree restore),
`48bda567-no-fire-both-sides-informative-and-different` (unit-level, via the test-only
`armQuarantineKeyTestOnly` export — a REGRESSION PIN proving the correction's own outer guard stays false,
and the result is deep-equal to the plain legacy union, when both sides are genuinely different and
informative; it is NOT evidence the shape is unreachable — see the "Do not" bullet above). The original
`4b06875f-migrate-union-drops-dual-arm` (A-older) scenario stays green with the correction present AND
absent (negative-control, same run). All 34 `merge-quarantine*.mjs` files and `guards` re-run clean.

## Follow-up 1e739f4a — the promote-site self-stamp (Fix 1, SHIPPED); a divert attempt at the PASS 1b
primary-arm collision (Round 1, REVERTED after Code Review)

From CR `31ba43b4` of card `48bda567` round 3 — its own "Do not" bullet named TWO further findings:
PASS 1b's own tmp-PROMOTION write durably loses a dual-arm's secondary key, and the "both sides
informative and different" union shape — reachable at PASS 1b's own PRIMARY arm, not just the
secondary-arm site `48bda567-no-fire-both-sides-informative-and-different` regression-pins — was
genuinely reachable but masked by the first bug. Both REPRODUCED first (merge-quarantine.ts, before any
fix): `one-tmp`/`two-tmps`/`json-plus-tmp`/`json-plus-tmp-subpath` in the new
`merge-quarantine-tmp-promotion-dual-arm.mjs`, all RED on main (`42ae41c`) except the `one-json-control`
negative control.

### Fix 1, SHIPPED — PHASE 2's own promote-site self-stamp (merge-quarantine.ts, PHASE 2, search
`isInformativeKey`)

`const armedForWrite: MergeQuarantineEntry = { ...unionEntry, resolvedKey: key };` unconditionally
overwrote `unionEntry.resolvedKey` with the promote key, regardless of whether `unionEntry.resolvedKey`
already carried a genuinely informative secondary key — PASS 1b's own primary+secondary arm sequence
(immediately above PHASE 2 in the read loop) correctly dual-arms BOTH keys in memory THIS boot, but the
promoted `.json` final's own persisted `resolvedKey` field can only ever carry one value, and this stamp
threw away whichever one it already had in favor of the self-referential promote key — even when nothing
about the entry was ever wrong (e.g. an unrelated, harmless stale tmp sharing a hash with an already-
correct `.json` final, `json-plus-tmp`).

**Origin, traced via `git log -S`:** commit `a1401880` (card `92c645cc` round 2). That card's own
decision record (`docs/decisions/92c645cc-fresh-tmp-name-and-conditional-sweep.md`, "PASS 1b's one-boot
dual-arm vs PASS 1's immediate single-arm") argued the loss was harmless ("the only thing a stale key's
continued presence ever enabled was a human `/clear-by-path {id}` convenience... nothing is ever LESS
enforced either way") — true only when the lost key is a disposable self-migration marker, false when it
is a genuine cross-repo dual-arm (the exact load-bearing shape `4b06875f`/`48bda567` established). That
round never considered the latter because, at the time, nothing dual-armed a tmp sharing a key with a
pre-existing `.json` final the way this card's fixtures do. Corrective cross-reference added to that
record (see below).

**The fix (SHIPPED):** a shared `isInformativeKey(entry, key)` helper (defined once, used by
`armQuarantineKey`'s own `48bda567` correction, this promote-site write, and the log-only check below, so
all three can never again drift on what "informative" means) — only stamp `resolvedKey: key` when
`unionEntry.resolvedKey` is NOT already informative (undefined, or already equals `key`); when it IS
informative, keep it untouched.

**Reviewer's own note on this fix's shape (CR `cd9b1e3e`):** `unionEntry.resolvedKey` can, in principle,
be preserved even when it is a DISPOSABLE self-migration marker left over from some earlier state rather
than a genuine cross-repo dual-arm — Fix 1 cannot and does not distinguish the two (nothing in the
in-memory object marks WHICH kind a given informative key is). The failure direction this produces is
OVER-block, never under-block: at worst a key stays armed slightly longer than strictly necessary, and a
human `/clear-by-path` on it still lifts it correctly — this is the same direction, and the same
remediation, `92c645cc`'s own accepted PASS-1-vs-PASS-1b asymmetry already lives with. Not a regression
this fix introduces; a pre-existing shape of the scalar-`resolvedKey` design this fix does not change.

### Round 1 (REVERTED after Code Review `cd9b1e3e`) — PASS 1b's own primary-arm union can silently drop
a genuinely different, equally informative secondary key

With Fix 1 alone, a SECOND, independent loss remained: when a second tmp's raw entry collides, at
`armCurrentKeyUnlessDegradedCollision`'s own PRIMARY arm, with an already-armed result where BOTH sides'
own `resolvedKey` are genuinely informative and DIFFERENT (`two-tmps`: tmp #1 armed at K1, tmp #2's own
raw entry carries K2) — `unionQuarantineEntries`'s plain legacy `{...older}` rule keeps exactly ONE
side's `resolvedKey` (by age) and has no representation for the other at all. `armedKeys` stays
correctly triple-armed `[Ky, K1, K2]` in memory THIS boot (the in-memory arm set was never the broken
part, same as `48bda567`'s own finding), but only one of K1/K2 can ever survive in the scalar
`resolvedKey` field written to disk.

**First ruling (since REVISED — see below):** the Lead initially ruled this should be FIXED here rather
than deferred to `398f476c` (whose own identity-model redesign covers the scalar `resolvedKey`'s
inability to represent two identities PASSIVELY, not actively DROPPING an arm this boot's own processing
already knows is enforced) — a divert was implemented: keep the legacy rule's winner untouched; push the
LOSING side's key into `pendingUnresolvedQuarantines`, protecting whichever tmp file physically carries
it from this key's own unlink step, so a future boot re-reads that surviving tmp and re-derives the SAME
divert. Verified GREEN at the time against the card's own test matrix (`two-tmps` closing fully, both
witnesses blocked across two reboots, idempotent).

**Code Review `cd9b1e3e` found this UNSOUND and the Lead REVISED the ruling — three findings, none
caught by the card's own matrix because none of them are reachable FROM it in isolation:**
- **CRITICAL 1** — any `activeMergeQuarantineFor(Y)` query or raise on Y after the divert absorbs the
  diverted pending entry as a cross-tier sibling. `consumeMatchedPendingsIntoArmedEntry` (`~:1301`)
  carries its OWN FOURTH unconditional `resolvedKey: key` self-stamp and unlinks the protected tmp — so a
  query or raise between boots (not exercised by `two-tmps`, which never queries/raises between boots)
  unblocks BOTH W1 and W2 after the next reboot, worse than Fix 1 alone (which at least keeps W1).
- **CRITICAL 2** — with Y REGISTERED (the normal production case; `two-tmps` deliberately stays
  unregistered to reach the full parse path — see the file header), PASS 1b's own early-delete gate
  (`~:4677`, gated on `cleanlyParsedKeys`) unlinks the protected tmp UNREAD on the very next boot, once
  the promoted `.json` final itself parses cleanly — so W2 is unblocked after exactly one reboot, the
  divert never even getting a chance to re-derive itself.
- **MAJOR 3** — the divert's own identity gate silently dropped a DIFFERENT-identity collision (Y vs
  Y's own subdirectory) with no log at all — worse than simply accepting the residual, which at least
  would have been visible.

Making the divert durable needs a REAL multi-arm representation (tracking identity over token/key SETS,
not one scalar `resolvedKey`/`armedKeys` pair) — `398f476c`-scale, not a scoped bugfix for this card.

### Round 2, SHIPPED — the divert removed; the residual logged instead, never silently

**Revised ruling:** remove the Round 1 divert entirely. At the PASS 1b collision (search
`isInformativeKey(priorAtCurrentKey`), when both resolvedKeys are informative and DIFFERENT (ANY
identity, same or different — Round 1's own identity gate, MAJOR 3 above, is also removed), do not
attempt recovery at all. Emit ONE `console.error` naming the dropped key, both source files (the current
tmp, and — via a best-effort reverse lookup through `originalEntryBySource`, or the `.json` final's own
basename when the losing side isn't traceable to a surviving tmp — the other side), and pointing at card
`43cf3b26`, so the residual is visible and never silent, on every boot it recurs.

### ACCEPTED RESIDUALS, both owned by card `43cf3b26` (not fixed by 1e739f4a; reported, never silently
widened)

1. **Two informative, DIFFERENT keys colliding at PASS 1b's own primary arm (same OR different
   identity)** — the loser is dropped from the persisted `resolvedKey` field and loudly logged (never
   silent); `armedKeys` still correctly represents it in memory for the boot that saw the collision, but
   nothing persists that past a reboot. Pinned as a REGRESSION PIN (not a bug report) by the `two-tmps`
   scenario below: W1 (the kept key) stays blocked across two reboots; W2 (the dropped key) is UNBLOCKED
   after the first reboot and stays that way — asserting that IS pinning the residual's real, current
   behaviour, not a regression in the test.
2. **A `.json` FINAL losing the union** (Round 1's own identified sub-case) — there is no existing file a
   future fix could safely reuse without first solving (1)'s own identity-model gap anyway, since both
   residuals are the SAME root cause (a scalar `resolvedKey` cannot represent two identities) surfacing at
   slightly different call shapes.

### Overlap

- **`398f476c`** (identity-model redesign): both residuals above are, in spirit, `398f476c`'s own
  eventual territory — a real fix needs identity tracked over token/key SETS, not a scalar. `43cf3b26` is
  the card that owns actually doing that work (or deciding it's `398f476c` itself); this record only
  documents the two residuals, not a plan to close them.
- **`48bda567`**: Fix 1 is the SAME bug class (a self-referential stamp masking a genuine dual-arm) at a
  DIFFERENT call site (promote vs. `armQuarantineKey`'s own union), fixed the same way, now sharing
  `isInformativeKey` with it. The residuals above are the SAME union shape `48bda567`'s own "Do not"
  bullet named as reachable-but-masked at this file's PRIMARY arm, as opposed to the regression-pinned
  secondary-arm shape that bullet itself pins.
- **`92c645cc`**: its own decision record's "the loss is harmless" reasoning is corrected below — never
  read that record's own section as still endorsing an unconditional self-stamp for a genuine dual-arm.

### Do not

- Do not widen Fix 1 beyond the ONE promote-site write — it already mirrors `armQuarantineKey`'s own
  `48bda567` correction via the shared `isInformativeKey` helper; a THIRD near-identical arbitration site
  (PASS 1's own `.json` migrate branch, `~L4516`, `entry.resolvedKey = currentKey`) has the SAME
  unconditional-overwrite SHAPE but was explicitly left untouched — flagged, not reproduced, filed as a
  separate card by the Lead. Do not fold it into this card's own fix without a fresh repro and ruling.
- Do not re-attempt a divert at the PASS 1b collision without first closing `398f476c`'s own
  identity-model gap — Round 1 above is the record of exactly why a narrower attempt is unsound: it is
  reachable by a query, a raise, or simply registering the repo, none of which the fixing card's own
  narrow test matrix happened to exercise. A new attempt needs to independently prove it survives ALL
  THREE of those before it can be trusted, not just the matrix that originally motivated it.
- Do not touch `consumeMatchedPendingsIntoArmedEntry`'s own FOURTH self-stamp (`~:1301`, CRITICAL 1 above)
  from this card — it is not reachable without a divert in this card's own fixtures, and is carded
  separately (card `43cf3b26`) rather than folded in here.
- Do not read either ACCEPTED RESIDUAL above as fixed, or as something this card's own test matrix closes
  — it does not, by design; `two-tmps` is a REGRESSION PIN on the residual's current behaviour, not a
  claim that behaviour is correct. Re-open via card `43cf3b26`.
- Do not trust `armedKeys` alone as proof of reboot survival — `two-tmps`'s own precondition check shows
  `armedKeys` was ALREADY correct in memory on the very commit this card reproduces as RED; Fix 1's own
  bug was never in-memory enforcement, only PERSISTENCE.

### Tests

`merge-quarantine-tmp-promotion-dual-arm.mjs` (7 scenarios): `one-json-control` (negative control, never
reaches PHASE 2), `one-tmp` and `registered-y` (Fix 1, unregistered and registered respectively — both
closed), `raise-y-after-boot0` (Fix 1's own kept key survives a genuine runtime raise + reboot, not just
a plain reboot), `json-plus-tmp`/`json-plus-tmp-subpath` (Fix 1, an unrelated harmless tmp never destroys
an already-correct final), and `two-tmps` (the REGRESSION PIN described above — asserts the
`console.error` fires naming the dropped key and card `43cf3b26`, asserts W1 survives two reboots, asserts
W2 stays unblocked after both, asserts the on-disk file set never grows/duplicates across either reboot).
All scenarios RED on main (`42ae41c`) before Fix 1, GREEN after, negative-control proven (reverted Fix 1
in the compiled `dist/git/merge-quarantine.js` directly — a byte-copy aside before mutating, `cmp`-verified
restore after — rather than rebuilding from a reverted `.ts`, so the control exercises exactly the shipped
artifact); every scenario re-confirmed RED again under that reversion. Every scenario in
`merge-quarantine-runtime-union-provenance.mjs` (including `48bda567-migrate-union-drops-dual-arm-b-older`,
`48bda567-no-fire-both-sides-informative-and-different`, `4b06875f-migrate-union-drops-dual-arm`,
`clear-by-path-still-proceeds-and-protects`, and every `4b06875f` probe B/D scenario) and
`merge-quarantine-raise-protect-failure.mjs` (probes C/E) stay green.
`d2582692-clearing-union-winner-keeps-loser-pending` (`merge-quarantine-pass1-degraded-union-guard.mjs`)
stays green. All 35 `merge-quarantine*.mjs` files, every OTHER test importing `merge-quarantine.js`
(batch-merge/vault-commit/kill-confirm/quarantine-admission families), and `pnpm --filter @loom/daemon
guards` (30/30) re-run clean — under both `LOOM_DEV` unset and `LOOM_DEV=1`.

## Follow-up 43cf3b26 — persisted, plural `resolvedKeys`, generalizing Fix 1/48bda567 from one surviving secondary key to N

Card `43cf3b26` (widened by gen 417 after this card's own Code Review `cd9b1e3e`). Owns both ACCEPTED
RESIDUALS this record's own "Follow-up 1e739f4a" section documented, plus a FOURTH, independently
reproduced shape never covered by either residual: `consumeMatchedPendingsIntoArmedEntry`'s own
unconditional `resolvedKey: key` self-stamp (`~:1366` pre-fix) silently (no console output anywhere in
the call path, unlike every other collision in this file) discards an already-informative `resolvedKey`
the moment a RESOLVABLE pending entry graduates via a PLAIN QUERY — reachable without 1e739f4a's own
Round-1 divert (removed) ever existing, via the ordinary d163aef5 pending-diversion path alone. Both
residuals and the new silent shape were reproduced hermetically (`merge-quarantine-dual-key-persistence-
43cf3b26.mjs`, scenarios `same-identity-two-tmps`/`different-identity-subpath`/`json-final-loses-to-tmp`/
`pending-consume-no-loss`) before any source edit, per the card's own INVESTIGATE-FIRST instruction.

### The design — widen the existing single-key mechanism, not a new one

`armQuarantineKey` (48bda567) and the PASS 1b promote site (1e739f4a's own Fix 1) already proved out a
safe pattern for preserving exactly ONE secondary key across a boot: never self-stamp an already-
informative scalar `resolvedKey`. The gap was never in-process enforcement (`armedKeys` was already
correct in memory every boot, per this record's own prior "Do not trust armedKeys alone" bullets) — it
was that a scalar field can represent only one secondary identity, so a SECOND one colliding at the same
physical file had nothing to survive in. Rejected alternatives: (a) persist `armedKeys` wholesale,
unconditionally trusted on reboot — reopens the exact "stale persisted value actively misleading" hazard
48bda567's own "Options weighed" flagged, since a key that merely fails to re-arm one boot is not proof it
is permanently invalid; (b) one sidecar file per secondary key — a parallel bookkeeping system (new
naming/scan/orphan-sweep/collision-class) that reuses none of the already-proven `armedKeys` union/clear
machinery; (c) `398f476c`'s own full identity-model redesign (token/key-SET identity, N objects per
union) — correct in the limit but far larger than closing a reboot-persistence gap requires; this fix
never touches the one-union-object-per-key in-memory model `398f476c` owns.

### The fix

A new PERSISTED field, `MergeQuarantineEntry.resolvedKeys?: string[]` — the historical, deduped,
recency-ordered union of every key a logical entry has been armed at, capped at `RESOLVED_KEYS_CAP` (16,
Lead ruling). The legacy scalar `resolvedKey` is UNCHANGED in shape and stays the backward-compat surface
(always one informative key when any exist).

- `unionResolvedKeysRetaining(existing, fresh, label)` (merge-quarantine.ts, next to `isInformativeKey`)
  — the one retention/cap primitive. Moves a re-confirmed key to the end (most-recently-armed); evicts
  from the front past the cap with a loud `console.error` naming the record, the evicted key(s), and this
  card — never silent. A key is removed for NO other reason: no verification in this file proves a key
  that merely fails to re-arm one boot is permanently invalid, so the retention formula is a pure UNION,
  never a fresh recompute that could drop a legitimately-still-valid key that simply wasn't re-armed THIS
  boot.
- `unionQuarantineEntries` folds EACH side's own scalar `resolvedKey` into the result's `resolvedKeys`
  (in addition to unioning any pre-existing arrays) — independent of `explicitResolvedKeyRule`, since this
  is purely additive/historical, never an arbitration concern.
- `consumeMatchedPendingsIntoArmedEntry`'s self-stamp now mirrors `isInformativeKey`'s own guard (never
  overwrite an already-informative scalar) AND folds `unioned.resolvedKey` into `resolvedKeys` directly —
  the single-matched-entry case (case iv's own fixture) never calls `unionQuarantineEntries` at all, so
  this fold is REQUIRED here independently of the union-side fix above. The sibling `raiserUnion` self-
  stamp (the divert branch, still reachable for a genuinely-unreadable degraded occupant) gets the SAME
  `isInformativeKey` guard.
- THE retention formula lives at the ONE write chokepoint, `writeMergeQuarantineLatch`: persist
  `unionResolvedKeysRetaining(entry.resolvedKeys, (entry.armedKeys ?? []).filter(k => k !== ownKey))` —
  the union of whatever was already carried forward with every OTHER key this write's own `armedKeys`
  holds right now, minus the write's own physical target. The scalar `resolvedKey` is re-derived at the
  SAME site: kept as-is when already informative, else promoted from the first surviving `resolvedKeys`
  entry — so an old reader that only ever looks at the scalar still sees exactly one informative key.
- Every boot-time "attempt ONE secondary arm" call site (5 of them: PASS 1's degraded-else-branch and its
  primary+secondary arm, PASS 1b's tmp-residue mirror of both, and the safety-tmp recovery pass) is
  generalized from a single `if (entry.resolvedKey && ...)` into a loop over
  `secondaryKeysToAttempt(entry, anchorKey)` (falls back to the legacy scalar when `resolvedKeys` is
  absent — byte-identical behavior for an old record), threading the accumulator through each attempt
  exactly as the single-key case already did (54054c01's own "second call must build on the first's
  result" rule, now N calls instead of 2).
- PASS 1b's own collision check (the former `console.error` this record's "Follow-up 1e739f4a" section
  shipped) is downgraded to `console.log` — it no longer signals an unrecoverable loss, since both sides
  now survive via `resolvedKeys`; removing it entirely was rejected, since the collision itself (two
  independently-raised quarantines physically sharing one latch file) is still a fact worth a diagnostic
  trail, just no longer an urgent one.
- Every parse site that already whitelists `contributorRepoPaths`/`provenanceTracked` (PASS 1, PASS 1b,
  the safety-tmp recovery pass, the pending-divert reader, `protectOccupantContentBeforeDelete`'s own
  reader) now also whitelists `resolvedKeys` via a shared `parseResolvedKeysField` helper — an unknown
  field in an OLDER record simply parses to `undefined` (no strictness anywhere in this file's parsing:
  `isReadableLatchRecord` only checks `typeof value === "object"`). `protectOccupantContentBeforeDelete`
  and the pending-divert reconciliation path (`~:1997`, the `050a4428` ACCEPTED-RESIDUAL site) both get a
  NEW plural `excludeLiftedResolvedKeys` — the per-element counterpart of the existing
  `excludeLiftedResolvedKey` chokepoint — so a protective copy or a reconciled union can never carry
  forward a key the CURRENT clear/raise is itself lifting, mirroring the scalar's own existing guarantee.

### Backward/forward compatibility

An OLD record (written before this card) has no `resolvedKeys` field at all — every read site falls back
to `[]`/the legacy scalar, byte-identical to pre-card behavior. A NEW record read by an OLD binary: the
old parser's own explicit field whitelist never looks at `resolvedKeys`, so it is silently ignored — no
throw, no corruption — and the old binary's own single-secondary-key behavior applies exactly as before
(a downgrade loses the GENERALIZATION, never any data integrity). Proven directly (`downgrade-compat`
scenario): a real record written by the fixed code, re-parsed through an inlined copy of the OLD
whitelist, still yields exactly one informative scalar `resolvedKey` and never even accesses
`resolvedKeys`.

### Scope note — what this does NOT fix

The union object underlying a multi-key record still carries only ONE `repoPath`/`branch`/`tokens` set —
two colliding identities still cannot be independently cleared from each other (unchanged from before
this card; `7673d096` already treats a same-physical-repo collision this way by design, and a genuinely
different-repo collision is `398f476c`'s own identity-model territory, not narrowed or widened here).
This card closes the REBOOT-PERSISTENCE gap only, exactly as scoped.

### Tests

`merge-quarantine-dual-key-persistence-43cf3b26.mjs` (9 scenarios, all GREEN): the four repro cases above,
plus `registered-y-multi-key` (two reboots, Y registered), `raise-after-boot-multi-key` (a genuine runtime
raise between boot and reboot), `clear-by-path-lifts-all-keys` (every key is lifted by one clear and none
resurrects after a reboot), `resolved-keys-cap-eviction` (17 distinct colliding sources exceed the 16-key
cap; asserts the eviction log fires naming the card and exactly 16 keys survive, all still blocked after a
reboot), and `downgrade-compat` (above). `merge-quarantine-tmp-promotion-dual-arm.mjs`'s own "two-tmps"
scenario is UPDATED (not left as a stale pin) — it now asserts BOTH W1 and W2 stay blocked across two
reboots (the former residual assertion, "W2 unblocked", is retired) and that the boot-0 collision report
moved to `console.log`. All 36 `merge-quarantine*.mjs` files, every other test importing
`merge-quarantine.js`, and `pnpm --filter @loom/daemon guards` re-run clean under both `LOOM_DEV` unset
and `LOOM_DEV=1`.

## Round 2 (Code Review 46c5c492) — SCALAR-ONLY gates that never learned about `resolvedKeys`

Round 1 shipped `resolvedKeys` as a plural, persisted, additive field — but FOUR call sites still gated on
the legacy SCALAR `resolvedKey` alone, reopening fail-opens the plural field was supposed to close.
Reproduced first, hermetically, via the reviewer's own probe scripts (`natural.mjs`, `probe.mjs`,
`probe2.mjs`, `case3.mjs`) before any further source edit.

### CRITICAL (fail-open) — the degraded branch's own divert gate, and PASS 1b's own branch-entry gate

`secondaryKeysToAttempt` already filtered out the walked-up `currentKey`, but the DIVERT-TO-PENDING guard
immediately after the loop (PASS 1's degraded-else branch) still checked only `currentKey !==
entry.resolvedKey` — the bare SCALAR. When the scalar happened to COINCIDE with the degraded, walked-up
`currentKey` (natural.mjs: a dual-armed nested repo Y=R/sub disappears, so Y's own canonical key degrades
to walk up to Kr — the SAME value its own persisted scalar already names), the OTHER key in `resolvedKeys`
still armed correctly, but `currentKey` itself (Y's own identity) was neither armed (this branch never
arms the degraded key directly, by design, 883e29bc) NOR diverted to pending — Y stayed UNBLOCKED even
after being re-created. PASS 1b's own mirror had a WORSE shape: its branch-ENTRY gate itself required
`entry.resolvedKey !== currentKey`, so the same coincidence skipped the whole branch and fell through to a
DIRECT primary arm at the degraded key instead (probe.mjs's "plural" variant: D is never even pending).
`probe2.mjs` found a THIRD shape: the "no key at all" pending gate also checked the scalar alone, so a
record carrying `resolvedKeys` but NO scalar was wrongly treated as a pre-upgrade keyless latch — its own
`resolvedKeys` entry (naming an unrelated repo X) was never even attempted.

**The fix (Lead ruling, verbatim structure):**
- `informativeKeysFor(entry)` — ONE shared helper, the UNION of the scalar and `resolvedKeys` (never
  "array else scalar"). `secondaryKeysToAttempt` is now built on it. Every scalar-only gate (`!entry.
  resolvedKey` at the two "no key at all" pending gates, PASS 1b's own branch-entry gate, the tier-4
  pending match in `findPendingIndicesFor`) now routes through it.
- PASS 1b's branch-entry gate no longer requires `entry.resolvedKey !== currentKey` — ANY unresolvable
  entry enters the degraded branch now, matching PASS 1's own architecture (which never had this
  requirement at entry, only at the exit gate this round also fixes).
- The exit-gate divert push is now UNCONDITIONAL in both PASS 1 and PASS 1b — reached regardless of
  whether the scalar happens to equal `currentKey`, since this branch structurally never arms `currentKey`
  directly either way, so skipping the divert on that coincidence was never safe.
- A SEPARATE, newly-discovered interaction: once a sibling degraded identity sharing the same key
  genuinely lands in `pendingUnresolvedQuarantines` (rather than being silently evicted/unioned into
  `direct`, as the pre-fix code's fallthrough did), `activeMergeQuarantineFor`'s own tier-4 pending
  fallback — purely KEY-based, never identity-based — could shadow an ALREADY-correct `direct` entry with
  an unrelated sibling's content for the exact repoPath being queried. Fixed by skipping the pending
  search entirely when `direct`'s own identity already matches the query (a same-identity `direct` is
  unambiguously the right answer, stronger than anything the pending search could find).

  **Correction (Round 3, Code Review 4c59172f)** — this is NOT a production shadowing scenario the fix
  protects a real caller from. Every production reader of `activeMergeQuarantineFor` reaches it through
  {@link resolveQuarantineFor} (`assertRepoNotQuarantined`/`clearMergeQuarantineReporting`), which for an
  unresolvable `repoPath` already tries `ownIdentityEntryFor` FIRST — a BROADER, identity-based scan of
  every active-or-pending entry — and returns early the instant it finds one. By the time
  `activeMergeQuarantineFor`'s own tier-4 fallback runs inside that call chain, `direct`'s identity can
  never already equal the query's own identity (if it did, `ownIdentityEntryFor` would already have
  matched and returned first), so this guard's own `directPathIdentity(direct.repoPath) !==
  directPathIdentity(repoPath)` condition is always true there — a no-op on that path. The guard is real
  and correct, but it is exercised only by a DIRECT call to the exported `activeMergeQuarantineFor` (a
  test, or any future caller that bypasses `resolveQuarantineFor`), never by the shipped
  `assertRepoNotQuarantined`/clear-reporting call chain. Test coverage added by this round asserts through
  `assertRepoNotQuarantined`, not a bare `activeMergeQuarantineFor` call, for exactly this reason.

### MAJOR (spurious block) — the explicit-rule fail-close only excluded the two SCALARS, never the arrays

`unionQuarantineEntries`'s explicit-rule fail-close (both sides' scalars set and genuinely different) only
ever excluded those two SCALAR values from the `resolvedKeys` fold — `older.resolvedKeys ∪
newer.resolvedKeys` still carried both conflicting keys through UNFILTERED whenever either side ALSO
already had them in its own array (`case3.mjs`'s "newFormat" variant: both records carry `resolvedKeys`
matching their own scalar) — durably blocking the unrelated repo S until a human cleared it, reopening
exactly the fail-closed protection 050a4428/this record's own "Follow-up 4b06875f" established.

**The fix:** decide the conflict over the full KEY SET, not just the scalars — when the explicit rule
fails closed, both conflicting keys are excluded from the ENTIRE union (the pre-existing arrays included),
not merely withheld from being freshly added.

### MINOR (both addressed)

- This record's own "Follow-up 43cf3b26" section (above) claimed the scalar fold was "independent of
  `explicitResolvedKeyRule`" — FALSE, per the MAJOR fix above; recorded here rather than silently amended,
  since the claim was wrong when written, not merely superseded.
- The degraded-else branch's own "every candidate occupied" log wording fired even when there were ZERO
  candidates to attempt (claiming "ALREADY occupied by a VERIFIED entry" when nothing was ever attempted)
  — now gated on `secondaryCandidates.length > 0`, so it only ever fires when every candidate was
  genuinely attempted and refused.

### A further, newly-discovered interaction — a later raise correctly UNIONS with a surviving prior raise

`merge-quarantine-protect-read-failure.mjs`'s own "tp" and "round3-b2" scenarios use the SAME
coincidentally-matching-scalar shape this round's CRITICAL fix targets (D=R/gone-subdir, resolvedKey=Kr=
D's own walked-up key) — but for a DIFFERENT reason (testing a read-failure-during-clear interaction, not
boot-arm generalization). Pre-fix, D's own tautological primary arm EVICTED R (the resolvable repo whose
own key D's degraded identity coincidentally shares) at boot, and R's LATER clear then collaterally
destroyed D's own content as a side effect of clearing R's own key — this is what made D appear to "start
clean" on a later re-raise; it was never actually testing round 3's own stub-removal, since the fixture's
`dTmpFile` never goes through the real stub-minting code path at all. Post-fix, D's own degraded identity
is diverted to pending at boot, INDEPENDENT of R's key — so D's own (real, non-stub) prior content SURVIVES
R's clear untouched, and a later re-raise on D correctly UNIONS with it (this module's own stated
multi-token design: "a repo can be quarantined by more than one outstanding unconfirmed kill at once"),
keeping the older side's branch/reason and BOTH tokens. The affected assertions are UPDATED to assert this
directly (confirmed via a before/after-clear state dump against the fixed code), not silently loosened —
the round-3 M3 checks (no empty/stub branch, no ownership-anchor reason) are UNCHANGED and still pass,
confirming the actual stub-removal mechanism is untouched.

### Tests (Round 2)

Each finding reproduced hermetically via the reviewer's own probe scripts BEFORE any source edit, then
proven RED on commit `16b45535` (round 1) and GREEN after, via committed scenarios:
`merge-quarantine-dual-key-persistence-43cf3b26.mjs` gains `degraded-divert-after-disappear`
(`natural.mjs`), `degraded-branch-scalar-coincidence` (`probe.mjs`, legacy+plural), and
`plural-only-no-scalar` (`probe2.mjs`). `merge-quarantine-raise-protect-failure.mjs` gains a new-format
sibling of its own "UNION RULE case 3/3" (`case3.mjs`). `merge-quarantine-protect-read-failure.mjs`'s own
"tp"/"round3-b1"/"round3-b2" scenarios are UPDATED (3 assertions re-grounded, not silently weakened) to
assert the newly-correct behavior described above. All 36 `merge-quarantine*.mjs` files, every other test
importing `merge-quarantine.js`, and `pnpm --filter @loom/daemon guards` (30/30) re-run clean under BOTH
`env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1`.

## Round 3 (Code Review 4c59172f) — the explicit-rule conflict check still compared only the two
## SCALARS, and PASS 1b's own resolvable secondary-arm loop never threaded its own accumulator

Round 2 shipped `informativeKeysFor` (scalar UNION `resolvedKeys`) at every GATE that decides whether a
key is worth attempting at all — but `unionQuarantineEntries`'s own explicit-rule CONFLICT ARBITRATION
(`explicitRuleFailedClosed`/`conflictExclusions`, ~:706-707 pre-round-3) still compared `older.resolvedKey`
against `newer.resolvedKey` directly — the bare scalars, never the full informative sets. An ARRAY-ONLY
side (a record whose only informative key lives in `resolvedKeys`, with no scalar at all — reachable via
`protectOccupantContentBeforeDelete`'s own separate scalar/array carry-forward filtering, `~:1980-1987` →
`writePendingDivertFile`, `~:1823`) made the scalar comparison see `undefined` on one side, so it took the
"one side undefined, keep the other" branch — the array's OWN conflicting key sailed through UNFILTERED,
durably blocking an unrelated repo S. A SEPARATE, independent finding (missed in round 1, present since
`16b45535`): PASS 1b's own RESOLVABLE secondary-arm loop (the loop pairing PASS 1's `~:4729-4738` primary-
arm-loop; PASS 1b's own copy sat at `~:4948-4953` pre-round-3) passed the SAME `armedTmpEntry` to every
`armKeyUnlessDegradedCollision` call across its iterations instead of threading the prior call's own
result forward — invisible with exactly one secondary key (nothing ever reads the stale accumulator
again), but with TWO OR MORE secondaries this left each key in `byRepoKey` pointing at a DIFFERENT object
for the SAME logical identity: `armQuarantineKey`'s own write (`for (const k of armed.armedKeys ?? [key])
byRepoKey.set(k, armed)`) stamps every key in the RESULT's own `armedKeys` with whatever it was called
with. The pre-loop accumulator's own `armedKeys` holds only the ANCHOR key (`Ky`, from the primary arm run
before the loop) — never any secondary the loop has already processed, since the (buggy) accumulator is
never updated. So the LAST secondary call in iteration order, still built on that un-updated pre-loop
entry, unions `[Ky]` with its own key and writes a FRESH object to BOTH `Ky` AND itself — silently
re-pointing the ANCHOR's own slot away from whatever the EARLIER call(s) had built there. Every
earlier-processed secondary key is left pointing at that earlier, now-orphaned object, which nothing will
ever update again (the loop never revisits it). `assertQuarantineIdentityInvariantTestOnly` then reports
more than the one legitimate active+pending pair for the identity, and clearing via the mounted repo's own
canonical key (`Ky`) only reaches the LAST-processed secondary's object — every EARLIER-processed
secondary key stays armed in-process until a restart re-derives a single, consistent union from disk.
**Round 3's own first test draft got this backwards** (see Code Review `5220fda9`'s correction) — in the
`resolvedKey: K1, resolvedKeys: [K1, K2]` fixture, `informativeKeysFor` enumerates `[K1, K2]` in that
order (scalar first), so K1 is armed FIRST and is the one left orphaned; K2, armed LAST, always ends up
correctly co-located with the anchor even pre-fix in this exact two-secondary case.

### The fix

- `unionQuarantineEntries`'s own conflict decision now computes `A = informativeKeysFor(older)`, `B =
  informativeKeysFor(newer)` FIRST (moved ahead of the scalar `resolvedKey` computation, which now reads
  the result). Lead ruling, the exact SET semantics: if EITHER set is empty, no conflict is possible —
  union everything, exactly as the legacy "one side undefined" rule already did. If BOTH are non-empty,
  keep the INTERSECTION (the keys both sides genuinely agree on) and exclude the WHOLE SYMMETRIC
  DIFFERENCE (A\B ∪ B\A) from the union — arrays included, not merely the two scalars. This reduces
  exactly to the pre-existing scalar rule whenever each side carries exactly one key (equal ⇒ keep; both
  different ⇒ exclude both) — the one-element-set special case of the general rule, not a parallel rule
  living beside it.
- The scalar `resolvedKey` itself is ALSO re-derived against the SAME `conflictExclusions` set (never the
  bare "one side undefined ⇒ keep the other" check alone) — without this, a scalar that happens to be the
  ONLY informative key on its own side could resurrect a key the array-level fold just correctly excluded
  (e.g. `olderArrayOnly`'s own shape: the array side's lone key and the scalar side's lone key are both
  excluded by the symmetric-difference rule at the ARRAY level, but the UNCHANGED pre-round-3 scalar
  branch — "one side undefined, keep the other" — would have handed the scalar side's own key straight
  back as the returned `resolvedKey`, reopening exactly the bug the array-level fix just closed one field
  over). `informativeKeysFor` always unions scalar and array on every future read, so a scalar the
  conflict decision didn't also exclude is just as informative as one the array carries.
- PASS 1b's own resolvable secondary-arm loop now threads its accumulator through each
  `armKeyUnlessDegradedCollision` call exactly like PASS 1's sibling loop and the safety-tmp recovery
  loop already did (`let armedTmpEntry = ...; ...; if (dualArmed !== undefined) { armedTmpEntry =
  dualArmed; byRepoKey.set(currentKey, armedTmpEntry); }`) — the THIRD of three structurally-identical
  loops in this file, now byte-for-byte the same shape as the other two.

### Scope clarification — the tier-4 "shadowing" guard is a direct-call path only

Round 2's own "A SEPARATE, newly-discovered interaction" paragraph (above) described
`activeMergeQuarantineFor`'s tier-4 pending-fallback skip as protecting a real caller from a sibling
shadowing an already-correct `direct` entry. Round 3 (Code Review 4c59172f) found this guard is never
actually reached that way in production: every shipped caller (`assertRepoNotQuarantined`,
`clearMergeQuarantineReporting`) resolves through `resolveQuarantineFor`, which for an unresolvable
`repoPath` already tries the BROADER, identity-based `ownIdentityEntryFor` first and returns the instant
it finds a match — so by the time `activeMergeQuarantineFor`'s own tier-4 fallback would run inside that
call chain, `direct`'s identity can never already equal the query's own identity (if it did,
`ownIdentityEntryFor` would already have matched and returned). The guard is real, correct, and NOT
removed — it is exercised only by a direct call to the exported `activeMergeQuarantineFor` (a test, or any
future caller that bypasses `resolveQuarantineFor`). See the correction inserted directly under Round 2's
own paragraph above for the full argument. The stale comment at the top of PASS 1b's resolvable branch
("`entry.resolvedKey` is guaranteed set here") is also corrected to name `informativeKeysFor(entry)`,
never the bare scalar.

### Tests (Round 3)

Both findings reproduced hermetically (ad hoc scratch scripts against the real compiled module, never the
reviewer's own probe scripts — those lived in a prior session's own scratchpad, unreachable here) before
any source edit, then proven RED on commit `506c3159` (round 2) and GREEN after, via
`pnpm --filter @loom/daemon negative-control --ref HEAD --file packages/daemon/src/git/merge-quarantine.ts
--test <file>`:
- `merge-quarantine-raise-protect-failure.mjs` gains three scenarios beside its own "case 3/3"/new-format
  pair, all asserting through `assertRepoNotQuarantined` (never a bare `activeMergeQuarantineFor` call —
  see the scope clarification above for why that matters here specifically): `olderArrayOnly` (the OLDER
  pending record is array-only, the twin is scalar-only), `twinArrayOnly` (the mirror shape), and
  `[Kt,Ks]-vs-[Ks]` (the OLDER record carries BOTH keys, the twin carries only the agreed one — asserts
  the asymmetric-intersection case directly: S, the agreed key, correctly STAYS blocked, while T, the
  symmetric-difference key, is correctly excluded — the one shape a scalar-only rule could never express
  at all, since a scalar can hold only one value per side).
- `merge-quarantine-tmp-promotion-dual-arm.mjs` gains `identity-invariant-two-secondaries` (Y mounted
  throughout, one tmp carrying two secondary keys, asserts `assertQuarantineIdentityInvariantTestOnly().ok`
  plus that `clearMergeQuarantine(Y)` unblocks BOTH secondaries in-process) and its own remount variant,
  `identity-invariant-two-secondaries-remount` (Y unresolvable at boot-0, so the already-correct degraded
  branch runs first; Y is then created for real and a second boot exercises the FIXED resolvable loop
  against the same on-disk tmp).

**Correction (Code Review `5220fda9`, HEALTHY, no blockers)** — the `identity-invariant-two-secondaries`
(and its remount sibling) post-clear checks originally asserted via a bare `activeMergeQuarantineFor` call;
switched to `assertRepoNotQuarantined(w).ok`, the shipped entry point, matching the other new scenarios'
own posture. The accompanying check LABEL also misnamed which key gets orphaned pre-fix ("K2 pointed at a
DIFFERENT object") — see "The fix" paragraph above (now corrected) for the real mechanism: K1 (armed
FIRST, per `informativeKeysFor`'s own `[scalar, ...array]` enumeration order) is the one left stale; K2
(armed LAST) always shares the anchor's final object even pre-fix in this exact two-secondary case, so
its own check is the non-discriminating sibling of K1's. Re-proven RED on commit `9aab9b03` (test-only,
pre-fix) and GREEN on the restored fix, via the same `negative-control` invocation.

All 36 `merge-quarantine*.mjs` files plus every other test importing `merge-quarantine.js` (50 files total)
re-run clean under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1`; `pnpm --filter @loom/daemon
guards` is 30/30; `node packages/daemon/assets/comment-anchor-lint.mjs .` reports `orphanAnchors: 0`.

## Follow-up 8bff3cae — PASS 1's own `.json` migrate branch had the SAME unconditional-overwrite shape Follow-up 1e739f4a's own "Do not" section flagged but never reproduced

Card `8bff3cae`, filed by the Lead directly off that "Do not" bullet: "a THIRD near-identical arbitration
site (PASS 1's own `.json` migrate branch, `entry.resolvedKey = currentKey`) has the SAME
unconditional-overwrite SHAPE but was explicitly left untouched — flagged, not reproduced." This card's own
worker ran INVESTIGATE-FIRST (hermetic repro, temp `LOOM_HOME`, real git repos, no source edit until the
Lead ruled) and confirmed TWO independent fail-opens, both closed by the SAME fix below.

### Repro 1 — a legacy (pre-43cf3b26) scalar-only dual-arm is discarded with no array to fall back on

A record written by code predating card `43cf3b26` (no `resolvedKeys` field exists yet) already carries an
informative scalar `resolvedKey` naming a genuine cross-repo dual-arm partner (the 4b06875f/48bda567
shape) — the SAME shape Follow-up 1e739f4a's own Fix 1 protects at the PHASE 2 promote site. PASS 1's
migrate branch (`entry = {...entry, resolvedKey: currentKey}`) overwrote that scalar unconditionally, with
nothing folding the discarded value into `resolvedKeys` first (the field didn't exist when this record was
last written, so there's nothing to fall back on). The dual-arm partner (the witness) goes unblocked on
the SAME boot the migrate runs, and stays unblocked across reboot-sims — a real, durable upgrade-window
regression, confirmed via `merge-quarantine-pass1-migrate-resolvedkey-8bff3cae.mjs`'s own
`legacy-scalar-dual-arm` scenario (RED on `d694e77d` before this card's fix, same-boot AND both reboot
legs; GREEN after).

A CONTROL (`current-format-pin`, same shape but `resolvedKeys` already carries the dual-arm key — a
record already written by 43cf3b26-generation code) was ALREADY green before this card's fix: the write
chokepoint's own `unionResolvedKeysRetaining` fold already covers it. This bounds the bug precisely to the
legacy, scalar-only, no-array case — once a record has been through one post-43cf3b26 write, this gap
cannot recur for it.

### Repro 2 — a shared-ancestor-key sibling loses its OWN enforcement when the other side diverges

A SECOND, independent fail-open with no dual-arm at all. A plain subdir (no `.git` of its own) collapses
onto its parent repo's own canonical key (7673d096's toplevel walk) — if the subdir itself raises a
quarantine while in that state, the physical file is filed at `sha256(parentKey).json`, so the PARENT
repo's own enforcement is, in practice, backed by that exact file (both repoPaths genuinely share one
key). If the subdir LATER gains its own `.git` (its canonical key diverges from the parent's), PASS 1's
migrate branch moved that file to the subdir's own new key with no check for whether the STALE key it was
abandoning still names a DIFFERENT, currently-registered, resolvable repo — the parent's own identity
never changed at all, yet it went unblocked the instant the unrelated sibling's own key happened to
diverge. Confirmed via the same test's `shared-ancestor-sibling-survives-divergence` scenario (RED on
`d694e77d`, both the migrate boot and a second reboot-sim; GREEN after).

This is the manager's own probe question, answered with evidence — but the premise needs correcting
first (CR `0b975d2a`, MINOR (a)): the code does NOT drop the record's own old key at all. Source (a)
(below) ALWAYS keeps the migrating record's OWN already-self-stamped scalar `resolvedKey` (its own prior
key, from the write that stamped it there) — the Lead's ruling is that this is **intentional and
fail-closed**, not a residual: it keeps enforcement pinned to the EXACT path that was originally
quarantined, even after the migrate. The accepted consequence is that if a NEW, unrelated repo is later
re-`init`-ed at that exact old path (reusing the same real filesystem location), it inherits the stale
block too, until a human clears it — an over-block, never an under-block, and the SAME direction
`92c645cc`'s own accepted PASS-1-vs-PASS-1b asymmetry already lives with. What source (b) is actually for
is the SEPARATE, genuinely new fail-open this card closes: a DIFFERENT, currently-registered, resolvable
repo (never the migrating record's own prior self) whose key happens to still hash to the exact same
stale filename right now — the shared-ancestor-collapse shape above. That other repo's own key is always
recomputed fresh from its own registered path, never guessed from the hash — but see CR `0b975d2a`'s
BLOCKING finding below for why a naive version of that recompute was still wrong.

### The fix — two sources, no new mechanism; the SECOND source is deferred, not inline

Immediately before `entry = {...entry, resolvedKey: currentKey}`:
- Source (a), folded in RIGHT THERE, inline: if `entry.resolvedKey` is informative relative to
  `currentKey` (`isInformativeKey`, the SAME helper Follow-up 1e739f4a's Fix 1 and the write chokepoint
  already share), fold it into `entry.resolvedKeys` via `unionResolvedKeysRetaining` before the scalar
  overwrite runs. Safe inline because it is THIS entry's own, already-recorded secondary identity — no
  cross-entry race to get wrong.
- Source (b), queued into `staleKeyRetentionCandidates`, resolved LATER: look up `hashToRepo.get(hash)` —
  the SAME map, built once above from `registeredRepoPaths`, the corrupt-parse branches already use for
  the identical purpose. If a match exists and its own `canonicalRepoLockKey` differs from `currentKey`,
  queue `{currentKey, staleKey}` — never fold it in immediately.

**Round 1 of this fix (REVERTED before merge, caught by this card's own DoD re-run, never shipped)** —
folding source (b) in immediately, inline, alongside (a): reproduces as a NEW regression against
`merge-quarantine-migrate-source-owner-durable.mjs` (card `97cff6db`) — proven RED by re-running that
file directly, GREEN once reverted. Two of its own scenarios share the EXACT shape this card's own
`shared-ancestor-sibling` repro does (a plain subdir's stale key coincides with ANOTHER registered
repo's current key) — but there, that OTHER repo (`teamA`, or `sub`'s true owner) has its OWN
quarantine data of some kind THIS SAME BOOT (a clean parse OR a corrupt tmp), landing on the SAME
physical file via its OWN independent primary arm. Folding the stale key in at READ TIME, before that
OTHER entry has had its own chance to arm, let `armQuarantineKey`'s own union logic merge the migrating
entry's content INTO that other, unrelated entry — corrupting it (a corrupt-tmp placeholder's content
silently inheriting a stale sibling's tokens, caught by `round3-minor4-deferred-corrupt-placeholder-
survives-phase3-delete`'s own content assertion). An earlier narrower attempt (checking `byRepoKey.has`
right after PASS 1's own read loop, or checking for another physically-identically-NAMED file via
`files.some(...)`) failed the SAME regression for two DIFFERENT reasons: the former runs before a
corrupt-tmp-derived placeholder (armed+written DEEP inside its own later resolution cascade, not at
PASS 1's own read loop) has had its chance; the latter only catches a literal filename collision, never
a DIFFERENT, differently-named file that shares the same CANONICAL KEY (the `!stale-teamA-*.json` shape).

**The fix (SHIPPED):** resolve `staleKeyRetentionCandidates` in ONE pass, placed immediately before
PASS 1's own migrate-WRITE phase — after EVERY other way this boot can independently arm a key (clean
parse, corrupt `.json`, corrupt tmp, safety-tmp recovery) has already fully settled into `byRepoKey`,
and before any of THIS pass's own writes run. For each candidate: if `byRepoKey.has(staleKey)` — some
OTHER repo's own primary arm (of ANY shape) already, legitimately covers it — leave it alone entirely.
Otherwise, arm `staleKey` as the migrating entry's own secondary via the SAME `armKeyUnlessDegradedCollision`
primitive the existing per-file secondary-arm loop already uses.

No new field, no new map, no new cap — every primitive reused (`isInformativeKey`, `hashToRepo`,
`unionResolvedKeysRetaining`, `armKeyUnlessDegradedCollision`) was already built for a sibling purpose;
only the ORDERING (collect during the read loop, decide once, late) is new, and it mirrors this same
function's own pre-existing `migratedSourcesByKey`/`degradedOccupiedKeys` collect-then-write discipline.

### Round 2 (Code Review `0b975d2a`) — a LEGACY-tier `hashToRepo` match can recompute to an ANCESTOR's key, not `hash`'s own true owner, durably blocking an unrelated repo

**BLOCKING.** `hashToRepo` (built once, above PASS 1's own read loop) has TWO tiers: a FRESH tier
(`quarantineHashFor(p)`, only for a currently-resolvable `p` — by construction, `canonicalRepoLockKey(p)`
always hashes back to exactly this value) and a LEGACY tier (`legacyQuarantineHashFor(p)`, set
UNCONDITIONALLY for every registered `p` regardless of resolvability — a repo's own RAW realpath, never
toplevel-walked). Source (b) matched on `hashToRepo.get(hash)` and then recomputed
`canonicalRepoLockKey(staleKeyStillOwnedBy)` FRESH — correct when the match came from the fresh tier
(the recompute reproduces the SAME hash by construction), but NOT when it came from the legacy tier: a
registered repo `T` that HAD its own `.git` at raise time (so its legacy hash equals its OWN raw path's
hash) can later LOSE that `.git` — `canonicalRepoLockKey(T)`, recomputed now, toplevel-walks up to
whatever ancestor DOES still have a `.git` (its parent `P`), a DIFFERENT value than the hash that matched.
The pre-fix code trusted the recompute anyway, queuing `P`'s own key as "the stale key to retain" —
durably arming an entry that was never, at any point, meaningfully associated with `P` at all: `P`
durably blocked, and its only remedy (clearing `P`) collaterally lifts `X`'s own, genuine block too — a
human cannot clear the WRONG block without also destroying the RIGHT one.

Reproduced hermetically by the reviewer (`probe1.mjs`: outer repo `P`; `T = P/t`, its own repo; `X =
T/sub`, a plain subdir of `T` that raises while collapsed onto `T`'s own key; then `T`'s `.git` is
removed and `X` gets its own `.git` instead) before any further source edit — RED at commit `085aff66`
(`P` durably blocked on every boot after the migrate), confirmed still RED there independently by this
card's own worker, and confirmed GREEN only after the fix below.

**The fix:** before queuing a source-(b) candidate, re-verify that the freshly-recomputed key's OWN hash
still equals `hash` — `quarantineHashForKey(staleKeyStillLive) === hash`. This is automatically true for
a fresh-tier match (true by construction) and is exactly the check that rejects a legacy-tier match whose
owner has since lost its own `.git` — no new field or map, the SAME `quarantineHashForKey` helper the
write chokepoint already calls.

### Do not

- Do not fold source (b) in INLINE, at PASS 1's own read-loop time, even if it looks like the exact same
  shape as source (a) — Round 1 above (REVERTED before merge, see "The fix" above for the full narrative)
  is the record of exactly why: a not-yet-read sibling's own primary arm for that same key must be given
  its full chance first, including the corrupt-tmp cascade's own LATE, deep-inside-its-own-resolution
  arm+write — resolve `staleKeyRetentionCandidates` in the ONE deferred pass only, at its current
  placement (immediately before PASS 1's own migrate-write phase).
- Do not trust a `hashToRepo.get(hash)` match's freshly-recomputed `canonicalRepoLockKey` without
  re-verifying `quarantineHashForKey(that key) === hash` first — Round 2 above is the record of exactly
  why: the LEGACY tier can match on a repo's own raw path that no longer represents its current
  toplevel-walked identity, and trusting the recompute anyway arms a wrong, unrelated ancestor key.
- Do not read source (a)'s own old-key retention as a residual to someday "fix" — it is the Lead's own
  intentional, fail-closed ruling (see Repro 2's closing paragraph above); the one accepted consequence
  (a later re-`init` at the exact same old path inherits the stale block) is a DELIBERATE over-block, not
  an under-block, and needs no remedy beyond the existing human clear path.

### Tests

`merge-quarantine-pass1-migrate-resolvedkey-8bff3cae.mjs` (new, 5 scenarios): `legacy-scalar-dual-arm`
and `shared-ancestor-sibling-survives-divergence` (both RED on `d694e77d`, GREEN after, asserted through
`assertRepoNotQuarantined` across same-boot + two reboot-sims), `current-format-pin` (the control, green
both before and after — proves the fix is additive, never a behavior change to the already-correct array
path), and two Round-2 additions turning the reviewer's own hermetic probes into committed regression
tests: `legacy-tier-match-never-blocks-unrelated-repo` (named for the `hashToRepo` LEGACY tier it
exercises, never "ancestor tier" — that name belongs to the unrelated `ancestorHashToRepo` mechanism;
`probe1.mjs`'s own P/T/X shape — asserts P stays UNblocked and X stays blocked across 3 reboots, plus
that clearing the never-blocked P genuinely reports `wasQuarantined:false` via
`clearMergeQuarantineReporting` — NOT the originally-shipped check, which read `clearMergeQuarantine`'s
own `void` return and so passed vacuously regardless of whether P was blocked; re-verified by this card's
own worker to go RED, specifically on this real check, with the hash-equality guard removed (`tsconfig.
tsbuildinfo` cleared before each rebuild) — and that clearing P never collaterally lifts X's own genuine
block either; RED at `085aff66`, GREEN after) and `realistic-raise-source-a-retention` (`probe2.mjs`'s
own shape — a REAL `enterMergeQuarantine` raise rather than a hand-crafted `.json` final; RED on
`d694e77d`, GREEN after). **CR `0b975d2a` round 2 correction:** that last scenario NEVER reaches source
(b) at all — the migrating record's own self-stamped scalar (source (a), always retained, see Repro 2's
closing paragraph) is what keeps `R` blocked, so it stays green even with the hash-equality check removed
AND with source (b) disabled entirely (both independently re-verified by this card's own worker). It is a
realistic-record-SHAPE regression pin for source (a), never evidence for source (b)'s own over-filter
direction — only `shared-ancestor-sibling-survives-divergence` (whose hand-crafted stale file carries NO
self-stamped scalar) actually exercises (b), and it alone goes RED when (b) is disabled.
`pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-pass1-migrate-resolvedkey-8bff3cae.mjs --ref d694e77d`
independently proves RED→GREEN→clean-tree for the whole file.
`merge-quarantine-migrate-source-owner-durable.mjs` (card `97cff6db`) is explicitly re-confirmed green —
it is what caught Round 1 of this fix as a regression (see "The fix" above) and is the one file in this
card's own DoD sweep most likely to catch a reversion of the deferred-resolution ordering. All 37
`merge-quarantine*.mjs` files plus every other test importing `merge-quarantine.js` (51 files total)
re-run clean under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1`; `pnpm --filter @loom/daemon
guards` all pass; `node packages/daemon/assets/comment-anchor-lint.mjs .` reports `orphanAnchors: 0`.

## Follow-up 150aed7b — `reconcileMarkedBasenameBeforeWrite` folded `tokens` only, silently dropping the on-disk record's own `resolvedKey`/`resolvedKeys`

Card `150aed7b`, discovered from `43cf3b26`'s own Code Review (`46c5c492`, gen 418), not probed until this
card's own INVESTIGATE-FIRST pass. `reconcileMarkedBasenameBeforeWrite` (the chokepoint every writer in
this module goes through for a basename marked `keptUnreadableLatchFiles`) unioned `final`'s own on-disk
SURVIVING TOKENS into the in-memory `entry` before a write, but never carried forward the on-disk
record's own scalar `resolvedKey` or plural `resolvedKeys` — both are simply overwritten by whatever
`entry` already held in memory, which can be NOTHING (a fresh raise after a full clear carries no
resolvedKey/resolvedKeys of its own).

### Repro (hermetic, confirmed before any fix was written)

Y dual-armed at two secondary keys (W1, W2 — the same shape as `43cf3b26`'s own
`raise-after-boot-multi-key` scenario). A clear of Y hits an injected, transient read failure on Y's own
`final` (same fault-injection technique as `merge-quarantine-protect-read-failure.mjs`) — the clear
deletes Y's in-memory entry UNCONDITIONALLY before any protect call runs (`63e49ee2`'s own documented
ordering), so the file is left on disk, bytes untouched, and its basename is marked
`keptUnreadableLatchFiles`. A FRESH `enterMergeQuarantine(y)` then reaches this chokepoint with an
in-memory `entry` carrying no `resolvedKey`/`resolvedKeys` at all; the read of `final` now succeeds (no
injection this time), and the pre-fix code unioned `tokens` only — the written record's `resolvedKeys`
came back `undefined`. CONFIRMED CONSEQUENCE: a reboot after this leaves BOTH W1 and W2 unblocked, even
though they were genuinely, durably armed immediately before the read failure — a real fail-open, not a
cosmetic data loss.

### The fix

`reconcileMarkedBasenameBeforeWrite` now ALSO computes `informativeKeysFor` (card `43cf3b26`'s own
scalar-∪-plural helper) of the on-disk record, excluding `entry`'s own current key (mirrors
`secondaryKeysToAttempt`'s own `anchorKey` exclusion), and folds the result into `entry.resolvedKeys` via
the SAME `unionResolvedKeysRetaining` retention/cap/eviction-log every other writer in this module
already uses for this field. The broadened early-return guard (`resurrectable.length>0 ||
onDiskKeys.length>0`) means this now also fires a union when there's a key to fold even if there happens
to be no NEW token to resurrect.

**Why this is safe — it can never arm a key for a repo that was never quarantined:** the function's
PRE-EXISTING same-identity gate (`directPathIdentity(parsed.repoPath) !== directPathIdentity(entry.repoPath)
→ return entry unchanged`) already restricts every fold in this function — tokens AND, now, keys — to a
record that is CONFIRMED to be the SAME repoPath identity as the entry already being written. The keys
being folded are therefore never a foreign identity's keys; they are this SAME already-quarantined
entry's OWN historical secondary keys, being carried forward rather than originated.

**Why this is fail-closed-consistent, not merely loss-prevention:** a kept-unreadable file's own
`resolvedKey`/`resolvedKeys` would already have been picked back up and RE-ARMED at the very next boot
(PASS 1/1b's own `secondaryKeysToAttempt` loop reads them straight off the same on-disk bytes this
chokepoint reads). This fix only makes a RUNTIME write preserve what a REBOOT would already have done —
it never introduces a NEW source of truth, and never arms anything a reboot of the unmodified file
wouldn't also have armed.

### Do not

- Do not drop the same-identity gate to "simplify" this fold — it is the entire reason this can never
  cross-contaminate a foreign identity's keys into `entry`.
- Do not fold the on-disk keys WITHOUT excluding `entry`'s own current key first — an unfiltered fold can
  write a record's own current key into its own `resolvedKeys` (observed directly in this card's own
  repro output, via a pre-existing, unrelated `isInformativeKey` fallback quirk that self-references a
  fresh entry's own key) — harmless at the point it's later re-attempted (`secondaryKeysToAttempt` filters
  by `anchorKey` too), but confusing noise worth excluding at the source.
- Do not assume the broadened early-return guard (`resurrectable.length>0 || onDiskKeys.length>0`) is
  equivalent to the old one (`resurrectable.length>0` alone) — a record with keys to fold but no NEW
  token to resurrect (e.g. the in-memory and on-disk token sets already coincide) must still trigger the
  union, or the key-only case silently reverts to the original bug.

### Tests

`merge-quarantine-reconcile-fold-150aed7b.mjs` (new, 2 scenarios in one process): `fold-survives-reboot`
(the repro above, now asserting W1 AND W2 both stay blocked after the reboot that follows the
read-failure-then-fresh-raise sequence — the exact fail-open this card closes) and
`human-clear-lifts-all` (continuing from scenario 1's own post-fold state — Y is dual-armed again via the
fold — a SUCCESSFUL human clear of Y, no injection, must lift Y, W1, AND W2 together, immediately and
after a further reboot, with no orphan left armed at either secondary key). `pnpm --filter @loom/daemon
negative-control --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-reconcile-fold-150aed7b.mjs` proves RED (reverted to `HEAD`,
3 of 24 checks fail — the two reboot-survival assertions plus the on-disk resolvedKeys assertion) →
GREEN (restored) → byte-identical clean tree.

### CR follow-up (same card) — two findings

1. **The fold's own key-exclusion filtered by a RECOMPUTED `canonicalRepoLockKey(entry.repoPath)`**, the
   exact anti-pattern `82032b5c`/`97cff6db` already name: a write can target a SECONDARY key via
   `writeMergeQuarantineLatch`'s own `targetKey` param, which can differ from `entry.repoPath`'s own
   recomputed key. Fixed: exclude by `quarantineHashForKey(k) !== path.basename(final, ".json")` instead
   — the key `final` is ITSELF physically filed under right now, regardless of which key the write is
   targeting.
2. **`human-clear-lifts-all` was vacuous** — it drove the clear on the ORIGINAL module, where
   `enterMergeQuarantine(y)`'s own fresh-raise branch only ever arms Y's OWN key in memory; W1/W2 were
   never armed there to begin with, so "W1/W2 ALSO unblocked" could never fail even with the fold
   reverted. Fixed: the scenario now drives the clear on the POST-REBOOT module from scenario 1 (where
   W1/W2 are genuinely armed via the fold-preserved `resolvedKeys`), asserting blocked-before and
   unblocked-after. `pnpm --filter @loom/daemon negative-control --file
   packages/daemon/src/git/merge-quarantine.ts --test
   packages/daemon/test/merge-quarantine-reconcile-fold-150aed7b.mjs --ref 3a9e0027` (pre-150aed7b
   baseline — plain `HEAD` no longer isolates the fold fix once it's committed) now correctly fails the
   scenario's own PRECONDITION (W1/W2 never re-armed after the reboot), not merely the post-clear
   assertion — proving the test is sensitive to the bug, not merely never-armed either way.

## Follow-up 050a4428 — the over-block residual is ACCEPTED (unreachable in production); a candidate fix was REJECTED for introducing a worse, NEW fail-open

Discovered by card 4b06875f round 2 (worker 488af78d) as a FAIL-CLOSED residual, documented inline as an
ACCEPTED RESIDUAL comment pending this card's own investigation. **No fix landed. `merge-quarantine.ts`
is unchanged by this card.** The paragraphs below are kept, lightly trimmed, as the historical record of
what was tried and why each attempt was rejected or found moot — not as a description of current code.

### Step 1 — the original over-block, reproduced via an out-of-band mutation

A hermetic repro against the real compiled module (no mocking otherwise) showed: a dual-armed S [Ks, Kr],
D degraded at Kr with its own CURRENT resolvedKey=Ks (correctly excluded by `excludeLiftedResolvedKey`
when S is cleared, since Ks is one of S's own `liftedKeys`), plus a STALE in-memory
`pendingUnresolvedQuarantines` entry for D carrying a THIRD, genuinely UNRELATED key Kz, manufactured by
an out-of-band `fs.rmSync` of D's own pending-divert file AFTER boot loaded it — standing in for "memory
is stale, disk has since moved on," a shape that needed the out-of-band deletion to construct at all. The
second union's own conflict-guard (`unionQuarantineEntries`'s `symmetricKeyDifference`, gated on BOTH
sides' `informativeKeysFor` being non-empty) never engaged, because `toPersist`'s own informative-key set
was empty — so the plain legacy "one side undefined -> take the other" rule resurrected Kz
unconditionally. Measured consequence: a genuinely unrelated REAL repo Z whose own canonical key happened
to equal the resurrected Kz was reported QUARANTINED after a reboot — a pure over-block, fail-closed
only; nothing under-blocked.

### Step 1b — re-deriving reachability WITHOUT the out-of-band mutation: NONE FOUND

The Lead's own question: is there a PRODUCTION path (never an out-of-band test hack) that unlinks,
renames, or rewrites a pending-divert file while leaving its OWN (or an UNRELATED) surviving
`pendingUnresolvedQuarantines` entry stale/dangling? A full audit of every site that touches a
pending-divert file's disk bytes found none:

1. **All 9 `writePendingDivertFile(` call sites** (`protectOccupantContentBeforeDelete`,
   `consumeMatchedPendingsIntoArmedEntry`'s `foreignGroups`, `mergeTokenIntoPendingEntries`,
   `mintPendingDivert`, `divertRaiseEntry`, `rewriteOrphanLatchFilesAfterPartialClear`,
   `clearTokenFromPendingIndices`, the partial-clear dual-tracked-twin rewrite) each either update
   `pendingUnresolvedQuarantines` in the SAME call immediately before/after the write, re-insert the
   exact unchanged object when nothing changed, or match by OBJECT REFERENCE (never content/identity) —
   never leaving a surviving entry's own array slot stale while its file is rewritten to something else.
2. **`deleteSourceLatchIfSuperseded`** explicitly refuses to unlink a filename any surviving
   `pendingUnresolvedQuarantines` entry still names (`if (pendingUnresolvedQuarantines.some((p) =>
   p.sourceFile === sourceFile)) return true`).
3. **Every sweep/unlink helper** (`sweepOwnLatchFileUnlessOwnedElsewhere`,
   `sweepOrphanLatchFileIfUnreferenced`, `unlinkLatchFileConfirmed`) gates on
   `physicalOwnerRepoPaths`/`survivingSharedClaimRepoPaths`, both of which scan
   `pendingUnresolvedQuarantines` for ANY surviving entry naming that filename — not just the one being
   removed — before any unlink, and every call site removes the entry being cleared from memory FIRST.
4. **`rewriteOrphanLatchFilesAfterPartialClear` / `orphanRewriteOwnershipConfirmed`** was initially the
   one genuine candidate found independently — the SAME shape as card 29fe2372 (an orphan-reference
   rewrite that can't tell "this call's own identity" from "a different, independent record merely
   sharing that identity"). It is **already fixed on main**: layer 2, `anotherLiveEntryOwnsFile`, scans
   `pendingUnresolvedQuarantines` for any OTHER live entry (object-reference-distinct from the one being
   written) owning that exact filename, and refuses the rewrite if one exists.
5. **PASS 1b** builds `pendingUnresolvedQuarantines` fresh from a disk scan once per boot, and every
   write it performs is paired with its own `replaceEntryEverywhere` — memory and disk are consistent at
   the end of boot.
6. **`divertRaiseEntry`'s own write over an existing pending file** splices the matched OLD entries out
   of the array BEFORE writing, pushing the NEW merged entry back only after a successful write — or, on
   failure, leaves memory AHEAD of disk (see Step 2 below), never behind it.

**Conclusion: the Step 1 over-block is ACCEPTED as unreachable without an out-of-band mutation.** It
stays fail-closed, unfixed, exactly as main already behaves.

### Step 2 — the rejected fix ("arm 2"): reject when the first union's own informative-key set is empty

A candidate fix was drafted: capture the FIRST (disk-reconciled) union's own aggregate informative-key
set before the second (in-memory-sibling) union runs, and reject any resolvedKey/resolvedKeys value from
the second union whenever that first set is empty — the condition under which
`unionQuarantineEntries`'s own conflict-guard never engages. **REJECTED at Code Review (7b35b79f),
MAJOR 1**: this cannot distinguish a genuinely stale sibling (Step 1's shape) from a sibling that is the
SOLE SURVIVING COPY of a dual-armed twin's own secondary key, which is exactly what
`mintPendingDivert`/`divertRaiseEntry`'s own TRIPLE-FAULT path produces — a real, nameable production
path, not a contrived one:

`enterMergeQuarantine`'s `existing` branch (merge-quarantine.ts, the divert calls inside the
`mustDivert`/`"unreadable"` arms) diverts a raise into a dual-armed `existing` entry via
`divertRaiseEntry(baseEntry)`, which routes to `mintPendingDivert` (no prior same-identity pending record)
or its own inline merge-and-write. EITHER path can TRIPLE-FAULT on a genuine, ordinary `fs` I/O failure —
`writePendingDivertFile` (plain `fs.openSync`/`writeSync`/`renameSync`, no test gating) fails (ENOSPC,
EACCES, or a transient Windows `EBUSY` from an AV/indexer lock) AND `attemptDivertSafetyTmpFallback`
(also plain fs calls) ALSO fails — landing at the "Triple fault — nothing durable to re-point to; keep
the pre-existing (accepted-residual) shape" branch: `pendingUnresolvedQuarantines.push({entry,
sourceFile})`, an in-memory-ONLY entry carrying the twin's own genuinely-informative secondary key, with
ZERO backing file ever written anywhere. A LATER, same-identity `protectOccupantContentBeforeDelete`
call whose own freshly-read content carries no resolvedKey of its own (so the first union's own
informative-key set is empty, by genuine coincidence rather than staleness) would — under arm 2 — reject
that memory-only key too, silently dropping real, currently-enforced protection for the twin's own
secondary key. Per 4b06875f/883e29bc, `resolvedKey` is not decorative: it IS the post-reboot enforcement
mechanism for a dual-armed twin's own secondary key, so dropping it is a genuine, NEW fail-open — worse
than the accepted over-block it would have fixed.

Proven via a hermetic scenario built from the genuine triple fault (no out-of-band mutation — both the
read failure forcing the divert and the two divert-write failures are injected through the EXISTING
`fs.openSync`/`readFileSync` monkeypatch seams already established in
`packages/daemon/test/merge-quarantine-raise-protect-failure.mjs`, the SAME technique its own
`dd34da46/item3` and `EXISTING-BRANCH coverage` scenarios already use): **"CARD 050a4428,
MEMORY-ONLY-KEY GUARD"**. Step 1 establishes the triple fault (a dual-armed d3 [K3, Kw3], divert into it
fails on both writes). Step 2 raises an unrelated y3, which finds d3 degraded-occupying y3's own key with
ordinary, successfully-readable, no-resolvedKey content — exercising the SECOND union against the
Step-1 memory-only entry with no out-of-band step. On **main**: Kw3 survives in the protective copy, and
(after removing d3's own original physical file — a genuinely redundant, independent source of Kw3 that
the divert never touched, so the reboot check isolates the mechanism under test rather than being masked
by it) a real repo at Kw3 stays blocked after a reboot. A **surgical control** (arm 2 applied temporarily,
rebuilt, reverted byte-identical before commit) turned BOTH of those checks RED — confirming the Code
Review's own concern was real.

### Correcting a false claim from an earlier draft of this record

An earlier draft of this Follow-up asserted "`resolvedKey`/`resolvedKeys` are additive, defensive
over-blocking only... never the sole carrier of D's own real enforcement." **That claim is FALSE and is
retracted.** The MEMORY-ONLY-KEY GUARD scenario above is a direct counter-example: after the triple
fault, `resolvedKey` genuinely IS the sole surviving record of Kw3's own enforcement once the twin's
original physical file is gone — losing it is a real loss of enforcement, not merely "less defensive
over-blocking." Per 4b06875f ("keep a resolvedKey-armed twin blocking its key after a reboot") and
883e29bc, `resolvedKey` is load-bearing POST-REBOOT ENFORCEMENT for a dual-armed twin's own secondary key.
Any future fix attempt in this area must not re-derive the "purely additive" framing as a safety
argument — it is exactly backwards.

### Decision

Revert the fix attempt entirely — `merge-quarantine.ts` is byte-identical to its pre-card state. Keep
only the MEMORY-ONLY-KEY GUARD scenario (`packages/daemon/test/merge-quarantine-raise-protect-failure.mjs`),
proven GREEN on main and RED against the rejected arm-2 control, as a standing regression guard against a
future attempt reintroducing the SAME fail-open. No scenario for the Step 1 over-block itself was kept in
the suite — it reproduces only via the out-of-band mutation this record's own Step 1b found no production
substitute for, so a committed scenario for it would be a scenario for an UNREACHABLE shape, not a
regression guard.

### Interaction with card 398f476c

Unaffected either way. 398f476c is about a union being structurally unable to represent more than one
identity's own queryability at once — a full identity-model redesign; this card's own residual and
rejected fix never touched that scope and neither blocks nor needs it.

### Do not

- **Do not reject a sibling's resolvedKey/resolvedKeys value based on the disk (first-union) side being
  empty** — it cannot distinguish a genuinely stale sibling from the SOLE SURVIVING, memory-only copy of
  a dual-armed twin's own secondary key left by a real triple fault (see "CARD 050a4428,
  MEMORY-ONLY-KEY GUARD" in `merge-quarantine-raise-protect-failure.mjs`) — rejecting on that basis is a
  NEW fail-open, strictly worse than the accepted over-block it would fix.
- Do not revert to the EARLIER "blanket zero" design either ("force `resolvedKey`/`resolvedKeys` to
  `undefined` whenever this call's own adjudication excluded anything") — it fails open for the SAME
  reason, one step earlier: it cannot tell a legitimate key the disk-reconciled side genuinely carries
  apart from one that was adjudicated away.
- Do not treat `resolvedKey`/`resolvedKeys` as "purely additive, defensive over-blocking, safely
  droppable" — see the correction above. Any future design in this area must show it preserves a
  dual-armed twin's own secondary-key enforcement across a genuine triple fault, not just across an
  ordinary clear.
- Do not re-attempt a fix for the Step 1 over-block without first re-deriving Step 1b's own reachability
  audit fresh against whatever the code looks like by then — it is judgment-curated by reading each call
  site, not a filename grep, and a future change to any of the sites named above could reopen the gap.

## Follow-up d524d1c4 — `divertRaiseEntry`'s own merge branch dropped the INCOMING raise's resolvedKey/resolvedKeys entirely (a real fail-open, FIXED)

Found by Code Review `7b35b79f` (card `050a4428`), from a code read: `divertRaiseEntry`'s merge branch
(`indices.length > 0`, ~L2543-2561) built `merged` as `{...base.entry, tokens, orphanLatchFiles,
armedKeys, contributorRepoPaths, provenanceUnknown, provenanceTracked}` — every field is unioned across
`all` (`base.entry`, every `others` entry, and the incoming `entry`) EXCEPT `resolvedKey`/`resolvedKeys`,
which simply rode through unchanged from `base.entry`'s own spread. The incoming raise's own informative
resolvedKey (and every OTHER matched entry's) was silently dropped whenever it differed from
`base.entry`'s. Unlike the ACCEPTED Step 1 residual above, this function never calls
`unionQuarantineEntries` in any form (its own doc comment: "Built by hand, never via
`unionQuarantineEntries`") — this is a structural omission of the resolvedKey/resolvedKeys fields from
the hand-rolled union, not a narrower edge case of an existing adjudication rule.

**Sibling defect, fixed separately (card `00fd29d7`):** `mergeTokenIntoPendingEntries` — the `!verified`
twin of this same hand-rolled merge, reached from `enterMergeQuarantine`'s own pending-merge branch
instead of the `existing`/write-fault paths this function serves — had the IDENTICAL structural omission.
See "Follow-up 00fd29d7" below for its own repro and fix.

### Confirmed real, reproduced with ZERO out-of-band mutation to establish the premise

A production sequence, no triple fault needed (unlike the MEMORY-ONLY-KEY GUARD above, an ORDINARY
single read fault suffices): (a) D is dual-armed `[K,Kw]` (its own physical slot K, legacy
`resolvedKey=Kw`) via the standing protect/carry-forward mechanism (Follow-up 4b06875f) or boot's PASS 1
migrate dual-arm; (b) a genuinely independent raiser later finds D degraded-occupying ITS OWN write
target, and `protectOccupantContentBeforeDelete` durably mints a separate, reference-distinct pending
record for D's identity (no resolvedKey) at D's own deterministic pending filename — ordinary,
successfully-readable content, no injection; (c) D is raised again (`enterMergeQuarantine`'s `existing`
branch) and this raise's own write to `final` hits a single ordinary I/O fault (EACCES/EBUSY — an
AV/indexer lock, per this module's own documented hazards) — `mustDivert=true`,
`divertRaiseEntry(baseEntry)` runs with `baseEntry.resolvedKey=Kw`, `indices.length>0` matches (b)'s
record, the merge branch drops `Kw` from the written record; (d) D's own original token at `final`/K
later gets legitimately cleared (its now-redundant physical copy removed, mirroring the isolation step
below); (e) next boot: `Kw`'s own real repo is completely unprotected. Hermetic repro against the real
compiled module, direct final-file removal as the isolation step (same technique, same justification, as
the MEMORY-ONLY-KEY GUARD scenario — the premise itself needed zero out-of-band mutation): "CARD
d524d1c4, RESOLVEDKEY SURVIVES A MERGE-BRANCH DIVERT" in `merge-quarantine-raise-protect-failure.mjs`.
RED on main (`negative-control`, reverted `merge-quarantine.ts` to HEAD), GREEN restored, clean tree.

### The fix — ALWAYS-UNION-WHEN-INFORMATIVE across every matched entry plus the incoming one

Lead ruling: do NOT reuse `unionQuarantineEntries`'s `explicitResolvedKeyRule` (its symmetric-difference
exclusion adjudicates a KNOWN-stale side against a fresh one — 4b06875f's own context, and 050a4428's own
analysis of why it excludes the symmetric difference). On this path, NO input is known stale — the
existing pending record(s) and the incoming raise are all current knowledge of the SAME identity — so
excluding a conflicting key would just be a NEW way to drop one, the exact fail-open this card fixes.
Instead: `resolvedKeys` is the deduplicated union of every informative key (scalar `resolvedKey` UNIONED
with the array `resolvedKeys`, via the existing `informativeKeysFor` helper) across ALL of `all`
(`base.entry`, every `others` entry, the incoming `entry`), fed through the existing
`unionResolvedKeysRetaining` cap/eviction helper for consistency with every other call site that
accumulates this field. The scalar `resolvedKey` is kept only when every input that carries one agrees
(all defined scalars are `===`); otherwise it is left `undefined`, with every key still surviving in
`resolvedKeys`.

`excludeLiftedResolvedKey`/`excludeLiftedResolvedKeys` do NOT apply on this path, deliberately: both
exist to stop a protective copy read from `final` from carrying forward a key the SAME operation is about
to overwrite `final` with, or `final`'s own physical key (Follow-up 4b06875f) — `divertRaiseEntry` never
touches `final` at all (its own doc comment: "Never touches `final` itself"), so neither exclusion's
premise ever arises here; there is nothing to subtract. A literal self-reference surviving into
`resolvedKeys` (e.g. a matched entry's own resolvedKey happening to equal some OTHER key in the same
union) is harmless regardless of this: every reader filters self-reference at ARM time, via
`isInformativeKey`/`secondaryKeysToAttempt`'s own anchor-key check, never at write time — confirmed by
code and empirically (the matrix reboot check below re-arms a `resolvedKeys`-only record, no scalar
needed, at every key it carries).

### Confirmed from the code: a `resolvedKeys`-only record (no scalar) IS re-armed at boot for every key

`secondaryKeysToAttempt`/`informativeKeysFor` (the shared helpers every boot-time arm site — PASS 1's
primary-arm secondary loop and its degraded-divert branch alike — already route through) union the scalar
AND the array, never "array else scalar"; neither requires a scalar to be present. Re-verified
empirically, not just by inspection: the matrix scenario below produces a `resolvedKey:undefined,
resolvedKeys:[Y,Z,W]` record, and all three of Y/Z/W's own real repos stay blocked after a reboot.

### Tests

1. **"CARD d524d1c4, RESOLVEDKEY SURVIVES A MERGE-BRANCH DIVERT"** — the repro above, committed. RED on
   main (`negative-control`), GREEN after the fix, clean tree restore.
2. **"CARD d524d1c4, NO-KEY-DROPPED MATRIX"** — `indices.length === 3` (never just 1), M1 scalar-only
   (`Y`), M2 array-only (`[Z]`), M3 no key, incoming scalar `W` (disagrees with M1's `Y`). Asserts the
   output's informative-key set ⊇ `{Y,Z,W}`, the scalar is `undefined` on disagreement, and M2/M3's own
   sourceFiles are folded into `orphanLatchFiles`. **M1/M2/M3's own keys are DELIBERATELY DISJOINT** — a
   first draft gave M2 `resolvedKeys:[Z,Y]` (overlapping M1's own `Y`), and boot's own PRE-EXISTING,
   correct secondary-key-arming (`armQuarantineKey`/`unionQuarantineEntries`, unrelated to this card)
   silently unioned M1 and M2 together AT ARM TIME, before `divertRaiseEntry` ever saw them — collapsing
   the intended 3-input matrix down to 2 distinct objects while `indices.length` still read 3 (two array
   slots pointing at the SAME merged object). This is boot's own pre-existing behavior working correctly,
   not a defect — but it is a real trap for constructing a "3 genuinely independent matched entries"
   fixture: use disjoint keys, or verify distinctness explicitly.

   **CR `3555435b` round 2, three test-only findings, all fixed:**
   - **The distinctness precondition must read IN-MEMORY state, never on-disk bytes.** Boot's arm-time
     union (when it fires) happens entirely in memory and never rewrites either source file — reading
     m1Path/m2Path's own bytes passes identically whether or not they were actually unioned, so a
     file-content check cannot catch the collapse it documents. Fixed: assert via
     `listActiveMergeQuarantines()` instead — two separate live entries for d5's identity, one carrying
     ONLY M1's own token and one carrying ONLY M2's own token (a single merged entry would carry both).
     Proven to actually discriminate: temporarily reverted the fixture to the overlapping `[Z,Y]` shape
     (no source change) — the precondition goes RED; restored byte-identical — GREEN again.
   - **The Y/Z reboot checks didn't discriminate the fix on main.** `divertRaiseEntry` only ever rewrites
     `base.sourceFile` (`m1Path`); `others`' own sourceFiles (`m2Path`, `m3Path`) are folded into
     `orphanLatchFiles` but their ORIGINAL bytes are never swept — so Z would trivially re-arm from M2's
     own still-intact orphan file regardless of whether the merge itself carried Z forward. Fixed:
     `m2Path`/`m3Path` (and `K5FinalPath`, as before) are removed before the reboot, so only the merged
     record at `m1Path` survives — `negative-control --ref HEAD~2` against the genuinely pre-fix source
     now shows Z's AND W's own reboot checks going RED (not just W's). **Y's own reboot check still does
     NOT discriminate even after this fix** — Y is `base`/M1's own key, which the ORIGINAL, buggy
     `{...base.entry}` spread always kept unconditionally regardless of this card's bug (the bug only
     ever dropped `others`'/the incoming entry's own keys, never `base`'s). Confirmed empirically: the
     SAME `--ref HEAD~2` run shows Y's reboot check still PASSING. Relabeled honestly as a sanity check
     (matching this file's own established `(sanity, NOT hazard-discriminating...)` convention), per the
     CR's own stated fallback.
   - A leftover "Z+Y from M2" in one check's own label (stale text from before the disjoint-key fix,
     M2 only ever carried `[Z]`) corrected to "Z from M2".
3. **"CARD d524d1c4, SCALAR KEPT WHEN EVERY INFORMATIVE INPUT AGREES"** — NOT a repro of this card's own
   bug (CR `3555435b` round 2, nitpick): it passes on main too, by construction — a single matched entry
   that IS `base` has its own scalar trivially kept by the ORIGINAL, buggy `{...base.entry}` spread
   regardless of this card's fix. It instead guards against a DIFFERENT, hypothetical regression — some
   future change that drops the scalar to `undefined` any time a union occurs at all, even when every
   informative input agrees on the same key — which the matrix scenario above cannot catch (it only ever
   disagrees).
4. The 050a4428 MEMORY-ONLY-KEY GUARD scenario, every 4b06875f probe, and every `d2582692`-tagged
   scenario in `merge-quarantine-raise-protect-failure.mjs` stay green (same file, re-run in full). All
   42 `merge-quarantine*.mjs` files run serially, exit 0. The touched file re-run under both
   `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1` — the FIRST attempt at the matrix scenario above
   (before the disjoint-key fix) failed under BOTH states when run in isolation, confirming the earlier
   single-env failure seen when run as part of the full file was the SAME fixture bug, not a genuine
   `LOOM_DEV`-conditional behavior (`merge-quarantine.ts` reads neither `LOOM_DEV` nor `isLoomDev()` at
   all) and not even deterministic cross-scenario state bleed — it reproduced standalone, in isolation,
   under both env states identically, once the overlapping-key fixture bug was present.

### Do not

- Do not reuse `unionQuarantineEntries`'s `explicitResolvedKeyRule` for this merge branch — its
  symmetric-difference exclusion assumes one side is known-stale, which is never true here; applying it
  would just be a different-shaped version of the SAME fail-open this card fixes.
- Do not route this merge branch's resolvedKey/resolvedKeys computation through
  `excludeLiftedResolvedKey`/`excludeLiftedResolvedKeys` — `divertRaiseEntry` never touches `final`, so
  neither exclusion's premise (a protective copy about to be superseded by this SAME operation's own
  fresh write to `final`) ever applies here.
- Do not construct a "3 genuinely independent matched pending entries" fixture with overlapping
  informative keys across the matched entries — boot's own secondary-key arming will silently union them
  together before `divertRaiseEntry` ever runs, collapsing the intended input count. Use disjoint keys,
  or assert distinctness explicitly (see Test 2 above).

## Follow-up 00fd29d7 — `mergeTokenIntoPendingEntries` had the IDENTICAL drop, made durable by a later partial clear (FIXED)

Found and reproduced by Code Review `3555435b` (card `d524d1c4`'s own follow-up), against the compiled
dist, with zero out-of-band fault injection. `mergeTokenIntoPendingEntries` — the `!verified` twin of
`divertRaiseEntry`'s own merge branch above, reached from `enterMergeQuarantine`'s pending-merge branch
whenever the raising `repoPath` is itself still unresolvable (never via the `existing`/write-fault paths
`divertRaiseEntry` serves) — built `merged` as `{...base.entry, tokens, orphanLatchFiles,
contributorRepoPaths, provenanceUnknown, provenanceTracked}`: the SAME structural omission of
resolvedKey/resolvedKeys, dropping every non-base matched entry's own informative key(s) unconditionally.

Unlike the `divertRaiseEntry` shape, a single raise is enough to reach this: `enterMergeQuarantine`'s own
`!verified` branch routes straight into `mergeTokenIntoPendingEntries` whenever one or more pending
entries already match the raising repoPath's own identity — no dual-arm, no write fault, no `existing`
lookup involved at all.

### Why the drop becomes DURABLE, not just a one-boot miss

A dropped key here is worse than `divertRaiseEntry`'s own (pre-fix) drop in one respect: a LATER partial
clear of one of the merged entry's own tokens (`clearMergeQuarantineByToken` → `clearTokenFromPendingIndices`
→ `rewriteOrphanLatchFilesAfterPartialClear`) durably REWRITES every OTHER matched entry's own folded
`orphanLatchFiles` member with the SAME (already key-less) merged content — so even a sibling pending
record whose own original on-disk bytes still named the dropped key gets physically overwritten, and the
key is gone from every surviving copy, not just the merged one. A reboot after that partial clear
unblocks the dropped key's own real repo even though the token that actually owned it was never cleared.

### The fix — the SAME shared helper `unionInformativeResolvedKeys`, extracted from the `divertRaiseEntry` fix above

Rather than re-deriving a second, parallel ALWAYS-UNION-WHEN-INFORMATIVE implementation, `divertRaiseEntry`'s
own computation above was extracted into one shared helper (`unionInformativeResolvedKeys`, in
`merge-quarantine.ts`) and both hand-rolled merge branches now call it — `divertRaiseEntry` unchanged in
behavior (refactor only), `mergeTokenIntoPendingEntries` newly correct. Same rule, same exclusions that do
NOT apply (`explicitResolvedKeyRule`, `excludeLiftedResolvedKey(s)` — see the helper's own doc comment and
the "Follow-up d524d1c4" section above for why neither premise ever arises on either of these two paths):
no input to `mergeTokenIntoPendingEntries` is known-stale (every matched pending entry is matched purely
by `directPathIdentity` against the SAME still-unresolvable raise, exactly like `divertRaiseEntry`'s own
matched set — current knowledge of one identity, never a disk re-read of a possibly-superseded copy), and
this function never touches `final` either (its own doc comment: it never WRITES a new arm of its own at
a canonical key — though a matched entry it absorbs can already BE armed elsewhere, as an 883e29bc
boot-diverted twin; see "Follow-up 3d27c045" below for the gap that left open), so
`excludeLiftedResolvedKey(s)`'s premise (a protective copy about to be superseded by THIS SAME operation's
own fresh write to `final`) never arises here either.

### Tests

Committed in `merge-quarantine-raise-protect-failure.mjs` (`*** CARD 00fd29d7 ***`-tagged): d7 =
`r7/gone-subdir7` is genuinely unresolvable; M1 (no key, enteredAt 1000) and M2 (resolvedKeys=[Z7],
enteredAt 2000) are two independent pending-divert records for d7's own identity. A fresh raise on d7 (via
`enterMergeQuarantine`, still unresolvable) is confirmed to route into `mergeTokenIntoPendingEntries`
(never `divertRaiseEntry`); the merged record (at M1's own sourceFile) is asserted to carry Z7 forward.
`clearMergeQuarantineByToken` then clears M1's own token (a PARTIAL clear — two tokens remain outstanding),
confirmed to durably rewrite M2's own folded orphan file with the SAME reduced content (the mechanism this
card's own durability hazard depends on) — both copies are asserted to still carry Z7 after the clear. A
fresh boot-module reimport + `reenterMergeQuarantinesAtBoot` then confirms Z7's own real repo stays blocked
after a reboot, even though the token that actually owns Z7 (`m2-token`) was never cleared.

Proven RED on `main` (sha `40142d6b` — main's own tip immediately before this follow-up's own fix landed
as `a7add825`) and GREEN after, via `scripts/negative-control.mjs --ref main`: exactly the three
`*** CARD 00fd29d7 ***`-tagged assertions fail pre-fix (3 FAILURE(S), nothing else), pass post-fix, tree
restored clean. All 42 `merge-quarantine*.mjs` files run serially, exit 0 — including the
`050a4428`/`4b06875f`/`d2582692`-tagged scenarios and the `divertRaiseEntry`-side `d524d1c4` scenarios
(Follow-up above), confirming the refactor left that function's own behavior unchanged. The touched test
file re-run under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1` — identical, since
`merge-quarantine.ts` reads neither.

### Do not

- Do not re-derive a second, parallel resolvedKey/resolvedKeys union for `mergeTokenIntoPendingEntries` —
  call `unionInformativeResolvedKeys` (the same helper `divertRaiseEntry` now calls too), or the two
  hand-rolled merge branches drift apart again exactly the way this card's own bug diverged from the
  `divertRaiseEntry` fix in the first place.
- Do not assume a single matched pending entry is enough to prove this fix — the drop is invisible with
  only one matched entry (`base`'s own fields were never the ones either bug dropped); use at least two
  matched entries carrying DISJOINT informative keys (see the `d524d1c4` matrix scenario's own "Do not" on
  overlapping keys above — the same boot-time secondary-key-arming collapse applies here too).
- Do not skip the partial-clear step when verifying this fix — a repro that only checks the merged
  record's own immediate write (never the DURABLE drop a later `rewriteOrphanLatchFilesAfterPartialClear`
  can cause) proves a narrower claim than the one this card's own title makes.

## Follow-up 3d27c045 — `mergeTokenIntoPendingEntries` dropped `armedKeys` too, orphaning an 883e29bc boot-diverted twin's OTHER key — durably (FIXED)

Found and REPRODUCED by Code Review `533c5698` of this card (`00fd29d7`), 2026-10-17. The root cause is
PRE-EXISTING on `main` (not introduced by `00fd29d7`'s own resolvedKey/resolvedKeys fix above); that fix's
correct behavior WIDENS this gap's post-reboot blast radius, since the merged record now correctly carries
every matched twin's own `resolvedKey(s)` forward — exactly the signal the stale residue this gap leaves
behind needs to durably re-arm from at the next boot.

`mergeTokenIntoPendingEntries` built `merged` as `{...base.entry, tokens, orphanLatchFiles,
contributorRepoPaths, provenanceUnknown, provenanceTracked, resolvedKey, resolvedKeys}` — no `armedKeys`
field at all — even though its own doc comment already names (`@decision 64283e06`) that a matched entry
can be an 883e29bc boot-diverted TWIN: the SAME object reference already armed in `activeQuarantines`
under its own `resolvedKey(s)`. `64283e06` fixed HALF of that shape (routing every matched entry through
`replaceEntryEverywhere` so the ACTIVE side's map slots get re-pointed onto `merged`, by VALUE, regardless
of `armedKeys`) but left the OTHER half open: `merged.armedKeys` itself stays `undefined`, so once it sits
in `activeQuarantines` at two (or more) keys, nothing records that fact ON THE ENTRY ITSELF. Two
clear-path helpers walk "every key this entry is armed under" by reading `entry.armedKeys` directly, with
a `entry.armedKeys?.length ? entry.armedKeys : [key]` fallback to the ONE key already in hand when it's
empty: `clearMergeQuarantineByKey`'s own `keysToLift`, and `clearActiveEntryTokenAtKey`'s own
`armedKeysForEntry` (merge-quarantine.ts). `clearTokenFromPendingIndices`'s own loops do NOT share this
shape — they read `pending.entry.armedKeys ?? []` with no `[key]` fallback at all, so an empty `armedKeys`
there is just zero iterations, never a wrong one; that function is also never reached for THIS shape in
the first place, since a twinned merged entry is always routed through the ACTIVE side (see below).

### Why this is a DURABLE, cross-reboot loss, not a one-boot miss

A fresh raise on a still-unresolvable identity with two or more matched 883e29bc twins merges them all via
`mergeTokenIntoPendingEntries`, folding every non-base matched entry's own `sourceFile` into the merged
record's `orphanLatchFiles` — never deleting them; they survive on disk as inert residue, kept in sync by
every PARTIAL clear's own `rewriteOrphanLatchFilesAfterPartialClear`. Clearing every outstanding token (one
`clearMergeQuarantineByToken` call per token) routes EVERY one of those clears through the ACTIVE side
(`clearMergeQuarantineByToken`'s own `activeMatches`/`nonTwinPendingIndices` split correctly recognizes the
merged entry as a twin and excludes its pending reference from the PENDING clear path every time — it is
never a one-off), landing on whichever ONE key `Map` iteration visits first for the merged entry (insertion
order — stable across every clear call on the same entry). The first three (partial) clears stay IN-MEMORY
consistent regardless of the bug, since `replaceEntryEverywhere` re-points every key BY VALUE — but each
one's own write loop (`clearActiveEntryTokenAtKey`, gated by the SAME `armedKeys?.length ? armedKeys :
[key]` fallback) durably writes the reduced token set to ONLY that one key's own physical final, creating a
brand-new on-disk latch file there for the first time (no physical per-key file existed before — an
883e29bc degraded-divert boot-arm never writes one of its own). The FOURTH, LAST clear reaches
`clearMergeQuarantineByKey`'s full-lift branch — pre-fix, `keysToLift` collapses to that SAME one key, so
only its own `activeQuarantines` slot (and its own physical final) gets deleted. The entry's OTHER armed
key is NEVER deleted from `activeQuarantines`: it survives, in-process, holding a stale (should-be-empty)
token set, so the real repo at that key stays quarantined in-process for as long as the process keeps
running — and because that surviving map slot still points at an object whose `orphanLatchFiles` still
names the two orphan residue files, `clearMergeQuarantineByKey`'s own unreferenced-orphan sweep
(`sweepOrphanLatchFileIfUnreferenced`) finds them STILL referenced and leaves them on disk too, each one's
own on-disk `tokens` field frozen at whatever it held before the final clear (the already-tombstoned LAST
token, never actually removed from their bytes). **A daemon RESTART does not clear any of this — it makes
it WORSE:** PASS 1 re-reads each surviving orphan file at boot, and because it ALSO still carries BOTH
twins' own `resolvedKeys` forward (00fd29d7's own correct fix), it re-arms BOTH real repos, durably, from a
token that was already fully cleared in the prior process — measured directly (see Tests below): BOTH
reboot assertions fail pre-fix, not just the one left stuck in-process.

### The fix — the SAME shared helper family, extracted the same way `unionInformativeResolvedKeys` was

`armedKeys` is now unioned via a new sibling helper, `unionArmedKeys` (in `merge-quarantine.ts`, next to
`unionInformativeResolvedKeys`): the deduplicated union of every matched entry's own `armedKeys`,
normalized back to `undefined` when empty (never a cosmetic `armedKeys: []` on an ordinary pending-only
merge that was never armed anywhere — `divertRaiseEntry`'s own long-standing rule for this exact field).
`divertRaiseEntry`'s own hand-rolled computation (unchanged in behavior) was ALSO switched to call this
shared helper, so the two merge branches can no longer drift apart on this field the way they already had.
Post-fix, `keysToLift` correctly carries BOTH keys, so the full-lift clear deletes both `activeQuarantines`
slots AND correctly finds the two orphan residue files unreferenced, sweeping them too.

### Tests

Committed in `merge-quarantine-raise-protect-failure.mjs` (`*** CARD 3d27c045 ***`-tagged): d9 =
`r9/gone-subdir9` is genuinely unresolvable; M1 (no key, enteredAt 1000, becomes `base`), M2
(resolvedKeys=[Z9], enteredAt 2000) and M3 (resolvedKeys=[W9], enteredAt 3000) are three independent
pending-divert records for d9's own identity — M2 and M3 each graduate into a genuine 883e29bc twin at
boot. A fresh raise on d9 merges all three via `mergeTokenIntoPendingEntries`; the merged record is
asserted to carry BOTH Z9 and W9 forward in its own `armedKeys`. A PARTIAL clear (only m2's and m3's own
tokens, two of the four outstanding) is asserted to leave BOTH Z9's and W9's own real repo blocked, both
in-process AND after a fresh boot-module reimport + `reenterMergeQuarantinesAtBoot` — pinning that an
ordinary partial clear must never OVER-lift either key, the opposite failure from this card's own bug.
Clearing the remaining two tokens (the fourth/last clear) is then asserted, in-process, to leave NEITHER
Z9's nor W9's own real repo blocked, and to leave no stale entry (pending or an orphaned active arm) for
d9's identity — then a second fresh boot-module reimport confirms neither real repo is re-blocked after a
reboot either.

Proven RED on `main` (this card's own `00fd29d7` fix, sha `a7add825`, already applied — `merge-quarantine.ts`
was byte-identical between `a7add825` and `main`'s own tip at verification time) and GREEN after, via
`scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-raise-protect-failure.mjs --ref main`: exactly the five
`*** CARD 3d27c045 ***`-tagged assertions fail pre-fix (5 FAILURE(S), nothing else — every `00fd29d7`/
`d524d1c4`/`050a4428`/`4b06875f`/`d2582692`-tagged scenario, AND the new partial-clear-then-reboot leg,
stays green in BOTH phases), pass post-fix, tree restored clean. All 42 `merge-quarantine*.mjs` files run
serially, exit 0, under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1` — identical, since
`merge-quarantine.ts` reads neither. `pnpm --filter @loom/daemon guards`: all 30 guards pass.

### Do not

- Do not assume `replaceEntryEverywhere`'s own by-VALUE re-point (`64283e06`) is sufficient to keep a
  merged entry's OTHER armed key(s) alive through a later clear — it keeps the in-memory MAP slots
  consistent, but `clearMergeQuarantineByKey`'s own `keysToLift` and `clearActiveEntryTokenAtKey`'s own
  `armedKeysForEntry` both read the entry's OWN `armedKeys` field directly, with a fallback to the one key
  already in hand — a merge branch that drops that field silently reopens this exact gap at both call
  sites. (`clearTokenFromPendingIndices`'s own loops do NOT share this shape — see the gap's own
  description above for why — do not list it among these helpers again.)
- Do not hand-roll a second `armedKeys` union at a new merge branch — call the shared `unionArmedKeys`
  helper (the same one `divertRaiseEntry` and `mergeTokenIntoPendingEntries` both call), or a future merge
  branch drifts apart from the other two exactly the way `mergeTokenIntoPendingEntries` already had.
- Do not assume this gap is visible with only ONE matched twin — a single armed key collapsing to `[key]`
  via the fallback is indistinguishable from the correct answer; it takes at least TWO twins, each armed
  at a DIFFERENT key, for the drop to manifest as an observably wrong (too-narrow) key set.
- Do not read the surviving key's own in-process stuck state as the whole blast radius — the two orphan
  residue files this card's own repro leaves behind are an independent, SEPARATE consequence (the
  unreferenced-orphan sweep never runs against them either, since the stuck key's own surviving slot still
  "references" them) and are what actually carries the bug across a reboot; a fix (or a future regression)
  that only re-checks the in-process symptom can still miss the durable one.
- Do not touch `clearMergeQuarantineByKey`'s own `keysToLift`/`armedKeysForEntry` fallback-to-`[key]`
  shape as part of this card — the CR that found this gap ALSO found an independent armedKeys-lift
  asymmetry inside `clearMergeQuarantineByKey` itself; that is tracked on its own, separate card.

## Follow-up bfc9356e

Investigate-first card `bfc9356e` (2026-10-17), filed by worker `721c1123` while building `d524d1c4`'s
own fixture: a real `clearMergeQuarantineByToken(d4, "<d4's original token>")` on that exact dual-armed
fixture did not remove `d4`'s own final file and produced an "unconfirmed-kill identity collision"
refusal on a later query. **Verdict: correct fail-closed behaviour, not a bug.**

By the time that call ran, the fixture's active entry was already a UNION of THREE outstanding tokens —
`d4`'s own original, an independent raiser's own token folded in as a contributor by the merge-branch
divert (same mechanism this record's own "FOLLOW-UP (card d524d1c4)" section above describes), and the
re-raiser's own fresh token. `clearMergeQuarantineByToken` is documented compare-and-clear SET semantics:
one call removes ONLY its own token; the repo stays quarantined until the set is empty. Clearing 1-of-3
correctly left the final file in place (content rewritten to the 2-token remainder, never removed) and
left `assertRepoNotQuarantined` (`merge-quarantine.ts:4379`) refusing with its pre-existing
ambiguous-collision clause (built at `merge-quarantine.ts:4390-4402`, governed by `@decision 9a55fb90` /
`@decision abccee85`) — that refusal is unrelated to the clear call itself; the union already had more
than one contributor the instant the re-raise merged with the independent raiser's divert, before any
clear ever ran.

Clearing the REMAINING two tokens (via the same `clearMergeQuarantineByToken`) resolves it cleanly: the
entry is fully lifted, both latch files (the final and the pending-divert twin) are gone, and both repos
report `ok:true`. The mechanism is not stuck — it was simply doing its job of removing one of three.

Pinned by `*** CARD bfc9356e ***` in `merge-quarantine-raise-protect-failure.mjs` (right after the
`d524d1c4` scenario): partial clear stays active + ambiguous (asserted against the real refusal text,
confirmed to carry both the "unconfirmed-kill" and "ambiguous"/"collide" wording `721c1123` described),
full clear resolves cleanly.

## Follow-up 3152ec90

Code Review `7c48d35c` of `3d27c045`: `clearMergeQuarantineByKey`'s own `keysToLift` (`merge-
quarantine.ts:3500`, formerly `3510-3514`) deletes every member of `entry.armedKeys` from
`activeQuarantines` unconditionally — never gated by `entryStillOwnsKey` (`:3475`) the way its own
pending-sibling loop two screens down already is. Once a boot-diverted twin's `armedKeys` goes stale
(the freed key gets reused by an unrelated, later raise U), clearing the stale entry deletes U's own live
map slot.

**Reproduced, and confirmed NOT fail-open.** The safety net: `deleteMergeQuarantineLatchByKey`'s own
per-key protect call (`:1739`, `protectUnincorporatedOccupantBeforeDelete` → `protectOccupantContentBeforeDelete`
at `:2068`) reads the physical content at the stale key, recognizes it belongs to a different identity
(U), and durably copies it aside into a pending-divert record before unlinking the original — `activeMergeQuarantineFor`'s
own lazy-graduation tail then re-arms U on the very next query, in-process and (since the divert is
durable) across a reboot. This is a DELIBERATE invariant (built across `4900c365`/`d2582692`/`d163aef5`/
`63e49ee2` for a different purpose — a write must never destroy a foreign occupant's only durable copy)
but an INCIDENTAL rescue for this bug: it runs beside the unconditional in-memory delete over the same
stale `keysToLift`, not because of it. A SEPARATE, independent guard closes the staleness window across
a reboot: `d163aef5`'s boot-time rule ("never union a degraded entry into a verified sibling's slot")
means a twin's own stale key, once genuinely reused by a verified occupant, is never re-armed into
`armedKeys` after a restart — confirmed empirically (reboot between the free and the reuse never lets
the staleness form at all).

**THE FIX:** `keysToLift`'s non-`key` members are now filtered through `entryStillOwnsKey` — U's own slot
is never touched, not merely rescued. The same filter was applied to two more unconditional-`armedKeys`
reads the card named: `quarantineLatchFileIdsFor` (`:4073`, a stale member would hand out U's own latch
id as d9's), and `clearMergeQuarantineByRecordedPath`'s `activeLiftedKeys` (`:3698`). For `activeLiftedKeys`,
an honest attempt to reproduce a concrete fail-open (a stale member causing `excludeLiftedResolvedKey` to
wrongly strip an unrelated occupant's own `resolvedKey`) did not succeed — every constructible collision
either never forms (the write-side divert machinery already relocates foreign content away from a shared
key before it could coincide) or is pre-empted by `clearMergeQuarantineByKey`'s own fix narrowing which
keys are ever touched in the first place. Fixed anyway, filter-only (narrowing, fail-closed direction),
with no dedicated repro and no new committed fail-open scenario.

This same filter ALSO narrows an existing-but-empty slot out of `touchedFinalBasenames`/the unreferenced-orphan
sweep (Follow-up 78fccd3f, item 2) — fail-closed (a final that still held this entry's content there would
survive and re-arm at the next boot instead of being swept); no path producing that state was found either.

Pinned by `*** CARD 3152ec90 ***` in `merge-quarantine-raise-protect-failure.mjs` (right after the
`3d27c045` scenario): the key assertion is that U's own entry, read via `listActiveMergeQuarantines()`
immediately after the clear and BEFORE any query of its own repo, still carries `armedKeys` including the
stale key — proving the slot was never touched, not merely rescued. Negative-control (`--ref main`): RED
on the new assertions only, GREEN after, tree restored clean. All 42 `merge-quarantine*.mjs` files run
serially, exit 0, under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1`.

## Follow-up 78fccd3f

Code Review `c399729b` of `3152ec90` found `deleteMergeQuarantineLatchByKey`'s own DEFAULT `liftedKeys`
and `enterMergeQuarantine`'s existing-branch raise both built `liftedKeys` UNFILTERED — the same
over-include direction `3152ec90` fixed for `keysToLift` itself. `liftedKeys` feeds only
`excludeLiftedResolvedKey(s)`, so a stale `armedKeys` member surviving there is FAIL-OPEN (it can wrongly
strip a resolvedKey from a protective copy that should have survived).

**Raise path — narrowing-only, fail-open NOT reproduced.** An honest repro attempt (hermetic, in-process,
reusing `3152ec90`'s own twin-plus-stale-key fixture) found no constructible scenario where this site's
own protect call reaches a REAL on-disk foreign occupant to exercise the exclusion on: a boot-graduated
twin's secondary armed key never gets a physical final written at all, and this module's own overlapping
write-side guards (`d163aef5`, `e0192ffb`/`82032b5c`) prevent foreign content from durably coexisting at a
key a stale-but-still-armed twin's OTHER key occupies. THE FIX: this site now calls a new shared helper,
`ownedKeysIncluding(key, entry)` — `key` unconditionally plus every OTHER `armedKeys` member gated through
`entryStillOwnsKey`. Tested directly, via `*** CARD 78fccd3f ***` in `merge-quarantine-raise-protect-
failure.mjs` (the end-to-end protective-copy path can't discriminate filtered from unfiltered here).
Surgical negative control (drop the filter, rebuild): RED on exactly those two assertions; restoring
byte-identical (`cmp`-verified) turned it GREEN.

**Clear path — a genuinely reproduced CRITICAL, found by a second Code Review (of `a57f1e26`), FIXED.**
`deleteMergeQuarantineLatchByKey`'s former DEFAULT had exactly ONE caller — `clearMergeQuarantineByKey`'s
own primary `keysToLift` loop — which deletes every key in `keysToLift` from `activeQuarantines` BEFORE
that loop runs. Re-deriving `liftedKeys` from `entry.armedKeys` against that ALREADY-EMPTIED map made
`entryStillOwnsKey` reject every other key, collapsing `liftedKeys` to the one key in hand and wrongly
keeping a sibling key's own resolvedKey in a protective copy — a reboot then re-blocked an already-cleared
repo. THE FIX: `clearMergeQuarantineByKey` now passes `keysToLift` (computed BEFORE the deletes) as an
explicit override. With all 4 callers now passing one explicitly, the default was REMOVED entirely —
`liftedKeys` is a required parameter, so it can never again be lazily re-evaluated against a map a caller
already mutated.

Pinned by `78fccd3f-dual-arm-clear-route-resurrection` in `merge-quarantine-runtime-union-provenance.mjs`
(the clear-route sibling of that file's own `4b06875f-dual-arm-clear-resurrection` PROBE B). Checked out
`a57f1e26`'s own `merge-quarantine.ts` alone (tsbuildinfo cleared, rebuilt): RED on exactly the 2 expected
assertions; restored byte-identical (`cmp`-verified), rebuilt: GREEN. All 42 `merge-quarantine*.mjs` files
run serially, exit 0, under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1`. Item 3 (same card):
`merge-quarantine-clear-by-path.mjs`'s I3 precondition also asserts `armedKeys[0] === keyNoFile`.

## Follow-up f2cc5f18

Layer (b) (`orphanRewriteOwnershipConfirmed`) only protects the PARTIAL-clear REWRITE of an orphan file —
a FULL clear reached `sweepOrphanLatchFileIfUnreferenced` directly, content-blind, permanently destroying
a real foreign token nothing in memory owned or referenced. Hermetically reproduced against main first.

THE FIX: `sweepOrphanLatchFileIfUnreferenced` takes `candidateTokens` (every token the caller's clear is
lifting, captured before any mutation) and gates its unlink on `orphanSweepSafeToDelete` — every real
on-disk token must already be in `candidateTokens` or globally tombstoned. All 6 real call sites updated
(one more than first traced: `clearMergeQuarantineLatchFile`'s RAW-FALLBACK branch passes `[]`).

Deliberately does NOT reuse `orphanFileTokensAccountedForByUpdate`/`markedFinalFullyCoveredByClear`
verbatim: both treat a parse failure as "cannot prove" (keep), which would regress merge-quarantine-
clear-by-path.mjs's own (J)/(Z1)/(Z1-route) — genuinely corrupt debris must stay deletable once
unreferenced (no `repoPath` can ever be parsed back out of it).

Regression found while verifying: `merge-quarantine-raise-protect-failure.mjs`'s own pre-existing
`29fe2372-isolate-b` scenario left its orphan file on disk after its full clear, previously relying on
the old content-blind delete to keep the shared LOOM_HOME clean — fixed with an explicit assertion plus
an `fs.rmSync` cleanup.

ROUND 2 (Code Review 745c3736): (1) test D never rebooted, so the fixture never reached the sweep at all
— vacuous; fixed, and proven RED under the "EACCES -> safe:true" mutant, GREEN restored. (2)
`clearMergeQuarantineLatchFile`'s RAW-FALLBACK kept a foreign-token orphan SILENTLY (`ok:true,
wasQuarantined:false`, no `latchKept`) — `orphanSweepSafeToDelete` now also returns the parsed
`repoPath`, so a keep is reported via `latchKept`/`referencingRepoPaths` (or `anyKeptUnattributed` when
no repoPath parsed), never silent. (3) a readable record with valid `repoPath`/`branch`/`reason` but
ZERO tokens was deleted (`[].every(...)` vacuously true) even though `reenterMergeQuarantinesAtBootImpl`'s
own PASS 1 arms that exact shape as a real quarantine — fixed: tokenless + PASS-1-armable now KEEPS. (4)
dropped the clear-by-path.mjs child re-run (redundant with its own standalone suite run). Tests E/F added
for (2)/(3). All proven RED (negative control against the prior commit) and GREEN restored, byte-identical.

KNOWN RESIDUAL, DELIBERATELY UNCHANGED: a TORN write of a real record (crash mid-write leaving truncated
JSON) parses as corrupt and is still deleted once unreferenced — identical to pre-fix behavior.

Tests: `merge-quarantine-orphan-sweep-content-aware.mjs` — isolate-b survival across a fresh reboot (A),
a positive control (B), a tombstone case (C), a non-ENOENT read failure (D), a tokenless-genuine keep
(E), a RAW-FALLBACK latchKept report naming a parsed repoPath (F), and the SAME report with no parsable
repoPath — only `anyKeptUnattributed` can surface it (G, Code Review e726e2ba). All 44
`merge-quarantine*.mjs` files run serially, exit 0, under both env states.

## Follow-up cd5a3cf9 — a basename match is never proof of same identity

CRITICAL over-unblock, pre-existing, IN-PROCESS. `atFilenameIdx`/`atFinalBasenameIdx` matched by
`sourceFile` string equality alone — 6451a749/37452ddd's own fixtures always built that twin as the SAME
identity as the occupant. Repro: Y independently armed at Kb/Kc2; foreign Z2 sits at Kc2's own hash,
resolvedKey->Kb. Clearing Kc2 reached `protectOccupantContentBeforeDelete` for Z2; `atFinalBasenameIdx`
matched Y's own twin (still armed at Kb — a DIFFERENT identity), and `replaceEntryEverywhere` spliced Z2
into Kb, destroying Y's quarantine there, in-process.

**Fix:** gate all SIX union/re-point sites on the matched entry (`atFilenameIdx`'s own union; the outer
branch selection at both indices; the inner re-point/splice when both match; the `else if` when only
`atFinalBasenameIdx` matches; the double-fault re-point) on
`directPathIdentity(matched.repoPath) === directPathIdentity(toPersist.repoPath)` — captured before any
union/mutation (Lesson 196). On mismatch the slot is left untouched; falls to the pre-existing
independent-mint `else` (decision 1922be3a — Lesson 198).

**Code Review found 2 of 6 sites uncaught by the original test** (double-fault re-point; the inner
re-point when BOTH indices match, one genuine twin + one foreign) — both reproduced with realistic
fixtures (an injected EACCES write failure; a pre-existing same-identity pending file alongside the
foreign twin) and closed with two new scenarios. The sixth (the sibling splice, same branch as the inner
re-point) reverts to NO observable effect — `activeQuarantines` already holds the correct reference via
the OTHER gate, so losing only the pending-array bookkeeping entry is invisible to every query. All six
sites now independently verified: single-line reverts (Code Review, then re-confirmed by this worker)
each turn exactly one scenario RED; the splice reverts to zero failures, confirmed twice.

**Reboot checks are DURABILITY, not regression, for this shape:** they pass identically pre- and post-fix
— Y's own parked file genuinely survives either way (Code Review confirmed: nothing in production
deletes/skips it). The committed test labels them accordingly and omits the card's own script's
bootstrap-discard step, which is itself the artifact that made the ORIGINAL repro appear reboot-affected.

**Latent `atFilenameIdx`-mismatch channel, f3c644ca interaction, and the duplicated-index `sourceFile`
staleness (c93e9e7a round 3)** are unchanged from the prior revision of this Follow-up — not reachable in
production / not fixed here / left for a sibling card respectively.

Tests: `merge-quarantine-cd5a3cf9-identity-gate.mjs`, 4 scenarios, 24 checks — RED (9 failures) on HEAD~1
via `negative-control.mjs`, GREEN after, byte-identical restore. All `merge-quarantine*.mjs` run serially
in both env states; `guards` green.

## Follow-up f3c644ca — `entryStillOwnsKey` gated on identity alone, not entity

CRITICAL-CLASS over-unblock, pre-existing. `entryStillOwnsKey` (merge-quarantine.ts) treated ANY
same-identity occupant as automatically "the same logical entry" (bare `directPathIdentity` equality) —
contradicting decision d4b25feb, under which one identity can legitimately hold TWO INDEPENDENT records
at once. Found by the Code Reviewer of c93e9e7a (session eed46e01, gen 426), measured on c93e9e7a's own
build. The investigate-first phase (before any production edit) confirmed the Reviewer's own probe
script no longer reproduces on current main, post-cd5a3cf9 — a surgical negative control (checked out
`merge-quarantine.ts` at cd5a3cf9's own parent commit, rebuilt, re-ran) showed the SAME probe DOES
reproduce there, proving cd5a3cf9 incidentally closed that probe's own mechanism
(`protectOccupantContentBeforeDelete`'s basename-match, a DIFFERENT function) without ever touching
`entryStillOwnsKey` itself, which stayed byte-identical.

**Per-site table** (every `entryStillOwnsKey` caller, enumerated then independently re-verified by repro):

| Site | Shape | Reproduced on current main? |
|---|---|---|
| `clearMergeQuarantineByKey`'s pending sweep | LIFT | **YES** — independent active entry W's map slot deleted AND its physical latch file unlinked; durable (survives reboot) |
| `clearTokenFromPendingIndices` via `clearMergeQuarantineByToken` | LIFT | **YES** — same consequence |
| `clearMergeQuarantineByRecordedPath`'s `matchedPending` loop | LIFT | NO — structurally blocked: this function's own active-identity scan clears every same-identity active entry FIRST, by design, so nothing independent survives for the pending loop to wrongly catch; confirmed empirically |
| `consumeMatchedPendingsIntoArmedEntry`'s anchors loop | WRITE | NOT REPRODUCED within the time-box — every construction needed an ACTIVE entry with a stale `armedKeys` reference, and `armedKeys` is in-memory-only, never test-injectable for an active entry; a degraded/unresolvable-park construction kept being a genuine 883e29bc dual-tracked twin, legitimately re-absorbed by the raise's own pending-identity scan before this predicate ever mattered |
| `enterMergeQuarantine`'s existing-branch secondary-key write | WRITE | NOT REPRODUCED, same blocker |
| `clearActiveEntryTokenAtKey`'s write loop | WRITE | NOT REPRODUCED, same blocker |
| `ownedKeysIncluding`, `clearMergeQuarantineByRecordedPath`'s `activeLiftedKeys` collection | LIFT-adjacent | Not independently repro'd; same predicate, covered by the fix uniformly (Lesson 155) |
| `quarantineLatchFileIdsFor` | READ-only | No mutation; lower severity, covered by the fix uniformly |

**(i) Empty tokens:** confirmed, by code reading, that `tokens` is NEVER empty for a live entry reachable
by this predicate. Every fresh-entry construction site seeds `tokens` with ≥1 element (a real raise
token, or `randomUUID()` for a placeholder — ~12 sites across the file). Every on-disk parse path falls
back to `[parsed.token ?? randomUUID()]` when the array is missing/invalid/empty, never to `[]`. `unionQuarantineEntries` only ever grows a token set. Every clear path that would reduce
tokens to zero REMOVES the entry entirely from both `activeQuarantines` and `pendingUnresolvedQuarantines`
rather than leaving a live zero-token record. The fix's `occupant.tokens.length === 0 || entry.tokens.length
=== 0` guard is therefore defensive, never load-bearing on any real path — but required anyway, since an
empty set is vacuously a subset of anything, which would silently re-open the identity-only hole.

**(ii) Real-world reachability of LIFT A/B:** the repro injects a stale `armedKeys` via the
`testOnlyInjectUnprotectedPending` seam, standing in for a state this module's own history shows arising
naturally. 883e29bc's own record documents exactly this residual: a diverted pending copy "going inert
once its own path remounts to a DIFFERENT real key than the one it was diverted under (never explicitly
pruned — it just stops matching any future query's key)" — an ACCEPTED tradeoff at the time, reasoned
about only as "stops matching," never as "could still be CONSULTED by a later, unrelated clear's own
pending sweep." Project memory's `c9114934`/`d163aef5` investigations document the same general class
(a stale secondary arm destroying an unrelated occupant's content) as a recurring, real shape in this
module's development history. The fix goes ahead regardless of a fully-traced natural repro (per Lead
ruling); the seam-constructed state is a faithful stand-in for an already-documented residual, not a
purely synthetic contrivance.

**THE FIX (round 1, SUPERSEDED by round 2 below):** `entryStillOwnsKey` first shipped requiring, beyond
reference equality, a verified identity match AND a non-empty TOKEN-SUBSET relation in EITHER direction
(`entry.tokens ⊆ occupant.tokens || occupant.tokens ⊆ entry.tokens`). Round-2 Code Review found this
reopens a DIFFERENT over-unblock (below) — **do not re-add the `entry ⊆ occupant` half.**

**ROUND 2 — Code Review found the symmetric gate's `entry ⊆ occupant` half reopens a real over-unblock
via the AUTOMATIC settle-time clear.** Probe A: active `W` with TWO outstanding tokens `{s,u}`; pending
`P`, same identity, carrying only `{s}` (a genuine SUBSET of `W`'s own tokens) with a stale
`armedKeys:[K]` naming `W`'s own key — exactly scenario 3's (round 1) own state. `clearMergeQuarantineByToken(y,"s")`
— the route `git/worktrees.ts`/`git/batch-merge.ts` call automatically when an op settles — runs the
PENDING pass first; `P`'s last token makes it a full lift, `entryStillOwnsKey(K,P)` was `P ⊆ W` (true
under the round-1 gate), and `W`'s entire map slot AND physical latch were deleted before the ACTIVE pass
could reduce `W` to `{u}` on its own — `u` was lost, in memory AND after a reboot, breaking this module's
own token SET semantics (clearing one outstanding token must never lift the quarantine while another is
still outstanding). The ORIGINAL justification for keeping `entry ⊆ occupant` (round-1 scenario 3) used
`clearMergeQuarantineByKey` on an UNUSED key — a shape no real clear route takes. With `occupant ⊆ entry`
ALONE, Code Review ran every REAL human/automatic clear route against probe A's exact state
(`clearMergeQuarantine(y)` resolvable → `clearMergeQuarantineByKey`; `clearMergeQuarantine(y)`
unresolvable → `clearMergeQuarantineByRecordedPath`; `clearMergeQuarantineByRecordedPath(y)` directly) and
all three still lifted fully, in memory and after reboot, while all 47 other `merge-quarantine*.mjs` files
stayed green. `occupant ⊆ entry` is also the semantically safe direction at the
`consumeMatchedPendingsIntoArmedEntry` WRITE site.

**THE FIX (round 2, CURRENT):** `entryStillOwnsKey` requires, beyond reference equality, a verified
identity match AND `occupant.tokens ⊆ entry.tokens` — `occupant ⊆ entry` ONLY, never the reverse. Two
genuinely independent records (disjoint tokens, since tokens are fresh `randomUUID()`s per raise, never
reused) are correctly rejected. A genuinely overlapping-but-INCOMPARABLE pair (sharing SOME tokens,
neither a full subset of the other) is ALSO correctly rejected by this predicate — Code Review verified
such pairs still resolve cleanly through every real clear route via OTHER mechanisms, never through this
predicate claiming a false ownership; do not read that as "this predicate itself accepts them." The
`clearMergeQuarantineByRecordedPath`'s `activeLiftedKeys` collection and its own pending loop are
REDUNDANT/MOOT for the same-identity case specifically (Code Review's own finding) — do not
assert either direction is "needed" there; the function's own active-first clear ordering (see the
per-site table row above) already makes the independent-record shape unreachable through them. Per the
Lead's ruling, this stays a ONE-PREDICATE fix (Lesson 155) — no per-site gating, so the WRITE-type sites
stay safer too (`false` moves every caller toward over-block, the safe direction under this record's own
original ruling), even though the three WRITE sites themselves were not independently reproduced.

**ROUND 3 (re-CR, SOUND):** no new over-unblock and no stuck human clear found across W⊂entry, entry⊂W,
overlapping-incomparable, disjoint, and equal × every real clear route, in memory and after reboot — round
2 is never worse than round 1 or bare identity. Three doc/naming corrections only, no behavior change:
(1) `entryStillOwnsKey`'s own LEAD doc paragraph had drifted to describe the DROPPED `entry ⊆ occupant`
direction while the code is `occupant ⊆ entry` — fixed in place to match the code and this record. (2) the
test-only setter was renamed `setActiveQuarantineTestOnly` (see (iii) below) so its OWN name, not just its
doc comment, is what `no-src-testonly-import-guard.mjs` actually keys on. (3) the doc's "every real
human/automatic clear route still lifts a genuine rebuild fully" claim is now bounded, not absolute: one
HAND-BUILT exception stays fail-closed (never fail-open) — an entry armed at two keys (`armedKeys:[K,K2]`)
whose own `K2` slot was never synced to a later, same-identity SUPERSET build sitting there can leave that
`K2` slot un-lifted by the resolvable `clearMergeQuarantine` route specifically, while
`clearMergeQuarantineByRecordedPath` still clears it; no real path to that unsynced state was found
(`replaceEntryEverywhere` syncs every `===` slot).

**(iii) Pinning the non-empty-tokens clause:** an empty token set is vacuously a subset of anything,
which would silently reopen the identity-only hole for a pathological zero-token occupant. No real code
path can produce one (see (i) above), so it is pinned via a new, minimal TEST-ONLY export,
`setActiveQuarantineTestOnly(key, entry)` — directly arms the REAL, module-global `activeQuarantines` map
itself. This does NOT mirror `armQuarantineKeyTestOnly`'s own precedent: that one writes into a
CALLER-SUPPLIED `byRepoKey` map, isolated from the real singleton; this one has no such isolation and
mutates the live map directly, so its name's `TestOnly` suffix is load-bearing —
`no-src-testonly-import-guard.mjs` matches `/TestOnly$/` specifically to catch a future production import
of exactly this kind of live-map-mutating seam (round-3 CR). Verified RED when the guard clause is
removed (manual negative control, not committed).

**c93e9e7a (unmerged, branch `loom/dbc76bd19a0e`) — not touched, per Lead instruction.** Its own fixture
encoded W1 being DROPPED by `clearMergeQuarantineByKey(Kc2, y)` as the expected, asserted outcome (the
"W1-W3 as separate records" shape this card's own title names). Every assertion in that fixture expecting
W1 (or an equivalent independent same-identity record) to be LOST by that clear must flip to expect
SURVIVAL once that branch resumes and rebases past this fix — c93e9e7a's own round 2 note already flagged
this; this record is the pointer for whoever resumes it.

**Probe G** (Code Review's own round-2 finding): a pre-existing, same-general-class over-unblock, OUTSIDE
this predicate entirely — carded separately by the Lead. Not fixed here.

Tests: `merge-quarantine-f3c644ca-entity-gate.mjs` — 7 scenarios (2 LIFT repros, probe A, 2 real-clear-
route clearability sub-cases, the ONE kept `occupant ⊆ entry` clearability direction, the empty-tokens
guard pin, 1 ordinary-multi-raise regression sanity), 32 checks. RED (6 failures) on the bare pre-fix
identity predicate; RED (3 failures, probe A) with the round-1 SYMMETRIC gate restored; RED (1 failure,
the guard pin) with the non-empty clause removed; GREEN after the round-2 fix, byte-identical restore
each time. All 48 `merge-quarantine*.mjs` run serially, exit 0, in both env states
(`LOOM_DEV`/`LOOM_SUPERVISED` unset, and `LOOM_DEV=1`).

## Follow-up c93e9e7a — cross-pending-entry lifted-key union computed before any delete

Two same-identity pending twins both armed (via `armedKeys`) at a key `Kb` outside the active entry's own
`keysToLift`: each of `clearTokenFromPendingIndices`, `clearMergeQuarantineByKey`'s pending filter, and
its own active `keysToLift` loop recomputed `ownedArmedKeys`/`liftedKeys` via `entryStillOwnsKey` against
the LIVE `activeQuarantines` map — read AFTER an earlier-processed twin's own iteration (in the SAME
clear) had already deleted `Kb`. The later twin's own narrower set then let a foreign occupant X,
co-located at the twin's own OTHER genuinely-owned key, wrongly RETAIN `resolvedKey: Kb` even though `Kb`
was genuinely lifted this same call — fail-closed reboot resurrection of an innocent third-party repo
whose own canonical key IS `Kb`. `clearMergeQuarantineByRecordedPath`'s own `matchedPending` sweep had the
identical shape, transitively through delegation.

**THE FIX:** each site computes `L`, the full lifted-key union, ONCE before any delete — the active
entry's own `keysToLift` plus every tied pending twin's own pre-delete-snapshot-owned armed keys (a twin
that 64119847's path REDUCES contributes nothing) — then threads that SAME `L` into every subsequent
protect/exclude call, including the active loop itself (round-2 MAJOR 2: it used to miss a key only a
tied pending twin owned). `clearMergeQuarantineByKey` gained an optional `externalLiftedKeys` param so
`clearMergeQuarantineByRecordedPath` can compose its OWN outer union (computed before any delegated call)
into each one. Deliberately NOT a global deferred finalize across the whole operation (an earlier,
unmerged WIP design) — that over-unblocked two distinct foreign occupants sharing one stale key.

Tests: `merge-quarantine-c93e9e7a-cross-entry-liftedkeys.mjs` — 11 scenarios, including a one-twin
negative control, the active-loop-union case, a 64119847-reduced-twin interaction, a no-over-unblock
control, the two-distinct-foreign-occupant regression guard, and (round 2) `recorded-path-threading-pin`.
RED on the unmodified file via `negative-control`; per-site RED confirmed for the ByKey pre-pass,
`clearTokenFromPendingIndices`, and the ByRecordedPath delegated-call threading, each reverted alone —
GREEN, byte-identical restore, every time. All 51 `merge-quarantine*.mjs` (+
`batch-merge-quarantined-not-cached.mjs`) run serially, exit 0, both env states.

**ROUND 2 (Code Review `89aa6630`):** production code CONFIRMED CORRECT, no over-unblock (reduced twins,
3+ occupants, error paths, Q2 all probed) — zero behavior change this round. Two test gaps, both fixed:

1. `twin-twin-by-recorded-path`'s own KNOWN GAP (a pending twin tied via `subsetOfClearedTokens` is, by
   construction, redundant with `clearMergeQuarantineByKey`'s own internal completeness) is real and
   stays — but `recorded-path-threading-pin` (new) closes it from a DIFFERENT angle: W (armed only at K,
   its own physical file holding foreign X) and P (pending, DISJOINT tokens, its OWN separate active
   match at Kq) are structurally UNTIED to each other, so only the OUTER `activeLiftedKeys`/`L` — built by
   scanning every matched active entry, including P, before delegation — carries Kq into W's own delegated
   call. Removing `, L` from the `clearMergeQuarantineByKey(m.key, m.repoPath, L)` call site now turns
   this scenario RED (confirmed); nothing else moves.
2. The original `pure-pending-by-token` armed its own P1/P2 directly, making them their own `activeMatches`
   and routing them through `clearActiveEntryTokenAtKey` — never reaching `clearTokenFromPendingIndices`
   at all; the comment claiming otherwise was false. Rebuilt per the CR's own construction: a REAL active
   entry O (never the twins themselves) owns the shared keys, so the pure-pending twins reach
   `clearTokenFromPendingIndices` directly. Reverting only that function now turns this scenario RED
   (confirmed); nothing else moves.

Also this round: `clearTokenFromPendingIndices` now caches ONE plan per index (reduce-or-remove, pre-pass
and mutating loop reuse it) instead of deriving the decision twice, mirroring `clearMergeQuarantineByKey`'s
own `pendingPlan`. `entryStillOwnsKey`'s optional map parameter was removed (every caller relied on the
default; no caller needed it).

**Two sub-mechanisms in `clearMergeQuarantineByRecordedPath` are honestly redundant, not load-bearing on
their own:** the pending-owned contribution to the outer `L` (every identity-matched pending entry's own
armed keys, unioned in before delegation) and the matchedPending loop's own reuse of that pre-delegation
snapshot (`pendingOwnedArmedKeys.get(p)`, never a live recompute). The CR found removing either turns
nothing RED, and the reason is structural, not merely untested: `entryStillOwnsKey` can only ever report
ownership of a key that something currently occupies in `activeQuarantines`, and anything occupying a key
under this SAME identity is unconditionally discovered by the `matched` active-entry scan too — so
whatever either mechanism would contribute to `L`, `clearMergeQuarantineByKey`'s own internal pre-pass (fed
by the pre-existing `activeLiftedKeys`) already computes independently once delegated. Kept, not removed,
this round: they were part of the original design spec, cost nothing at runtime, and offer defense-in-depth
against a future change to that invariant — but the record states plainly they are not independently
proven necessary by any current test, and neither should be cited as such.

## Follow-up 0a783fb2 — a content-parsed orphan keep is reported distinctly, on every clear path

From CR#2 (`e726e2ba`) of card `f2cc5f18`. That card's own fix only reported a content-based orphan keep
(`sweepOrphanLatchFileIfUnreferenced`'s fail-closed branch) via `clearMergeQuarantineLatchFile`'s
RAW-FALLBACK branch — three other call sites (`clearTokenFromPendingIndices`, `clearMergeQuarantineByKey`,
`clearMergeQuarantineByRecordedPath`) discarded it with only a `console.error`, and the pending-match
branch of `clearMergeQuarantineLatchFile` itself never tracked a kept-but-UNATTRIBUTED result at all. The
RAW-FALLBACK branch also OVERLOADED `referencingRepoPaths` — a content-parsed repoPath (no live entry
backs it) and a true in-memory referencer both landed in the same field, which `64283e06`'s own "Do not
overload `referencingRepoPaths`" bullet did not yet cover (it was scoped to the `stillQuarantined`
ambiguity only).

**Fix:** `sweepOrphanLatchFileIfUnreferenced` now returns `contentKeptRepoPath?: string`, SEPARATE from
`referencingRepoPaths` (true referencers only). A new shared helper, `foldOrphanSweepResult`, folds one
sweep result into a caller's running `{referencing, contentKept, unattributed}` state — used at every
TRUE orphan-sweep call site (`clearTokenFromPendingIndices`, `clearMergeQuarantineByKey`,
`clearMergeQuarantineByRecordedPath`, `clearMergeQuarantineLatchFile`'s pending-match AND RAW-FALLBACK
branches — FIVE sites, not four; `clearTokenFromPendingIndices`/`clearMergeQuarantineLatchFile`'s
pending-match branch each sweep orphan files at their own, separate call site in addition to the other
three), plus the pending-match branch's own `ownSweep`/`finalSweep` calls (structurally compatible via
TypeScript's optional-property assignability — `sweepOwnLatchFileUnlessOwnedElsewhere` never sets
`contentKeptRepoPath` at all, so it passes through as an always-absent optional field). **CORRECTION
(round 2): the helper does NOT cover `tmpSweep`** (`sweepTmpResidueForHashIfUnreferenced`) — that function
has no content-parse branch at all, and its `keptEntries` can span MULTIPLE distinct `{repoPath,
sourceFile}` pairs per call, which the helper's one-sourceFile-per-call signature can't represent; its own
unattributed case stays a deliberate 2-line inline check, with a guard comment stating exactly why (Code
Review 47289f8d, item 4). A new `contentKeptRepoPaths?: string[]` field threads through
`clearMergeQuarantineByKey`/`ByRecordedPath`/`Reporting`/`LatchFile` and all three REST handlers
(`gateway/server.ts`) — never folded into `stillBlockedCoOccupants` (no live entry exists to clear by id
for mere on-disk content). The TWO sites reached only via the auto-clear path
(`clearMergeQuarantineByToken`, `void` by design, no human-facing return) instead console.warn, mirroring
the existing "no human route reaches this path — logging only" convention already used there for a
relocated co-occupant.

**Behavioral/test-contract change:** `clearMergeQuarantineLatchFile`'s RAW-FALLBACK branch (scenario F in
`merge-quarantine-orphan-sweep-content-aware.mjs`) now reports a parsed foreign repoPath via
`contentKeptRepoPaths`, not `referencingRepoPaths` — the test's own assertion was migrated accordingly,
and a new assertion confirms `referencingRepoPaths` no longer carries it.

**ROUND 2 (Code Review `47289f8d`, MERGEABLE-after-one-Major):** round 1's own `stillBlockedCoOccupants`
extension — a TRUE referencer found by the orphan-sweep now ALSO feeds `stillBlockedCoOccupants` (via
`blockedCoOccupantForReferencer`) at the four previously-fully-discarding sites, not just
`contentKeptRepoPaths` — introduced a REGRESSION the round-1 worker never tested: `clearMergeQuarantineByRecordedPath`
processes a query identity's own `matched` (active) entries before its own `matchedPending` entries, so a
delegated `clearMergeQuarantineByKey` call for one matched active entry can find that SAME identity's own
UNTIED pending twin (or a later `matched` active entry, the `d4b25feb` "two independent raise-groups"
shape) still live in memory and report it as a TRUE referencer — the cleared identity ends up reported as
its OWN `stillBlockedCoOccupants` entry, with `latchKept:true` and a route id that no longer exists once
the whole clear finishes (R3's own repro, Code Review 47289f8d: `listActiveMergeQuarantines()` for that
identity reads `0` immediately after, confirming nothing was actually still blocking it).

**THE FIX:** `sweepOrphanLatchFileIfUnreferenced` gained `excludeIdentities?: ReadonlySet<string>`, applied
to all three of its own referencer scans (`activeQuarantines`, `pendingUnresolvedQuarantines`,
`physicalOwnerRepoPaths`) — every orphan-sweep call site now passes the identity (or, for
`clearMergeQuarantineLatchFile`'s pending-match branch, the SET of identities — `882d6cff`'s multi-claimant
shape can span several at once) the CURRENT clear is already in the middle of lifting. **Why exclude,
never defer:** a same-identity record's own "still quarantined" status is already `stillQuarantined`/
`resolveQuarantineFor`'s job, re-resolved FRESH after the whole clear completes — `referencingRepoPaths`/
`stillBlockedCoOccupants` means a DIFFERENT repo, with a real, standing clear-by-id route; a same-identity
entry can never be that, in EITHER direction (a same-identity entry already cleared can't come back, and
one not yet cleared is about to be). Excluding it costs nothing in content-safety: `orphanSweepSafeToDelete`
still runs independently afterward and still fails closed on any genuinely uncovered token, same-identity
or not (see the primitive-level argument in `sweepOrphanLatchFileIfUnreferenced`'s own doc comment).

**MINOR fixes, same round:** (1) `clearMergeQuarantineByKey` now returns an EXPLICIT `unattributed?: true`
field — `clearMergeQuarantineByRecordedPath` used to INFER "unattributed" from an empty
`referencingRepoPaths`, which misfired the instant `latchKept` was true SOLELY because
`contentKeptRepoPaths` fired (a content-only keep, wrongly reported with the "no specific other claimant
can be named" wording instead of naming `contentKeptRepoPaths`). (2) Two new shared reason-text helpers,
`contentKeptOnlyReasonFor`/`unattributedKeptReasonFor`, replace `keptOnlyReasonFor`'s own garbled "0 other
claimant(s) … ()" text (produced when called with an empty `refs` array) at every site that can report a
content-only or purely-unattributed keep — `clearMergeQuarantineReporting`'s own latchKept branch now picks
the right base reason by WHICH kind of keep fired, never `keptOnlyReasonFor` unconditionally; two
`clearMergeQuarantineByRecordedPath` branches that used to give NO reason at all for a content-only keep
now compose one.

Tests added: `merge-quarantine-clear-by-path.mjs`'s own (AM) proves the R3 self-reference fix directly
(latchKept absent, `stillBlockedCoOccupants` empty, zero entries survive for the identity, all RED on
`ad3b2c35`); `merge-quarantine-orphan-sweep-content-aware.mjs`'s own (L)/(M)/(N)/(O) each prove a TRUE,
DIFFERENT-identity referencer still correctly reaches `stillBlockedCoOccupants` (or, for (O)'s auto-clear
site, `console.warn`) at `clearMergeQuarantineByKey`/`ByRecordedPath`/`LatchFile`'s pending-match branch/
`clearTokenFromPendingIndices` respectively — proving the self-exclusion fix narrows the bug without
regressing the legitimate cross-identity case the `stillBlockedCoOccupants` extension exists for.

## Do not (extends `64283e06`'s own bullet)

- Do not fold a CONTENT-parsed repoPath (from `orphanSweepSafeToDelete`'s fail-closed branch) into
  `referencingRepoPaths` — that field means a TRUE in-memory referencer only, now enforced by
  `sweepOrphanLatchFileIfUnreferenced`'s own return shape. Use `contentKeptRepoPath(s)` instead, and never
  fold it into `stillBlockedCoOccupants` (no live entry backs it).
- Do not hand-roll a new per-site fold of an orphan-sweep result — route it through `foldOrphanSweepResult`
  so a future site can't silently drop either kind of keep the way FIVE sites did before this card (the
  four this card's own investigation found, plus the RAW-FALLBACK branch's own pre-existing hand-rolled
  fold, migrated onto the helper too for consistency — never "four", see the corrected count above).
- Do not claim `foldOrphanSweepResult` covers `sweepTmpResidueForHashIfUnreferenced` — it does not, and
  never will without a signature change neither its no-content-parse contract nor its multi-entry
  `keptEntries` shape can satisfy; its own unattributed case stays a deliberate, commented inline check.
- Do not let an orphan-sweep's own true-referencer check treat a SAME-IDENTITY record (active or pending)
  as a genuine co-occupant — exclude it via `excludeIdentities`, at every call site, for the identity (or
  identities) the CURRENT clear is already in the middle of lifting. A same-identity record's own "still
  quarantined" status belongs to `stillQuarantined`/`resolveQuarantineFor` alone, re-resolved AFTER the
  whole clear completes — never to `referencingRepoPaths`/`stillBlockedCoOccupants`, which name a
  DIFFERENT repo with a real, standing clear-by-id route.
- Do not have a caller re-INFER `clearMergeQuarantineByKey`'s own "unattributed" state from an empty
  `referencingRepoPaths` — read its EXPLICIT `unattributed` field instead; the inference misfires the
  instant `latchKept` is true solely because `contentKeptRepoPaths` fired.
- Do not call `keptOnlyReasonFor` unconditionally for a kept-latch reason — it assumes a true referencer
  and reads as a garbled "0 other claimant(s) … ()" when there is none. Pick the base reason by which kind
  of keep actually fired (`keptOnlyReasonFor` / `contentKeptOnlyReasonFor` / `unattributedKeptReasonFor`),
  and never silently return no reason at all for a content-only or purely-unattributed keep.

## Follow-up 1dd00dca — a kept, genuinely foreign, uncovered orphan was never enforced within the SAME
process; the next boot's own PASS 1 was the only thing that ever armed it

From CR `745c3736` of this card. O surviving a full clear (the fix above) left T wholly unenforced in
this process until the next restart — confirmed via a hermetic repro: `activeMergeQuarantineFor(T)` read
`undefined` in the SAME booted instance right after a clear that kept O.

THE FIX: `sweepOrphanLatchFileIfUnreferenced`'s keep branch now calls a new helper,
`armForeignOrphanContentInMemoryIfUnenforced`, synchronously inline, arming T in memory (active if
resolvable, pending if not) UNLESS `resolveQuarantineFor(T)` already answers non-`undefined` — the SAME
lookup `assertRepoNotQuarantined` uses, which (via `activeMergeQuarantineFor`'s own lookup order) answers
truthy whenever EITHER T's own identity is already enforced OR T's canonical key is already occupied by a
DIFFERENT identity. Either shape is a plain skip, never a union — the boot-only degraded-collision
union/eviction machinery (six-plus CR rounds deep) was deliberately not replicated at runtime.
`orphanSweepSafeToDelete`'s return was widened, additively only, to carry the already-parsed armable
record forward (no second read). NEVER touches disk — O is left exactly as kept today, so the next boot
is byte-for-byte unaffected.

DEFERRED to its own follow-up card: the `.tmp`-residue twin (`sweepTmpResidueForHashIfUnreferenced`) has
the IDENTICAL gap — `1fea8b15`'s own "fail-open at runtime" accepted residual stays true for it until
that card lands. The new helper takes an already-parsed record + a bare basename specifically so that
follow-up can adopt it with no copy. The second CR nitpick (consolidating `markedFinalFullyCoveredByClear`/
`orphanFileTokensAccountedForByUpdate`/`orphanSweepSafeToDelete` behind one polarity-parameterized helper)
is also deferred, to its own refactor card.

Tests: `merge-quarantine-1dd00dca-arm-foreign-orphan-in-memory.mjs` — see
`docs/decisions/1dd00dca-arm-foreign-orphan-latch-in-memory.md` for the full design and scenario list.
Verified RED (pre-fix sha `91bb76277cac3986ef91ab85b5a32d96387847a6`) via `negative-control`, GREEN after.
All 6 `contentKeptRepoPath(s)`-referencing files re-run in full, unchanged.