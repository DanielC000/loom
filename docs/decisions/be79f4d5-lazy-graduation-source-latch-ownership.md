# be79f4d5 — a lazily-graduated pending quarantine's stale source latch must stay owned until its fresh-key write actually succeeds

Found by Code Reviewer `4d619c1f`'s reading of `a6fa60e2` (see
docs/decisions/a6fa60e2-failed-migrate-latch-ownership.md for that card's own PASS-1-migrate-branch fix —
this record does not restate its narrative). Same defect class, a SECOND code path a6fa60e2 never touched.

## The bug

`activeMergeQuarantineFor`'s lazy-graduation branch (the tail of that function, `git/merge-quarantine.ts`)
splices a matched `PendingUnresolvedQuarantine` out of `pendingUnresolvedQuarantines` UNCONDITIONALLY,
before it even knows whether the fresh-key `writeMergeQuarantineLatch` call will succeed. The in-memory
entry is armed under the fresh key either way (enforcement must not wait on disk I/O) — but when that
write FAILS, the entry's only remaining durable copy is `pending.sourceFile`, a filename now referenced by
NEITHER `pendingUnresolvedQuarantines` (already removed) NOR the armed entry's own `orphanLatchFiles`
(never populated on this path, unlike a6fa60e2's fix for PASS 1's analogous branch). A raw clear-by-id of
that stale hash therefore falls through every ownership check (`physicalOwnerRepoPaths` only recognizes an
entry's CURRENT armed-key hash or its freshly-recomputed `quarantinePathFor` target — never a stale,
migrated-away-from filename) into the orphan-sweep fallback and is deleted outright, destroying the
quarantine's only durable record. The entry stays enforced for the rest of THIS process's life, but a
restart finds nothing on disk (the fresh-key write never succeeded either) and the repo comes back up
UNQUARANTINED — a silent fail-open, reproduced in `merge-quarantine-lazy-graduation-source-latch-owner.mjs`
scenario 1.

A SECOND, separate gap in the same family: when `pending.sourceFile` is a PASS-1b-recovered
`.json.tmp-<pid>` residue rather than a PASS-1 `.json` final (both shapes feed this exact same graduation
branch — see `reenterMergeQuarantinesAtBoot`'s PASS 1 and PASS 1b, both of which can `push` a pending entry
with either sourceFile shape), `clearMergeQuarantineLatchFile`'s final "no entry matches this id" fallback
unconditionally called `deleteMergeQuarantineTmpResidueForHash`, which sweeps ANY tmp residue matching that
hash with NO ownership check at all — not even the `orphanLatchFiles` check that protects the `.json`
shape. This is the exact gap a6fa60e2's own decision record flagged and deliberately deferred; confirmed
real by `merge-quarantine-lazy-graduation-source-latch-owner.mjs` scenario 2.

A THIRD, related gap: once `orphanLatchFiles` is folded in on a failed graduation (the fix below), a LATER
query against the same pending entry's persisted content — if it already carried a self-referencing
`orphanLatchFiles` entry from an earlier failed graduation attempt, now resolvable and succeeding this time
— must strip that self-reference before persisting, or the newly-written file falsely "protects" its own
already-deleted predecessor forever. Reproduced in scenario 3 (the graduation-branch analogue of a6fa60e2's
own DANGLING-ORPHAN-STRIPPED-ON-SUCCESSFUL-MIGRATE scenario).

## The fix

Mirrors a6fa60e2 exactly, for both shapes:

- On a FAILED graduation write, fold `pending.sourceFile` into the armed entry's own `orphanLatchFiles`
  (deduped) — folded in by re-arming under the SAME key with the updated object before returning, so
  nothing downstream (including a concurrent query, since this is all synchronous) ever observes the
  pre-mutation one. `sweepOrphanLatchFileIfUnreferenced`'s check (1) then keeps the stale `.json` final
  alive against a raw clear-by-id, exactly like PASS 1's branch already does.
