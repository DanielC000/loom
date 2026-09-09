# 369d8824 — `ConfirmMergeResult.opId` lets a manager match a settled outcome back to its own call

## Narrative

`opId` (card 369d8824): the correlation stamp threaded from `PendingOpRegistry.attach` (or minted fresh for a caller outside that registry — since card 361520a0's Half One routed the last such caller, the human REST merge route, through `SessionService.confirmWorkerMergeUntilSettled` / `SessionService.confirmWorkerMergeTracked`, NO current caller takes this branch; kept as a defensive fallback for `confirmWorkerMerge` being called directly again in the future, not a live path today) — carried on every return so a manager juggling several concurrent merges can match this outcome back to the specific `worker_merge_confirm` call that produced it.

## Do not

- Do not remove the fresh-mint fallback branch for `opId` on the assumption it's dead code — no current caller takes it (card 361520a0's Half One routed the last one through the tracked path), but it's a deliberate defensive fallback for `confirmWorkerMerge` being called directly again, not an oversight.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`ConfirmMergeResult.opId`): part of the lines-397-426 block, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
