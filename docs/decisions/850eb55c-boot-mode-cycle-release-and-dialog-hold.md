# 850eb55c — the boot mode-cycle's own SessionStart release, not `reconcile()`, drains a kickoff held behind a latched `ready`

## Context

Card 01160ae3/850eb55c (round 1) added `isBlockedOnUnresolvedBootDialog`: a HOLD, not a drop, on both
kickoff-delivery paths (`drainPending`, `enqueueStdin`'s immediate-submit conjunction,
`scheduleKickoffGuarantee`'s own direct-submit gate) while a LOOM_DRIVEN_ROLES session is still
pre-SessionStart and showing a recognized blocking-dialog signature.

Round 2 Code Review (gen 389) found the hold had no STRUCTURAL release. `READY_FALLBACK_MS` can latch
`live.ready = true` well before SessionStart ever fires (a slow-but-healthy boot, or a boot genuinely held
by the dialog hold above). `markReady` is guarded to run AT MOST ONCE per session (`live.ready`), so when
SessionStart later DOES arrive, the SessionStart case's own `this.cycleToMode(sessionId, target, () =>
this.markReady(sessionId))` — and the two sibling direct-call sites (no cycling target; a repeat
SessionStart on an already-cycled session) — all hit that guard and silently no-op. Nothing then drains
whatever `scheduleKickoffGuarantee`'s held branch (or an ordinary `enqueueStdin`) queued, except
`reconcile()`'s periodic tick:

- (a) a real, measured 30-40s latency floor (the optimistic spawn-time `busy` value has to clear via
  `healIfStuck`'s own pre-first-turn stale window before a tick can even drain anything), and
- (b) an ORDERING RACE: if `healIfStuck` had already cleared `busy` mid-dialog, the NEXT reconcile tick
  can land the kickoff INSIDE the mode cycle's own settle + Shift+Tab window (the c469d54e/0050a17e
  frame-splice class) — the exact interleave class this whole mode-cycle mechanism exists to prevent.

## Decision

Drain directly from the SessionStart cycle's own convergence point (`releaseBootModeCycle`, `pty/host.ts`)
instead of leaning on `reconcile()`: if `live.ready` is still false there, run `markReady` as before
(ordinary, unchanged path); if `ready` was ALREADY latched by the fallback, call `drainPending` directly.
This is safe by construction at that point — `sessionStartObserved` is flipped true, and `dialogStuckScan`
is cleared, at the very TOP of the `SessionStart` case, strictly BEFORE the mode cycle (or its no-target/
repeat equivalent) ever runs — so `isBlockedOnUnresolvedBootDialog` already reads false and
`drainPending`'s own gates are the only ones left to satisfy.

A SEPARATE new flag, `Live.startupCycleInFlight`, closes race (b) above: true from the moment the
SessionStart case hands the cycle to `cycleToMode` until that cycle's own `onDone` calls
`releaseBootModeCycle`. It gates the SAME three sites `isBlockedOnUnresolvedBootDialog` already gates
(`drainPending`, `enqueueStdin`'s immediate-submit conjunction, `scheduleKickoffGuarantee`'s own
direct-submit gate) — needed BECAUSE `isBlockedOnUnresolvedBootDialog` itself goes false the instant
SessionStart fires, before the cycle has actually finished pressing Shift+Tab / reading the footer, so
without a separate flag nothing would hold a write for the cycle's own (asynchronous, multi-tick)
duration.

## Correction — `startupCycleInFlight` must not defeat the absolute-ceiling liveness guarantee

The first cut of this fix gated `scheduleKickoffGuarantee`/`enqueueStdin`/`drainPending` on
`startupCycleInFlight` wherever `isBlockedOnUnresolvedBootDialog` was already gated, and cleared the flag
ONLY in `cycleToMode`'s own `onDone` callback. `pty-ready-fallback-ceiling.mjs` (pre-existing, card
`c469d54e`) caught that this breaks a SEPARATE, already-documented guarantee: the SessionStart case's
re-armed fallback timer (`newFallbackTimer`) doubles as the ABSOLUTE CEILING
(`READY_FALLBACK_ABSOLUTE_CEILING_MS`) whenever that's the binding constraint on `boundedDelay` — its whole
purpose is to force readiness (and kickoff delivery) even when the cycle itself (`MODE_CYCLE_FALLBACK_MS`,
or `cycleToMode`'s own internal give-up via `RESUME_MODE_MAX_POLLS`) is configured, or genuinely stuck, far
larger than the ceiling. With `startupCycleInFlight` cleared only by the cycle's own `onDone`, the ceiling's
`markReady` call still ran, but `scheduleKickoffGuarantee`'s own gate then held the kickoff hostage to that
SAME oversized/stuck cycle budget anyway — silently downgrading "never stranded forever" to "stranded until
the cycle's own budget expires" (observed: a kickoff still undelivered after 18+ seconds against a 3000ms
test budget, with `MODE_CYCLE_FALLBACK_MS` pinned to 60000ms in that test).

Fix: the SAME fallback-timer callback that calls `markReady` (because `!l.ready`) now ALSO clears
`l.startupCycleInFlight = false` first. This restores the pre-existing, already-documented trade-off
unchanged: the ceiling's forced delivery can still race the still-running cycle's own writes (never claimed
corruption-free for arbitrary contention — see the surrounding comment on `elapsedSinceSpawn`), but it can
no longer be stranded waiting on that cycle's own budget. The ordinary (non-ceiling) case — the cycle
converges within its own normal budget — is unaffected: `startupCycleInFlight` still holds every write path
for that cycle's entire real duration, exactly as intended.

## Do not

- Do not call `this.markReady(sessionId)` again from any SessionStart-case convergence point without
  first checking `live.ready` — the guard inside `markReady` makes a direct repeat call a silent no-op,
  which is the exact defect this record exists to close. Call `releaseBootModeCycle` instead.
- Do not gate `drainPending`/`enqueueStdin`'s immediate path/`scheduleKickoffGuarantee`'s direct-submit
  gate on `isBlockedOnUnresolvedBootDialog` alone to protect the mode-cycle's own settle window — that
  predicate already reads false once SessionStart fires (before the cycle itself has finished), so it
  cannot close race (b) above on its own. Use `Live.startupCycleInFlight` for that.
- Do not forget to clear `startupCycleInFlight` in `cycleToMode`'s `onDone` callback before calling
  `releaseBootModeCycle` — leaving it true would permanently wedge every kickoff-delivery path for that
  session.
- Do not assume `cycleToMode`'s own `onDone` is the ONLY place `startupCycleInFlight` must be cleared — the
  SessionStart case's re-armed fallback timer doubles as the absolute-ceiling backstop (see the Correction
  section above) and must clear it too, or the ceiling's own liveness guarantee is silently defeated by the
  very cycle it exists to route around.
