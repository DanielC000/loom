# beb6f2b5 — a successful taskless spawn only clears the cap-queue marker for ITS OWN review target, never every sibling for the same agent

## What happened in production

2026-10-13, Loom lead `e47d9022`. A taskless Code Reviewer spawn (reviewing worker `939dfb89`) was
cap-rejected and cap-queued as op `e23de925` at 20:23:09Z. A second, unrelated taskless Code Reviewer
spawn (reviewing a different worker, `d46525dd`) was cap-queued as op `3cfa3758` at 20:38:54Z. `e23de925`
later auto-fired correctly. `3cfa3758` never fired — over the following ~5 hours many slots freed and
many new spawns succeeded, with no daemon restart in between, and no notice of any kind (no
`[loom:cap-queue-ttl-reaped]`, no `[loom:cap-queue-autofire-failed]`) ever reached the manager. The
worker that should have reviewed `d46525dd` sat `awaitingReview` for 41 manager turns until the human
noticed and the manager re-spawned it by hand.

## Root cause

`CapQueueRegistry.clearTasklessForAgent(managerSessionId, agentId)` — called from `spawnWorker`'s own
success path as "the natural 'I re-drove it' signal" for a taskless spawn (which has no stable per-call
key, unlike a tasked spawn's `taskId`) — matched on `managerSessionId` + `agentId` + `taskId === null`
ONLY. Two distinct taskless entries for the SAME agent (two Code Reviewer spawns, each reviewing a
*different* worker) are indistinguishable under that match. The instant either one's own spawn
succeeded — whether via `maybeDrainCapQueue`'s own auto-drain popping the oldest entry, or via a
completely unrelated LATER manual `worker_spawn` call for that same agent — this bulk-clear deleted
BOTH entries from the registry, not just the one that actually fired. The dropped sibling was never
popped by `takeOldest`, never aged past `CAP_QUEUE_TTL_MS`, and so never reached either of the two
existing notification paths (`[loom:cap-queue-ttl-reaped]` on TTL reap, `[loom:cap-queue-autofire-failed]`
on a genuine re-drive failure) — it simply vanished from `this.entries` with nothing anywhere recording
that it had ever existed.

## The fix

`clearTasklessForAgent` now also takes the spawn's own `reviewOfWorkerSessionId`/`reviewOfTaskId` and
only clears an entry whose stored review identity matches (both fields, `undefined` included — a plain,
non-review taskless spawn still matches another plain taskless entry for the same agent, same as
before). A sibling entry queued for a *different* review target now survives untouched.

## Do not

- Do not revert `clearTasklessForAgent` to matching on `agentId` alone — that is exactly this bug.
- Do not assume this closes every taskless-entry ambiguity: two queued entries that are BOTH plain
  (no task, no review target) for the same agent are still indistinguishable from each other by
  design — there is no stable identity left to disambiguate them on, and that narrower case is
  unchanged by this fix (it was already ambiguous before it, and is out of this card's scope).
- Do not read the pre-existing TTL-reap/autofire-failed notification paths as a complete safety net for
  every drop in this registry — this incident proved an entry can be silently deleted by a THIRD path
  (`clearTasklessForAgent`) that neither of those two notifications ever observes, because the entry is
  gone before either check runs.