- On EVERY graduation (not just the failure branch), `pending.entry.orphanLatchFiles` is stripped of
  `pending.sourceFile` BEFORE the write is attempted — the same dangling-reference ordering rule a6fa60e2
  added for PASS 1's branch, applied here so a pending entry whose own persisted content already names its
  own (about-to-be-superseded) filename from an earlier failed graduation never falsely protects it once a
  later graduation succeeds.
- `clearMergeQuarantineLatchFile`'s raw "no entry matches this id" fallback now calls a NEW,
  ownership-checked `sweepTmpResidueForHashIfUnreferenced` instead of the unconditional
  `deleteMergeQuarantineTmpResidueForHash` — it keeps (and reports `latchKept`) any `.tmp-<pid>` residue
  file still named in a surviving entry's `orphanLatchFiles`, deleting only what nothing references.

## Code Review `eccb3d10` (round 2) — MAJOR: the SAME ownership gap also lives in the PENDING-MATCH branch

The round-1 fix above only touched `clearMergeQuarantineLatchFile`'s RAW fallback (reached when NOTHING in
memory matches the cleared id). The reviewer reproduced the identical defect through the function's OTHER
branch — the PENDING-MATCH branch (reached when the clear-by-id DOES match some pending entry) — which had
its own belt-and-suspenders cleanup with the exact same two unconditional sweeps:

Two same-hash `.tmp-<pid>` residues can exist for ONE repo (PASS 1b pushes one pending entry per tmp file
sharing a hash). `activeMergeQuarantineFor` graduates only ONE of them (a separate, already-filed
follow-up card owns fixing that one-of-several-graduates shape — out of scope here); its fresh-key write
FAILS, folding its OWN tmp into its `orphanLatchFiles` (the round-1 fix, working as intended). A raw
clear-by-id of the SHARED hash then matches the OTHER (still-pending) entry — and the belt-and-suspenders
tmp sweep at that site called `deleteMergeQuarantineTmpResidueForHash` UNCONDITIONALLY, deleting the
graduated entry's own protected tmp too, even though this exact clear-by-id call never matched or removed
that entry at all. Reproduced in scenario 6. The `.json`-final analogue (the belt-and-suspenders
`${id}.json` sweep, gated on ownership (check 2) alone via `sweepOwnLatchFileUnlessOwnedElsewhere`) has the
identical shape: TWO INDEPENDENT repos can happen to reference/own the exact same hash (no real collision
needed — 9cabd143's own point, a filename is just a string) — one graduates from a `.json`-shaped pending
source with a failed write, the other holds an unrelated pending `.tmp-<pid>` entry sharing that hash
prefix; clearing by that hash matches only the second repo's pending tmp, yet the belt-and-suspenders
`.json` sweep used to delete the first repo's only durable copy on ownership alone. Reproduced in scenario 7.

### Fix

Each matched pending entry's own `sourceFile` stays check-(2)-only (`sweepOwnLatchFileUnlessOwnedElsewhere`,
9cabd143 unchanged — that function's own contract is specifically for an entry's OWN file, never gated on
whether something else merely references it). The two belt-and-suspenders sweeps are now:

- `${id}.json`: `sweepOwnLatchFileUnlessOwnedElsewhere` ONLY when `${id}.json` is itself one of the
  entries actually matched/removed in this call (the ordinary case — already deleted by the per-pending
  loop, so this is a harmless no-op). Otherwise routed through the full, orphan-reference-aware
  `sweepOrphanLatchFileIfUnreferenced` (checks 1 AND 2) — it might be a DIFFERENT, surviving entry's own
  reference, never something this call is entitled to delete on ownership alone.
- the tmp residue: `sweepTmpResidueForHashIfUnreferenced` (the same ownership-checked helper round 1 added
  for the raw fallback), never the unconditional `deleteMergeQuarantineTmpResidueForHash`.

### Item 2 — reworking the round-1 negative controls (scenarios 4/5) — SUPERSEDED by round 3, below

Round 2 correctly flagged that round 1's scenarios 4/5 were VACUOUS: their leftover tmp was UNREFERENCED,
so an ownership-checked sweep deletes it too — the test never actually distinguished "unconditional by
hash" from "ownership-checked but happens to be unreferenced." Round 2 reworked them to seed a GENUINELY
REFERENCED tmp instead, and then asserted that `deleteMergeQuarantineLatchByKey` (a legitimate clear) and
`writeMergeQuarantineLatch`'s own `sweepOtherTmpsOnSuccess` both STILL delete it, by hash, regardless of
the other entry's surviving reference — concluding that was CORRECT, deliberate behavior.

