# 656fdf39 — a human clear re-ingests a now-readable marked file BEFORE deciding, then lets the existing coverage/ambiguity checks decide

From Code Review `fde4674d` of `21ec39e5` (gen 435); PRE-EXISTING, from `702b4241`'s own machinery.

## The bug

Once boot marks a file in `keptUnreadableLatchFiles` (a read failure other than ENOENT/EISDIR —
`702b4241`), the mark persists for the whole PROCESS LIFETIME. The clear/sweep chokepoints that check this
mark before deleting a file only ever had ONE way past it: a token-coverage proof
(`markedFinalFullyCoveredByClear`/`orphanSweepSafeToDelete`-style checks) that the entry being cleared's
own `tokens` fully cover whatever is on disk. That proof structurally can never succeed for the shape this
card closes: the in-memory entry a human clear is lifting is boot's own PLACEHOLDER (a synthetic
`randomUUID()` token, self-referencing the marked file as its `sourceFile`) — never the real raiser's own
token, which the placeholder's read failure meant boot never actually saw. So a human full clear (the same
`clearMergeQuarantineReporting` helper `POST /internal/merge-quarantine/clear` calls) reported success and
lifted in-memory enforcement, but left the marked physical file on disk, still marked kept — and the NEXT
boot re-read it fresh (nothing re-triggers a re-read once the pending placeholder was already consumed by
the clear) and re-armed the exact identity the clear believed it had lifted.

Reproduced for BOTH physical shapes: the entry's own FINAL `.json` (self-referenced by
`divertUnreadableBootLatch`, reached via `deleteMergeQuarantineLatchByKey`'s own final-file check) and a
`.json.tmp-<pid>` residue (reached via `sweepTmpResidueForHashIfUnreferenced`'s same-hash sweep once
`resolveQuarantineFor`'s own eager `activeMergeQuarantineFor` snapshot — called at the very top of
`clearMergeQuarantineReporting`, BEFORE the real clear ever runs — graduates the pending placeholder into
`activeQuarantines`, which routes the clear through `deleteMergeQuarantineLatchByKey`'s active-entry path
rather than the pending-entry sweep). `sweepOwnLatchFileUnlessOwnedElsewhere` (used by every PENDING-entry
clear route that runs BEFORE graduation — `clearMergeQuarantineByKey`'s/`clearMergeQuarantineByRecordedPath`'s/
`clearMergeQuarantineLatchFile`'s own pending loops) has the identical gap for the same reason, reachable
whenever a pending entry's sourceFile is swept before any graduation happens.

## Round 1 (REJECTED, Code Review `66fad7ed`) — an identity-only discharge was a fail-open regression

The first fix added a SECOND, independent way past "cannot prove coverage": a marked basename that is
readable right now, whose content's own `repoPath` matches the identity being cleared, discharged
unconditionally — reasoning that a human-authoritative clear is "entitled to lift its own never-marked
latch unconditionally" the same way it already does for an ordinary, never-marked file.

That reasoning was wrong. Code Review found two concrete fail-opens:

- **B1** — identity match proves WHOSE file this structurally is, never that every token currently inside
  it is accounted for by what THIS clear is lifting. A repoPath can legitimately hold more than one
  outstanding raise over its lifetime (a partial/token-scoped history), or — the reviewer's own
  adversarial probe (`95ea8d3f-adversarial`/`25f6a7dc-l1318` in
  `merge-quarantine-raise-protect-failure.mjs`) — a degraded, walked-up key can be legitimately SHARED by
  a second identity's own real raise. The identity-only check destroyed that real, uncovered token. This
  reversed `63e49ee2` round 5's own rule ("never on an identity comparison against possibly-stale disk
  bytes") instead of mirroring it, despite the round-1 record's own claim to the contrary.
- **B2** — the SAME shortcut bypassed the existing `provenanceUnknown`/`contributorRepoPaths` ambiguity
  refusals (`9a55fb90`/`82032b5c`/`db0a9db0`) entirely: a union recorded on disk with either marker, whose
  in-memory record was still boot's own blank placeholder (no provenance info of its own), got unlinked on
  identity match alone, with the refusal never given a chance to fire.

## Round 2 (shipped) — re-ingest BEFORE deciding, then let the UNCHANGED existing checks decide

Round 1's identity-match shortcut is removed entirely, from all three chokepoints. In its place: before a
human clear decides anything about a `keptUnreadableLatchFiles`-marked file, re-ingest that file's real
content into the in-memory entry EXACTLY as a successful boot read would have — reusing
`latchEntryFromParsedRecord`/`detectUnknownProvenance`, the SAME primitives
`reconcileMarkedBasenameBeforeWrite`'s own placeholder branch already uses for the WRITE side (never a
parallel parser) — via the new shared helper `reconcileClearedEntryIfPlaceholder(entry, physicalPath)`.
Then the EXISTING, UNMODIFIED token-coverage proof (`markedFinalFullyCoveredByClear`) and ambiguity
refusals decide, with no further special-casing.

