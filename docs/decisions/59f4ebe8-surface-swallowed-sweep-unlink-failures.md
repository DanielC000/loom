# 59f4ebe8 — a non-ENOENT unlink failure in the quarantine sweeps is a write failure, not a silent drop

Found by 3d4467cf's round-4 worker (`d2592cd5-durable-cleared-tokens-tombstone.md`, "What this round did NOT fix"); same class as its ruling "a failed unlink IS a write failure".

## Defect (reproduced on a fresh build of main)

1. `sweepTmpResidueForHashIfUnreferenced`'s same-hash loop swallowed a non-ENOENT unlink failure of an unmarked tmp residue: no log, no `anyUnattributed`, no write-failure signal (the cross-hash loop set `anyUnattributed` only).
2. `orphanLatchFileSweepDecision` called a void `unlinkLatchFile` and returned `deleted` whatever happened.

Result under an injected EPERM: `anyWriteFailed:false`, no `latchKept`, file survives, no tombstone, and a fresh boot re-arms the quarantine from it. A silent over-block, never a fail-open, EXCEPT the tracked shape below.

## Tracked shape

The decide-time scan (`identityHasAnyPhysicalRecordHoldingToken`) excludes TRACKED basenames (`trackedBasenamesForIdentity`). A same-identity pending entry whose `sourceFile` (or `orphanLatchFiles`) is the survivor blinds it: the token was durably tombstoned while the file still held it. Only a caller-side write-failure signal covers that.

## Fix

- The tmp sweep returns `unlinkFailed` (both loops; also logs and sets `anyUnattributed`); `sweepTmpResidueForClearedPendingEntries` aggregates it. The orphan decision returns `{outcome:"unlink-failed"}` via `unlinkLatchFileConfirmed`, folded by `sweepOrphanLatchFilesUnioned`.
- Folded into the write-failure signal at: `deleteMergeQuarantineLatchByKey` (`ownFinalWriteFailed`); the token route's remove branch (`removeWriteFailed`, orphan AND tmp sweep); `clearMergeQuarantineByKey` (`anyWriteFailed` for the orphan sweep; for the 7aa9c406 tmp sweep, `deferred.writeFailed` in token mode only, gated on `unlinkFailed` never `kept`); `clearActiveEntryTokenAtKey`'s partial clear (`tmpSweepUnlinkFailed`, kept apart from `writeFailed` so its log stays accurate).
- Census of the three 7aa9c406 tmp sweeps: token remove branch FOLDED. By-key is fail-closed in identity-wide mode by structure: the durable decision (~:7653-7660) runs BEFORE the sweep (~:7663), and every same-identity pending record has already been removed, so `trackedBasenamesForIdentity` cannot exclude the not-yet-swept tmp; the disk scan sees it holding the token and no tombstone is written whatever the unlink outcome. It was NOT fail-closed in token mode (job pushed before the sweep, decide pass blind to tracked) until the deferred fold. Recorded-path NOT folded: its tombstone decision runs before the sweep with an identity-only disk scan, and a foreign residue must never feed this identity's tombstone (7aa9c406). Supporting evidence only: I probed recorded-path and identity-wide by-key in the twin shape (no tombstone, `latchKept`); that shape never tombstones even without a fault, so it is weak evidence, not a proof.
- Not folded: by-id and recorded-path own-file sweeps (`pendingAnyKept` includes `anyUnattributed`, which `unlinkFailed` implies), `writeMergeQuarantineLatch`'s success sweep, and the by-id no-match fallback (log line only). The log says "treated as a write failure by every caller that tracks one".
- Audited, no gap: every deferred-job push (remove, reduce, partial clear, by-key) has its sweeps folded before the push or via the deferred set; `rewriteOrphanLatchFilesAfterPartialClear` never unlinks; `protectForeignTmpResidueBeforeSweep`'s best-effort unlink only removes an already-duplicated tmp.

## Tests

`merge-quarantine-59f4ebe8-*`: `tmp-sweep-unlink-failure` (identity, token, tracked, token-pending-tracked, twin), `orphan-sweep-unlink-failure` (identity, token, token-pending-tracked), `remove-write-failed-sole-guard` (probe Q1). Each fold has a BEHAVIOURAL `negative-control --mutant`: tmp same-hash 5, orphan 2, Q1 1, remove-branch tmp fold 1, remove-branch orphan fold 1, by-key deferred fold 1 failing assertion(s).

## Do not

- Do not swallow a non-ENOENT unlink result at a sweep site, or report `deleted` for a file still on disk. Use `unlinkLatchFileConfirmed`'s boolean.
- Do not fold a sweep's `unlinkFailed` into a persistence-failure flag whose log text claims a write did not persist; use a separate flag (see `tmpSweepUnlinkFailed`).
- Do not read the decide-time disk scan as the guard for a failed unlink: it is blind to a tracked basename. The caller-side write-failure signal is the guard.
- Do not make `removeWriteFailed` look redundant because P8 is triple-masked; the Q1 test is the case where it is the only guard.
- Do not add a deferred job's sweep AFTER its push without folding `unlinkFailed` into `deferred.writeFailed`.
