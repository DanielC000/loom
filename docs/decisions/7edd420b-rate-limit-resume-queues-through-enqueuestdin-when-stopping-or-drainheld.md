# 7edd420b — a rate-limit resume queues through `enqueueStdin`, not a direct `submit()`, when an unrelated stop overlaps it

## Narrative

Card `7edd420b`: a PARKED (`rateLimited`) session is alive-but-idle, not dying — so an UNRELATED stop can overlap it: a plain `pty.stop()` (`live.stopping`) or a companion upgrade's `holdDrain` window (`live.drainHeld`) can both be mid-flight the instant `resumeAfterRateLimit` fires (the 60s rate-limit-watcher tick, or a human clearing the park via REST).

Pre-fix this method guarded on `alive` only, so it would write the replayed turn straight into that dying/held pty — a write that races the kill, is never recorded in `pending` (so `flushPending` can't recover it), and is simply lost.

`blocked` closes that: when either flag is set, route the replay through `enqueueStdin` instead of a direct `submit()` — the SAME queuing primitive `drainPending`'s own turn-starting site already falls back to when it can't submit safely. That HOLDS the prompt in `live.pending` rather than writing it into the pty, and a caller that's actively draining `pending` before the pty actually exits (`upgradeCompanionCapabilities`'s `holdDrain` loop is exactly this) recovers and redelivers it onto the fresh pty after the respawn — preserving the turn instead of merely declining to lose it noisily.

A plain `stop()` with no such capture (`drainHeld` never set) still clears `pending` itself before anything can recover it (see `stop()`), so the prompt CAN still be lost on that narrower path — but only ever as a quietly-dropped queue entry, never by corrupting a dying pty's write.

## Do not

- Do not write a rate-limit replay straight into the pty via a direct `submit()` without first checking `live.stopping`/`live.drainHeld` — an unrelated stop or a companion upgrade's `holdDrain` window can be mid-flight, and a direct write there races the kill and is unrecoverably lost.
- Do not assume queuing via `enqueueStdin` guarantees the replay survives every stop path — a plain `stop()` with `drainHeld` never set still clears `pending` before recovery, so the prompt can still be lost on that narrower path (quietly dropped, never corrupted).

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`resumeAfterRateLimit`'s own method doc), commit `8be7e97962` (2026-07-17). Extracted by card `09a1354e` (tranche 46 on `pty/host.ts`); condensed and reworded, not verbatim.
