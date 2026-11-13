# 11ca11fd — adopting a stopped manager's live workers is human/Platform-Lead only, with the worker move as the last step

Incident: the owner stopped a manager; a fresh (non-recycle) manager could not review, merge, message or stop the stopped manager's live workers ("not your worker"), and Loom had no adopt path outside recycle. `archiveOnExit`'s `[loom:orphaned-fleet]` banner told readers to reparent via a sibling manager, but no such action existed.

`SessionService.adoptOrphanedWorkers(oldManagerId, newManagerId, trigger)` composes the recycle reparent steps (wakes, questions, event-trigger/poll-job/webhook targets, pending owner message, cap queue, then the live workers) and files an `orphaned_workers_adopted` audit event under the NEW manager. Reachable only from the Tier-0 loopback route `POST /api/sessions/:id/adopt-orphaned-workers` and the Platform Lead tool `session_adopt_orphaned_workers`. Every refusal (old still live, old recycle-superseded, target not a live current manager of the same project, same id, non-manager roles, no live workers) is enforced in the service method.

## Do not

- Do not expose this on the manager, worker, setup or auditor surface; one manager must never be able to take another's workers.
- Do not move the workers before the other steps. The worker move is the commit point: a failed non-worker step refuses with no worker moved, and re-running completes. Recycle's own order (workers first) does not apply here because there is no successor to roll back to.
- Do not use `reparentPendingOwnerMessage` for the adopt: the target is a live manager that may hold its own open episode, so a plain overwrite breaks first-message-wins. `mergePendingOwnerMessage` keeps the earlier `at`/excerpt and sums counts.
- Do not treat `starting` as stopped (only `exited`/`none`), and do not adopt while `currentHaltedSuccessor(old)` is set: `recycle_reattempt` is the forward path and carries the queue.
- Do not refuse a resumable old manager; the human or Lead chooses between resume and adopt.
- Do not add `orphaned_workers_adopted` to the event-trigger, gate-history or report-resolution kind sets (audit-only, same bucket as `grants_repinned`).
- Do not copy `attemptManagerOwnershipTransfer`'s retry loop; both callers share `runOwnershipStepsWithOneRetry`, and recycle's log lines must stay byte-identical.
