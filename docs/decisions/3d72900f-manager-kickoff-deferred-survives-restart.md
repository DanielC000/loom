# 3d72900f — the manager/platform kickoff's within-window DEFERRAL now survives a daemon restart

Full mechanism and rationale: `ab3c965d-manager-kickoff-dropped-notification.md`'s own "Round 4" section
— not restated here. This record exists because the comment taxonomy wants one record file per id; the
narrative lives on the card this one closes a residual of.

In short: `handleKickoffGiveUpExhausted`'s manager/platform `pending` branch used to arm
`armKickoffConfirmRecheck`'s in-memory-only timer with nothing durable recorded — a daemon restart inside
that window lost the drop permanently, with no boot-reconcile path to resume from (unlike a worker's own
`escalateParkedKickoffAtBoot`). This card records a durable `session_message_gave_up(outcome:"deferred")`
marker before arming the timer, and adds `escalateDeferredManagerKickoffAtBoot` — the manager/platform
twin of the worker's boot re-arm. Round 5 (below) widened the boot-consumer wiring to the REAL path every
non-self-host install actually takes (`recoverCrashOrphanedWorkers`, not just `resumeFleetOnBoot`).

## Round 5 — pointer only

A Code Review of round 4 widened the boot-consumer wiring to `recoverCrashOrphanedWorkers` (round 4 had
reached `resumeFleetOnBoot` only) and, in the SAME round before this ever shipped, found and fixed a bug
in its own first attempt at the crash path's `hasBusyAtCapture`: a live `db.getSession(managerId)?.busy`
read is ALWAYS false there (`recoverStaleSessions()` already zeroed it before this method ever runs), so
that read was dead code. Fixed by threading the PRE-FLIP busy value through instead — see the "Do not"
list below for the specifics, and `ab3c965d`'s own "Round 5" section for the full narrative (this card's
own method) plus the Lead-notify-side fixes from the same review.

## Do not

- Do not write the `outcome:"deferred"` marker AFTER arming `armKickoffConfirmRecheck`, or inside its
  callback — it must be written FIRST, in the `pending` branch itself, or a restart in the gap between
  arming the timer and it ever firing loses the drop exactly like before this card.
- Do not give `escalateDeferredManagerKickoffAtBoot` a `kickoff_confirm_escalated`-style second durable
  marker — the manager/platform path has exactly ONE terminal action (`handleManagerKickoffDropped`), and
  its own `manager_kickoff_dropped` event (matched by `rootMsgId`) is already sufficient to detect
  "already handled" on a later boot; a second marker here is an unneeded divergent copy.
- Do not wire `escalateDeferredManagerKickoffAtBoot` into `resumeFleetOnBoot` alone — `recoverCrashOrphanedWorkers`
  (card `9fc41af5`) is the path every non-self-host install (and the end-user Platform Lead) actually
  takes; this was round 4's own gap, closed by round 5 above.
- Do not derive the crash-recovery call site's `hasBusyAtCapture` from a LIVE `db.getSession(managerId)
  ?.busy` read — `recoverStaleSessions()` already zeroed it before this method ever runs, so that read is
  always false and the discriminator becomes dead code. Thread the PRE-FLIP value through instead
  (`recoverCrashOrphanedWorkers`'s own `busyAtCrashByManagerId`, built in `index.ts` from
  `recoverStaleSessions()`'s own pre-UPDATE `recovered` snapshot) — round 5's own first attempt at this
  fix made exactly this mistake, and a test that sets `busy` AFTER that point (production can't) will
  pass against the bug without catching it.
- Do not derive the crash-recovery call site's `hasQueuedPending` by inventing a captured-state concept
  that doesn't exist there — it is read LIVE from `db.listUnresolvedQueuedMessagesForWorker(managerId)`,
  the same durable store `recoverUndeliveredMessagesOnBoot` already redrives from elsewhere in the same
  boot; unlike `hasBusyAtCapture` above, there is no "already zeroed by the time this runs" hazard here.
- Do not write a "no continuation nudge"/role-check test against a subject or fixture with no OTHER
  reason to get one (a bystander that's already a no-op regardless of the escalation, or a role-check
  scenario with no real marker to escalate in the first place) — pair it with a mirror scenario using the
  IDENTICAL fixture minus the one condition under test, proving the silence was that condition's doing.
- Do not read the accepted residual (any non-kickoff turn-start — human typing, a Lead `session_message`
  — permanently suppressing the drop via `armKickoffConfirmRecheck`'s generic fire-time stand-down) as a
  defect this card leaves open to fix without a fresh card — it is the SAME accepted shape `b03e636c`
  already documents for the worker boot path, carried here deliberately.
- Do not hardcode this boot consumer's own discriminator count in its docblock, or the
  `session_message_gave_up`-referencing test-file count in prose anywhere in this project — both already
  rotted once; point at the source/a `grep` instead (the specimens: ten → nineteen referencing test
  files; a docblock claim of "four... a subset of five" that never matched its own six-item list).

## Source

See `ab3c965d`'s own "Source" section — not duplicated here. For round 5's own fixes specifically
(including the busy-capture correction above), see this record's own "Round 5" section; for the
Lead-notify-side round 5 fixes, see `ab3c965d`'s own "Round 5" section.
