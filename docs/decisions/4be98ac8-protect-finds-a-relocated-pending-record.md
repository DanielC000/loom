# 4be98ac8 — protectOccupantContentBeforeDelete folds a safety-tmp-relocated pending record into its write

Found while working 59e758e5 / 7845ae33. When `divertRaiseEntry`/`mintPendingDivert`'s safety-tmp fallback relocates a
pending record to `<24hex>.json.tmp-safety-<pid>-<hex>`, `protectOccupantContentBeforeDelete` could not find it (its
match is `sourceFile === <deterministic pending name>`, and that file no longer exists), so it minted a SECOND pending
record for the same identity. Fail-closed (a split, not a loss), but the identity then needed both records cleared.

## Fix

The protect write now also folds in every pending record whose `directPathIdentity` equals the occupant's AND whose
`sourceFile` matches `RELOCATED_SAFETY_TMP_RECORD_RE` (anchored on the full basename). On a successful merged write
each whose file is already gone, or whose on-disk tokens are all in the written entry, is re-pointed everywhere,
dropped from the pending list, and (if present) swept via `sweepOwnLatchFileUnlessOwnedElsewhere`. "Kept" means
tracked: a file left on disk (unsafe, unreadable, uncovered) keeps its pending slot and entry untouched; a sweep
that fails (EPERM) has its name added to the written entry's `orphanLatchFiles`. Each case logs.

## The shape is shared, so the match is identity + shape

`<24hex>.json.tmp-safety-<pid>-<hex>` is NOT unique to the divert fallback. Every `writeSafetyTmpResidueAtHash`
output has it, and boot pushes pending records with that sourceFile too: Phase 0 at-risk relocation, boot
safety-tmp recovery's unresolvable case, the degraded-occupied finding-E ref, and the corrupt-safety-tmp
placeholders. Why matching them is safe: the identity gate excludes the finding-E ref (different identity); a
same-identity union is exactly what the `atFilenameIdx` path already does; the sweep re-checks content coverage
and ownership before unlinking; a corrupt or placeholder file reads as not-`entry` and so is never swept.

## Do not

- Do not match a relocated record via a bare `orphanLatchFiles` cross-reference (decision 9cabd143).
- Do not widen the tier to ordinary-named records: one identity may legitimately hold two disjoint-token records (d4b25feb R2).
- Do not fold the relocated records into `toWrite`: the double-fault branch must keep leaving them untouched (fail closed).
- Do not sweep a relocated file before the merged write has succeeded.
- Do not take only the first matching relocated record (188b145f: take all).

Test: `packages/daemon/test/merge-quarantine-7845ae33-relocated-record-polarity.mjs` (in-process, reboot, write-failure and ordinary-name legs).
