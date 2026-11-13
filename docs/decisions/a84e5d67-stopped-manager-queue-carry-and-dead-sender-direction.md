# a84e5d67 — a stopped manager's undelivered queue is carried to the next spawn; the done-guard keys on row deliverability

Incident: an owner-stopped manager's inbound worker messages were lost when the Lead spawned a fresh (non-recycle) manager, and a worker's `done` was refused by `pending-direction` for direction that never reached it.

## Part 1 — spawn-time carry (bounded)

On exit the pty's in-memory queue is emptied (`pty/host.ts`), but the durable `session_message_queued` rows stay unresolved. Only a recycle (`carryPendingToSuccessor`) ever moved them. `startManager` and `startNew` (when the resolved role is `manager`) now call `carryStoppedManagerQueueToNewManager` after a successful spawn: the most recent non-live manager of the same agent and project that is not recycle-superseded and has CARRYABLE rows is carried via `carryPendingToSuccessor(..., { carriedFromLabel: true })`. Carryable = agent-authored (not `kind:"warning"`, not a `system` sender), not a stale context nudge, not something `staleQueuedMessageReason` would retire, not older than 7 days. The 7-day age is measured PER HOP: a carry re-mints the row, so its age resets to the carry time and the original mint time is deliberately not carried (YAGNI). An existing `[loom:carried-from …]` prefix is replaced, never stacked. A failed carry boards a card; it never fails the spawn.

## Part 2 — the done-guard keys on deliverability, not sender liveness

A manager's exit never touches direction already in the WORKER's live queue; that still drains, so refusing `done` for it was right. The real deadlock is a STRANDED row (durable, but not in the worker's live pending), which refused forever even with a live manager. For each unresolved manager-direction row at `done` time: in the worker's live pending (`PtyHost.hasPendingLogicalId`) → refuse; stranded → clear any stale in-flight mark, re-drive via `redriveQueuedMessage`, still refuse (error says it was re-delivered); the re-drive cannot deliver it (worker not live, stale, retired) AND the live queue still does not hold it (re-checked after the re-drive; a codex held entry reports `{queued:true}` with no `position`, which `redriveQueuedMessage` now counts as re-enqueued) → accept with a `[loom:undeliverable-direction]` warning and an `undeliverableDirection` field on the `worker_report` event.

## Do not

- Do not key the guard on sender liveness; a live manager's stranded row deadlocked the worker just as a dead one's.
- Do not trust `redriveInFlightByMsgId` to mean "in the worker's queue"; a stale mark outlives a dead pty (cd390610). Use the live queue.
- Do not let a later `progress`/`blocked` worker_report retire a stranded direction as `already-reported`; only a later `done` does.
- Do not classify a re-drive by `position` alone; codex reports `queued:true`/`deliveryState:"queued"`.
- Do not carry from a recycle-superseded predecessor (its recycle carry owns the queue) or from a live manager.
- Do not carry Loom's own warning/system nudges, rows older than 7 days, or rows a redrive would retire.
- Do not drop the possible-duplicate tag (248abf9b) or the old-to-new msgId link (af995d1d) from the carry; the `[loom:carried-from <old8>]` label goes after the tag and is never stacked.
- Do not make the carry a hard failure of the spawn; it is post-spawn best-effort bookkeeping (2fd55955).
- Do not build the adopt-orphaned-workers action here; that is its own card.
