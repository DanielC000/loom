# a0d1165c — persist the transient-kill auto-retry fact, mutually exclusive with the single-file retry

## Narrative

Card a0d1165c is `retriedFile`/`retryPassed`'s sibling (card `6dcb9cd3`) — durable persistence for the OTHER retry that can produce a `merged:true` verdict, the TRANSIENT-KILL AUTO-RETRY (card `bcba83a1`, `ConfirmMergeResult.transientRetried`). Same "measured negative" discipline as `retriedFile`/`retryPassed`: `deriveMergeGateVerdict` writes a real boolean here (`v.transientRetried ?? false`), never `undefined`, on every "pass"/"fail" row it writes going forward. `undefined` here means only "this row predates card a0d1165c" or "a cancelled/error row, where this pairing was never computed" — never "no such retry fired".

This mirrors `ConfirmMergeResult.transientRetried`'s own scope exactly (not widened here): that field is set `true` ONLY on a `merged:true` return reached via this retry — a still-failing transient retry rejects instead, and `v.transientRetried` stays `undefined` on that return (the rejection's own detail text already names the retry by other means). So `?? false` on a rejection row records `false` here too, by the same design choice the source field already made, not a new gap.

`transientRetried` is mutually exclusive with `retriedFile` being non-null on the SAME row, by construction: a first attempt is classified either "genuine" (eligible for the single-file retry) or "kill"/"timeout" (eligible for this retry) — never both (see `gate-runner.ts`'s `classifyGateFailure`).

### `GateHistoryRow.transientRetried` is a DIFFERENT field, computed a different way

`GateHistoryRow` carries its OWN `transientRetried` boolean (not `PendingGateOpVerdict.transientRetried` above) — before this card a transient-kill-retry-assisted pass was "nudge text only": `[loom:merge-done]` rendered `formatTransientRetryWarning()` live, but nothing durable recorded it, so a reader who missed that one nudge (a recycle, a restart, a successor reading history later) saw an ordinary `outcome:"pass"` with no way to tell it apart from a clean first-attempt pass. Unlike the `PendingGateOpVerdict` field (a stamped boolean), this one is DERIVED from the row's own event kind: `true` iff the underlying event is `kind:"build_gate_retry"` (the transient-kill retry's OWN admission and verdict — a SEPARATE row from attempt 1's `"build_gate"` row, unlike the single-file retry which folds `retriedFile`/`retryPassed` onto the SAME row instead of emitting a second one); `false` for every `"build_gate"`/`"worker_gate"`/`"deploy"` row, including one that carries a non-null `retriedFile` — the two fields can never both be truthy on the same row, for the same mutual-exclusion reason as above, restated at the row-kind level (a `"build_gate"` row is never a transient-kill retry's own row, and a `"build_gate_retry"` row never carries `retriedFile`). Populated on BOTH a resulting pass and a resulting rejection of the retry itself — the row's own `outcome`/`passed` already state which; `transientRetried:true` only flags that THIS row IS the retry, not that it passed.

## Do not

- Do not read `transientRetried: undefined` as "this retry never fired" — check whether the row predates card a0d1165c or is a cancelled/error row before drawing that conclusion.
- Do not expect both `transientRetried: true` and a non-null `retriedFile` on the same row — a first attempt is classified into exactly one retry-eligibility class, never both.
- Do not conflate `GateHistoryRow.transientRetried` with `PendingGateOpVerdict.transientRetried` — the former is derived from the row's own event kind (`build_gate_retry`), the latter is a stamped boolean on the settled verdict.

## Source

Inline comment in `packages/daemon/src/db.ts` (`PendingGateOpVerdict.transientRetried`): lines 2244-2259, as of this tranche's HEAD.

The "`GateHistoryRow.transientRetried`" section above was appended by tranche 3 on `packages/shared/src/types.ts` (card 555f817f), extracted from `GateHistoryRow.transientRetried`'s own doc comment — same decision, a second (differently-computed) field it governs, folded into this existing file per the one-record-per-id rule rather than a new one.
