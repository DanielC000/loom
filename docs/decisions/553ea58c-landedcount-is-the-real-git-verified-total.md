# 553ea58c — `MergeBatchResult.landedCount` is the real git-verified total, not always equal to `landed.length`

## Narrative

Card 553ea58c (Code Review fold-in): the REAL git-verified landed count (`result.landed.length` from `runBatchedMerge`) — present on `ok:true` only, and NOT always equal to `landed.length` immediately above: that array is built by skipping any branch whose worker session row no longer resolves (a hard row DELETE between batch selection and finalize — `db.getSession` applies no archive filter, so this is a narrow, never-repro'd case), so it can under-report vs. this count. `retryWarning`'s own batch clause already renders off THIS field (see that call site); this is exposed separately so a reader building its own prose from `MergeBatchResult` (e.g. the async settle nudge's "landed N branch(es) on main" text) can use the same real total rather than reconstructing a smaller one from `landed.length`.

## Do not

- Do not assume `landedCount` always equals `landed.length` — the `landed` array can under-report if a worker session row was hard-deleted between batch selection and finalize (a narrow, never-repro'd case); use `landedCount` for the real git-verified total.
- Do not reconstruct a batch's "landed N branch(es)" prose from `landed.length` — use `landedCount`, the same field `retryWarning`'s own batch clause already renders off.
- Do not call `batchBranchCount` (Code Review finding [5]) "the batch's own landed branch count" — it is the count of branches ASSEMBLED into the batch worktree (`landedCount` at the call site), never necessarily landed on main; that's false whenever the gate passes but the fast-forward afterward forfeits or its post-gate HEAD read fails (see `PendingGateOpVerdict.batchLanded`'s own doc, db.ts, for that separate, later fact).

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`MergeBatchResult.landedCount`, lines 459-466; the batch verdict derivation's `batchBranchCount` correction, lines 871-942): as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
