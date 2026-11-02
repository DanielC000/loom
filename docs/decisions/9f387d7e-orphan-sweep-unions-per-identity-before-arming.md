# 9f387d7e — union a kept foreign orphan's tokens per identity before arming, never per file

Found by `25d0d45b`'s re-CR (`6e97c9da`, 2026-10-28, PROBED P4) as the orphan-latch twin of the
`.tmp-residue` union that card itself landed. `1dd00dca` armed a kept foreign orphan's content in memory,
synchronously, the moment its own sweep proved it safe to keep — but it armed PER FILE, inline, inside
`sweepOrphanLatchFileIfUnreferenced` itself. `25d0d45b` (the `.tmp-residue` twin) instead collects every
armable candidate for one hash across its OWN per-file loop and arms each identity exactly ONCE, after
the loop — but that fix never touched the `.json` orphan sweep, which kept arming inline.

## The repro

Clear an entry carrying two orphan refs O1 and O2 in its own `orphanLatchFiles`, both holding foreign
identity T's content, with distinct tokens tk1 and tk2. Processing O1 arms T in-process from O1 alone
(tokens: `[tk1]`). Processing O2 finds T already enforced (`stillBlockedEntryFor(T) !== undefined`) and
skips arming entirely — tk2, and O2 itself, are never folded into T's own in-memory entry at all. A
reboot reads O1.json and O2.json independently; PASS 1's own `armKeyUnlessDegradedCollision` ->
`armQuarantineKey` -> `unionQuarantineEntries` unions them into ONE entry carrying `tokens: [tk1, tk2]`.
So T ends up with only tk1 in-process but tk1+tk2 after a reboot — an IN-PROCESS-vs-REBOOT split (the
same class `1dd00dca` round 2 was rejected for; see that record).

## The fix

`sweepOrphanLatchFileIfUnreferenced` (renamed `orphanLatchFileSweepDecision`) stops arming/classifying
inline — a `"foreign"` outcome now hands its `armable` candidate and `repoPath` back to the caller
instead. A new shared helper, `sweepOrphanLatchFilesUnioned(files, candidateTokens, excludeIdentities)`,
runs that per-file decision over a WHOLE file list, buckets every `"foreign"` outcome by
`directPathIdentity` (unioning via `unionQuarantineEntries`, mirroring `sweepTmpResidueForHashIfUnreferenced`'s
own `armableByIdentity` union), arms each identity exactly ONCE after the whole loop, then classifies
(`classifyKeptRepoPath`) and logs each file's final disposition — only after arming, so a sibling orphan
of the same identity armed earlier in the same batch is already visible to the classification.

