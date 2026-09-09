# 865c528e — Measure `minutesSinceStart` from GateSemaphore admission, never `PendingOpRegistry.startedAt`

## Narrative

**`minutesSinceStart` measured from GateSemaphore ADMISSION, never from `PendingOpRegistry`'s own `startedAt`** (card 865c528e): the registry stamps `startedAt` the moment `run_gate` is CALLED, which for a queued gate (the daemon-global `maxConcurrentGates` cap already saturated) can be arbitrarily long before the gate is actually admitted and starts running — comparing that against a threshold calibrated to RUN time misclassifies an unbounded, perfectly healthy queue wait as a wedged gate. The live `GateSemaphore` registry (looked up by the op's own `opId` via `findByOpId`, the same lookup `gate_status` uses) distinguishes "queued" (never admitted — this branch never fires, no matter how long the wait) from "running" (admitted — `since` IS the admission timestamp, exactly what the threshold is calibrated against).

## Do not

- Do not measure `minutesSinceStart` from `PendingOpRegistry`'s own `startedAt` (card 865c528e) — it stamps the moment `run_gate` is CALLED, which for a queued gate can be arbitrarily long before actual admission.
- Do not compare a value stamped at CALL time against a threshold calibrated to RUN time — measure from the live `GateSemaphore` registry's own admission timestamp instead, or an unbounded, perfectly healthy queue wait misclassifies as a wedged gate.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`classifyIdleWorker`, within the `parked-gate-stale` bullet): lines 12837-12845 (from "`minutesSinceStart` measured from GateSemaphore ADMISSION" through "calibrated against)."), as of commit `a07c5092c871d47f25aeb2ec160958306294a043`. Relocated by card `3f40210c`; no wording changed, wrapped source lines joined into a flowing paragraph, `*` comment markers stripped. Split out of the same bullet as `docs/decisions/422d3003-parked-gate-stale-needs-idlems-not-elapsed-alone.md`, which covers the earlier half of that comment (the idleMs-vs-elapsed reasoning this correction builds on).
