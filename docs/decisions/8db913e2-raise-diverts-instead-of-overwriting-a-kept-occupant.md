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
