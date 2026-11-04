# 8d80b736 — a kept stranded pending tmp is tracked in `orphanLatchFiles` too, so an in-process clear narrows or sweeps it

Found by the `59e758e5` CR round 2 (reviewer `6aee1d61`, 2026-11-02; probe9 L2). PRE-EXISTING on main.

## The gap

`writePendingDivertFile`'s 3 raise callers (`mintPendingDivert`, `divertRaiseEntry`,
`mergeTokenIntoPendingEntries`) each have a triple-fault `else` branch (card `59e758e5`, B1) that KEEPS a
stranded `pending-<hash>.json.tmp-<pid>-<hex>` on disk — deliberately, since it is the only durable copy
of the entry's tokens when both the primary write and the safety-tmp fallback failed. The in-memory
pending entry pushed in that branch keeps its `sourceFile` at the ORIGINAL intended filename (which may
not even exist yet, or may hold older, stale content), and — until this card — never referenced the
stranded tmp's own basename anywhere, including `orphanLatchFiles`.

## The bug

Because nothing tracks the stranded tmp, an in-process clear (`clearMergeQuarantineByToken`, routed
through `clearTokenFromPendingIndices`) only ever narrows or sweeps whatever `sourceFile` names — never
the untracked tmp. A PARTIAL clear durably narrows the tracked file to the remaining token(s), while the
tmp still holds the full, stale (pre-clear) token set. At the next boot, `reenterMergeQuarantinesAtBoot`'s
own tmp-recovery pass finds the untracked tmp (nothing durable ever having pointed at it) and arms it as
a SEPARATE, fail-closed duplicate pending entry — resurrecting the token that was just cleared.
Reproduced hermetically: clearing a second token (t2) that only the stranded tmp still fully accounted
for came back armed after a reboot, and clearing the first token (t1) too, then rebooting again, left the
identity still blocked — by the resurrected t2.

## Fix

At each of the 3 raise callers' own triple-fault `else` branches, the kept in-memory entry's
`orphanLatchFiles` now ALSO includes `path.basename(written.strandedTmp)` (guarded on `written.strandedTmp`
being truthy — set, deduped via the same `[...new Set([...])]` pattern already used for
`safetyTmpBasename` two branches above each one). `sourceFile` itself is left unchanged (still the
original intended filename) — this is a pure cross-reference addition, not a relocation.

