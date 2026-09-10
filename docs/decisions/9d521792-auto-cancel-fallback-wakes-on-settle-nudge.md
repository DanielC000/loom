# 9d521792 — auto-cancel a parked session's fallback `wake_me` the moment its settle nudge lands

## Narrative

Card 9d521792, finding 23d8864a: when one of the 5 settle-nudge push sites (`runWorkerGate`'s
`onSettledAfterPending`, `confirmWorkerMergeTracked`'s generic echo, `rejectNotify`'s
`[loom:merge-rejected]`, `finishAlreadyMerged`'s `[loom:already-merged]`, and the boot-time
`reconcileOrphanedGateOps` sweep) delivers its TERMINAL `[loom:gate-*]`/`[loom:merge-*]` nudge, a fallback
`wake_me` a parked session scheduled to cover this exact op is now pointless — left alone it fires anyway
(sometimes after the session already reported done), burning a turn re-discovering "already handled".
`autoCancelSettleWakes` reaps it. Scoped by TIME, not by touching every pending wake: only `target`'s
wakes with `createdAt >= opStartedAt` are reaped — a wake created BEFORE this op started provably
predates it and is left untouched no matter how many wakes are pending. `target` is always the
LINEAGE-RESOLVED recipient ({@link resolveSettleNudgeTarget}) — a recycle already reparents a
predecessor's pending wakes onto the live successor (`db.reparentWakes`) at recycle time, so a fallback
wake scheduled before a mid-op recycle already lives under `target`'s own session id, with its ORIGINAL
`createdAt` preserved, by the time this runs.

ACCEPTED RESIDUAL RISK (documented in `/worker` doctrine too, not just here): a session that schedules a
SECOND, unrelated `wake_me` strictly after this op started but before it settles is swept too —
timestamps alone can't tell "fallback for this op" apart from "unrelated wake scheduled while parked".
This matches the card's own DoD wording ("any wake scheduled while that op was pending"); the doctrine's
cancel-your-own-wake-on-nudge instruction is the primary defense, this is the backstop for the common
single-fallback-wake case the originating evidence actually showed.

`opStartedAt` IS A CAPTURED VALUE, NEVER A SETTLE-TIME LOOKUP: every call site either closes over a local
captured synchronously BEFORE `attach()` ever ran (mirroring `attach()`'s own internal stamp: an
already-running entry for `key` keeps ITS start instant, no running entry means this call is about to
mint a fresh one at the same synchronous instant), threads that SAME captured value down through
`confirmWorkerMerge`'s `opStartedAt` param, or reads `started_at` straight off the durable row
(`reconcileOrphanedGateOps`). An EARLIER version instead re-derived `opStartedAt` via
`pendingOps.peek(key)` AT SETTLE TIME — plausible-looking (the retained view IS written moments earlier,
in the same synchronous settle callback), but it raced the registry's retain-then-notify ordering under
CPU-contended concurrent test load (merge-gate op `473b8596`: this test's own "fallback wake reaped"
assertions failed under `LOOM_GATE_TEST_CONCURRENCY=2` while passing standalone) — closure capture
removes that race entirely instead of chasing a more reliable read.

FAIL-SAFE ON UNKNOWN START TIME (kept even though closure capture makes it unreachable on every current
caller): `opStartedAt` would be undefined for a caller of `confirmWorkerMerge` OUTSIDE
`PendingOpRegistry` — the human REST merge route used to be exactly that caller, until card `361520a0`'s
Half One routed it through the tracked path too. NO current caller takes this branch; kept purely as a
defensive guard against `confirmWorkerMerge` being invoked directly again in the future. The two failure
directions are NOT symmetric: cancelling nothing just leaves a stale wake to fire once more (the original
bug, unchanged); cancelling broadly — or from epoch — could destroy a wake the session is genuinely
relying on. So an unknown start time cancels NOTHING — logged, never silent.

VISIBILITY: every reaped row is logged INDIVIDUALLY (never just a count) — this feature destroys state a
session deliberately created, and its one known imperfection is over-cancellation; a per-row log line is
the only way anyone can diagnose "a session mysteriously never woke up" after the fact. Deletes via the
SAME `db.deleteWake` the `wake_cancel` MCP tool itself uses — no separate cancellation event or counter
exists, so this produces the identical observable end state as an explicit agent cancel.

## Do not

- Do not re-derive `opStartedAt` via a settle-time registry lookup — capture it synchronously before/at
  `attach()` and thread it through; a settle-time re-derive races the registry's retain-then-notify
  ordering under concurrent test load (measured: merge-gate op `473b8596`'s "fallback wake reaped"
  assertions failed at `LOOM_GATE_TEST_CONCURRENCY=2` while passing standalone).
- Do not cancel broadly (or from epoch) when `opStartedAt` is unknown — cancel nothing and log it; the
  two failure directions are not symmetric, and over-cancellation can destroy a wake a session relies on.
- Do not log a reaped-wake count only — log every reaped row individually, since over-cancellation is
  this feature's one known failure mode and needs a per-row trail to diagnose.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `autoCancelSettleWakes`: lines
6350-6402, as of main `055e96ce`. Relocated by card `c7ca6c08` (tranche 16); no wording changed, wrapped
source lines joined into a flowing paragraph and the `*` comment markers stripped.
