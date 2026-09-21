# f9802e9f — a schedule occurrence missed while the daemon was down is skipped and recorded, never caught up

## Narrative

The Platform Lead measured a hard 38-hour zero in `orchestration_events` (2026-09-19T18Z through
2026-09-21T06Z) — the daemon was not running across that whole window, with a positive control (2,724
events exist for `ts >= 2026-09-18`) proving the table/query were live the rest of the time. Three
schedules had a due occurrence fall inside that window across two projects. A weekly schedule (`cron`
`0 8 * * 1`) missed its run and rolled forward to the FOLLOWING week with `lastFiredAt`, `lastDeferredAt`,
and `lastDeferredReason` all still `null` — nothing anywhere recorded that an occurrence should have run
and didn't. A second weekly schedule on the same project missed a cycle too and was caught only by luck
(it happens to write a dated file to disk); a schedule that leaves no on-disk artifact would have been
invisible entirely.

Cron is evaluated in the daemon's LOCAL timezone, not UTC — `0 8 * * 1` means 08:00 local. Reading it as
08:00 UTC inverts the whole diagnosis (the daemon would then have been up at the due time, making the
non-fire look like a scheduler bug rather than a downtime-window miss). `nextFireAtLocal` (already present
on every schedule tool response via `withScheduleTimeEcho`) is the reliable cross-check; the bare `cron`
string alone is what misled a careful reader.

Two of the three signals a reporter might reach for to detect a miss don't exist in this database at all:
`schedule_fire_failed` and (before this card) any recorded trace of a boot-time reconcile skip. Only
`schedule_fired` was ever genuinely emitted and absent — a real signal, but on its own it can't distinguish
"never attempted" from "this kind of event is never emitted on any code path."

## Decision

**Policy: SKIP the missed occurrence, never catch up / replay it.** Catch-up after a long outage would
stampede every missed occurrence's manager spawn at once — the same shape of incident
`countLiveScheduledManagers`'s manager-cap budget (card `53edd8d5`) already exists to prevent for an
in-tick burst. The defect this card fixes is not the skip (skipping is defensible policy) — it's that the
skip was **silent**.

The fix reuses the schedule row's existing `last_deferred_at`/`last_deferred_reason` columns and the
Schedules-UI "deferred: `<reason>`" badge that a budget/owner-gate defer already renders (card `53edd8d5`)
— no new UI surface was needed, just a new writer into the same read path — plus a new durable
`schedule_fire_missed` orchestration event (schedule id, the ORIGINAL due time as `dueAt`, and `reason:
"daemon down"`, the only cause a boot-time reconcile can distinguish; it cannot tell a deliberate stop
from a crash from a machine being off).

**A DISABLED schedule's past `next_fire_at` is a different case, not a miss**: it was never going to fire
regardless of whether the daemon was up, so nothing was actually lost. Its stale `last_deferred_at`/
`last_deferred_reason` — left over from a defer episode that predates the outage — are CLEARED (not
replaced with a miss reason), preserving the existing fix from CR `a3715e68` on card `53edd8d5`: an
operator who paused a starved schedule must not keep seeing an amber badge implying a live episode that
already ended.

## Do not

- Do not implement misfire catch-up/replay in `Scheduler.start()`'s reconcile — after a long outage it
  would stampede every missed occurrence's manager spawn at once; skip and record instead.
- Do not emit `schedule_fire_missed` for a DISABLED schedule's past `next_fire_at` — it was never due
  regardless of daemon uptime, so nothing was missed; only advance it and clear any stale deferral fields.
- Do not assert a *cause* for the daemon downtime from this mechanism alone — a boot-time reconcile only
  knows the daemon was not running across the missed slot, never why (machine off, deliberate stop, crash).
- Do not read `0 8 * * 1`-style cron fields as UTC — they are evaluated in the daemon's LOCAL timezone;
  cross-check against `nextFireAtLocal`, never the bare `cron` string alone.

## Source

`packages/daemon/src/orchestration/scheduler.ts`, `Scheduler.start()`'s own doc comment, condensed to a
<=3-line `@decision f9802e9f` guard citing this record. Fleet-wide scope (n=3 across two projects), the
local-time cron correction, and the evidence tiers are the Platform Lead's own triage on card `f9802e9f`
itself — read there for the full measured evidence; not restated here.
