# 14bdcb2f — the human identity-wide clear defers its durable tombstone to the end of the public call

`tryClearMergeQuarantineByOwnIdentity` (clear-by-path, and `clearMergeQuarantine`'s foreign-fresh-key "unreduced" branch) delegated to `clearMergeQuarantineByKey`, which wrote its durable tombstone immediately, before the same call's own pending sweep ran. A later unlink failure in that sweep (an orphan file holding the token, tracked through a same-identity pending entry so ByKey's push-time disk scan excluded it) could not withhold the earlier tombstone: the clear reported `latchKept` while a reboot dropped the token. Same cross-phase shape card 3d4467cf closed on the token path.

The public function is now a wrapper: the body PUSHES jobs (ByKey's delegate through the optional `DeferredClearContext`, and the pending branch directly) and the wrapper runs `decideDeferredTombstones` once on the normal return. The `"none"` route (`clearMergeQuarantine`'s `overrideTargets`, several ByKey delegates in one call) also defers now and shares one write-failed set across its delegates; that can only withhold more, never write more.

## What each mechanism pins (from the mutants, not from reading)

Two mechanisms can withhold a token at decide time: the decide-time re-scan (`identityHasAnyPhysicalRecordHoldingToken` over `trackedBasenamesForIdentity`) and the call-scoped write-failed set. A mutant that removes ONE of them was run against the test, so each claim below names what actually goes RED.

- The re-scan alone pins only P4 (a survivor holding the token, tracked only by a DIFFERENT identity's entry, so not excluded). Removing the re-scan turns P4 RED and nothing else. P1 and P2 are withheld by BOTH mechanisms (the orphan feed and the re-scan), so neither mutant alone turns them RED.
- The re-scan is blind to basenames tracked by SAME-identity live entries (`trackedBasenamesForIdentity` excludes them). For those, only the write-failed set can withhold.
- Each write-failed feed of the pending branch is pinned by name, as the SOLE withhold (the failed file never holds the token, so the re-scan cannot be what withholds it), each by its own mutant that removes just that feed: the sourceFile sweep's real failed unlink (P9), the orphan sweep's `unlinkFailed` (P10), the tmp sweep's `unlinkFailed` (P11). ByKey's own feeds (`anyWriteFailed`, `tmpSweep.unlinkFailed` inside ByKey) and `deleteMergeQuarantineLatchByKey`'s `writeFailed` are inherited, not new.
- `deferred.writeFailed` is fed ONLY by a real failed write or unlink. `sweepOwnLatchFileUnlessOwnedElsewhere` now returns a distinct `unlinkFailed` for that; a keep that never attempted an unlink (a marked-unreadable file whose coverage cannot be proven: a foreign record, a same-identity record with other tokens, or corrupt JSON) is `kept` WITHOUT it and must not withhold (P8).
- P6 is a CHARACTERIZATION (it passes on main too): a failed tmp unlink withholds the tombstone. It is not a proof of this fix.

## Policy: the feeds are identity-keyed (accepted, cf. 59f4ebe8)

The write-failed set is keyed by identity, so a REAL failed unlink of a file that does NOT hold the token still withholds that token (P9/P10/P11 pin exactly this). That over-retain is accepted and intended: it is fail-closed, needs a genuine I/O failure, and matches 59f4ebe8's identity-wide write-failed policy.

## Do not

- Do not decide or write any tombstone for this route mid-call. The body pushes; the wrapper decides once.
- Do not decide in a `finally`. A throw out of the body must DROP the jobs (fail-closed, no tombstone); P3 pins this with a throw that lands in the pending branch, after ByKey has pushed its job.
- Do not feed a FOREIGN keep (`pendingAnyKept`: a referencing / content-kept / unattributed outcome) into `writeFailed`. That ANDs one site's foreign-keep signal into another site's decision (d2592cd5) and over-retains a token nothing holds (P5). The pending branch's OWN job keeps `!pendingAnyKept && !identityHasAnyPhysicalRecordOnDisk` as its `nonFailureOk`.
- Do not feed a sourceFile keep that attempted no unlink into `writeFailed` (P8); only `sweepOwnLatchFileUnlessOwnedElsewhere`'s `unlinkFailed` may.