Every call site that used to loop over `sweepOrphanLatchFileIfUnreferenced` once per file now calls
`sweepOrphanLatchFilesUnioned` once over its whole set instead: `clearTokenFromPendingIndices`'s
full-lift branch, `clearMergeQuarantineByKey`, `tryClearMergeQuarantineByOwnIdentity`, and
`clearMergeQuarantineLatchFile`'s matched-pending branch (which also folds its own `${id}.json` orphan
check into the SAME batch when `${id}.json` is a mere orphan reference, rather than calling the old
single-file sweep separately — a same-identity pair sharing that id now unions too). The one remaining
standalone single-file call (`clearMergeQuarantineLatchFile`'s no-match fallback) also routes through the
new helper, with a one-element file list, for uniformity.

## Do not

- Do not re-copy the `armableByIdentity`-bucket-then-arm-once shape into a new orphan-sweep call site's
  own loop — route through `sweepOrphanLatchFilesUnioned`. Four hand-copied loops is exactly the
  shared-unit divergence this file keeps paying for (lesson 286).
- Do not arm or classify inside `orphanLatchFileSweepDecision` — it is the per-file DECISION only
  (referenced / deleted / own-content / unattributed / foreign-with-an-armable-candidate). Both the arm
  and the classification depend on the WHOLE batch having been decided first; doing either inline, per
  file, reopens this exact bug.
- Do not touch `armForeignOrphanContentInMemoryIfUnenforced`'s own Step B / unresolvable-identity union
  behavior — that is card `188ebf31`'s own, separate, out-of-scope territory (per `6b327712`'s own "Do
  not" list). This card changes only HOW/WHEN its `basenames[]` argument is assembled by each caller,
  never that function's own internal logic.
- Do not construct a two-orphan-same-identity repro fixture by writing the orphan file's REAL content
  before the boot pass that is supposed to see only the clearer's own reference to it — PASS 1 reads
  every `.json` file in the directory unconditionally, so a too-early write trips an unrelated
  stale-canonical-key migration for the foreign identity. Fold the bare reference first, boot, THEN write
  the orphan's real content — see `test/merge-quarantine-9f387d7e-orphan-union-per-identity.mjs`'s own
  `raiseAndFoldOrphanRefs`/`writeOrphanContentsForFixture` split (mirrors `1dd00dca`'s own established
  two-step fixture shape).

## Verification

`test/merge-quarantine-9f387d7e-orphan-union-per-identity.mjs`: the two-orphan repro driven through call
sites #2 (`clearMergeQuarantineByKey`, the MAIN scenario), #1 (`clearTokenFromPendingIndices`), #3
(`tryClearMergeQuarantineByOwnIdentity`) and #4 (`clearMergeQuarantineLatchFile`) via a table/loop, plus a
different-identity negative control (two orphan refs naming two DIFFERENT foreign identities on one
entry, proving they arm independently and never merge).

**Round 2 (Code Review) hardening** — a boolean `.ok` compare after clearing only tk1 cannot tell "T holds
tk1+tk2" from "T holds only tk2", so a last-wins mutant (`bucket.record = decision.armable` instead of the
union) passed the round-1 assertions. Each site-specific check now: (a) asserts T's in-process token SET
immediately after the clearer's own clear, via the pure `stillBlockedEntryFor` — never the mutating
`resolveQuarantineFor`/`activeMergeQuarantineFor` — carries BOTH tk1 and tk2 (this is the check the
last-wins mutant actually fails); (b) runs two symmetric legs, clearing tk1 and tk2 independently, each
asserting the SURVIVING token set rather than a bare boolean; (c) snapshots `MERGE_QUARANTINE_DIR`'s own
files right after the clearer's clear (before either leg touches T) and restores from that snapshot before
each reboot leg boots, so the reboot leg is a genuinely independent derivation of the same orphan files
rather than a boot from whatever the in-process leg already mutated. `assertRepoNotQuarantined` is still
used alongside the token-set checks (it mirrors real enforcement), but no assertion relies on it alone.

Negative-control (`pnpm --filter @loom/daemon negative-control --file
packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-9f387d7e-orphan-union-per-identity.mjs --ref a9848641`) against the
sha immediately before this fix: RED — 12 real assertion failures (build ok, not a build error), covering
all four call sites' token-set and leg checks; the different-identity negative control still passes
pre-fix too, confirming it is correctly scoped to the union behavior alone. GREEN — all 30 checks pass
after restoring the fix. Byte-identical restore confirmed.

**Last-wins mutant** (`bucket.record = decision.armable` in place of `unionQuarantineEntries(bucket.record,
decision.armable)`, `sweepOrphanLatchFilesUnioned`): applied as a temporary src edit, rebuilt, run directly
— 4 real assertion failures, exactly the new "(T's in-process token set carries both tk1 and tk2 ...)"
check at all four call sites, regardless of file-processing order. Restored byte-identical (confirmed via
`git diff`), rebuilt, re-ran green.

Also run directly (not via negative-control) under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and
`LOOM_DEV=1 LOOM_SUPERVISED=1` — green in both, ~3.2s solo (no `TEST_TIMEOUT_OVERRIDES` entry needed).
