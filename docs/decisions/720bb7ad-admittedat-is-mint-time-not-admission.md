# 720bb7ad (DoD-4) — `admittedAt` is MINT time, not admission time — the trap its own name invites

## Narrative

Card 720bb7ad DoD-4: `admittedAt` READS as "the instant this op was admitted past the gate concurrency cap" but is NOT that — it is MINT time (when the op was first created/queued, before it ever competed for a slot). A queued op can sit for minutes before it's actually admitted (routine at `maxConcurrentGates>=2` under fleet load), so `totalDurationMs` (`settledAt - admittedAt`) SILENTLY INCLUDES that queue wait — it is the REAL total op wall time (worktree prep + queue wait + gate + squash), never a queue-wait-excluded "how long did the actual work take" figure. Measured: one op's `admittedAt` sat ~7m16s before `GateQueueEntry.since` (the LIVE field that re-bases to the moment this SAME op was actually admitted) read the op as `"running"` — a real, not hypothetical, gap.

The field that DOES re-base to true admission is `gate_queue`'s (or this same op's own live, pre-settle `gate_status` read's) `since`/`elapsedMs` — but ONLY while the op is still live (`queued`/`running`); once settled, that live view is gone and `admittedAt` (mint time) is the only admission-adjacent timestamp left on the durable record. There is no settled-and-queue-wait-excluded field — if queue wait specifically is needed, read it from `gate_queue`/`gate_status` while the op is still live, before it settles. `admittedAt` is present for EVERY tombstone-branch result (settled, evicted-dead-owner, orphaned-by-restart, or the real `pending` window), not gated on a recorded verdict, since it's the row's own `started_at` column, always known once a row exists at all — absent only for the two no-row outcomes and the live `queued`/`running`/`ambiguous` returns, which report `since`/`elapsedMs` instead.

## Do not

- Do not read `admittedAt` as "when this op was admitted past the cap" — it is mint time, before the op ever competed for a slot.
- Do not read `totalDurationMs` (`settledAt - admittedAt`) as excluding queue wait — it silently includes it; there is no settled figure that excludes it.
- Do not try to recover true admission time after an op has settled — read `since`/`elapsedMs` from `gate_queue`/`gate_status` while the op is still live, before it settles.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`'s `admittedAt` return-type field). Relocated by card `f05ca65c` (tranche 8); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