**Why this closes B1 without reopening it:** `reconcileClearedEntryIfPlaceholder` is deliberately gated on
`isUnreadablePlaceholderEntry(entry)`. A bare boot placeholder has NEVER been independently verified
before — there is no earlier, narrower truth for the disk to "grow past" — so adopting its real content
wholesale (tokens, provenanceUnknown, contributorRepoPaths) is safe, and the ordinary coverage check then
trivially (and correctly) succeeds, since every on-disk token is now also a known token of the entry being
cleared. A NON-placeholder entry (one whose real content a PRIOR successful read already captured,
`95ea8d3f-adversarial`/`25f6a7dc-l1318`'s own shape) is returned UNCHANGED — its tokens are never touched —
so the pre-existing coverage check, unmodified, is what correctly refuses when the file now holds more than
the entry already knew about.

**Why this closes B2:** reconciliation runs BEFORE the ambiguity checks, not after a decision has already
been made — at `clearMergeQuarantineLatchFile`'s own `activeMatch`/`matchedPending` resolution, and at
`clearMergeQuarantineByKey`'s/`clearMergeQuarantineByRecordedPath`'s own pending-identity loops — so a
real `provenanceUnknown`/`contributorRepoPaths` marker recovered from disk is visible to the existing
`9a55fb90`/`82032b5c`/`db0a9db0` refusal the moment it would otherwise fire, exactly as it would be for a
record that had never been marked unreadable at all.

Fixed at three chokepoints (the re-ingest call sites), plus the FOUR places that must run it early enough
to matter:

1. **`deleteMergeQuarantineLatchByKey`** (the FINAL-file check) — does NOT call `reconcileClearedEntryIfPlaceholder`
   itself (corrected by "Round 3" below, which found this description imprecise): its CALLER
   (`clearMergeQuarantineByKey`) reconciles its own `entry` BEFORE passing it down as `clearedEntry`, so
   `markedFinalFullyCoveredByClear` sees the already-reconciled tokens. For a SECONDARY key (`k !== key` in
   `keysToLift`), that one reconcile (against `key`'s own physical content) is never re-run against `k`'s
   own file — a marked final at a secondary key stays uncovered by this card alone (fails CLOSED: kept,
   disclosed, never a false lift) and is an accepted residual, not a bug this card closes.
2. **`sweepOwnLatchFileUnlessOwnedElsewhere`** — UNCHANGED signature (`filename, candidateTokens?`); every
   caller now passes an ALREADY-reconciled `entry.tokens` as `candidateTokens`.
3. **`sweepTmpResidueForHashIfUnreferenced`** (a same-hash `.json.tmp-<pid>` residue) — gained an optional
   `clearedEntry?: MergeQuarantineEntry` param (replacing round 1's `clearerIdentity?: string`), reconciled
   against the TMP's own path (not `final`'s), then checked via the same `markedFinalFullyCoveredByClear`.
4. **Early reconciliation call sites** — `clearMergeQuarantineByKey` (its own `entry` lookup, and its own
   pending-identity loop, mutating `p.entry` via `replaceEntryEverywhere` so an `883e29bc` twin's
   in-memory references never drift apart), `clearMergeQuarantineByRecordedPath` (its own pending-identity
   loop — delegated active entries are covered transitively, since `clearMergeQuarantineByKey` reconciles
   its own `entry` regardless of caller), and `clearMergeQuarantineLatchFile` (its own `activeMatch`/every
   `matchedPending` entry, reconciled immediately after they are resolved, BEFORE the
   `ambiguousIdentitiesFor`/`pendingContributors`/`pendingUnknownProvenance` checks ever run).

## Do not

- Do not reintroduce an identity-only (or any identity-ONLY) discharge shortcut at any of these
  chokepoints — see "Round 1" above for the exact two fail-opens that shape reproduces, independent of how
  narrowly it is worded.
- Do not let `reconcileClearedEntryIfPlaceholder` touch a NON-placeholder entry's `tokens` — that is
  precisely what makes B1's adversarial probe pass; the function's own gate (`isUnreadablePlaceholderEntry`)
  is load-bearing, not an optimization.
- Do not run the re-ingest AFTER an ambiguity check instead of before it — `clearMergeQuarantineLatchFile`'s
  own fix is positioned exactly where it is (immediately after `activeMatch`/`matchedPending` are resolved,
  before `ambiguousIdentitiesFor` or `pendingContributors`/`pendingUnknownProvenance` ever read the entry)
  for this reason; moving it later reopens B2.
- Do not assume `sweepOwnLatchFileUnlessOwnedElsewhere`'s own fix alone covers the realistic
  `clearMergeQuarantineReporting` path — `resolveQuarantineFor`'s own eager `activeMergeQuarantineFor`
  snapshot graduates a RESOLVABLE repo's pending placeholder before the real clear ever runs, which routes
  the clear through `deleteMergeQuarantineLatchByKey`'s ACTIVE-entry path (and its own
  `sweepTmpResidueForHashIfUnreferenced` call) instead. Both chokepoints are load-bearing; this was
  confirmed directly via a scratch repro before either fix was written, not assumed from reading the code
  alone.
- Do not read this card as closing `divertRaiseEntry`'s own best-effort `sweepOwnLatchFileUnlessOwnedElsewhere`
  call in its write-failure fallback (merge-quarantine.ts, inside the triple-fault branch) — it carries no
  `clearedEntry` to reconcile through, and is deliberately left untouched by this card.
  **(SUPERSEDED by "Round 3" below for `clearTokenFromPendingIndices`'s own full-lift-branch sweep — that
  one DOES carry a `clearedEntry` through `deleteMergeQuarantineLatchByKey`, which is exactly how it
  reached the round-2 chokepoint; see Round 3's BLOCKING 1.)**
- Do not assume `clearMergeQuarantineLatchFile`'s own raw "no entry matched this id" fallback
  (`sweepOrphanLatchFileIfUnreferenced`/`sweepTmpResidueForHashIfUnreferenced` with no `clearedEntry`) is
  covered by this card — there is no matched entry to reconcile in that branch, so it is left unchanged,
  fail-closed as before (this is the shape `merge-quarantine-protect-read-failure.mjs`'s own `tp:clearid-p`
  variant still exercises).
- `63e49ee2` round 5's own rule ("only a durable action — a rename-over or copy-aside — may ever clear a
  mark, never an identity comparison against possibly-stale disk bytes") is UPHELD by this design, not
  reversed: the mark is discharged only after `deleteMergeQuarantineLatchByKey`'s/`sweepOwnLatchFileUnlessOwnedElsewhere`'s/
  `sweepTmpResidueForHashIfUnreferenced`'s own confirmed unlink, never from the re-ingest read alone — see
  each site's own doc comment for where that discharge actually happens.

## Tests

`packages/daemon/test/merge-quarantine-boot-unreadable-vs-corrupt.mjs` gained three scenarios:
`human-clear-after-unreadable-final-readable-does-not-rearm` (the FINAL-file shape, via
`deleteMergeQuarantineLatchByKey`), `human-clear-after-unreadable-tmp-readable-does-not-rearm` (the
TMP-residue shape, via `sweepTmpResidueForHashIfUnreferenced` reached through the graduated-entry active
path), and `human-clear-by-id-reingested-ambiguous-union-refuses` (Code Review `66fad7ed`'s own B2: a
genuine on-disk union with `provenanceUnknown:true` and two tokens, marked unreadable at boot — asserts
the clear is REFUSED, not silently unlinked, and both tokens survive a reboot).

`merge-quarantine-protect-read-failure.mjs`'s own pre-existing `tp:clearid-t` scenario was re-baselined
(its "t" variant only — "p" is unchanged): `reenterMergeQuarantinesAtBoot` had already, BEFORE any
injection, successfully read the tmp residue and armed a genuine, non-placeholder pending entry for D (a
real `resolvedKey`, real tokens — confirmed directly via `listActiveMergeQuarantines()`), so once the
injected failure lifts, `clearMergeQuarantineLatchFile` now genuinely, correctly lifts D — its own tokens
already fully known and covering what's on disk. This is the fix working as intended on an entry that was
never placeholder-shaped to begin with (`reconcileClearedEntryIfPlaceholder` is a no-op here), not an
adopt-from-disk shortcut.

RED/GREEN proven via `pnpm --filter @loom/daemon negative-control --file
packages/daemon/src/git/merge-quarantine.ts --test packages/daemon/test/merge-quarantine-boot-unreadable-vs-corrupt.mjs
--test packages/daemon/test/merge-quarantine-protect-read-failure.mjs --test packages/daemon/test/merge-quarantine-raise-protect-failure.mjs
--ref <the true pre-card parent commit>` — RED failed as expected (the unfixed baseline), GREEN passed,
tree restored byte-identical.

Full `merge-quarantine*.mjs` corpus (72 files) run individually, both env states (`env -u LOOM_DEV -u
LOOM_SUPERVISED` / `LOOM_DEV=1 LOOM_SUPERVISED=1`), one lane at a time — all pass. One file
(`merge-quarantine-c93e9e7a-cross-entry-liftedkeys.mjs`) showed a single transient `git init` failure
(Windows status `0xC0000142`) during one run, immediately re-run in isolation and confirmed clean — a
process-contention flake unrelated to this card's own change, not a real regression.

## Round 3 (Code Review `d1e02886`, NOT-MERGEABLE on Round 2 / commit `56934e55`)

Round 2's re-ingest ran UNCONDITIONALLY, at every call site named above — with no notion of WHO is
clearing. Two BLOCKING findings, both pre-existing in Round 2's own shipped shape.

**BLOCKING 1 — the re-ingest is reachable from a TOKEN-scoped clear, not just a human identity-wide one.**
`clearMergeQuarantineByKey` is a SHARED unit: a human clear reaches it directly, but so does
`clearActiveEntryTokenAtKey`'s own full-lift (`clearMergeQuarantineByToken` -> `clearActiveEntryTokenAtKey`
-> `clearMergeQuarantineByKey`, fired whenever a single in-process auto-clear — e.g. a confirmed-dead
worktree kill — happens to release the LAST outstanding token on an entry that is still placeholder-shaped).
A token-scoped clear holds no identity-wide authority at all — it is a compare-and-clear over ONE token,
documented as "never used for the human REST route" — yet Round 2's unconditional re-ingest let it adopt
a marked file's ENTIRE real on-disk token set into the entry it is about to fully lift, making the
coverage proof `markedFinalFullyCoveredByClear` tautologically pass (every on-disk token is now also one
of the entry's OWN, freshly-adopted tokens) and unlinking the file — destroying a genuinely outstanding,
unrelated raiser's own token as collateral. The identical reach applies transitively: `deleteMergeQuarantineLatchByKey`'s
own unconditional `sweepTmpResidueForHashIfUnreferenced` call (passing `clearedEntry` straight through)
is reached by EVERY caller of `deleteMergeQuarantineLatchByKey`, including `clearTokenFromPendingIndices`'s
own full-lift branch — the "Do not" note above claiming that branch "carries no `clearedEntry`" was
itself wrong (see the correction inline, above); it does, via exactly this call chain.

**Fix:** an explicit `identityWideHumanClear: boolean` parameter, threaded through
`clearMergeQuarantineByKey` / `deleteMergeQuarantineLatchByKey` / `sweepTmpResidueForHashIfUnreferenced`.
`true` ONLY at the three genuinely identity-wide human clear routes — `clearMergeQuarantine`/
`clearMergeQuarantineReporting`, `clearMergeQuarantineByRecordedPath`, `clearMergeQuarantineLatchFile` —
and their own internal delegation to `clearMergeQuarantineByKey`/`deleteMergeQuarantineLatchByKey`.
`false` everywhere else, in particular `clearActiveEntryTokenAtKey`'s own full-lift call and
`clearTokenFromPendingIndices`'s own `deleteMergeQuarantineLatchByKey` call — both pass `false`
explicitly. Without the flag, a marked file keeps exactly Round 2's own BASELINE-BEFORE-round-2 behaviour:
kept, disclosed, never silently discharged on a tautological proof.

**(Round 4, Code Review `d19f0490`, nit 2)** On `clearMergeQuarantineByKey` and
`sweepTmpResidueForHashIfUnreferenced`, `identityWideHumanClear` is now a REQUIRED parameter (no default),
mirroring `deleteMergeQuarantineLatchByKey`'s own required param — every one of the (now 4 + 5) call
sites across this module decides the value explicitly; none inherits an implicit default. The one
remaining implicit-default call site the Round 3 text above already described as passing `false`
explicitly (`clearActiveEntryTokenAtKey`'s own `clearMergeQuarantineByKey(key, entry.repoPath)` call) was
in fact still relying on the default at the time that text was written — this round made it literally
explicit (`clearMergeQuarantineByKey(key, entry.repoPath, undefined, false)`), closing the gap between
the record's own claim and the code.

**BLOCKING 2 — `reconcileClearedEntryIfPlaceholder`'s own field merge OVERWROTE instead of UNIONING.**
The function's `{ ...reingested, tokens: ..., resolvedKey: entry.resolvedKey, resolvedKeys: entry.resolvedKeys,
armedKeys: entry.armedKeys, provenanceUnknown: ... }` return spread disk's own parsed record first, then
explicitly overrode `resolvedKey`/`resolvedKeys`/`armedKeys` with the IN-MEMORY entry's own (discarding
disk's), while leaving `orphanLatchFiles`/`contributorRepoPaths` to fall through from the DISK-ONLY spread
(discarding the in-memory entry's own). Two concrete consequences, both reproduced:

- A genuinely outstanding "collision" pending-divert file — minted when a fresh raise for the SAME
  identity cannot overwrite a marked final and diverts instead (`8db913e2`), then folded into the
  eventually-armed placeholder's own `orphanLatchFiles` when a later lazy-graduation write ALSO fails
  while the final is still marked (`188b145f`/`8a1bc2ef`'s own write-fails-folds-to-orphan shape) — was
  silently dropped the moment the final became readable and ANY identity-wide clear ran: `orphanLatchFiles`
  computed from the now-reconciled entry read as empty, so the collision file was never even considered for
  sweep, survived on disk holding a real outstanding token, and the NEXT boot re-armed the identity from
  it — while the clear itself reported CLEAN SUCCESS (no `latchKept`).
- `contributorRepoPaths` — an in-memory-only marker (another raiser's own identity folded in at RUNTIME,
  `82032b5c`, never persisted to disk by design) — was likewise dropped the moment reconcile ran, letting
  `9a55fb90`/`82032b5c`/`db0a9db0`'s own clear-by-id ambiguity refusal silently never fire on a union disk
  itself never recorded as ambiguous.

**Fix:** every field is now UNIONED, mirroring `reconcileMarkedBasenameBeforeWrite`'s own sibling fold
branch — `resolvedKey` stays the entry's own (never overwritten by disk), `resolvedKeys` unions disk's own
informative keys in via `unionResolvedKeysRetaining` (filtered through `positivelyForeignKey` against the
live `activeQuarantines` map, never a boot-time snapshot — this function is only ever reached outside the
boot loop), and `orphanLatchFiles`/`contributorRepoPaths` are plain set-unions of both sides (mirroring
`unionQuarantineEntries`'s own pattern), never a one-sided spread.

**Tests:** three new scenarios in `merge-quarantine-boot-unreadable-vs-corrupt.mjs` —
`656fdf39-round3-b1y-token-clear-old-tok-survives` (BLOCKING 1, the reviewer's own probe sequence: a
token-scoped clear of a fresh raise's own token must never adopt and destroy a DIFFERENT, genuinely
outstanding token physically sitting at the marked final), `656fdf39-round3-orphan-collision-never-silently-dropped`
(BLOCKING 2a: an identity-wide clear must never report clean success while a referenced collision file
survives unswept), and `656fdf39-round3-contributor-repo-paths-placeholder-clear-by-id-refuses` (BLOCKING
2b: clear-by-id must still refuse on an in-memory-only `contributorRepoPaths` marker disk itself never
carried). Each constructs its precondition directly via the existing `setActiveQuarantineTestOnly`/
`markLatchFileUnreadableTestOnly` test-only seams (never a real injected read failure) for determinism,
and each is proven RED on commit `56934e55` / GREEN after via
`node packages/daemon/scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts
--test packages/daemon/test/merge-quarantine-boot-unreadable-vs-corrupt.mjs` (default `--ref HEAD`, since
the fix was uncommitted on top of `56934e55` at the time it was run) — all three FAIL in the RED phase,
every pre-existing scenario in the same file stays green in both phases, and the GREEN phase plus the
byte-identical tree restore are both confirmed by the script itself.

**(Round 4, Code Review `d19f0490`, MINOR, proving the gap — rounds 3's own three scenarios above all
drove the FINAL-file shape through `clearActiveEntryTokenAtKey`'s own path; three of round 3's own gates
could each be removed with every then-existing test (including the three above) still green.** Two new
scenarios, same file: `656fdf39-round4-m6-tmp-shape-active-token-clear-old-tok-survives` (M6 —
`sweepTmpResidueForHashIfUnreferenced`'s own `&& identityWideHumanClear` gate, the SAME B1y shape but a
`.json.tmp-<pid>` residue, reached through `deleteMergeQuarantineLatchByKey`'s own tmp sweep rather than
its final-file coverage check) and `656fdf39-round4-m2-pending-entry-token-clear-old-tok-survives` (M2 —
`clearTokenFromPendingIndices`'s own hardcoded `false` at its `deleteMergeQuarantineLatchByKey` call, via
a genuinely PENDING, non-twin entry structurally tied to a separate active entry by token subset — never
reference equality, which `clearMergeQuarantineByToken`'s own twin-exclusion would otherwise route
through `clearActiveEntryTokenAtKey` instead). Each constructs its precondition via the existing
`setActiveQuarantineTestOnly`/`markLatchFileUnreadableTestOnly` seams plus a NEW test-only seam,
`pushPendingQuarantineTestOnly` (the pending-array twin of `setActiveQuarantineTestOnly`, needed to
construct a genuinely pending entry without a real raise/divert/boot sequence). Each is proven RED by
temporarily removing its own target gate (a direct, manual mutate → rebuild → run → restore cycle, the
gate's own line reverted via `Edit` immediately after — not `negative-control.mjs`, since the mutation
here is a single gate, not a revert to a prior commit) and GREEN on the restored tip.

**M8 — `clearMergeQuarantineByKey`'s own pending-loop reconcile gate (~L4642) — investigated, NO
discriminating test found, after two genuine attempts; do not re-attempt without reading this in full.**
The obvious construction (a genuine `883e29bc`-style dual-tracked twin, `p.entry === entry` by
reference, mirroring M6/B1y's own shape) was built and run against the gate removed (mutated to `if
(true)`) — it did **NOT** go red. Tracing why: the function's OUTER `entry` variable is captured ONCE, at
the top of `clearMergeQuarantineByKey`, BEFORE the pending loop ever runs, and is NEVER itself reconciled
for a token-scoped clear (the OUTER gate, a few lines above the pending loop, is `false` the whole time —
that is the correct, unmutated behaviour this card's own BLOCKING 1 fix already enforces). Mutating ONLY
the pending-loop's own gate makes `reconcileClearedEntryIfPlaceholder` return a NEW object and
`replaceEntryEverywhere` re-point `activeQuarantines`'s slot to it — but `p.entry` and the OUTER `entry`
now diverge (`p.entry !== entry`), which makes `tiedToThisEntity`'s own reference-equality disjunct FALSE,
so the twin is skipped entirely (`continue`) rather than mis-processed. The mutation's real effect here is
an accidental, SAFE no-op for this shape, not an exploit. A second construction (tying the twin via
`orphanLatchFiles` instead of reference equality, so the tie survives the `p.entry`/`entry` divergence)
was also traced by hand before building it: it reaches the REDUCE branch (not remove), whose own
`writePendingDivertFile` call there writes `p.entry.tokens` — the RECONCILED, UNION'd set — back to the
pending entry's own physical file. In THAT branch, reconciling is what PRESERVES the file's own real
on-disk token across the rewrite; NOT reconciling (the correct, gated behaviour) is what would instead
overwrite the file with a narrower, synthetic-only view and lose it — the EXACT OPPOSITE sensitivity from
BLOCKING 1/M6/M2. Given this, M8's gate was left in place (no evidence it is dead weight, and removing a
gate on "untested" grounds alone would reintroduce exactly the shape BLOCKING 1 closed if some other,
unexplored path through it exists) but no scenario for it ships — a scenario that cannot be shown to fail
is not evidence, and `656fdf39-round4-m8-dual-tracked-twin-token-clear-old-tok-survives` was removed from
the test file for exactly that reason before this record was finalized.

`656fdf39-round4-m5` (a `resolvedKeys`-union gap) was considered and left out per the manager's own
ruling — it is fail-closed either way, so no mutation of it can be shown to regress anything.

Full `merge-quarantine*.mjs` corpus (72 files; the new round-4 scenarios land inside the SAME, already-counted
`merge-quarantine-boot-unreadable-vs-corrupt.mjs`) re-run individually, both env states, one lane at a
time — all pass. `pnpm --filter @loom/daemon guards` — 30/30.

## Do not (Round 3 additions)

- Do not call `reconcileClearedEntryIfPlaceholder` from `clearMergeQuarantineByKey`/
  `deleteMergeQuarantineLatchByKey`/`sweepTmpResidueForHashIfUnreferenced` without first checking
  `identityWideHumanClear` — see "BLOCKING 1" above. A future caller of any of these three functions must
  explicitly decide which value it is entitled to pass, never default-inherit `true`.
- Do not let `reconcileClearedEntryIfPlaceholder` overwrite `orphanLatchFiles`/`contributorRepoPaths`/
  `resolvedKey`/`resolvedKeys` from either side alone — union them, exactly as "BLOCKING 2" above fixes.
  A future field added to `MergeQuarantineEntry` that this function's return literal does not explicitly
  name will silently fall through from the DISK-ONLY `...reingested` spread — audit every new field
  against this function specifically, not just `reconcileMarkedBasenameBeforeWrite`'s sibling fold branch.

## Do not (Round 4 additions)

- Do not remove `sweepTmpResidueForHashIfUnreferenced`'s own `&& identityWideHumanClear` gate, or change
  `clearTokenFromPendingIndices`'s own hardcoded `false` — each is proven RED (M6/M2 respectively) by the
  round-4 scenarios named in "Tests" above; removing either is a confirmed, reproduced regression, not
  dead weight. `clearMergeQuarantineByKey`'s own pending-loop reconcile gate (M8) is a THIRD such gate
  but is NOT proven this way — see "Tests" above's own M8 section before touching it; its own removal was
  investigated and NOT shown to regress through two attempted constructions, for reasons specific to how
  the pending loop's `p.entry`/the function's outer `entry` can diverge. Keep it anyway (no evidence it is
  safe to remove either) — "not proven dangerous" is not the same claim as "proven safe."
- Do not add a NEW caller of `clearMergeQuarantineByKey` or `sweepTmpResidueForHashIfUnreferenced` without
  an explicit `identityWideHumanClear` argument — both parameters are REQUIRED (round 4), so a caller that
  omits it fails to compile; there is no implicit default left to silently inherit.
- Do not import `pushPendingQuarantineTestOnly` from production code — same `TestOnly`-suffix convention
  as `setActiveQuarantineTestOnly`/`markLatchFileUnreadableTestOnly`; `no-src-testonly-import-guard.mjs`
  catches an accidental import.
