# 81d795de — `mergeBatch`'s tombstone settle is deferred to WHOLE-BATCH completion, widening its pending-exposure window

## Narrative

Card 81d795de (Code Review): `mergeBatch`'s own `insertPendingGateOp` tombstone (kind:"merge", key
`merge-batch:<managerSessionId>`) used to settle back-to-back right after its one `runExclusive` gate
call resolved, the same shape `deployOwnProject`'s tombstone still uses today (see
`docs/decisions/bed91595-deploy-tombstone-removes-the-in-process-workaround.md`). This card deferred that
settle to `onSettle`, firing only once the WHOLE batch — fast-forward and every per-branch finalize
included, not just the gate run — has actually settled. A `mergeBatch` finalize can now span tens of
minutes, comfortably outliving one manager turn, which made a mid-batch manager recycle an ORDINARY
event rather than a corner case (see
`docs/decisions/27ea069e-dead-owner-recovery-the-one-eviction-exception.md`'s own correction narrative,
and `docs/decisions/edc1ec12-gate-status-is-read-only-with-no-passfail-outcome.md` for the `gate_status`
consequence: a healthy in-flight batch can now sit `"pending"` for tens of minutes with no way, before
that card, to tell it apart from a genuinely stranded row).

CONSEQUENCE FOR RESTART-ORPHAN SWEEPS: deferring the settle makes the tombstone's mint-to-settle span
WIDER for a batch than for a deploy, not narrower — a daemon death anywhere in that now-much-longer span
strands the row exactly like `deployOwnProject`'s narrower window does, for the SAME underlying reason
(`surfaced_pending` is never flipped for either mint site). See
`docs/decisions/7239c712-tombstone-pending-covers-the-pre-registration-and-boot-reconcile-window.md` for
how `reconcileUnsurfacedPendingGateOps` covers both regardless of how wide either span is.

## Do not

- Do not assume `mergeBatch`'s tombstone settles quickly the way `deployOwnProject`'s does — its settle
  is deferred to whole-batch completion, so its pending-exposure window is the WIDER of the two, not
  narrower, and any restart-orphan reasoning must treat it that way.

## Source

Inline comments in `packages/daemon/src/sessions/service.ts`: cited (not originally introduced) at
`isManagerLineageDead`'s doc (tranche 15) and at `reconcileUnsurfacedPendingGateOps`'s own doc, lines
6485-6486 and 6517-6521, as of main `055e96ce`. Relocated by card `c7ca6c08` (tranche 16) from the second
site; the primary `mergeBatchTracked`/`batchGateVerdict` design doc this card most fully belongs to is
elsewhere in this file and out of this tranche's scope — extend this record there rather than creating a
second file.
