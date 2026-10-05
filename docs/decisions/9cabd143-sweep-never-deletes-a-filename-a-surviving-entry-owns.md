# 9cabd143 — never sweep a filename a surviving quarantine entry uses as its own latch

## Context

Follow-up to `6237bef6` (Code Review `4fc079ba`, pre-existing semantics, not introduced there).
`sweepOrphanLatchFileIfUnreferenced` (git/merge-quarantine.ts) decided whether an orphan filename was
safe to delete by checking only whether any surviving active/pending entry's own `orphanLatchFiles`
array still listed it. It never checked whether the filename IS itself a surviving entry's own current
physical latch.

## The scenario — no real SHA-256 collision needed

`quarantineHashForKey(key)` is deterministic: a `.json` latch's filename is always exactly
`<hash-of-key>.json`. The bug doesn't need two different repos' keys to hash equal — it's simpler and
directly reachable:

1. At boot, repo B is NOT in `registeredRepoPaths` (not yet registered as a Loom project). A corrupt/
   unparsable leftover file happens to sit on disk at `<hashB>.json` — B's own deterministic filename,
   left over from some earlier life. `reenterMergeQuarantinesAtBoot`'s PASS 2 can't match it to any
   CURRENTLY registered repo, so it's an orphan — fanned into every other registered repo's (e.g. repo
   A's) `orphanLatchFiles: ["<hashB>.json", ...]`, durably persisted on A's own entry.
2. Later, in-process, repo B gets registered and raises a real quarantine via `enterMergeQuarantine(B,
   ...)`. `writeMergeQuarantineLatch` writes B's real, valid latch to the SAME deterministic path
   `<hashB>.json` — that's just B's own filename, nothing coincidental. The file now holds B's live,
   real quarantine data.
3. A human (or an in-process auto-clear) clears A. `clearMergeQuarantineByKey` sweeps A's
   `orphanLatchFiles`, including `<hashB>.json`, via `sweepOrphanLatchFileIfUnreferenced`. The old check
   only asks "does any surviving entry's own `orphanLatchFiles` still list this filename?" — B's entry
   doesn't list its own file there (that field references *other* orphans, never itself) — so nothing
   references it, and the sweep deletes `<hashB>.json`, destroying B's only durable record. B stays
   quarantined in THIS process's memory, but a restart loses the latch file entirely — the quarantine
   fails OPEN.

## Fix

`sweepOrphanLatchFileIfUnreferenced` now treats a filename as "needed" (never deleted) under either of
two conditions:

1. Some surviving entry's own `orphanLatchFiles` still lists it (the pre-existing check).
2. The filename IS itself a surviving entry's own current physical latch — an ACTIVE entry armed under
   a key whose `quarantineHashForKey` output equals this filename, or a PENDING entry whose own
   `sourceFile` is this exact filename.

Condition 2 closes the gap: a filename that was unclaimed/corrupt orphan debris at one boot, and so got
fanned into some other repo's `orphanLatchFiles`, can later be legitimately reclaimed by its own
rightful repo. The sweep must recognize that reclaim regardless of whether anyone's `orphanLatchFiles`
list was ever updated to reflect it (nothing updates those lists when a repo later raises for real — by
design, raising a quarantine has no reason to touch any OTHER entry's bookkeeping).

The function now returns `{ kept: boolean; referencingRepoPaths: string[] }` instead of `void`, so a
caller that cares (see below) can report a kept file rather than silently treating "I asked to sweep"
as "it's gone."

## Fix — `clearMergeQuarantineLatchFile`'s own two direct-unlink bypass sites

Found during review (lead, reviewing `6237bef6` round 2 `d449dff8`): `clearMergeQuarantineLatchFile`'s
pending-match branch's own belt-and-suspenders cleanup, and the raw-fallback branch below it (reached
when no in-memory entry anywhere matches `id`), both unlinked `<id>.json` directly via `fs.unlinkSync`
— bypassing `sweepOrphanLatchFileIfUnreferenced` entirely, including its PRE-EXISTING `orphanLatchFiles`
check, not just the new condition 2 above. If `<id>.json` is also a surviving entry's own
`orphanLatchFiles` reference (or, the narrower sibling of the main bug, that surviving entry's own
physical latch), it was deleted "while still referenced" — same narrow collision class, reached through
a call path that never shared the check at all.

Both sites now route through `sweepOrphanLatchFileIfUnreferenced(`${id}.json`)` instead of a bare
unlink. `deleteMergeQuarantineTmpResidueForHash(id)` (the `.tmp-` residue cleanup at both sites) is left
as a direct, unconditional unlink — see "Round 2, item 2" below for why that remains correct (round 1's
own claim here, that a `.tmp-` filename is never tracked in anyone's `orphanLatchFiles`, was WRONG and is
corrected there, not restated here).

### A third direct unlink, found by the test for the second site above (round 1 shape — corrected by Round 2 item 1 below)

The pending-match branch's own per-matched-entry loop — `for (const pending of matchedPending) { ...
fs.unlinkSync(path.join(MERGE_QUARANTINE_DIR, pending.sourceFile)); }`, which runs BEFORE the
belt-and-suspenders sweep — has the SAME bypass: a matched pending entry's own `sourceFile` is typically
EXACTLY `${id}.json` (the ordinary `.json`-final shape), so in the common case THIS loop, not the
trailing belt-and-suspenders call, is what actually deletes the file. The test built for the
belt-and-suspenders fix (a hand-written pending fixture whose sourceFile basename matched the `id` under
test, exactly the ordinary shape) caught this: a kept-reporting flag correctly came back `true`, but the
file was already gone by the time the belt-and-suspenders sweep ran. Round 1 fixed this by routing it
through the SAME `sweepOrphanLatchFileIfUnreferenced` (both checks 1 and 2) the orphan-reference sites
use — which introduced the Round 2 item 1 regression below, since an entry's OWN file must never be
gated on check 1.

### Surfacing a kept file, rather than reporting a clean removal

`clearMergeQuarantineLatchFile`'s result gained two optional fields, set only when the sweep actually
kept the file: `latchKept: true` and `referencingRepoPaths: string[]` (the repoPaths of every entry
still referencing or owning the filename). `wasQuarantined` is unaffected — it already answers "did
*this id's own* in-memory entry/entries get cleared," which is orthogonal to whether the underlying
`.json` file happened to survive because something else still needs it.

`POST /internal/merge-quarantine/clear-by-path`'s `{id}` form (the only gateway route that calls
`clearMergeQuarantineLatchFile`) forwards these fields on its response when present, so a human clearing
by id can see that the file was intentionally kept and which quarantine(s) still hold it, rather than
reading a bare `{ok:true}` as "fully removed."

## Round 2 (Code Review `d37fd1aa` @ `627293b7`: REQUEST-CHANGES — the core fix is sound, mutation 1 confirms (Y))

**Item 1 (BLOCKING).** Round 1's third-site fix (above) routed a cleared pending entry's OWN `sourceFile`
through the FULL `sweepOrphanLatchFileIfUnreferenced` — including check (1), another entry's
`orphanLatchFiles` merely *listing* the filename. That's wrong for an entry's OWN file: the entry BEING
CLEARED is who that filename belongs to, so some other entry's stale reference to it is never a reason to
keep it. The bug: clear a pending entry by id while an unrelated SURVIVING entry's `orphanLatchFiles`
happens to list that same filename (e.g. a leftover reference from an earlier boot's own orphan fan-out)
— the file was kept, so the quarantine the human just cleared RE-ARMED on the next boot, while
`/clear`/`/clear-by-path {repoPath}` (which always delete a cleared pending entry's own `sourceFile`
unconditionally — see `clearMergeQuarantineByKey`'s and `clearMergeQuarantineByRecordedPath`'s own pending
filters) genuinely clear it. All three address forms must agree.

Fixed by splitting the helper: `physicalOwnerRepoPaths(filename)` factors out check (2) alone (does any
SURVIVING entry currently OWN `filename` as its own physical latch), used by a NEW
`sweepOwnLatchFileUnlessOwnedElsewhere(filename)` — gated ONLY on ownership, never on check (1) — for
BOTH the per-pending-entry `sourceFile` deletion and the belt-and-suspenders final-file deletion in
`clearMergeQuarantineLatchFile`'s pending-match branch. `sweepOrphanLatchFileIfUnreferenced` (checks 1 AND
2) stays as-is for genuine orphan-REFERENCE files (an entry's own `orphanLatchFiles` entries — files that
are NOT the entry being cleared's own file) and for the raw-fallback branch (reached when NOTHING in
memory matches `id` at all, so there is no "entry's own file" to distinguish from a referenced one — test
(Z1) still needs the full check there, confirmed by re-running it against this change).

(Z2) is re-pointed: it now proves a pending entry cleared by id STAYS cleared — its own file is deleted
even though a surviving entry's `orphanLatchFiles` still names it — across a REAL child-process restart
(the same rigor (Y) already uses), not merely that the file vanishes in-process.

**Item 2.** Round 1's claim that "`.tmp-`-shaped filenames are never tracked in anyone's
`orphanLatchFiles`" (used to justify leaving `deleteMergeQuarantineTmpResidueForHash`'s tmp-residue sweep
as a direct, unconditional unlink) was FALSE: `reenterMergeQuarantinesAtBoot`'s PASS 1b catch branch
(`else { orphanFilenames.push(f); ... }`, reached for a genuinely unparsable/unmatched `.tmp-` residue)
pushes the TMP's own filename into `orphanFilenames` exactly like a corrupt `.json` final — PASS 2 then
fans it into every registered repo's `orphanLatchFiles` identically, with no shape distinction at all.

The unconditional unlink is still CORRECT, for a different reason than originally claimed: a `.tmp-`
filename can NEVER be check (2)'s "a surviving entry's own CURRENT physical latch" — `writeMergeQuarantineLatch`
always renames tmp→final on success before anything else can observe it, so a live entry's own enduring
anchor is always a `.json` final, never a lingering tmp. A REFERENCED orphan tmp (check 1 only) is
therefore always safe to delete unconditionally too: the referencing entry's OWN quarantine enforcement
lives entirely in THAT entry's own separate, already-durable latch file — never in this orphan tmp — so
deleting it can never undermine anything currently enforced, only delay disk-debris cleanup bookkeeping
that was never going to matter functionally. This is the stated justification the Code Review offered as
an acceptable alternative to routing tmp deletion through the sweep; adopted rather than the sweep route,
since a glob-matched set of tmp files doesn't fit the sweep's own single-filename shape.

**Item 3.** `physicalOwnerRepoPaths`'s active-entry half now ALSO checks
`path.basename(quarantinePathFor(e.repoPath)) === filename` — the entry's TRUE current write target,
recomputed fresh from `e.repoPath` — not only `${quarantineHashForKey(k)}.json` for each of its own
`armedKeys`. An entry's `armedKeys` can go stale relative to its TRUE current key after a key drift (see
`abccee85`): `writeMergeQuarantineLatch` always targets the freshly recomputed key, never a stale armed
one, so checking only `armedKeys` could miss the filename a NEXT write to this entry would actually land
on.

**Item 4.** `physicalOwnerRepoPaths`'s pending half (`p.sourceFile === filename`) had no reachable test —
added (test (AA)): a pending entry P's own `sourceFile` protects it when a SEPARATE, surviving entry's
`orphanLatchFiles` references that exact filename and THAT entry (not P) is cleared. Unlike the
active-entry half of check (2) inside `clearMergeQuarantineLatchFile`'s OWN pending-match branch (where
reaching the branch at all already proves no active entry owns `id`, and any pending entry sharing that
exact `sourceFile` would already be in `matchedPending` and cleared alongside it — so condition 2 is
PROVABLY unreachable for an entry's own file there specifically), this pending-ownership path IS reached
by `sweepOrphanLatchFileIfUnreferenced`'s own ordinary callers (`clearMergeQuarantineByKey`'s and
`clearMergeQuarantineByRecordedPath`'s orphan-reference sweeps) — a real, hand-constructed scenario, no
SHA-256 anything needed (a pending fixture's `sourceFile` basename is chosen freely by whoever writes it).

**Item 5.** Added an `app.inject` assertion (`POST /internal/merge-quarantine/clear-by-path {id}`) proving
the route forwards `latchKept`/`referencingRepoPaths` on its JSON response, not just the underlying
function's own return value (section (Z1-route)).

## Do not

- Do not delete a filename in `sweepOrphanLatchFileIfUnreferenced` based only on whether some OTHER
  entry's `orphanLatchFiles` references it — also check whether the filename IS a surviving entry's own
  current physical latch (an armed key's deterministic hash, or a pending entry's own `sourceFile`).
  Checking only the reference list is exactly how this card's bug happened.
- Do not add a new direct `fs.unlinkSync` of a `.json` latch filename anywhere in this module without
  routing it through `sweepOrphanLatchFileIfUnreferenced` or `sweepOwnLatchFileUnlessOwnedElsewhere` —
  pick whichever matches what the filename IS (see the next item), never a bare unlink. This includes a
  PER-ENTRY unlink inside a loop, not just an obviously-named "sweep" call.
- Do not gate the deletion of an entry's OWN latch file (the file belonging to the entry you are
  currently removing — a pending entry's own `sourceFile`, or `<id>.json` when it IS a matched entry's
  own `sourceFile`, never merely "`<id>.json` for the id being cleared" in the loose sense — a
  pending-match call can match some OTHER entry while `<id>.json` itself belongs to nobody being cleared
  at all; see card `be79f4d5`, round 2, for the real repro this distinction closes) on check (1) (another
  entry's `orphanLatchFiles` merely listing it) — use `sweepOwnLatchFileUnlessOwnedElsewhere` (check 2
  ONLY) for that file. Use the full `sweepOrphanLatchFileIfUnreferenced` (checks 1 AND 2) for every OTHER
  case — a filename that is NOT one of the entries actually matched/removed in this call (an
  `orphanLatchFiles` entry it references, a DIFFERENT surviving entry's own cross-reference sharing only
  the hash prefix, or the raw-fallback branch where nothing in memory claims ownership of `id` at all).
  Conflating the two is exactly round 2 item 1's regression (this file) and `be79f4d5`'s round-2 MAJOR
  finding (the same conflation, reached via a pending-match that matches a DIFFERENT entry than the one
  `<id>.json` belongs to) — a cleared quarantine's own file (or a surviving entry's cross-reference) kept
  alive by someone else's stale reference, or wrongly treated as unowned, re-arms or fails open on the
  next boot.
- Do not assume a `.tmp-`-shaped filename is never referenced in anyone's `orphanLatchFiles` — PASS 1b's
  own catch branch pushes an unmatched/unparsable tmp's filename into the SAME `orphanFilenames` list a
  corrupt `.json` final uses (round 2 item 2). ⚠️ SUPERSEDED: this bullet used to go on to claim
  "unconditional tmp deletion remains correct only because a tmp can NEVER be check (2)'s 'a surviving
  entry's own current physical latch'" — that narrow technical point is still TRUE, but it is no longer
  why any call site may delete a tmp unconditionally: card `be79f4d5` rounds 3-4 found and fixed FOUR real
  call sites (`clearMergeQuarantineLatchFile`'s two sweeps, `deleteMergeQuarantineLatchByKey`,
  `writeMergeQuarantineLatch`'s `sweepOtherTmpsOnSuccess`, and `clearMergeQuarantineByToken`'s
  partial-clear branch) that needed exactly a check-1-style (referenced-by-`orphanLatchFiles`) gate this
  reasoning never addressed — none of them deletes a tmp unconditionally any more. Read
  docs/decisions/be79f4d5-lazy-graduation-source-latch-ownership.md rounds 3-4 for the real rule; do not
  re-derive or restate the retracted justification here.
- Do not check only an active entry's `armedKeys` when deciding whether it OWNS a filename — also check
  `path.basename(quarantinePathFor(e.repoPath))`, its TRUE current write target recomputed fresh. A key
  can drift after an entry was last armed (`abccee85`), and a write always targets the fresh key.
- Do not treat `clearMergeQuarantineLatchFile`'s `{ok:true}` as proof the underlying `.json` file is
  gone — check `latchKept` first. A kept file is a correct, intentional outcome (something else still
  needs it), never an error, but it must never be silently indistinguishable from a real removal.
- Do not extend this `latchKept`/`referencingRepoPaths` surfacing to `clearMergeQuarantineByKey`'s or
  `clearMergeQuarantineByRecordedPath`'s own pre-existing orphan-sweep loops without a fresh card — their
  return shapes (`void`, `{wasQuarantined, reason?}`) were left untouched here deliberately; only the two
  sites named above (and the one gateway route that reaches them) were in scope.
