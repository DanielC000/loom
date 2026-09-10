# b9d479b0 — Single-source idle-worker classification, never two independently-drifting copies

## Narrative

Board card b9d479b0's original defect (the TWO-PATH ASYMMETRY): the idle-manager loop (`idle-watcher.ts`)
used to skip its own nudge for a manager with ANY live worker at all, busy or idle, while
`BusyWorkerWatcher` only ever covered `busy=true` workers — a live worker that went idle (`busy=false`)
WITHOUT calling `worker_report` was watched by NOBODY, and the manager loop's own live-worker skip
suppressed exactly the nudge that would have caught it. The fix narrowed that skip to a live BUSY worker
only (an idle live worker is no longer a reason to skip the manager's own idle nudge), and added
`tickIdleWorkers` — a periodic loop that RE-fires the same reconciled worker→manager nudge
`notifyManagerOfIdleWorker` already fires once on the busy→false edge, on its own `idleWorkerMinutes`
cadence. It also made a genuinely-stranded live worker (never a merely busy or rate-limited/parked one)
independently actionable in the "nothing else to do" skip below the manager loop's actionable-card count
— that skip must not re-silence exactly the manager that should be checking on its stranded worker.

SINGLE-SOURCED idle-worker classification (CR fold-in on board card b9d479b0/99efaab3): both notifyManagerOfIdleWorker (the busy→false edge nudge) AND IdleWatcher's periodic caller + manager-loop message (via isWorkerGenuinelyStranded below) key off this ONE reconciliation — a second, drifted copy is exactly how 99efaab3's false-alarm class reappears (a rate-limited worker re-nagged for the length of its cap; a message asserting "unreported" for a worker that's actually done-awaiting-merge or parked awaiting an ack).

## Do not

- Do not skip a manager's own idle nudge for a live worker that is idle (not busy) — only a live BUSY
  worker is a legitimate reason to consider the manager not-idle; an idle live worker is `tickIdleWorkers`'
  own concern instead.
- Do not let the "nothing else actionable" skip re-silence a manager with a genuinely-stranded live
  worker — a stranded worker is independently actionable even when every other card is not.
- Do not give `notifyManagerOfIdleWorker`'s busy→false edge nudge and `IdleWatcher`'s periodic/manager-loop check (`isWorkerGenuinelyStranded`) independently-maintained copies of idle-worker classification — both must key off the ONE `classifyIdleWorker` reconciliation, or the false-alarm class card `99efaab3` fixed (a rate-limited worker re-nagged for its whole cap window; a worker already done-awaiting-merge or parked-awaiting-ack reported as "unreported") reappears.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`classifyIdleWorker`): lines 12718-12723, as of commit `a07c5092c871d47f25aeb2ec160958306294a043`. Relocated by card `3f40210c`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. Extended by card `b072e5d4` (tranche 1 on `packages/daemon/src/orchestration/idle-watcher.ts`) with the original two-path-asymmetry defect this card fixed there.
