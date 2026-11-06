# d10ac47e — companion self-heal must not resume the old engine during an in-flight recycle or upgrade

## Defect

`recycleCompanion` / `upgradeCompanionCapabilities` stop the old pty, then bring up a successor. In the ≤100 ms between the old pty's exit and the stop loop's next `isAlive` check, an inbound chat message gets `{delivered:false}` with no `position`. `withCompanionSelfHeal` then called `sessions.resume()` on the OLD engine id (still on the row), the stop loop saw "alive" and hard-killed that auto-resumed pty, and the message — written into the old transcript — was lost for a recycle.

## Decision

- `SessionService` keeps a per-session, in-memory marker (`beginCompanionTransition`, a token set) set at the top of both ops and cleared in a `finally`.
- `withCompanionSelfHeal` takes an optional `transition` seam. On the dead-session signal, while the marker is live it HOLDS the inbound (returns `{delivered:false, position:N}`, the gateway's normal "queued" ack) instead of resuming.
- When the LAST concurrent op for the session ends (success or failure) each held inbound is replayed ONCE through the same wrapper: onto the successor if it is up, or through a normal self-heal if the op failed and the session is dead.
- Chosen over "enqueue onto the dead pty" (enqueueStdin drops on a dead pty) and over a durable redrive (companion inbound is not a durable message row): the hold-then-replay path is the only one that delivers each message exactly once, because each held closure is removed from the list before it runs.

## Leak bounds

Each token carries a TTL (`COMPANION_TRANSITION_MARKER_TTL_MS`, derived from the busy wait + both stop loops + a margin; the busy wait is clamped by `UPGRADE_BUSY_WAIT_MAX_MS`, so an env setting cannot push the dead window past it); an expired token no longer blocks self-heal. A daemon restart drops the in-memory map and any held inbound with it — the same loss the existing in-memory pending FIFO already has on a restart, so this adds no new durability gap. A replay that is still dead after the op ends is logged (`onReplayDead`) rather than silently acked; the gateway has already sent its "queued" ack by then, and an owner-visible error ack would need a new gateway callback (not done). Concurrent ops use separate tokens; the marker holds until the last one ends.

## Do not

- Do not drop the `finally`/TTL, or make the marker durable: a leaked marker would block self-heal for that Companion indefinitely.
- Do not resume the old engine id from the self-heal path while the marker is live.
- Do not replay held inbound before the op settles: the successor does not exist yet.
