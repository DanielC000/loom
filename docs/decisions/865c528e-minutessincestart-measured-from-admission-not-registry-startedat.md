# 865c528e — Measure `minutesSinceStart` from GateSemaphore admission, never `PendingOpRegistry.startedAt`

## Narrative

**`minutesSinceStart` measured from GateSemaphore ADMISSION, never from `PendingOpRegistry`'s own `startedAt`** (card 865c528e): the registry stamps `startedAt` the moment `run_gate` is CALLED, which for a queued gate (the daemon-global `maxConcurrentGates` cap already saturated) can be arbitrarily long before the gate is actually admitted and starts running — comparing that against a threshold calibrated to RUN time misclassifies an unbounded, perfectly healthy queue wait as a wedged gate. The live `GateSemaphore` registry (looked up by the op's own `opId` via `findByOpId`, the same lookup `gate_status` uses) distinguishes "queued" (never admitted — this branch never fires, no matter how long the wait) from "running" (admitted — `since` IS the admission timestamp, exactly what the threshold is calibrated against). Verified directly, not just argued: an op can show `state:"running"` in `PendingOpRegistry` while `gate_status` reports the SAME op still `state:"queued"` in the live `GateSemaphore`, zero seconds actually executed — the exact registration-vs-admission gap this fix corrects for.

## Do not

- Do not measure `minutesSinceStart` from `PendingOpRegistry`'s own `startedAt` (card 865c528e) — it stamps the moment `run_gate` is CALLED, which for a queued gate can be arbitrarily long before actual admission.
- Do not compare a value stamped at CALL time against a threshold calibrated to RUN time — measure from the live `GateSemaphore` registry's own admission timestamp instead, or an unbounded, perfectly healthy queue wait misclassifies as a wedged gate.
- Do not trust `PendingOpRegistry`'s own `state:"running"` as proof of admission — it can disagree with the live `GateSemaphore` (what `gate_status` reads) while the op is still genuinely queued, zero seconds executed.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`classifyIdleWorker`, within the `parked-gate-stale` bullet): lines 12837-12845 (from "`minutesSinceStart` measured from GateSemaphore ADMISSION" through "calibrated against)."), as of commit `a07c5092c871d47f25aeb2ec160958306294a043`. Relocated by card `3f40210c`; no wording changed, wrapped source lines joined into a flowing paragraph, `*` comment markers stripped. Split out of the same bullet as `docs/decisions/422d3003-parked-gate-stale-needs-idlems-not-elapsed-alone.md`, which covers the earlier half of that comment (the idleMs-vs-elapsed reasoning this correction builds on).

A second, distinct site restates this same decision inline at the actual call site (`classifyIdleWorker`'s `pendingGate.state === "running"` branch, the "QUEUE-VS-RUN FIX" comment) rather than in the summary JSDoc above the function — added by extraction tranche 34, which folded in the "verified directly" specimen (the `state:"running"`-vs-`state:"queued"` disagreement) that only that second site carried.
