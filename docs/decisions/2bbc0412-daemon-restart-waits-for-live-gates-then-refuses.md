# 2bbc0412 — `daemon_restart` waits (bounded) for live gate/merge ops, then REFUSES; it never silently orphans them

Specimen: a worker `run_gate` was admitted after `gate_queue` said `restartSafe:true` and before the exit; the restart fired and the gate came back `orphaned-by-restart`. The boot sweep only marks orphans, it never re-fires them.

## What it does

- After the green build and BEFORE the advisory pre-empt / backup / fleet capture / intent write, `requestDaemonRestart` closes a restart-admission latch and polls `liveRealWorkOps()` (the same read `gate_queue`'s `restartSafe` uses) for up to `LIVE_WORK_WAIT_MS` (120 s).
- Still live at the bound, or newly live at the final synchronous recheck right before the exit is scheduled: `{restarting:false, liveOpsRefused, error}`, intent cleared, advisories re-fired, latch released.
- While latched, a NEW worker `run_gate` is refused before any op/tombstone/verdict exists (so never a red, never `lastWorkerGateCheck`). Re-attaching to the worker's already-running op is still allowed.
- Owning managers of live ops in OTHER projects get one `[loom:restart-pending]` nudge (`enqueueDurableNudge`), falling back to the project's live manager/Lead.
- Override `proceedDespiteLiveOps:true` + REQUIRED non-empty `proceedReason` (both daemon_restart surfaces): skips the wait, records the orphaned opIds in the restart intent (`orphanedOps`) and the result, and nudges every owner in ALL projects with `[loom:restart-orphaning]` before the exit. A second overlapping call carrying the override switches an already-waiting attempt to the override path.

## Do not

- Do not widen "live real work" to `distImporterCheckOnly` entries: advisories are pre-empted (`c9a21e8f`), never waited for.
- Do not exit past a non-empty `liveRealWorkOps()` without the explicit override — a bounded wait that then proceeds IS the original defect.
- Do not let the latch refusal write a verdict, a `worker_gate` event or `lastWorkerGateCheck`; it must stay a plain thrown refusal.
- Do not leave the latch set on any non-exit path (refusal, catch-all, supervisor re-check failure).
- Do not fork the `restartSafe` predicate from the restart wait; both call `liveRealWorkOps()`.
- The override's durable record is one `restart_orphaned_ops` event per affected project ({overridingSessionId, reason, opIds, projectId}), appended synchronously before the exit — the restart intent is consumed at boot, so never rely on it as the trace. `overridingSessionId` is the OVERRIDING caller (an attached second caller included), never the first caller's.
- The run_gate latch lets a running op or a usable retained verdict through (same predicate as attach()); only a NEW gate is refused.
- `proceedReason` is capped at 500 chars (schemas + service).
