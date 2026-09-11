# 81d795de — `mergeBatch`'s tombstone settle is deferred to WHOLE-BATCH completion, widening its pending-exposure window

## Narrative

Card 81d795de (Code Review): `mergeBatch`'s own `insertPendingGateOp` tombstone (kind:"merge", key
`merge-batch:<managerSessionId>`) used to settle back-to-back right after its one `runExclusive` gate
call resolved — confirmed at source, not inferred — the same shape `deployOwnProject`'s tombstone still
uses today (see
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

## `mergeBatchTracked`'s own `attach()` call — the mechanism behind the deferred settle

`opts.onSettle` (part of the `attach()` call cf803152 also extends — see
[[cf803152-mergebatchtracked-attach-opts-verdict-identity-and-classification]]) is what actually implements
the deferral above: it defers the tombstone's `settlePendingGateOp` WRITE until this whole `run()` —
fast-forward and every per-branch finalize included, not just the gate run — has settled. This does NOT
move when the verdict itself is computed: `deriveBatchGateVerdict` still runs at the exact same point in
`runGate` it always did — after the gate run and any bounded retry settle, inside `runGate` — only the
WRITE of that already-computed verdict into the tombstone row is held back, deliberately, until the wider
span above has fully settled. The MINT timing is likewise unchanged — see `insertPendingGateOp`'s own
call-site comment for why it must stay late; only the settle WRITE moved, never the mint.

### Do not (2)

- Do not read `opts.onSettle`'s deferral as moving WHEN the verdict is computed — `deriveBatchGateVerdict` still runs at the same point inside `runGate` it always did; only the tombstone WRITE of that verdict is held back until the whole `run()` settles.

### Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts`, `mergeBatchTracked`'s own JSDoc header (the
deferred-settle claim itself), as of this tranche's HEAD. The "after the gate run and any bounded retry
settle" timing detail is not stated in that JSDoc — read directly from the code around the
`batchGateVerdict` declaration (`deriveBatchGateVerdict` is called after the first `gateSemaphore.runExclusive`
AND after any bounded-retry `runExclusive`, never only the former).

## Why the solo path never had this problem

The SOLO path (`confirmWorkerMergeTracked`) passes `onOpMinted`/`onSettle` to `pendingOps.attach` itself,
so its durable tombstone settles in lockstep with the WHOLE operation (via `run()`'s own settle), never
with an inner sub-step. This batch path was the one outlier that minted and settled the tombstone by hand,
from inside a nested closure invoked partway through `run()` — which is exactly why `gate_status(opId)`
could read `"settled"` the instant the gate itself finished, while canonical main had not yet moved and no
branch had been finalized.

### Source (3)

Inline comment in `packages/daemon/src/sessions/service.ts`, `mergeBatchTracked`'s body, the DEFERRED
SETTLE block immediately before the `pendingOps.attach` call, as of this tranche's HEAD.
