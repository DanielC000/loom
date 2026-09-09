# 57f346e6 — the manual-deferral-needs-a-reason guard must gate on the patch's DELTA, not resulting state

## Narrative

Card `c90e9525`'s manual-deferral guard refuses a write that would leave a card `deferred:true` with no
`deferredUntilTaskId` and no reason recorded. The ORIGINAL form of this guard evaluated `isManualDeferral`
from the RESULTING state unconditionally — so it re-validated (and rejected) a patch that never touched
`deferred`/`deferredUntilTaskId`/`deferredReason` at all, the moment it landed on a card that happened to
ALREADY be a manual deferral with no reason.

That made every legacy pre-`c90e9525` no-reason-deferred row reject EVERY future patch — including a bare
`columnKey` move — forever, since nothing about such a patch could ever supply the missing reason.

`touchesDeferralFields` scopes both the reason guard AND the `deferredAt` backfill to patches that
actually touch one of the three deferral fields, so an unrelated field-only patch passes through a legacy
row UNCHANGED (deferred/deferredReason/deferredAt all untouched) — while a patch that DOES touch
`deferred`/`deferredUntilTaskId`/`deferredReason` and would still leave the card
manually-deferred-with-no-reason is refused exactly as before (the real case `c90e9525` exists to catch).

## Do not

- Do not gate the manual-deferral-needs-a-reason guard on the RESULTING state alone — gate it on whether
  the patch actually touches `deferred`/`deferredUntilTaskId`/`deferredReason`. Gating on resulting state
  alone permanently locks every legacy no-reason-deferred row against any future patch, including an
  unrelated column move.

## Source

Inline comment in `packages/daemon/src/mcp/tasks.ts` (`updateProjectTask`, lines 1330-1340 as of this
tranche's HEAD).
