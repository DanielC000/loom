# 564eaffb — "/new" persona reinject is held with its "/clear" during a companion recycle/upgrade

Follow-up to d10ac47e. "/new" = `/clear` via `submitTurn` (held by `withCompanionSelfHeal` while a transition is in flight) + a persona reinject via a raw `pty.enqueueStdin`, which a dead pty drops. The held `/clear` then replayed onto the successor after its startup prompt with no persona behind it.

## Decision

Option (a): `withCompanionTransitionHeldReinject` (`companion/revive.ts`) parks the reinject in the same held list, after the `/clear` (FIFO), so both replay in order at op end. The reinject composes its prompt at replay time.

Rejected: (b) refuse — worse UX, and the owner already got the "queued" ack path. (c) no-op during recycle — fine for recycle (fresh engine) but wrong for upgrade, which resumes the same transcript and needs the clear + persona.

## Do not

- Do not let the reinject bypass the hold while a transition is in flight.
- Do not compose the reinject prompt at hold time; compose at replay.