No new sweep/narrowing logic was needed: this module's existing `orphanLatchFiles`-aware machinery
already handles a `.json.tmp-` shaped filename correctly (decision `9cabd143` round 2, item 2, already
derives a tmp's provenance hash correctly in `orphanSweepSafeToDelete`). With the tmp now referenced:

- A PARTIAL clear's `rewriteOrphanLatchFilesAfterPartialClear` walks the updated entry's
  `orphanLatchFiles`, confirms ownership via `orphanRewriteOwnershipConfirmed` (the tmp is not any
  surviving entry's own physical latch — `physicalOwnerRepoPaths`/`survivingSharedClaimRepoPaths` return
  nothing for it; no other live entry depends on it; its content identity matches; and the on-disk tokens
  are already accounted for by the narrowed entry plus the dropped token) — then durably REWRITES the
  tmp's own bytes in place with the narrowed token set, via `writePendingDivertFile`.
- A FULL lift's `sweepOrphanLatchFilesUnioned`/`orphanLatchFileSweepDecision` walks the same set and,
  once every on-disk token is accounted for, DELETES the tmp outright.

So a sequence of partial clears correctly narrows the tmp's own content at each step, and a final clear
(or an already-fully-accounted-for tmp) deletes it — closing the resurrection gap without any new
mechanism, only a missing reference.

## Why this is tracking, not matching (forbidden by `9cabd143`)

Decision `9cabd143` (and card `4be98ac8`'s own triage note) forbids using `orphanLatchFiles` to MATCH —
i.e. to discover or resolve an UNKNOWN record's identity from a stray file's own content or basename
(e.g. `protectOccupantContentBeforeDelete` guessing which record a relocated safety-tmp belongs to). This
fix does no matching: it is a plain WRITE, made at the exact call that just minted the tmp, recording a
reference the code already knows with certainty is its own — the identical, already-established pattern
this file uses for `safetyTmpBasename` (the double-fault branches two lines above each of these three) and
`finalBasename` (`protectOccupantContentBeforeDelete`'s own kept branch), merely extended to the one case
(the triple fault) where it had been omitted.

## Scope: 2 other "keep but don't track" sites — ONE confirmed safe, ONE a confirmed OPEN gap (Round 2 correction)

`59e758e5`'s own enumeration of stranded-tmp-keeping sites names two more that are NOT touched by this
card: `protectOccupantContentBeforeDelete`'s own double-fault branch (~`merge-quarantine.ts:3739`), and
the write-failure `else` branch of `clearTokenFromPendingIndices`'s own reduce branch
(~`merge-quarantine.ts:4972-4978`; the stranded tmp a FAILED narrowing write leaves behind).

- `protectOccupantContentBeforeDelete`'s own double-fault branch: CONFIRMED SAFE, unchanged from Round 1's
  analysis — its stranded tmp is always a subset-or-duplicate of content that is ALREADY correctly
  tracked at an untouched, pre-existing file, so there is no clear-then-resurrect gap. Still left as a
  named, examined residual rather than an unexamined one.
- `clearTokenFromPendingIndices`'s own reduce-write-failure branch: Round 1's "no gap" claim for THIS site
  is WRONG, per the `59e758e5` CR round 2 reviewer's (`6aee1d61`, 2026-11-02) own repro — a durably-cleared
  token DOES resurrect here, after a LATER successful clear narrows the tracked file, followed by a
  reboot: the stranded tmp from the EARLIER failed reduce still holds the full, pre-clear token set, and
  nothing tracks it, so boot's own tmp-recovery pass arms it as a fail-closed duplicate carrying the
  already-cleared token back. **FIXED by card `5332762e`** ("track the stranded tmp from a failed
  clear-time narrowing write") — same tracking shape (basename, Set-deduped, `replaceEntryEverywhere`),
  with one deliberate ordering difference from this card's own 3 sites: the tracking runs AFTER, never
  before, that same call's own `rewriteOrphanLatchFilesAfterPartialClear`, or that helper would
  immediately try to re-narrow the tmp the SAME call just minted — see `5332762e`'s own record for why
  that specific ordering also matters for card `e1572b69`'s sibling finding. The card `5332762e` kickoff's
  own suspicion that `rewriteOrphanLatchFilesAfterPartialClear`'s own write-failure tmp "likely has the
  same shape (untested)" turned out to be investigated and CONFIRMED a real defect, but a DIFFERENT shape
  (a permanent disk-debris leak, not a resurrection) — tracked separately as card `e1572b69`.

## Test-coverage ripple (Round 2 correction — see "Round 2" below for why Round 1's own claim here was wrong)

Round 1 (this section, as first written) claimed that tracking the stranded tmp in `orphanLatchFiles`
caused a LATER resolve-aware query (`activeMergeQuarantineFor`'s cross-tier-sibling absorption) to
recover the extra in-memory-only token in `merge-quarantine-raise-protect-failure.mjs`'s own
`f00e9de8-dropped-tokens-finalbasename-only-triple-fault` scenario, flipping that scenario's own assertion
from "genuinely dropped" to "survives." That was WRONG: the apparent survival came from Round 1's own
*incomplete* fix (see "Round 2" below) leaving `activeQuarantines` pointed at the stale, pre-tmp `merged`/
`toWrite` object while `pendingUnresolvedQuarantines` got the new, tmp-tracking `kept` object — two
DISTINCT objects for the same identity. The resolve-aware query simply read the stale, untouched active
slot, which had never lost the token in the first place (nothing ever repointed it) — not because the
stranded tmp's own tracking recovered anything. With Round 2's fix unifying both slots onto the SAME
object, `protectOccupantContentBeforeDelete`'s own `atFinalBasenameIdx`-only re-point now correctly
reaches that unified object too, and the extra token IS genuinely dropped — restoring the test's
assertion to the ORIGINAL f00e9de8 accepted-residual polarity (card `59e758e5`'s own
"f00e9de8-dropped-tokens-finalbasename-only" ripple note for the non-triple-fault sibling scenario never
had this problem, since that scenario never reaches the triple-fault split at all).

## Round 2 (lead triage, gen 463, 2026-11-03) — Round 1's own fix was incomplete

Round 1's fix (above) added the stranded tmp's basename to the triple-fault-kept entry's own
`orphanLatchFiles`, but pushed that updated object into `pendingUnresolvedQuarantines` WITHOUT also
re-pointing `activeQuarantines` (or any other pre-existing `pendingUnresolvedQuarantines` reference) to
it — unlike the sibling DOUBLE-fault `secured` branch two lines above each one, which already called
`replaceEntryEverywhere` for exactly this reason. For a repoPath already armed as a dual-tracked twin (the
SAME object referenced from both `activeQuarantines` and `pendingUnresolvedQuarantines` — the `883e29bc`
boot-diverted shape, or the equivalent reached at runtime) BEFORE the triple fault, this split the twin
into two DISTINCT objects representing the same identity — the exact stale-copy shape `d4b25feb` round 3
forbids. Added `replaceEntryEverywhere(activeQuarantines, merged, kept)` (or `toWrite`/`kept` at
`mintPendingDivert`'s own site) at all 3 sites, mirroring the double-fault `secured` branch's own call.
Verified with a dedicated regression test
(`merge-quarantine-8d80b736-r2-twin-repoint-guard.mjs`) using the module's own structural invariant
(`assertQuarantineIdentityInvariantTestOnly`) at all 3 sites — RED (a real violation: 2 distinct objects,
overlapping tokens) against the pre-Round-2 code, GREEN after. Deliberately did NOT use a resolve-aware
query (`activeMergeQuarantineFor`) as the discriminator — per decision `59e758e5`'s own "Do not", such a
query self-heals a split as a side effect of being merely queried, masking exactly the defect this round
fixes (as Round 1's own now-corrected ripple note above demonstrates first-hand).

## Round 3 (card `da7bf48e`, 2026-11-04) — the raise-side `mustDivert:true` shape is NOT safe; fixed

Re-raised, trace-only, by the `444cd8e2` and `bdb09095` Code Reviews, both citing this site without
checking this record. Investigated by repro under card `da7bf48e` before any fix, per the "Do not" bullet
below (now superseded).

**Clear-path: CONFIRMED SAFE, as originally analyzed.** `deleteMergeQuarantineLatchByKey`'s own trailing
`sweepTmpResidueForHashIfUnreferenced(quarantineHashForKey(key), ..., freedKey: key)` is CONTENT-aware
(`f8e11853`), not filename-hash-keyed — it finds and removes any tmp residue whose own parsed content
canonicalises onto the just-freed key, regardless of whether anyone tracks it, within the SAME
synchronous clear call. Reproduced with a genuine `fs.renameSync` failure (not `fs.openSync`, which never
leaves a real file on disk): the untracked stray survives only transiently and is gone before any reboot;
no resurrection, no fail-open.

**Raise-path: NOT safe — a real, reproduced resurrection.** An earlier raise-path repro attempt (built on
a degraded occupant sharing its own enclosing repo's NATURAL canonical key) never actually reached this
function at all — `unincorporatedOccupantRepoPathAt`'s same-identity check returns "none" there, since
`final`'s own on-disk content and `existing.repoPath` are the same identity. The genuine repro needs
decision `e0192ffb`'s own fixture shape instead (`merge-quarantine-degraded-occupant-guard.mjs`'s
"existing-branch-raise-protects-foreign-pending-occupant"): a foreign, pure-pending X occupies a key that
`existing` (a DIFFERENT identity, e.g. a just-graduated sibling) does not. When X's own protect call ALSO
double-faults there, `resolveRaiseOverwrite` calls `protectOccupantContentBeforeDelete` a SECOND,
redundant time for X (same failure), returns `mustDivert:true`, and `enterMergeQuarantine`'s own
`mustDivert` branch is `replaceEntryEverywhere(...); divertRaiseEntry(baseEntry); return token;` — no
sweep follows at all. The untracked stray survives indefinitely; a real reboot's PASS 1b re-arms it,
resurrecting X's already-cleared token. Reproduced with a genuine `fs.renameSync` failure scoped to X's
own exact pending-divert mint basename (a bare `"pending-"` prefix also fails the unrelated raiser's own
divert mint and produces a confusing triple fault — scope the injection precisely).

**Self-healing-reader trap, found WHILE building the repro:** `activeMergeQuarantineFor`'s own lazy
re-resolve can retry the SAME occupant's protect call successfully later in the same process (e.g.
triggered by an unrelated `clearMergeQuarantine` call on the raiser), silently overwriting the
double-fault's own tracked `kept` record with a fresh, untracked one — making a fix LOOK like it isn't
working when the test's own assertions are the ones destroying the fixture. Assert via the shared PURE
reader `stillBlockedEntryFor` instead (mirrors `assertRepoNotQuarantined`'s own enforcement decision,
never mutates).

**The fix:** the double-fault branch's own `kept` record now tracks `path.basename(written.strandedTmp)`
in `orphanLatchFiles` (same shape as `bdb09095`/`444cd8e2`/`5332762e`), AND unions
`oldAtFinalBasename`'s own `orphanLatchFiles` forward when `atFinalBasenameSameIdentity` — required
because `resolveRaiseOverwrite`'s own redundant second call for the SAME identity overwrites this
function's own `pendingUnresolvedQuarantines` slot, and without the union that overwrite silently drops
the FIRST call's own already-tracked stray (reproduced: tracking without the union still resurrected one
of the two stray tmps this exact double-double-fault shape produces).

Test: `merge-quarantine-da7bf48e-occupant-protect-double-fault.mjs` — both call-path families, a genuine
`fs.renameSync` double fault, a full lift, and a real reboot. Negative-controlled (`node
packages/daemon/scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-da7bf48e-occupant-protect-double-fault.mjs --ref fda21b05`): RED
against that pre-fix sha (exactly the raise-path's own 3 fix assertions), GREEN after, tree restored
byte-identical. API-keeping mutant (keeps the tracking call, writes a wrong/fixed basename instead of the
real one): the same 3 assertions go RED; reverted.

## Round 4 (card `da7bf48e`, Code Review M1, 2026-11-04) — Round 3's own fix was INCOMPLETE; the SUCCESS branches needed it too

Round 3's own "fixed" claim covered only the DOUBLE-FAULT branch's own double-call union (both internal
protect calls failing) — it said nothing about what happens when a LATER protect call for the SAME
identity SUCCEEDS. `protectOccupantContentBeforeDelete`'s own SUCCESS branches (`atFilenameSameIdentity` /
`else if atFinalBasenameSameIdentity`) replace the same-identity slot with `written.entry`, built from
`toPersist`/`oldAtFilename` alone — the OLD `kept` record's own tracked stray tmp(s) were silently dropped,
untracked again, never swept, and boot PASS 1b re-armed them. Reproduced two ways:

- **V1 (transient fault, the realistic shape):** only the FIRST of the raise's own two internal protect
  calls fails; the SECOND (`resolveRaiseOverwrite`'s own redundant retry) succeeds. The stray from the
  first call survives untracked past the SUCCESS write.
- **V6 (persistent double fault, then a genuinely SEPARATE later raise):** the first raise double-faults
  BOTH internal calls (Round 3's own shape, correctly unioning both strays via `kept`) — but a SECOND,
  independent top-level raise, before X is ever cleared, succeeds and drops BOTH tracked strays at once.

**Correction to Round 3's own self-healing-reader-trap paragraph above:** that paragraph framed "a later
successful protect retry overwriting the double-fault's own tracked `kept` record" as something that
happens only as a side effect of the TEST's own mutating reads — that framing was WRONG. V1/V6 above prove
it is a genuine, reachable PRODUCTION path: a real retry or a real second raise, not a test artifact. The
guidance to assert via the pure `stillBlockedEntryFor` (never `activeMergeQuarantineFor`) in a TEST still
stands, but for a narrower reason: so the TEST's own assertions don't trigger an INCIDENTAL extra retry the
test never intended to exercise, confounding what it's trying to measure — not because the underlying
mechanism itself is test-only.

**The fix:** carry `oldAtFinalBasename`'s own `orphanLatchFiles` forward into `toWrite` BEFORE the write,
same identity only — `toWrite` feeds every SUCCESS branch's own `written.entry`, not just the double-fault
branch's own `kept` record, so a replaced slot's own tracked strays are handed forward there instead of
being re-derived per branch.

Tests: V1, V6, and V3 (partial clear → reboot → clear → reboot) added to
`merge-quarantine-da7bf48e-occupant-protect-double-fault.mjs`. Each RED at `fda21b05` and at `4bca8b30`
(the tip before this round) via negative-control, GREEN after, tree restored byte-identical. An
API-keeping mutant (keeps the carry-forward structure, passes an empty list) turns V1/V6/V3 red; reverted.

## Round 5 (card `da7bf48e`, 2nd Code Review M1, 2026-11-04) — Round 4's own carry included a stale self-reference

Round 4's fix (above) carried `oldAtFinalBasename.orphanLatchFiles` into `toWrite` wholesale — but
`oldAtFinalBasename` can itself BE a double-fault `kept` record (Round 3's own shape), whose own
`orphanLatchFiles` deliberately self-references `finalBasename` (it physically lives there). Once THIS
call's SUCCESS relocates to `written.filename` and the caller unlinks `final`, that self-reference is
stale: a different occupant (e.g. a sibling identity sharing the same canonical key) can mint its own
latch at that exact basename next, and the carried-forward self-reference made `written.entry` wrongly
cross-reference that stranger's live latch. Enforcement stayed correct (the orphan sweep content-checks
before touching a referenced file), but a later full clear of THIS identity reported the stranger as a
spurious co-occupant — `latchKept:true`, naming the stranger in `referencingRepoPaths`/
`stillBlockedCoOccupants`, with reason text suggesting the stranger's own live latch could be lifted by
clearing "the shared latch by its own 24-hex id," which would wrongly imply lifting the stranger's own
legitimate quarantine.

**The fix:** filter `finalBasename` out of the unioned set in the `toWrite` carry specifically — `kept`'s
own carry (which self-references `finalBasename` on purpose) is untouched.

Test: V1 and V6 in `merge-quarantine-da7bf48e-occupant-protect-double-fault.mjs` now additionally assert,
after X's full clear, that the result does not name the raiser (teamA/W) in `referencingRepoPaths`/
`stillBlockedCoOccupants` and does not report `latchKept` for its file, and that the raiser (teamA/W)
stays blocked — in-process and after a reboot — with its own latch file surviving on disk. RED at the
pre-Round-5 tip, GREEN after.

## Do not

- Do not re-litigate this site as "confirmed safe" from the Round-1/2 analysis alone — see Round 3/4
  above. The clear-path remains safe for the original reason; the raise-path's DOUBLE-FAULT branch (Round
  3) and its SUCCESS branches (Round 4) are two SEPARATE carry-forward sites — fixing one is not evidence
  the other is covered.
- Do not carry `oldAtFinalBasename`'s own `orphanLatchFiles` forward anywhere OTHER than `toWrite`, also
  into `toWrite` — not INSTEAD of `kept`'s own carry (above), which must stay: `kept` lives AT
  `finalBasename` itself and needs that self-reference; `toWrite` does not. `written.entry` (what every
  SUCCESS branch re-points to) is derived from `toWrite` alone; a carry-forward added only to the
  double-fault branch's own `kept` record (Round 3's own shape) never reaches a LATER call's own SUCCESS
  path, which is exactly the Round 4 gap.
- **(Round 5, Code Review M1)** Do not carry `finalBasename` itself forward into `toWrite`'s own carry —
  only `kept` (two bullets below) may self-reference it; see "Round 5" above for the stale-self-reference
  gap this closes and why it's scoped to `toWrite` alone.
- Do NOT treat `clearTokenFromPendingIndices`'s own reduce-write-failure branch
  (~`merge-quarantine.ts:4972-4978`) as covered by this card's own `protectOccupantContentBeforeDelete`
  fixes (Round 3/4) — it is a CONFIRMED, OPEN, clear-then-resurrect gap (see "Scope" above), tracked
  separately on card `5332762e`. Do not fix it as part of THIS card without a Lead ruling to widen scope —
  it is a different write site with its own reduce-branch mechanics, not a drop-in application of this
  card's fix.
- Do not forget `replaceEntryEverywhere` at a NEW triple-fault "keep" branch — Round 2 (see above) found
  this card's OWN original fix omitted it at all 3 of its own sites, splitting a dual-tracked twin into
  two same-identity objects. Mirror the double-fault `secured` branch's own call every time.
- Do not use a resolve-aware query (e.g. `activeMergeQuarantineFor`) to verify "exactly one object" after
  a triple fault — it self-heals a split as a side effect of being merely queried (decision `59e758e5`'s
  own "Do not"), which is exactly what made Round 1's own now-corrected test-coverage-ripple claim above
  look true when it wasn't. Use `assertQuarantineIdentityInvariantTestOnly` (a structural, non-healing
  check) instead.
- Do not store `written.strandedTmp` itself (an ABSOLUTE path) in `orphanLatchFiles` — every reference in
  that array, and every sweep/rewrite helper that consumes it, is a plain basename relative to
  `MERGE_QUARANTINE_DIR`. Always `path.basename(written.strandedTmp)`, mirroring
  `attemptDivertSafetyTmpFallback`'s own identical convention.
- Do not relocate `sourceFile` to the stranded tmp in these 3 branches — the tmp is tracked as an
  ordinary orphan CROSS-REFERENCE (check-1 in `9cabd143`'s own two-check split), never as the entry's own
  physical latch (check 2 / `sweepOwnLatchFileUnlessOwnedElsewhere`'s territory). The original
  `sourceFile` stays exactly as it was before this card.
