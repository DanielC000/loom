# ae0b7891 — archived-without-report workers surface a vanished worker, scoped by lineage not exact parent match

## Narrative

Card ae0b7891: the archived counterpart to the three fleet-view categories above it — a worker that genuinely vanished (exited without ever calling `worker_report`) instead of silently disappearing from the fleet view once `archiveOnExit` stamps `archivedAt`. `listWorkerSessionIdsWithEventKind` is the existing "which sessions ever had event kind X" lookup (built for the crash-recovery watcher, already indexed) — reused here rather than adding a new SQL join. Bounded/self-clearing: `isArchivedWithoutReport` re-checks live, so this only ever holds workers still worth the manager's attention.

LINEAGE, not exact parent match (card `93609ef3`'s own reasoning applies verbatim here — see that card's own inline doc, above `workerReadableByManager`): an archived-without-report worker is by definition exited and was never re-parented by `reparentLiveWorkers` (which only moves LIVE workers on recycle), so after a manager recycle it keeps `parentSessionId` pointing at the now-retired predecessor. An exact match would silently hide it from the successor manager — exactly the finding this category exists to surface. Unlike the real `workers` list (deliberately exact-match, per `workerReadableByManager`'s own doc), this NEW category has no such precedent to preserve, so it uses the lineage-tolerant read guard.

## Do not

- Do not scope this category by exact `parentSessionId` match — an archived-without-report worker keeps its now-retired predecessor's id after a manager recycle, so exact match would silently hide the exact finding this category exists to surface. Use the lineage-tolerant read guard instead.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (the fleet-view builder, `archivedUnreported`): lines 2986-3000 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).

## `isArchivedWithoutReport` reuses the exited-without-report event, never `reportedState`

`reportedState:null` is AMBIGUOUS between "never reported" and "reported, then a LATER event pushed it back to null" (e.g. the `noChanges` auto-retire path's own `stop_worker` bookkeeping event in `workerReport` — see that method's `autoRetireNoCommit` branch) — so `isArchivedWithoutReport` deliberately does NOT derive from `reportedState` at all. It reuses `notifyManagerOfExitedWorker`'s own gate instead (see `docs/decisions/84151b99-exited-without-report-guard-catches-a-worker-that-never-idles.md`): that method already writes a durable `worker_exited_without_report` event, and ONLY for a genuinely-unreported exit (gated on `intended:false`, and on the task still sitting in the active lane — a `noChanges` report already moves it before any of this runs). Re-checked LIVE (not just "did the event ever fire") so the signal SELF-CLEARS once the manager resolves it — moves the task off the active lane, or a successor lands — instead of nagging forever from a stale historical event. The `archivedAt` check additionally guards against a flagged worker later being crash-resumed (`restoreSession` clears `archivedAt`) — it's live again, not "archived without report" anymore.

### Do not (2)

- Do not derive `isArchivedWithoutReport` from `reportedState` — `null` is ambiguous between never-reported and reported-then-reset (e.g. the `noChanges` auto-retire path), and would misclassify the reset case as a vanished worker.
- Do not treat "the `worker_exited_without_report` event ever fired" as sufficient on its own — re-check the task's active-lane membership LIVE too, so the signal self-clears once the manager resolves it rather than nagging forever.

## Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts` (`isArchivedWithoutReport`'s JSDoc): lines 9888-9904, as of main `a4fdccf6` (introducing commit `487b3c37367a46292fb0b3e038dbbbb1f7c7de32`, `fix(sessions): a worker that exits without worker_report is archived silently — indistinguishable from "done, nothing to commit" for vault-only work`). Extraction tranche 36.
