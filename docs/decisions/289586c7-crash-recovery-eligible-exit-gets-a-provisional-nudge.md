# 289586c7 — a crash-recovery-eligible exit gets a provisional nudge, never the definitive one

## Narrative

Board card 289586c7: the exited-without-report guard (`notifyManagerOfExitedWorker`, see
`docs/decisions/84151b99-exited-without-report-guard-catches-a-worker-that-never-idles.md`) records an
UNEXPECTED exit and, by default, tells the manager the worker "will NOT come back" and should be
re-dispatched. But `worker` is one of the `RECOVERABLE_ROLES` the `CrashRecoveryWatcher` may ALSO be
about to auto-resume from this exact same exit — firing the definitive "will NOT come back, re-dispatch"
nudge in that case would be actively WRONG and races the resume. Origin incident: worker `a1c71a86` got
the false definitive nudge immediately before three auto-recovery re-confirmation `worker_report`s
landed from that SAME worker, once it came back.

FIX: when the worker is still crash-recovery ELIGIBLE (`isCrashRecoveryEligible`), the guard rewords to
a provisional heads-up instead of the definitive "won't come back" nudge. The definitive nudge is left
entirely to the crash-recovery watchdog itself, fired ONLY once it actually gives up
(`session_recovery_abandoned`; see `crash-recovery-watcher.ts`'s own `pty.enqueueStdin` at that point).

## Do not

- Do not fire the definitive "will NOT come back, re-dispatch" nudge for a worker still eligible for
  crash-recovery auto-resume — it races the watchdog's own resume attempt and can land immediately
  before that same worker's own re-confirmation reports (origin incident: worker `a1c71a86`).
- Do not duplicate the "gave up" determination here — leave the definitive, no-longer-provisional nudge
  to the crash-recovery watchdog's own `session_recovery_abandoned` path, the single place that already
  knows recovery has actually been exhausted.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`notifyManagerOfExitedWorker`'s JSDoc, the
"CRASH-RECOVERY COORDINATION" paragraph): lines 9845-9853, as of main `a4fdccf6` (introducing commit
`21c17c8d5dacbc4b1ee0df588de7260577e0acb6`, `fix(sessions): coordinate crash-recovery — add assistant
to RECOVERABLE_ROLES + stop the worker-exit "won't come back" nudge colliding with auto-resume`).
Extraction tranche 36.
