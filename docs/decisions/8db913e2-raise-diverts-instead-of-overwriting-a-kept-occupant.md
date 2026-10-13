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
on `HEAD` (this card's own round-4 commit) and GREEN after, via `scripts/negative-control.mjs`. CR3's own
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

**Correction (Round 2, Code Review d42418af, Minor 1, card `95ea8d3f`):** following the refusal's own
`clear-by-path` remedy, the remedy lasts for R but currently does NOT last for D — a `clear-by-path(D)`
after a shape-1 divert plus a query clears D in-process but does not durably persist that clear, so D's
own token can come back after a reboot. That gap is out of scope for this card and is tracked separately
as card `95ea8d3f` ("fix(git): make clear-by-path of a diverted occupant survive a reboot") — read that
card for the repro and fix, not restated here.

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
