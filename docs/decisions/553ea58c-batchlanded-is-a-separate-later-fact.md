# 553ea58c — `batchLanded` is a separate, LATER fact from `batchBranchCount`, never folded into it

⚠️ Spans two decisions, both under this card's Code Review fold-in: this record (§1, `db.ts`) and
`MergeBatchResult.landedCount` (§2, `sessions/service.ts`). `resolveRecord` serves one file per id;
folded here rather than left as a second unreachable `553ea58c-*.md` file (card `6de8956e`).

## §1 — Narrative

Card 553ea58c: `batchLanded` is the separate, LATER fact `batchBranchCount`'s own doc points to — whether a batch's gate (and any single-file retry) passing actually resulted in the assembled branches landing on main. Unlike `GateHistoryRow.batchForfeited` (card `b480dda9`, sourced from a correlated subquery against a sibling `batch_merge_forfeited` orchestration event, scoped ONLY to the canonical-main-advanced forfeit shape), this field is set directly by `mergeBatchTracked` once `runBatchedMerge` resolves — so it covers BOTH real `ok:false` shapes reachable on an already-passed batch gate: a fast-forward forfeit and a post-gate HEAD-read failure. See `MergeBatchResult.retryWarning`'s own three-case doc for the identical two-shape enumeration.

Written UNCONDITIONALLY (never silence) whenever this verdict is a batch "pass" — the same present-with-`false`-is-a-measured-negative convention `retryPassed`/`transientRetried` already use on this payload: a stored `false` positively asserts "the gate passed but nothing landed", not merely "nothing to report". `undefined` on a non-batch ("solo") row, on a "fail"/"cancelled"/"error" verdict kind (a genuine gate rejection has nothing to land regardless), or on a row that predates this field.

`gate_status`'s own render consults this to omit the "ALL N land on the strength of this ONE retry" clause exactly when `batchLanded === false` — WITHOUT touching the underlying `batchBranchCount`, which stays visible and accurate either way.

### Do not

- Do not "fix" a forfeited batch row by zeroing `batchBranchCount` instead of setting `batchLanded: false` — the forfeit is a separate, later fact and belongs in its own field, not a falsified count (mirrors `GateHistoryRow.batchForfeited`'s own precedent, card `b480dda9`).
- Do not read `batchLanded: undefined` as `false` — `undefined` means non-batch, non-pass, or pre-dates-this-field; only a stored `false` is the measured "passed but didn't land" negative.

### Source

Inline comment in `packages/daemon/src/db.ts` (`PendingGateOpVerdict.batchLanded`): lines 2278-2296, as of this tranche's HEAD.

## §2 — `MergeBatchResult.landedCount` is the real git-verified total, not always equal to `landed.length`

### Narrative

The REAL git-verified landed count (`result.landed.length` from `runBatchedMerge`) — present on `ok:true` only, and NOT always equal to `landed.length` immediately above: that array is built by skipping any branch whose worker session row no longer resolves (a hard row DELETE between batch selection and finalize — `db.getSession` applies no archive filter, so this is a narrow, never-repro'd case), so it can under-report vs. this count. `retryWarning`'s own batch clause already renders off THIS field; this is exposed separately so a reader building its own prose from `MergeBatchResult` (e.g. the async settle nudge's "landed N branch(es) on main" text) can use the same real total rather than reconstructing a smaller one from `landed.length`.

### Do not

- Do not assume `landedCount` always equals `landed.length` — the `landed` array can under-report if a worker session row was hard-deleted between batch selection and finalize (a narrow, never-repro'd case); use `landedCount` for the real git-verified total.
- Do not reconstruct a batch's "landed N branch(es)" prose from `landed.length` — use `landedCount`, the same field `retryWarning`'s own batch clause already renders off.
- Do not call `batchBranchCount` (Code Review finding [5]) "the batch's own landed branch count" — it is the count of branches ASSEMBLED into the batch worktree, never necessarily landed on main; that's false whenever the gate passes but the fast-forward afterward forfeits or its post-gate HEAD read fails (see §1 above, `batchLanded`, for that separate, later fact).

### Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`MergeBatchResult.landedCount`, lines 459-466; the batch verdict derivation's `batchBranchCount` correction, lines 871-942): as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`. Folded into this pre-existing record by card `6de8956e`.
