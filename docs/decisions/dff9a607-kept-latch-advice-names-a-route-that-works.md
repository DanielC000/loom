# dff9a607 — a kept-latch reason advises remove-by-hand or restart-and-clear, never an in-process retry

Found by the Code Review of `a6690287` (reproduced by probe). Text-only change; no disposition logic touched.

## Defect

`b11056a9`'s unlink-failed clause said "remove it or retry the clear" and the shared unattributed sentence said "until a later successful clear resolves it". A same-process retry does not reliably reach a kept file, because the first clear already evicted the in-memory entry, so a retry sees nothing active. Observed per route (own final, EPERM injected then removed):

| variant | /clear and by-id retry | by-path `{repoPath}` retry |
| --- | --- | --- |
| unmarked | deletes the file, `wasQuarantined:false`, no tombstone | silent not-quarantined, file stays |
| marked (`keptUnreadableLatchFiles`) | `latchKept`, file stays (coverage needs the evicted entry) | silent not-quarantined, file stays |

Every kept file re-blocks on the next reboot. The orphan source behaves the same (retry leaves it); a tmp residue is reached by a retry but still gets no tombstone.

## Decision: route-accurate text (option a)

The clause now says to remove the file by hand, or restart the daemon and clear again once the cause is gone, and that a same-process retry may not reach it. Restart then clear was probed for the own-final, orphan and tmp sources: the file is removed, the token is tombstoned, and a second boot stays clear. The shared unattributed sentence no longer promises a plain retry; it says the latch re-diverts on the next restart until removed (by hand, or by a later clear which may need a restart first). The restart advice lives only in the unlink-failed clause, which is emitted only for a real failed unlink; the unattributed sentence is also emitted for a marked-unreadable keep with no unlink failure, where a restart does not necessarily help, so it stays source-neutral.

Option (b), letting a same-process retry reach and tombstone a kept own file, was not taken: the entry (and its tokens) is gone by then, so it needs a new re-derive-from-content path, and a lone own-final re-arm is the partial parity `a6690287` excludes.

## Do not

- Do not advise "retry the clear" for a kept file; it is wrong for the marked, by-path and orphan cases.
- Do not put the restart promise in the shared unattributed sentence; not every source it covers is resolved by a restart.
- Do not substitute the clause for the base reason or add a response key (`b11056a9`).

## Not covered

The clause's restart advice was probed for the own-final, orphan and tmp sources only; a pending-twin source file and the unresolvable-repo by-path route emit it through the same mechanism but were not probed separately.

## Tests

`merge-quarantine-dff9a607-retry-advice.mjs` pins the per-route retry outcomes, the advice text, and the restart-then-clear leg (file removed, token tombstoned, second boot clear). `merge-quarantine-b11056a9-unlink-failed-reason.mjs` pins the new clause wording.
