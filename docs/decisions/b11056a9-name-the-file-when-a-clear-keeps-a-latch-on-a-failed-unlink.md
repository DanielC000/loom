# b11056a9 — a clear that keeps a latch because an unlink failed names the file and the next action in its reason

From the Code Review of `59f4ebe8` (pre-existing UX gap). A failed non-ENOENT unlink in a quarantine sweep keeps the file and files the clear under the unattributed keep: `latchKept:true`, an empty `referencingRepoPaths`, and only the generic "a physical latch file ... is still on disk" sentence. `/clear-by-path {id}` returned no reason at all, and the file name lived only in a `console.error` line.

## What changed

The sweeps already knew the failing basename; they kept only booleans. Each records the name next to its existing failure flag, never as a parallel signal: `sweepOrphanLatchFilesUnioned` and `sweepTmpResidueForHashIfUnreferenced` (and its cleared-pending aggregate) return `unlinkFailedFiles`, `sweepOwnLatchFileUnlessOwnedElsewhere` returns `unlinkFailedFile` beside `unlinkFailed`, and `deleteMergeQuarantineLatchByKey` forwards `unlinkFailedFiles`. The three public clears fold them into one set per call and append `unlinkFailedClauseFor(...)` to the reason. `/clear-by-path {id}` now forwards `reason` when a latch was kept.

## Round 2 (Code Review S2/S3/N3)

- The clause also rides the two reasons that are rebuilt rather than extended: `clearMergeQuarantineReporting`'s still-quarantined branch (the by-path body result now carries `unlinkFailedFiles`) and `composeBroadUnionClearResult` (`clear-broad-union`). Both go through `withUnlinkFailedClause`; neither changes a disposition.
- The still-on-disk filter is pinned by a case where the FIRST unlink of an orphan fails once and a second sweep of the same basename (a same-identity pending entry listing it) deletes it: the name is not reported.
- The by-id gateway spread forwards `reason` whenever a latch was kept, so it also forwards a relocated-co-occupant reason (those repoPaths are already in `stillBlockedCoOccupants`); that is intended, not a leak.

## Do not

- Do not replace a reason with the unlink clause. It is appended to the existing reason (the generic unattributed sentence stays), so another unattributed cause (a marked-unreadable keep) is never hidden.
- Do not name a file from a keep. Names come only from real failed-unlink events, filtered to files still on disk when the result is built (`liveUnlinkFailedNames`), so a content keep that `retractContentKeepsBlockedOnlyByClearedIdentity` removed, or a file a later step deleted, is never named.
- Do not add a response key. The text rides in the existing `reason`; the key-set pins stay untouched.
- Do not name a directory, an errno text or file content: basenames only, deduped, at most `UNLINK_FAILED_CLAUSE_MAX_NAMES` then "and N more".
- Do not touch a sweep's keep/disposition logic to record a name; the changes are name-recording additions beside existing flags.

## Not covered

- (Closed by `a6690287`: a failed unlink of an active entry's OWN final file now also sets `unattributed`, so it reports `latchKept` with the named file.) Previously it recorded a name but set no `unattributed`, so the name was reported only when some other keep fired.
