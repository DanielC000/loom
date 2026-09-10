# 959a5fb7 — gate the crash-recovery nudge on `awaitingReview`, not the wider `reportedDone`

## Narrative

Card 959a5fb7 (commit `a7cde03ae3`, "fix(sessions): stop claiming a consumed report is awaiting review") fixed `recoverCrashOrphanedWorkers`: it used to gate nudge-suppression on the wider `w.reportedDone`, which stayed true forever once a worker had ever reported `done` — even after the manager had already consumed that report and sent the worker a follow-up directive. Such a worker would be silently recovered with NO continue-nudge and wrongly counted as "awaiting your review/merge" in the manager's summary, even though it was actually mid-fix on the manager's own follow-up.

The fix narrows the gate to `w.awaitingReview` (see `{@link CrashOrphanedWorker}`): a `done`/`blocked` report the manager has NOT yet acted on. A report the manager already consumed (a subsequent directive delivered against it) reads as NOT `awaitingReview` and gets the SAME ordinary continue-nudge as any other still-working worker — the manager's follow-up is presumably what it's now mid-fix on.

## Do not

- Do not gate crash-recovery nudge suppression (or the "awaiting your review/merge" summary count) on `reportedDone` — it stays true forever and misclassifies a worker whose report the manager already consumed and followed up on.
- Do not assume a done/blocked report is still live without checking `awaitingReview` — a subsequent manager directive against it flips it to false.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `recoverCrashOrphanedWorkers`: line 4838 as of this tranche's HEAD (tranche 14). Introduced by commit `a7cde03ae3`.
