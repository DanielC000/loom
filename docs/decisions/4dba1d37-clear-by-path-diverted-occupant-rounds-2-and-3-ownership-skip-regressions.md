# 4dba1d37 — rounds 2 and 3 of 95ea8d3f (the ownership-skip regressions in clear-by-path)

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

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
Follow-up section in `0dc514dc`'s own record for where it is proven reachable, naming the surviving sibling.

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
  `merge-quarantine-raise-protect-failure.mjs` and the Follow-up section in `0dc514dc`'s own record.
