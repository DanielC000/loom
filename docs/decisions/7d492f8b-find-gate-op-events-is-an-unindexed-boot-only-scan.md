# 7d492f8b — `findGateOpEventsByOpId` is an unindexed scan, accepted because it's boot-time only

## Narrative

Card 7d492f8b: `findGateOpEventsByOpId` returns every durable audit event stamped with a given gate/merge op's `opId` (see `confirmWorkerMerge`'s/`runWorkerGate`'s own `evt` closures, which merge `opId` into every emitted `detail` unconditionally) — the read `SessionService.reconcileOrphanedGateOps` needs to recover a genuinely-settled op's real outcome from durable history (see the sibling record on `recoverGateOpVerdict` for how that outcome is derived from the events this returns).

`opId` is a UUID minted once per op (`PendingOpRegistry.attach`'s `onOpMinted`), so an exact `json_extract` match is unambiguous — no `kind` filter needed; a "merge" op can log more than one event under the same `opId` (e.g. `build_gate` then `merge_rejected`), so this returns ALL of them, ordered `seq ASC` (chronological, the never-reused monotonic sequence) so a caller reading them in event order sees them in the order they actually happened. It's an unindexed `json_extract` scan over the whole table — accepted: this is called ONLY from a boot-time sweep, only for the (normally zero, always small) set of rows still `state:'pending'` after a restart, never a hot path (mirrors `listScheduleHistory`'s own precedent for an unindexed `json_extract` filter).

## Do not

- Do not add a `kind` filter to this query — `opId` alone is already an unambiguous match, and a "merge" op legitimately logs more than one event kind under it.
- Do not index this scan or worry about its cost — it only ever runs from the boot-time sweep over the (normally zero, always small) still-pending set, never a hot path.

## Source

Inline comment in `packages/daemon/src/db.ts` (`findGateOpEventsByOpId`): lines 6032-6046, as of this tranche's HEAD.
