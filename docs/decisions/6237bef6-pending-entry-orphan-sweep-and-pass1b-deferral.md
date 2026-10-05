# 6237bef6 — sweep a pending entry's `orphanLatchFiles` on every clear path, and defer PASS 1b's tmp-residue recovery to pending too

## Context

Follow-up to `abccee85`'s "Traced, not fixed: pending entries' `orphanLatchFiles` sweep gap" (see that
record's own section) and its adjacent note on a PASS 1b asymmetry. `abccee85`'s section (P) reproduced,
informationally only: a PASS-2 fail-closed entry (an orphan latch matching no registered repo) persists no
`resolvedKey`; if its own `repoPath` later becomes unresolvable on a SUBSEQUENT boot, it reloads as a
PENDING entry (the `!resolvableNow && !entry.resolvedKey` gate in `reenterMergeQuarantinesAtBoot`'s PASS
1), still carrying its old `orphanLatchFiles` forward. Nothing that clears a pending entry ever looked at
that field — only the entry's own `sourceFile` was deleted.

## Fix — orphan sweep, at every pending-removal site, including one `abccee85` didn't name

Three sites, not two — `abccee85`'s own trace named only the first two:

1. `clearMergeQuarantineByKey`'s pending filter (used by `/clear`, project-resolved).
2. `clearMergeQuarantineLatchFile`'s pending-match branch (`/clear-by-path {id}`) — the exact site
   section (P) exercises.
3. `clearMergeQuarantineByRecordedPath`'s own direct `matchedPending` branch (`/clear-by-path {repoPath}`)
   — a sibling route to #2, same gap, not named in `abccee85`'s trace.

Added `sweepOrphanLatchFileIfUnreferenced(filename)`: deletes `filename` from `MERGE_QUARANTINE_DIR` only
if no SURVIVING entry — active or pending — still references it. Shared by all three sites above, and
also now backs the pre-existing ACTIVE-entry sweep in `clearMergeQuarantineByKey` (round 7 M2 only ever
checked `activeQuarantines`, so it could already delete a file a PENDING entry still referenced — a
narrower, untested instance of the same bug class, closed as a side effect of sharing one check).

