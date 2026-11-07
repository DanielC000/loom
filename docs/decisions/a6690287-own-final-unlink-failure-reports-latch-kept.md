# a6690287 — an unconfirmed unlink of the active entry's own final file reports latchKept

Found by the Code Review of `b11056a9` (pre-existing misleading success, reproduced on HEAD `9051bdd4`).

## Defect

`deleteMergeQuarantineLatchByKey` recorded a failed non-ENOENT unlink of the entry's OWN `<id>.json` only as `ownFinalWriteFailed` (and, since `b11056a9`, its basename). Neither sets `unattributed`, so `clearMergeQuarantineByKey` took its clean-return branch: 200, `wasQuarantined:true`, the repo lifted, no `latchKept`, no reason. The file stayed on disk holding the token, the tombstone was correctly withheld, and a reboot re-armed the latch: merges ran until the next restart, then the repo re-blocked unexplained. Reproduced on `/clear`, `/clear-by-path {repoPath}`, `/clear-by-path {id}` (resolvable repo) and on an unresolvable repo (`/clear`, `/clear-by-path {repoPath}`). A pending-only own file was already disclosed correctly (its sweep sets `anyUnattributed`).

## Decision: disclose, do not keep the in-process entry armed

Option (a): the clear stays lifted in-process and reports `latchKept` + `unattributed` with the shared unattributed reason plus the named file (`b11056a9`'s clause). Option (b) (keep the entry armed so in-process matches reboot) was rejected: by-key has already deleted the map slot and `tombstoneIfNotSurviving` has already put the token in the in-memory `clearedTokens`, so re-arming means rebuilding an entry whose tokens are tombstoned, across multi-key and tied-pending shapes; and doing it for own-final alone would leave the orphan/tmp unlink failures of `59f4ebe8` lifted, i.e. partial parity. The no-split rule of `f8e11853`/`63569b55` covers a FOREIGN residue the clear never meant to touch, not the cleared identity's own file, and `unattributedKeptReasonFor` already tells the human the latch re-diverts on the next restart.

## Fix

In the `finalProtectOk` branch, an attempted-and-unconfirmed unlink of `final` sets `unattributedKept = true` (both the `provenCoverage` and the non-coverage sub-branch); ENOENT is confirmed. The basename was already recorded by `b11056a9`; it is reused, not recorded twice.

## Do not

- Do not widen this to "`anyWriteFailed` implies `latchKept`". Other write failures keep their clean return on purpose (`d2592cd5` M4-AWF pins a twin rename fault returning `anyWriteFailed:true` with no `latchKept`).
- Do not treat ENOENT from the unlink as a failure: the file is gone, so the clear is confirmed.
- Do not make this site keep the in-process entry armed without redesigning every unlink-failure site together (see above); a lone own-final re-arm is partial parity.

## Tests

`merge-quarantine-a6690287-own-final-unlink-failure.mjs`: per route latchKept + named reason + no tombstone, a disclosure-consistency reboot check, retry-clears-it, ENOENT and no-fault controls, the unresolvable shape, and the pending-only regression pin.
