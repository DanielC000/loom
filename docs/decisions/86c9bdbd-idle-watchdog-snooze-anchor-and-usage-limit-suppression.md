# 86c9bdbd — the idle watchdog's snooze anchor, and why `wakeParkedManagerOnReport` stays unchanged

## Narrative

The idle watchdog kept re-nudging a manager that had just called `idle_report({state:"waiting",
minutes:1440})` in response to `worker_spawn` refusing on an exhausted usage allowance — the nudge
repeated roughly every 45 minutes (the project's `idleNudgeMinutes` default) despite the just-set 24h
snooze, inviting the manager to retry the same already-refused spawn each time.

Root cause: `IdleWatcher.tick()`'s reset-on-activity check (`producedActivitySince`) anchors on
`last_idle_nudge_at` — a column stamped ONLY when a nudge actually fires, and never advanced by
`idle_report`. So any genuine orchestration-activity event (e.g. a merge the manager finished while
winding down) that happened AFTER the previous nudge but BEFORE the manager's own `idle_report(waiting)`
call looked, on the very next tick, identical to activity that happened after the snooze was set — both
"land after `last_idle_nudge_at`" — and unconditionally reset the brand-new snooze back to `watching`,
even though the manager had already accounted for that activity when it chose to park.

Fix: a new `idle_disposition_at` column records the manager's own most recent `idle_report`
(`waiting`/`done`) call instant, stamped by `SessionService.recordIdleReport` via
`Db.stampIdleDispositionAt` — deliberately a SEPARATE column from `last_idle_nudge_at`, not an overload
of it. `last_idle_nudge_at` is read elsewhere in `idle-watcher.ts` (the `idleForMin` pacing math, both
the manager and worker idle loops) as "a nudge was actually sent", to pace re-nudge cadence; stamping it
at `idle_report` time would corrupt that reading. The reset-on-activity check now anchors on
`laterIso(lastIdleNudgeAt, idleDispositionAt)` instead, so only activity that happens AFTER the manager's
own most recent disposition call can still re-arm it.

Separately, DoD-2: the manager idle-nudge loop never consulted the usage-limit signal at all (only the
unrelated `tickAnsweredStuckQuestions` loop checked `rateLimitedUntil`). `tick()` now computes
`isLikelyNearClaudeUsageLimit(now, recencyWindowMs)` once per tick — the SAME signal and SAME
`resolveConfig` `recencyWindowMs` resolution `worker_spawn`'s own refusal reads — and skips the nudge
silently (same shape as the `human-paused` skip, including suppressing the escalate-on-unanswered-cap
branch) while it's true.

`wakeParkedManagerOnReport` (unconditionally re-arms any non-`watching` policy to `watching` whenever a
worker reports) was deliberately left UNCHANGED. A worker's report is genuine new work delivered as a
turn — there is no "activity that predates the park" to misattribute here, unlike the bug above. If that
wake fires during a usage-limited window, the usage-limit skip above still suppresses the resulting
nudge; once the manager re-parks after handling the report, its own `idle_disposition_at` re-arms the
anchor again. So the DoD-3 guarantee reads as "a waiting snooze holds across intervening orchestration
events the manager itself caused" — a worker's report is deliberately not one of those, and is pinned by
its own dedicated test (`idle-watcher.mjs`, "(12e)" — worker report during a snooze still wakes the
manager) rather than being folded into the "holds across events" test.

## Do not

- Do not stamp `idle_disposition_at`'s timestamp into `last_idle_nudge_at` (or vice versa) — the latter
  is read elsewhere as "a nudge was actually sent" to pace re-nudge cadence; conflating the two changes
  that pacing.
- Do not anchor the reset-on-activity check on `lastIdleNudgeAt` alone — use
  `laterIso(lastIdleNudgeAt, idleDispositionAt)`, or a stale nudge timestamp can again misattribute
  pre-disposition activity as a reason to re-arm.
- Do not change `wakeParkedManagerOnReport` to skip on a worker report — a report is genuine new work,
  not pre-park activity; gate the resulting NUDGE on the usage-limit signal instead (already done in
  `tick()`), never the wake-on-report re-arm itself.
- Do not let the usage-limit skip in `tick()` diverge from `worker_spawn`'s own
  `isLikelyNearClaudeUsageLimit` + `resolveConfig` `recencyWindowMs` resolution — a second notion of
  "usage-limited" is exactly what this card's kickoff ruled out.

## Source

Board card 86c9bdbd. Fix in `packages/daemon/src/orchestration/idle-watcher.ts` (reset-on-activity anchor
+ usage-limit skip) and `packages/daemon/src/db.ts` / `packages/daemon/src/sessions/service.ts`
(`idle_disposition_at` column + `stampIdleDispositionAt` + `recordIdleReport`'s `waiting`/`done` branches).
