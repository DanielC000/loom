# 95ea8d3f — a diverted occupant's clear-by-path never durably persisted

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

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

## Do not

- **(Follow-up 95ea8d3f)** Do not trust `sweepOwnLatchFileUnlessOwnedElsewhere`'s own
  `keptUnreadableLatchFiles` mark unconditionally forever — re-prove coverage via the SAME
  `markedFinalFullyCoveredByClear` content-containment check `deleteMergeQuarantineLatchByKey` already
  uses before trusting a mark that outlived the transient read failure that set it.
- **(Follow-up 95ea8d3f)** Do not fix only the mark check and assume `physicalOwnerRepoPaths` will then
  correctly let the file go — an entry ARMED at a key (but whose own write there was refused) reports as
  an "owner" purely from in-memory state, with no physical backing at all. Proven content coverage must
  settle BOTH checks together, never the mark alone — see the decision record's own two-cause narrative
  for why skipping the ownership check in that exact state is sound, not merely convenient.
  **(SUPERSEDED BY Follow-up 95ea8d3f, Round 2 — see its own bullets in `4dba1d37`'s record.)** "BOTH checks together" is
  TOO BROAD: proven coverage may settle ONLY `physicalOwnerRepoPaths`'s aspirational armed-but-unwritten
  half, never its pending-`sourceFile` match or any entry's `orphanLatchFiles` — a Critical fail-open
  regression, found by Code Review `c9af122d`.
- **(Follow-up 95ea8d3f)** Do not drop a settled mark before the unlink it licenses is CONFIRMED (success
  or ENOENT) — same N4 ordering rule as `deleteMergeQuarantineLatchByKey`; an EPERM/EBUSY-shaped failure
  must leave the mark set, fail-closed.
