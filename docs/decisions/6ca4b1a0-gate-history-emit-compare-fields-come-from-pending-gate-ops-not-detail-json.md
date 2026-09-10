# 6ca4b1a0 — the Gates page's emit-compare fields join `pending_gate_ops`, not `detail_json` directly

## Narrative

Card 6ca4b1a0: `listGateEvents` ALSO left-joins `pending_gate_ops` by the gate-history row's own `opId` (extracted from `detail_json`) to project `emitCompareReduced`/`emitCompareIdenticalCount`/`emitCompareTestFiles` — see `GateEventJoinRow.verdictPayloadJson`'s own doc for why that table, not `detail_json` directly, is the one place the real true/false tri-state survives. `op_id` is `pending_gate_ops`'s PRIMARY KEY, so this LEFT JOIN can never fan out a row — safe to share with the COUNT query unchanged.

### `GateHistoryRow.emitCompareReduced`'s tri-state, at the type-consumer level

`true` = this merge gate genuinely ran REDUCED (build + static guards, ± the changed test files — NOT the full daemon test suite); `false` = a real gate spawned for this op and was PROVEN not reduced (a genuine full run — the positive control, never conflate with "nothing to report"); `null` = no gate spawned for this op, this row predates card 6ca4b1a0, or this is a `"worker"`/`"deploy"` row (the reduction feature is MERGE-ONLY). NEVER `false` for an unmeasured row — that would assert "this was a full run" about a row nobody measured. A caller building a duration series MUST bucket on this field — pooling a `true` row's reduced run with a `false`/`null` row's full run silently averages two different populations into one meaningless number: measured evidence is a 12.9× duration gap between the two populations, with zero observations inside that gap. Never pool a `null` row with a `false` row either — `null` means "not determinable", not "known full run".

### `GateHistoryRow.emitCompareIdenticalCount`'s two-arm discipline

`identicalCount` is present (non-null) ONLY alongside `emitCompareReduced: true`; `null` whenever `emitCompareReduced` is `false` or `null` (nothing reduced to report). It is VACUOUS ON ONE OF TWO ARMS — never read it alone, always alongside `emitCompareTestFiles`: `identicalCount: 0` paired with a NON-EMPTY `emitCompareTestFiles` means the changed-test-files arm — a test-only diff has no compiled files to compare, so `0` means "nothing to check", NOT "the check found nothing". `identicalCount` non-zero paired with an EMPTY `emitCompareTestFiles` means the emit-identity arm, fully informative — zero test files ran, build + static guards only. See docs/decisions/0984260f-emitcompareidenticalcount-two-arms-are-not-mutually-exclusive.md for the MIXED-case correction to this two-arm picture.

## Do not

- Do not read `emitCompareReduced`/etc. off the raw `orchestration_events.detail_json` for this page — join `pending_gate_ops` by `opId` instead, which is the one place the tri-state (true/false/undefined) is preserved correctly.
- Do not pool a `GateHistoryRow.emitCompareReduced:true` row with a `false`/`null` row in a duration series — they are different populations (measured 12.9× gap).
- Do not infer `emitCompareIdenticalCount` vacuity from `emitCompareTestFiles` being non-empty alone — see the MIXED-case correction linked above.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listGateEvents`'s `pending_gate_ops` LEFT JOIN): lines 5852-5856 and 5876-5878, as of this tranche's HEAD.

The two type-consumer sections above were appended by tranche 3 on `packages/shared/src/types.ts` (card 555f817f), extracted from `GateHistoryRow.emitCompareReduced`'s and `GateHistoryRow.emitCompareIdenticalCount`'s own doc comments — same decision, the type-level usage detail, folded into this existing file per the one-record-per-id rule rather than a new one.
