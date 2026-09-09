# 6ca4b1a0 — the Gates page's emit-compare fields join `pending_gate_ops`, not `detail_json` directly

## Narrative

Card 6ca4b1a0: `listGateEvents` ALSO left-joins `pending_gate_ops` by the gate-history row's own `opId` (extracted from `detail_json`) to project `emitCompareReduced`/`emitCompareIdenticalCount`/`emitCompareTestFiles` — see `GateEventJoinRow.verdictPayloadJson`'s own doc for why that table, not `detail_json` directly, is the one place the real true/false tri-state survives. `op_id` is `pending_gate_ops`'s PRIMARY KEY, so this LEFT JOIN can never fan out a row — safe to share with the COUNT query unchanged.

## Do not

- Do not read `emitCompareReduced`/etc. off the raw `orchestration_events.detail_json` for this page — join `pending_gate_ops` by `opId` instead, which is the one place the tri-state (true/false/undefined) is preserved correctly.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listGateEvents`'s `pending_gate_ops` LEFT JOIN): lines 5852-5856 and 5876-5878, as of this tranche's HEAD.
