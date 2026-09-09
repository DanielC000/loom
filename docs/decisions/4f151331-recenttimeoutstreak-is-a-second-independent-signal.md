# 4f151331 — `recentTimeoutStreak` is a second, independently-derived signal, not the semaphore's own belief

## Narrative

Escalation 4f151331 — a SECOND, INDEPENDENTLY-derived signal, not the semaphore's own live phase above: how many CONSECUTIVE `timedOut` gate results this entry's `branch` has recorded (see `SessionService.gateTimeoutStreakCount`). `phase`/`queuePosition` reflect only what the GateSemaphore registry currently BELIEVES; they cannot see a gate whose process tree wasn't actually fully reaped after an earlier timeout on this SAME worktree. A nonzero count here — even below the circuit breaker's own trip threshold — means treat "queued"/"running" with suspicion: verify no orphaned process survives from a prior attempt before assuming this worktree is otherwise idle. `0` means no recent timeout on this branch (the common case); omitted entirely when there's no `branch` to key it by at all (a deploy gate has none).

## Do not

- Do not trust `phase`/`queuePosition` alone as proof a worktree is idle — they reflect only the GateSemaphore registry's own belief, not whether an earlier timeout's process tree was actually fully reaped. A nonzero `recentTimeoutStreak` means verify no orphaned process survives before assuming otherwise.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`GateQueueEntry.recentTimeoutStreak`): lines 174-182, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
