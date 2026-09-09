# eb9348b0 — CORRECTION: `gate_history.failingTest` is no longer unconditionally null for a merge row

## Narrative

Card eb9348b0 corrects stale wording claiming `gate_history`'s own `failingTest` is unconditionally `null` for a merge row. Its mapper now also reads the SAME settled verdict payload `gateStatus` reads (already joined in for `emitCompareReduced`) as a fallback, so the common "has this test failed before" scan doesn't need the `gate_status(opId)` pivot at all in the common case. See `GateHistoryRow.failingTest`'s own doc for the recovery rate and the cases still requiring the pivot.

## Do not

- Do not assume `gate_history.failingTest` is always `null` for a merge row — it now falls back to the settled verdict payload; only the cases that payload doesn't cover still need `gate_status(opId)`.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`). Relocated by card `f05ca65c` (tranche 8); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
