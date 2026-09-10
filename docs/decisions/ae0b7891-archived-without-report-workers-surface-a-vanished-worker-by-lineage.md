# ae0b7891 — archived-without-report workers surface a vanished worker, scoped by lineage not exact parent match

## Narrative

Card ae0b7891: the archived counterpart to the three fleet-view categories above it — a worker that genuinely vanished (exited without ever calling `worker_report`) instead of silently disappearing from the fleet view once `archiveOnExit` stamps `archivedAt`. `listWorkerSessionIdsWithEventKind` is the existing "which sessions ever had event kind X" lookup (built for the crash-recovery watcher, already indexed) — reused here rather than adding a new SQL join. Bounded/self-clearing: `isArchivedWithoutReport` re-checks live, so this only ever holds workers still worth the manager's attention.

LINEAGE, not exact parent match (card `93609ef3`'s own reasoning applies verbatim here — see that card's own inline doc, above `workerReadableByManager`): an archived-without-report worker is by definition exited and was never re-parented by `reparentLiveWorkers` (which only moves LIVE workers on recycle), so after a manager recycle it keeps `parentSessionId` pointing at the now-retired predecessor. An exact match would silently hide it from the successor manager — exactly the finding this category exists to surface. Unlike the real `workers` list (deliberately exact-match, per `workerReadableByManager`'s own doc), this NEW category has no such precedent to preserve, so it uses the lineage-tolerant read guard.

## Do not

- Do not scope this category by exact `parentSessionId` match — an archived-without-report worker keeps its now-retired predecessor's id after a manager recycle, so exact match would silently hide the exact finding this category exists to surface. Use the lineage-tolerant read guard instead.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (the fleet-view builder, `archivedUnreported`): lines 2986-3000 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
