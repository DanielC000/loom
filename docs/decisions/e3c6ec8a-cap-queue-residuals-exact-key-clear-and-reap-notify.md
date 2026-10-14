# e3c6ec8a — two cap-queue residuals left over from beb6f2b5: exact-key clear on auto-fire, and a reap notice from every read path

See `docs/decisions/beb6f2b5-cap-queue-clear-taskless-matches-review-target.md` for the original incident
and fix. That fix's own "Do not" section named two things it deliberately left open — this card closes
both.

## Residual 1 — two PLAIN taskless entries for the same agent were still indistinguishable

`clearTasklessForAgent` matches on `agentId` + review identity (`reviewOfWorkerSessionId`/
`reviewOfTaskId`, both `undefined` for a plain, non-review taskless spawn). Two plain taskless entries for
the same agent carry the SAME `undefined`/`undefined` review identity, so they remained indistinguishable
under that match — exactly the case beb6f2b5's own "Do not" section flagged as out of its scope. When one
such entry auto-fired via `maybeDrainCapQueue`, the success path's `clearTasklessForAgent` call — now
matching the survivor's own identical (undefined/undefined) identity — would delete it too, even though
`takeOldestOrReaped` had already removed the one that actually fired.

## The fix

- `maybeDrainCapQueue`'s replay now threads the popped entry's own `opId` through `spawnWorker`'s internal
  options (`clearCapQueueOpId`). On success, the clear uses the new `CapQueueRegistry.clearByOpId` —an
  EXACT key match — instead of the heuristic, so a surviving sibling with the identical agent+review
  identity is never touched. (It's usually a no-op: `takeOldest`/`takeOldestOrReaped` already removed the
  fired entry before this runs.)
- A caller with no popped entry to key off (a fresh, non-drain `worker_spawn` call that happens to
  succeed while siblings are still queued) still has no stable key — `clearTasklessForAgent` now clears
  only the OLDEST matching entry (Map iteration order), never every match.

## Residual 2 — a plain read silently TTL-reaped an entry with no notice

`CapQueueRegistry.prune()` (called from `record`/`listByManager`/`takeOldest`/`takeOldestOrReaped`/
`cancel`) silently deleted any entry past `CAP_QUEUE_TTL_MS`. Only `takeOldestOrReaped` — used exclusively
by `maybeDrainCapQueue` — ever reported what it reaped, via a notification loop local to that one method.
A plain read elsewhere (e.g. `worker_list`'s `listByManager`) could reap the SAME stale entry first,
before the drain ever got a chance to — and that reap reached neither notification path.

## The fix

`CapQueueRegistry`'s constructor now takes an optional `onReap` callback, invoked by `prune()` itself with
every entry it just reaped (across every manager), regardless of which public method triggered that
prune pass. `SessionService` wires this to `notifyReapedCapQueueEntries`, the SAME
`[loom:cap-queue-ttl-reaped]` text `maybeDrainCapQueue` used to compose inline. `maybeDrainCapQueue`'s own
notification loop is removed — redundant now that every prune() call notifies on its own.

## Do not

- Do not revert `clearTasklessForAgent` to clearing every match — that reopens residual 1 for two plain
  siblings exactly as beb6f2b5 reopened it for two differently-reviewed siblings.
- Do not add a new reap-triggering method to `CapQueueRegistry` without routing its `prune()` call through
  the existing notifier — that is exactly the gap residual 2 closes; a silent caller reopens it.
- Do not call `onReap` with the internal `CapQueueEntry` shape (carries the full `kickoffPrompt`) — map to
  the public `CapQueuedSpawn` projection first, same as every other externally-visible read.
- Do not assume `clearByOpId` needing the `taskId === null` guard — an opId is a per-entry `randomUUID()`,
  globally unique within the registry; matching on it alone (scoped to `managerSessionId`) can never
  cross-match a tasked entry.