**That conclusion was WRONG, caught by Delta Code Review `bd812c95` (round 3).** The reworked scenarios 4/5
were pinning a REAL fail-open as a passing test, not demonstrating correct design — the SAME ownership gap
this whole card exists to close, reached through two MORE call sites. See the round-3 section below for
the real fix; this section is kept only so the history of the mistaken conclusion is visible, not restated
as if it were still live.

### Item 3 — per-half attribution for scenario 2

Verified directly (not captured in the test file itself — a one-off manual check, per the reviewer's ask):
with ONLY the round-1 fold-in fix present and the OLD unconditional `deleteMergeQuarantineTmpResidueForHash`
temporarily restored at the raw-fallback site, scenario 2 — and ONLY scenario 2 — goes RED (its 4 "THE
FIX"/"THE BUG"/"THE REGRESSION" checks). This confirms scenario 2's green is attributable specifically to
the ownership-checked SWEEP, not a side effect of the fold-in half alone.

### Item 4 — NIT: skip the failure-branch fold when sourceFile is already the fresh write target

The failure-branch fold (`activeMergeQuarantineFor`'s graduation tail) now skips folding `pending.sourceFile`
into `orphanLatchFiles` when it already equals `path.basename(quarantinePathFor(armed.repoPath))` — the
entry's own current write target — mirroring `deleteSourceLatchIfSuperseded`'s own equality guard ("the
stale source IS the file we just wrote — nothing to delete"). Purely hygienic: that edge case is already
fully owned via check (2), so folding it in as an `orphanLatchFiles` self-reference too would be redundant
bookkeeping, never a correctness gap on its own.

## Delta Code Review `bd812c95` (round 3) — MAJOR: round 2's scenarios 4/5 pinned a real fail-open

Round 2's negative controls were themselves wrong, not just weak. `clearMergeQuarantineByKey`'s own
tmp-residue sweep (via `deleteMergeQuarantineLatchByKey` → `deleteMergeQuarantineTmpResidueForKey` →
`deleteMergeQuarantineTmpResidueForHash`) and `writeMergeQuarantineLatch`'s `sweepOtherTmpsOnSuccess` path
both deleted EVERY tmp residue sharing the cleared/superseded entry's hash UNCONDITIONALLY — including a
DIFFERENT, SURVIVING entry's own protected residue (one it needs because ITS OWN graduation write failed,
exactly the round-1/round-2 shape). Concretely: repoB's failed graduation leaves a tmp as its ONLY durable
copy, filed under repoA's hash prefix (no real collision needed, per 9cabd143). `clearMergeQuarantine(repoA)`
deletes that tmp as a side effect of clearing repoA — an entry repoB's own quarantine has nothing to do
with. After a fresh-module reboot, repoB reads as NOT quarantined: the SAME two-path asymmetry class this
whole card exists to close, just reached through its THIRD and FOURTH call sites.

### Fix

Both call sites now route through `sweepTmpResidueForHashIfUnreferenced` instead of the unconditional
`deleteMergeQuarantineTmpResidueForHash` — a same-hash tmp a DIFFERENT, surviving entry's own
`orphanLatchFiles` still lists is KEPT. `writeMergeQuarantineLatch`'s own "proven superset" premise for
`sweepOtherTmpsOnSuccess` is a claim about THIS entry's own token/content history — it says nothing about
whether a DIFFERENT entry cross-references a same-hash tmp, so that premise never covered this case and
gating on it was never actually justified by it.

⚠️ **CORRECTED (round 4):** this section originally also claimed the cleared/superseded entry's OWN
residue is "still swept exactly as before." That is false whenever that entry's OWN `orphanLatchFiles`
self-references a same-hash tmp (e.g. its own stale source folded in by an earlier failed graduation) —
the ownership scan is not entry-scoped, so it sees that still-armed entry's self-reference and KEEPS the
file, exactly as it would for a different entry's cross-reference. See round 4, below, for the corrected
description (a benign keep, not a regression) and `sweepTmpResidueForHashIfUnreferenced`'s own doc.

**Deliberately NOT fixed here** (a separate card, per the delta reviewer's own scoping): the `.json`
overwrite sibling — `writeMergeQuarantineLatch` overwriting a fresh-key final that happens to collide with
a DIFFERENT repo's own `${H}.json`-shaped folded orphan reference. Same defect family, different call
site (a WRITE, not a sweep); out of scope for this round.

Scenarios 4 and 5 now seed a genuinely REFERENCED tmp AND assert the restart (the surviving entry's
quarantine must still be found after a fresh-module reboot) — proven RED at the pre-round-3 commit via
`negative-control.mjs`, GREEN after. Each also carries its own negative control: the cleared/superseded
entry's OWN genuinely UNREFERENCED residue is still swept.

## Delta Code Review `18485645` (round 4) — the LAST residual, closed; two doc corrections

The round-3 reviewer confirmed round 3 healthy (no resurrection via self-reference, dual-arm, or a surviving
pending copy) and reproduced the residual round 1-3 had each flagged but deliberately deferred:
`clearMergeQuarantineByToken`'s own PARTIAL-clear branch (an entry with more than one outstanding token;
clearing one token leaves the entry armed, reduced, and re-written) was still the ONE remaining caller of
the unconditional `deleteMergeQuarantineTmpResidueForHash` chain — same shape as rounds 2 and 3, just a
fourth call site. Fixed by routing it through `sweepTmpResidueForHashIfUnreferenced` too (scenario 8:
`tA1`/`tA2` both raised on repoA; repoB's own failed graduation leaves a tmp under repoA's hash prefix;
`clearMergeQuarantineByToken(repoA, tA1)` — a partial clear, repoA stays quarantined via `tA2` — used to
delete repoB's only durable copy regardless; proven RED at the pre-round-4 commit, GREEN after).

As of this fix, `deleteMergeQuarantineTmpResidueForHash`/`ForKey`/`ForRepoPath` (the UNCONDITIONAL chain)
have ZERO remaining production callers anywhere in this module — every site that sweeps a same-hash tmp
now goes through the reference-aware helper. Left in place rather than deleted (out of scope for a
targeted bugfix round; a drive-by deletion is its own review surface) — same posture as the PRE-EXISTING
dead `deleteMergeQuarantineLatch(repoPath)` (line ~354, zero callers, unrelated to this card, noted here
only because the reviewer flagged it in the same pass). A future housekeeping pass may remove both; this
card does not.

### Two doc corrections (findings 1-2, no behavior change)

**Finding 1.** `sweepTmpResidueForHashIfUnreferenced`'s own doc claimed the entry actually being
cleared/superseded at a given call "gets no special exemption: its own unreferenced residue is still
deleted exactly as before." FALSE whenever that entry's OWN `orphanLatchFiles` self-references a same-hash
tmp (e.g. a stale source folded in by an EARLIER failed graduation that hasn't yet been fully cleared): the
ownership scan is not entry-scoped, so it sees that still-armed entry's own self-reference exactly like it
would see a different entry's cross-reference, and KEEPS the file. The round-3 section above made the
identical claim ("still swept exactly as before"). Both are now corrected in place (not restated, per this
project's own doc-hygiene rule) to describe the real, BENIGN behavior: an entry that self-references a
same-hash tmp keeps it alive until that entry is FULLY cleared (verified by the reviewer: no resurrection,
no permanent leak — `clearMergeQuarantineByKey` folds `orphanLatchFiles` into its own sweep once the entry
is actually removed). Only a tmp NEITHER a different entry NOR the entry's own current bookkeeping names is
swept at any given call.

**Finding 2.** 9cabd143's own record claimed unconditional tmp deletion "remains correct only because a
`.tmp-` filename can NEVER be check (2)'s 'a surviving entry's own CURRENT physical latch'" — true as a
narrow technical point (a live entry's enduring anchor is always a renamed `.json` final), but no longer the
reason ANY call site may delete a tmp unconditionally, since round 3-4 proved real call sites needed
exactly a check-1-style (referenced-by-`orphanLatchFiles`) gate that claim never addressed. Corrected there
to point at this card's rounds 3-4 instead of restating a now-irrelevant justification.

## Do not

- Do not add the ownership check inside `deleteMergeQuarantineTmpResidueForHash`/
  `deleteMergeQuarantineTmpResidueForKey` themselves — call `sweepTmpResidueForHashIfUnreferenced` at
  each site that needs it instead. As of round 4 that is EVERY production site that ever swept a
  same-hash tmp: `clearMergeQuarantineLatchFile`'s two sweeps (round 1/2), `deleteMergeQuarantineLatchByKey`'s
  own legitimate-clear sweep (round 3), `writeMergeQuarantineLatch`'s `sweepOtherTmpsOnSuccess` (round 3),
  and `clearMergeQuarantineByToken`'s partial-clear branch (round 4) — the unconditional chain now has NO
  remaining production caller; see `deleteMergeQuarantineTmpResidueForHash`'s own doc. Do NOT cite "would
  leave orphaned residue behind forever" as a reason to avoid the reference-aware check anywhere — that
  framing is RETRACTED (round 2) and was never true (a kept file sweeps once its own referencing entry
  later clears) and never actually justified anything (rounds 3-4 showed the real unconditional call
  sites were a genuine bug, not a deliberate design needing that justification).
- Do not describe the entry actually being cleared/superseded at a `sweepTmpResidueForHashIfUnreferenced`
  call as "exempt from" or "unaffected by" the ownership check (round 4, findings 1-2) — the scan is not
  entry-scoped: if that SAME entry's own `orphanLatchFiles` self-references a same-hash tmp (e.g. from an
  earlier failed graduation not yet fully cleared), this call KEEPS it too, benignly, until that entry is
  fully cleared. Only a filename neither a different entry nor the entry's own current bookkeeping names
  is swept at a given call.
- Do not gate `clearMergeQuarantineLatchFile`'s belt-and-suspenders `${id}.json` sweep on ownership
  (`sweepOwnLatchFileUnlessOwnedElsewhere`) when `${id}.json` is NOT itself one of the entries actually
  matched/removed in that same call — route it through `sweepOrphanLatchFileIfUnreferenced` (checks 1 AND
  2) instead, or a DIFFERENT, surviving entry's own reference to that exact filename (sharing only the
  hash prefix with whatever this call actually matched) can be destroyed. See scenario 7.
- Do not assume the raw-fallback branch's ownership-checked sweeps (round 1) were sufficient on their own
  — `clearMergeQuarantineLatchFile`'s OTHER branch (the pending-match one) had the identical two
  unconditional sweeps, reachable whenever the clear-by-id matches some OTHER, unrelated same-hash pending
  entry instead of the one actually holding the protected reference. See scenario 6.
- Do not strip `pending.sourceFile` from `orphanLatchFiles` AFTER the `writeMergeQuarantineLatch` call, and
  do not skip re-adding it in the failure branch — same ordering rule as a6fa60e2 (strip before attempting
  the write; re-add only in the failure branch), or a graduation that fails after a prior successful strip
  loses the only-durable-copy protection this card exists for. Also skip the fold entirely when
  `pending.sourceFile` already equals the entry's own fresh write target (item 4) — nothing to protect.
- Do not assume this closes every lazy-graduation-adjacent gap — `activeMergeQuarantineFor`'s other two
  pending-match fallbacks (`ancestorAwarePathIdentity`, the resolvable-now walked-key match) funnel through
  the SAME graduation tail this fix covers, so they inherit the fix for free; this was not re-verified
  per-fallback with a dedicated repro, since all three share the identical code once `idx` is found.
- Do not fix the reviewer's OTHER finding here — that `activeMergeQuarantineFor` graduates only ONE of
  several same-hash pending entries per query, silently leaving the rest pending forever rather than
  reconciling them. That is a separate, already-filed follow-up card; scenarios 6/7 deliberately EXPLOIT
  this existing shape to reach the ownership gap rather than fixing it.
