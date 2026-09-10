# eb9348b0 — CORRECTION: `gate_history.failingTest` is no longer unconditionally null for a merge row

## Narrative

Card eb9348b0 corrects stale wording claiming `gate_history`'s own `failingTest` is unconditionally `null` for a merge row. Its mapper now also reads the SAME settled verdict payload `gateStatus` reads (already joined in for `emitCompareReduced`) as a fallback, so the common "has this test failed before" scan doesn't need the `gate_status(opId)` pivot at all in the common case. See `GateHistoryRow.failingTest`'s own doc for the recovery rate and the cases still requiring the pivot.

Measured: the fallback recovers ~70% of recent merge-rejection rows' `failingTest` this way, vs ~10% for rows recorded before the opId-stamping (card 78214063) and verdict-widening (card 9f6598dd) cards landed. Still `null` when the fallback has nothing to offer: a `"worker"`/`"deploy"` row whose own event lacks `failingTest` (rare — a worker self-check embeds it inline on failure), a row/op predating opId-stamping or the merge-verdict-payload widening, a `"pass"`/`"cancelled"`/`"skipped"` verdict (`gateDetail` is fail-only), or a genuine rejection whose output carried no recognizable marker (`gateDetail` present but its own `failingTest` absent — see `PendingGateOpVerdict.gateDetail`'s own doc).

## Do not

- Do not assume `gate_history.failingTest` is always `null` for a merge row — it now falls back to the settled verdict payload; only the cases that payload doesn't cover still need `gate_status(opId)`.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`). Relocated by card `f05ca65c` (tranche 8); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

The "Measured" paragraph above was appended by tranche 3 on `packages/shared/src/types.ts` (card 555f817f), extracted from `GateHistoryRow.failingTest`'s own doc comment — same decision, a second source location, folded into this existing file per the one-record-per-id rule rather than a new one.
