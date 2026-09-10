# a193398f — throttle the idle-nudge board rescan; a "nothing actionable" outcome never advances the cadence on its own

## Narrative

Card a193398f (perf): the board scan behind the idle-manager nudge decision — `db.listTasks(projectId)`
(every column, every row, including done) plus, historically, one `listQuestionsForTask` query PER
non-terminal card — is only NEEDED once per nudge decision. But a "nothing actionable" outcome doesn't
call `recordIdleNudge` (`last_idle_nudge_at` never advances), so without a separate throttle this full
scan reran on EVERY 60s tick, indefinitely, for as long as a manager sat idle-eligible with nothing to
nudge: cost scaling with `board_size × idle-tick-count`, not `board_size × nudge_count` as intended.

The fix is `IDLE_SCAN_THROTTLE_MINUTES`, an in-memory `lastIdleScanAt` cache (per manager, no schema
migration — a daemon restart just costs one extra scan per manager, harmless; pruned each tick to the
currently-live manager/platform set so it can't grow unboundedly across recycles/restarts) — deliberately
SHORTER than any real `idleNudgeMinutes` (default 45) so a due nudge is never delayed by more than this
window. It only ever SKIPS a re-derivation; it never affects whether a nudge fires once scanned. The N+1
per-card `listQuestionsForTask` calls were also batched into one project-wide
`listPendingQuestionTaskIds` query.

A later CR follow-up closed a floor gap: `idleMinutes` is project/env-overridable with NO floor of its
own, so a project configuring it below `IDLE_SCAN_THROTTLE_MINUTES` would have had its actionable
re-nudge cadence silently stretched to the throttle window instead of its own configured value. The
effective throttle is floored at `Math.min(IDLE_SCAN_THROTTLE_MINUTES, idleMinutes)` so it can never
exceed a given manager's own configured nudge cadence.

## Do not

- Do not re-derive the full board scan on every tick — cache the last-scanned-at per manager and skip a
  re-scan within the throttle window; only a scan due to fire can advance `last_idle_nudge_at`.
- Do not use `IDLE_SCAN_THROTTLE_MINUTES` unconditionally as the effective throttle — floor it at the
  manager's own `idleMinutes` first, or a short-configured project's nudge cadence is silently stretched.
- Do not re-issue one `listQuestionsForTask` call per non-terminal card — batch it into one project-wide
  query.

## Source

Inline comments in `packages/daemon/src/orchestration/idle-watcher.ts` (the scan-throttle constant, the
`lastIdleScanAt` cache field, and the scan-throttle check site in the manager loop). Relocated by card
`b072e5d4` (tranche 1 on `idle-watcher.ts`).
