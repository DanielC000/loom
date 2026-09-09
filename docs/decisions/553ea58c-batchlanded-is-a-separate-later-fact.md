# 553ea58c — `batchLanded` is a separate, LATER fact from `batchBranchCount`, never folded into it

## Narrative

Card 553ea58c: `batchLanded` is the separate, LATER fact `batchBranchCount`'s own doc points to — whether a batch's gate (and any single-file retry) passing actually resulted in the assembled branches landing on main. Unlike `GateHistoryRow.batchForfeited` (card `b480dda9`, sourced from a correlated subquery against a sibling `batch_merge_forfeited` orchestration event, scoped ONLY to the canonical-main-advanced forfeit shape), this field is set directly by `mergeBatchTracked` once `runBatchedMerge` resolves — so it covers BOTH real `ok:false` shapes reachable on an already-passed batch gate: a fast-forward forfeit and a post-gate HEAD-read failure. See `MergeBatchResult.retryWarning`'s own three-case doc for the identical two-shape enumeration.

Written UNCONDITIONALLY (never silence) whenever this verdict is a batch "pass" — the same present-with-`false`-is-a-measured-negative convention `retryPassed`/`transientRetried` already use on this payload: a stored `false` positively asserts "the gate passed but nothing landed", not merely "nothing to report". `undefined` on a non-batch ("solo") row, on a "fail"/"cancelled"/"error" verdict kind (a genuine gate rejection has nothing to land regardless), or on a row that predates this field.

`gate_status`'s own render consults this to omit the "ALL N land on the strength of this ONE retry" clause exactly when `batchLanded === false` — WITHOUT touching the underlying `batchBranchCount`, which stays visible and accurate either way.

## Do not

- Do not "fix" a forfeited batch row by zeroing `batchBranchCount` instead of setting `batchLanded: false` — the forfeit is a separate, later fact and belongs in its own field, not a falsified count (mirrors `GateHistoryRow.batchForfeited`'s own precedent, card `b480dda9`).
- Do not read `batchLanded: undefined` as `false` — `undefined` means non-batch, non-pass, or pre-dates-this-field; only a stored `false` is the measured "passed but didn't land" negative.

## Source

Inline comment in `packages/daemon/src/db.ts` (`PendingGateOpVerdict.batchLanded`): lines 2278-2296, as of this tranche's HEAD.