Each of the three call sites now collects the `orphanLatchFiles` of whatever pending entry/entries it
removes (in addition to any active entry's own list, where applicable) BEFORE sweeping, and always sweeps
after the removal — never before — so "still referenced" is evaluated against the true survivors.

Chose this over persisting `resolvedKey` on every PASS-2-created entry (the card's other proposed
direction): `resolvedKey` only closes the gap when the repo was resolvable AT PASS-2-creation time, but
`quarantineAllRegisteredFailClosed` (boot-time directory-scan failure) and the matched-corrupt-latch
branches can fire for a repo that is ALREADY unresolvable at that moment — `resolvedKey` would stay unset
and the gap would still exist. Decision `7673d096` also already forbids trusting a key computed while a
path is unresolvable. The sweep fix closes the gap unconditionally, regardless of when the entry started
lacking a trustworthy key.

## Fix — PASS 1b's tmp-residue deferral asymmetry (card `369b97be`)

PASS 1 (`.json` finals) defers an unresolvable-and-no-`resolvedKey` entry to `pendingUnresolvedQuarantines`
BEFORE arming it. PASS 1b (`.json.tmp-<pid>` residue recovery) had no equivalent gate — it armed every
parsed tmp into `byRepoKey`/`activeQuarantines` regardless of resolvability; only the later per-key write
loop checked resolvability, and only to skip the disk write/unlink, by which point the entry was already
live as ACTIVE under a possibly-degraded key. Fixed by adding the identical gate to the tmp loop: an
unresolvable, no-`resolvedKey` tmp-parsed entry is pushed to `pendingUnresolvedQuarantines` (with
`sourceFile` set to the tmp's own real on-disk filename) and skipped, never armed, exactly mirroring PASS
1. The tmp file itself is left untouched on disk (same as the pre-existing "leave every tmp AS WRITTEN"
behavior for an unresolvable union at the final write-loop stage), to be recovered on a later boot once a
`resolvedKey` is known or the path resolves again.

### Secondary fix this exposes: `quarantineLatchFileIdsFor`'s pending-id slice

A pending entry sourced from a `.json` final has `sourceFile` ending in `.json`; one sourced from a `.tmp-`
residue (new, after the fix above) has `sourceFile` shaped `<hash>.json.tmp-<pid>[-<hex>]`.
`quarantineLatchFileIdsFor`'s pending branch computed the id via `sourceFile.slice(0, -".json".length)` —
correct only for the `.json`-final shape (strips exactly 5 trailing chars); for a `.tmp-` residue this
strips the wrong 5 characters and returns a garbage id. Fixed to cut at the first `.json` occurrence
instead (`sourceFile.slice(0, sourceFile.indexOf(".json"))`), correct for both shapes since a quarantine
hash is lowercase hex and can never itself contain the literal substring `.json`.

`clearMergeQuarantineLatchFile`'s own pending match had the same shape-assumption bug (exact string
equality against `${id}.json`, which a `.tmp-` residue's `sourceFile` never satisfies) — fixed to accept
either `${id}.json` or a `${id}.json.tmp-` prefix.

## Round 2 (Code Reviewer `4fc079ba` @ `98f8f23f`: REQUEST-CHANGES)

**Item 1 (BLOCKING).** PASS 1 and PASS 1b each independently defer an unresolvable, no-`resolvedKey`
entry to `pendingUnresolvedQuarantines` — so ONE unresolvable repo can end up with SEVERAL distinct
pending entries sharing the SAME id (its own `.json` final plus a `.json.tmp-<pid>` residue, or two
separate tmps from two interrupted writes). `clearMergeQuarantineLatchFile`'s pending branch used a plain
`for...of` loop with an early `return` on the FIRST match — reproduced: one clear lifted only one of the
siblings, the repo stayed blocked, and the other file survived to re-quarantine the repo on the next boot.
Fixed: collect EVERY pending entry whose `sourceFile` carries this id (both shapes) via `.filter(...)`,
drop them all, sweep each one's own `sourceFile` + `orphanLatchFiles`, and — belt-and-suspenders, mirroring
the raw-fallback branch below it — also sweep this id's own `<id>.json` and any remaining tmp residue
directly (`deleteMergeQuarantineTmpResidueForHash`), in case something under this exact id sits on disk but
was never captured as an in-memory pending entry at all. Same "drop every one" rule `abccee85` r6 already
applies to every other pending-removal site.

**Item 2.** Added a regression check, in the SAME child-process boot `test/merge-quarantine-unresolvable-
path.mjs`'s TP scenario already uses, for the two tmp-shaped id fixes from round 1 (the `quarantineLatchFileIdsFor`
slice and `clearMergeQuarantineLatchFile`'s shape match): a second, independent tmp-sourced pending entry,
set up alongside the scenario's own subject so it never disturbs that entry's own continuation into boot 2.

**Item 3.** This record's own Tests section named the wrong file and mischaracterized boot 2's own code
path (see the corrected section below — this paragraph is itself the fix).

**Item 4.** Moved `sweepOrphanLatchFileIfUnreferenced` + its JSDoc to sit ABOVE `clearMergeQuarantineByKey`'s
own JSDoc block — round 1 had inserted it BETWEEN that block and the function it documents, detaching the
block (and its `@decision` anchors) from `clearMergeQuarantineByKey` itself.

## Tests

`test/merge-quarantine-clear-by-path.mjs`:
- Section (P) flipped from an informational SKIP print to a hard, two-way assertion: the originally-traced
  orphan file is swept once nothing references it, AND (new) a second orphan file in the same scenario
  that is ALSO referenced by a still-active entry survives clearing the pending one (negative control proving
  the sweep isn't an unconditional delete).
- Section (P2) exercises `clearMergeQuarantineByRecordedPath`'s own pending branch (site 3), same
  child-process-per-boot shape as (P).
- Section (P-SHARED) — a pending entry and an active entry share one orphan file; clearing either ALONE
  leaves the file in place (referenced by the other survivor); clearing BOTH sweeps it. Caught a quieter,
  narrower sibling of the traced bug in the pre-existing active-path sweep along the way (see "Fix" above).
- Section (P-MULTI), round 2 item 1 — two sub-cases (a final + a tmp, and two tmps) that each independently
  land as TWO pending entries sharing one id for the same unresolvable repo; asserts ONE clear-by-id drops
  BOTH, zero files survive, and a SEPARATE boot 2 lists nothing for that repo.

`test/merge-quarantine-unresolvable-path.mjs` (not `boot-hardening.mjs` — that file's own PASS 1b scenarios
all use REAL, resolvable repos; this one already owns every "repo currently unresolvable at boot" scenario,
including the two-boot child-process technique PASS 1b's own fix needs). SCENARIO TMP-PENDING: an
unresolvable-path tmp residue with no `.json` final lands PENDING in boot 1 (proven by `armedKeys` being
absent — not `resolvedKey`, which stays `undefined` in BOTH the pending and the buggy-immediately-armed
case, since nothing ever sets it for an unresolvable path either way); a SEPARATE, later child-process
boot 2, once the path resolves again, re-arms it under the CORRECT (freshly-walked) key — this is PASS
1b's own ORDINARY resolvable-path promote-and-self-heal code, reached because boot 2 re-parses the
still-on-disk tmp file from a genuinely fresh process, NOT `activeMergeQuarantineFor`'s in-process lazy
graduation (that path is never exercised by this scenario — see "untested" below). The SAME boot 1 also
carries round 2 item 2's regression check (TP-IDCHECK, above).

**Untested, stated plainly rather than silently assumed:** `activeMergeQuarantineFor`'s own in-process
lazy-graduation path (querying a tmp-sourced pending entry via a live process, WITHOUT a second boot, once
its path becomes resolvable again) is not covered by any test added here. It shares its graduation/
`deleteSourceLatchIfSuperseded` code with the already-tested `.json`-final case (scenario G and others,
`merge-quarantine-unresolvable-path.mjs`), so it is expected to behave the same way for a tmp-shaped
`sourceFile` — but that expectation has not been independently verified for the tmp shape specifically.

## Do not

- Do not sweep an orphan file before removing the entry/entries that reference it from
  `activeQuarantines`/`pendingUnresolvedQuarantines` — `sweepOrphanLatchFileIfUnreferenced` must only ever
  be called AFTER the caller's own removal, or "still referenced" trivially includes the entry being
  cleared.
- Do not check only `activeQuarantines` (or only `pendingUnresolvedQuarantines`) when deciding whether an
  orphan file is still referenced — always both, via the shared helper; a split check is exactly how this
  card's own bug (and a quieter, narrower sibling in the pre-existing active-path sweep) happened.
- Do not persist `resolvedKey` on a PASS-2-created entry as a substitute for the sweep fix — it narrows the
  window but cannot close it (see "Fix" above); the sweep is the unconditional closure.
- Do not assume a pending entry's `sourceFile` always ends in exactly `.json` — after the PASS 1b fix, it
  can also be a `.json.tmp-<pid>[-<hex>]` residue filename. Any code that slices or string-compares
  `sourceFile` to recover a bare hash/id must handle both shapes (cut at the first `.json`, or prefix-match
  `${id}.json`), not just the final-file shape.
- Do not arm a PASS 1b tmp-parsed entry into `byRepoKey`/`activeQuarantines` before checking
  `isRepoPathCurrentlyResolvable`/`resolvedKey` — gate it exactly like PASS 1 does for a `.json` final, or
  the same one-boot fail-open class `54054c01` closed for finals reopens for tmp residue.
- Do not clear a pending entry by id via a `find`-then-`return` (or any shape that stops at the first
  match) — more than one pending entry can share one id (a final AND a tmp, or two tmps, for the same
  unresolvable repo). Collect and drop EVERY matching pending entry in one call (round 2, item 1).
- Do not insert a new top-level helper's own JSDoc between an EXISTING function's JSDoc block and that
  function itself — it detaches the block (and any `@decision` anchors in it) from what it documents. Put
  the new helper, with its own JSDoc, entirely before or after the existing block instead.
