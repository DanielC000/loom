# 959a5fb7 — gate the crash-recovery nudge on `awaitingReview`, not the wider `reportedDone`

## Narrative

Card 959a5fb7 (commit `a7cde03ae3`, "fix(sessions): stop claiming a consumed report is awaiting review") fixed `recoverCrashOrphanedWorkers`: it used to gate nudge-suppression on the wider `w.reportedDone`, which stayed true forever once a worker had ever reported `done` — even after the manager had already consumed that report and sent the worker a follow-up directive. Such a worker would be silently recovered with NO continue-nudge and wrongly counted as "awaiting your review/merge" in the manager's summary, even though it was actually mid-fix on the manager's own follow-up.

The fix narrows the gate to `w.awaitingReview` (see `{@link CrashOrphanedWorker}`): a `done`/`blocked` report the manager has NOT yet acted on. A report the manager already consumed (a subsequent directive delivered against it) reads as NOT `awaitingReview` and gets the SAME ordinary continue-nudge as any other still-working worker — the manager's follow-up is presumably what it's now mid-fix on.

**The concrete specimen (`CrashOrphanedWorker`'s own JSDoc, `orchestration/crash-orphaned-workers.ts`):** the restart notice told a manager "1 of your workers already reported done and are awaiting your review/merge" from report EXISTENCE alone — but that same report had already been read and answered with a follow-up directive 68 minutes earlier, and the worker was actively mid-fix on a BLOCKING code-review finding. A manager who trusted the notice would have merged a branch still carrying that defect.

## Accepted narrow race: `stop_worker`/`recycle_begin` resolving a report just before a daemon crash

Same review round (accepted): if a report is "resolved" by `stop_worker`/`recycle_begin` — the manager stopped/recycled the worker — but the daemon dies before that worker session actually exits, `deriveCrashOrphanedWorkers` reads `awaitingReview:false` and the worker gets the ordinary "continue your assigned task" nudge, where before this card it got silence (the old `reportedDone` gate withheld the nudge unconditionally). This ADDS a nudge to a worker that may be on its way out, never a resurrection of a session that's actually gone — `resume()`'s own liveness re-check is what actually stops a genuinely-dead session from receiving anything. Accepted as a strict improvement over the prior silent-parking behavior, not a new risk.

## Do not

- Do not gate crash-recovery nudge suppression (or the "awaiting your review/merge" summary count) on `reportedDone` — it stays true forever and misclassifies a worker whose report the manager already consumed and followed up on.
- Do not assume a done/blocked report is still live without checking `awaitingReview` — a subsequent manager directive against it flips it to false.
- Do not treat the `stop_worker`/`recycle_begin` narrow race as a bug to fix defensively here — `resume()`'s own liveness re-check is the backstop against a genuinely-dead session; this predicate ADDS a nudge, it never resurrects one.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `recoverCrashOrphanedWorkers`: line 4838 as of this tranche's HEAD (tranche 14). Introduced by commit `a7cde03ae3`. The concrete specimen (68-minute gap, the quoted notice text) is cited (extraction tranche 1, no new content beyond the specimen itself) from the JSDoc above `CrashOrphanedWorker` in `packages/daemon/src/orchestration/crash-orphaned-workers.ts`, lines 8-9 as of this tranche's HEAD. The `stop_worker`/`recycle_begin` narrow race is cited (extraction tranche 1) in the JSDoc above `REPORT_RESOLVED_EVENT_KINDS` in `packages/daemon/src/orchestration/report-resolution.ts`, lines 62-64 as of this tranche's HEAD.
