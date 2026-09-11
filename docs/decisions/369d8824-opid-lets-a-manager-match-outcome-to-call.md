# 369d8824 — `ConfirmMergeResult.opId` lets a manager match a settled outcome back to its own call

## Narrative

`opId` (card 369d8824): the correlation stamp threaded from `PendingOpRegistry.attach` (or minted fresh for a caller outside that registry — since card 361520a0's Half One routed the last such caller, the human REST merge route, through `SessionService.confirmWorkerMergeUntilSettled` / `SessionService.confirmWorkerMergeTracked`, NO current caller takes this branch; kept as a defensive fallback for `confirmWorkerMerge` being called directly again in the future, not a live path today) — carried on every return so a manager juggling several concurrent merges can match this outcome back to the specific `worker_merge_confirm` call that produced it.

## Do not

- Do not remove the fresh-mint fallback branch for `opId` on the assumption it's dead code — no current caller takes it (card 361520a0's Half One routed the last one through the tracked path), but it's a deliberate defensive fallback for `confirmWorkerMerge` being called directly again, not an oversight.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`ConfirmMergeResult.opId`): part of the lines-397-426 block, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## STALE-REDELIVERY GUARD — `finishAlreadyMerged`'s early-idempotency branch (unrelated decision, same card id, `service.ts`)

`finishAlreadyMerged`'s EARLY entry (reached before the gate/stranded-check/merge even run) can be reached again by a genuinely stale, idempotent retry — a manager re-calling `worker_merge_confirm` (documented idempotent-retryable) AFTER a PRIOR call already fully finalized this exact worker. That prior call's own `finalizeMerge` already appended a `merge_done` event for it, so this later call's own path resolves via the FAST early-idempotency branch (before the gate even runs) — the manager gets its answer synchronously from ITS OWN tool call return, needs no async push, and a second `[loom:already-merged]` would just be a duplicate echo of something it already knows. So: skip the direct push (only) when a `merge_done` event already exists for this worker; still always finish the (idempotent, best-effort) cleanup. `notified` on the return is unconditionally `true` regardless — this path OWNS the announcement for an ALREADY_MERGED outcome, whether THIS call fired it or a prior one already did, so `confirmWorkerMergeTracked`'s generic echo must stay suppressed either way.

### Do not (2)

- Do not re-send `[loom:already-merged]` when a `merge_done` event already exists for the worker — the manager already learned the outcome synchronously from its own (superseded) call.
- Do not skip the idempotent cleanup below just because the direct push was skipped — cleanup always runs regardless of whether a `merge_done` event already existed.

### Source (this section only)

Inline comment in `packages/daemon/src/sessions/service.ts`, `finishAlreadyMerged`'s own JSDoc ("STALE-REDELIVERY GUARD"), as of this tranche's HEAD. Not the same decision as the `opId` correlation-stamp section above — corroborated by the same card id appearing in `packages/daemon/test/merge-confirm-stale-retry-idempotent.mjs`'s own header comment ("card 369d8824's 'already consumed' facet").
