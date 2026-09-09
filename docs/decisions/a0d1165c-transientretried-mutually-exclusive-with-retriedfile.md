# a0d1165c — persist the transient-kill auto-retry fact, mutually exclusive with the single-file retry

## Narrative

Card a0d1165c is `retriedFile`/`retryPassed`'s sibling (card `6dcb9cd3`) — durable persistence for the OTHER retry that can produce a `merged:true` verdict, the TRANSIENT-KILL AUTO-RETRY (card `bcba83a1`, `ConfirmMergeResult.transientRetried`). Same "measured negative" discipline as `retriedFile`/`retryPassed`: `deriveMergeGateVerdict` writes a real boolean here (`v.transientRetried ?? false`), never `undefined`, on every "pass"/"fail" row it writes going forward. `undefined` here means only "this row predates card a0d1165c" or "a cancelled/error row, where this pairing was never computed" — never "no such retry fired".

This mirrors `ConfirmMergeResult.transientRetried`'s own scope exactly (not widened here): that field is set `true` ONLY on a `merged:true` return reached via this retry — a still-failing transient retry rejects instead, and `v.transientRetried` stays `undefined` on that return (the rejection's own detail text already names the retry by other means). So `?? false` on a rejection row records `false` here too, by the same design choice the source field already made, not a new gap.

`transientRetried` is mutually exclusive with `retriedFile` being non-null on the SAME row, by construction: a first attempt is classified either "genuine" (eligible for the single-file retry) or "kill"/"timeout" (eligible for this retry) — never both (see `gate-runner.ts`'s `classifyGateFailure`).

## Do not

- Do not read `transientRetried: undefined` as "this retry never fired" — check whether the row predates card a0d1165c or is a cancelled/error row before drawing that conclusion.
- Do not expect both `transientRetried: true` and a non-null `retriedFile` on the same row — a first attempt is classified into exactly one retry-eligibility class, never both.

## Source

Inline comment in `packages/daemon/src/db.ts` (`PendingGateOpVerdict.transientRetried`): lines 2244-2259, as of this tranche's HEAD.
