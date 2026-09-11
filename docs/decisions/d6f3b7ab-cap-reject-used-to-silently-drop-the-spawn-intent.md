# sha:d6f3b7ab — a cap-reject used to silently drop the spawn intent; CapQueueRegistry exists to stop that

Source: commit `d6f3b7ab`, no board card ("feat(orchestration): a worker_spawn rejected by the concurrency cap (4) drops the intent silently — nothing queues, so the card stays in todo and the manager must remember to re-spawn a slot later"). Condensed, not verbatim.

## Narrative

Before `CapQueueRegistry` existed, a `worker_spawn` rejected purely because `maxConcurrentWorkers` was at capacity returned a bare `{error}` and recorded nothing durable — the caller had to remember to re-spawn, and evidence showed a card sat un-dispatched ~150 turns because a manager forgot. This registry exists to make a cap-rejected intent VISIBLE instead — `worker_list` surfaces it as a distinct placeholder row — instead of letting it silently disappear.

## Source

Inline comment in `packages/daemon/src/orchestration/cap-queue.ts`, above `CapQueueRegistry`, as of main `4ed709d8`. Relocated by card `78947c26` (tranche 1). Condensed and reworded, not verbatim.
