# b480dda9 — `batchForfeited` is a correlated subquery, deliberately, and only evaluates on the returned page

## Narrative

Card b480dda9: `listGateEvents` checks whether a sibling `batch_merge_forfeited` event shares this row's own `opId` via a correlated subquery (not a JOIN — a `batch_merge_forfeited` event has no dedicated table to join, and a subquery sidesteps any fan-out risk from a hypothetical duplicate), projected as `GateHistoryRow.batchForfeited`. Cheap in practice: `orchestration_events.kind` is indexed (`idx_orch_events_kind`), so the subquery filters to the (normally zero, always small) set of forfeit events before ever comparing `opId`, and it only evaluates for the page actually returned (after `LIMIT`/`OFFSET`), never the full matching set.

## Do not

- Do not replace this correlated subquery with a JOIN against `batch_merge_forfeited` — there is no dedicated table to join against safely, and the subquery form is what avoids any fan-out risk.
- Do not evaluate this check against the full matching set before pagination — it must only run against the page actually returned, or the "normally zero, always small" cost assumption breaks.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listGateEvents`'s `batchForfeited` correlated subquery): lines 5857-5864 and 5886-5890, as of this tranche's HEAD.
