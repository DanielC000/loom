# db05e657 — a recovered `blocked` worker gets its own re-state-your-blocker nudge, tallied apart from `done`

## Narrative

Card db05e657 (DoD-1, commit `8bf8f8c2` "fix(orchestration): unify awaitingReview and fix the blocked-worker nudge") ruled the two `awaitingReview` sub-cases in `recoverCrashOrphanedWorkers` differently, on top of the shared `959a5fb7` exclusion: a `done` report gets NO nudge at all (silence is correct — it's genuinely just awaiting merge review), but a `blocked` report gets a DISTINCT nudge reminding the worker to re-state its blocker to its manager. The generic continue-nudge would tell a worker that structurally CANNOT continue to do exactly that, and staying silent (the `done` treatment) would leave the worker that most needs its manager indistinguishable from one correctly waiting.

**Two blocking gaps found on review (MAJOR 1/2, commit `f5b0dc7c8`):**
- **MAJOR 1:** the per-manager crash-recovery summary sentence still unconditionally said "reported done ... awaiting your review/merge" even for a worker whose only report was `blocked`, telling the manager there was something to merge when nothing was reported done. Fixed by splitting the single `awaitingReviewCount` into `awaitingReviewDoneCount`/`awaitingReviewBlockedCount`, each worded correctly in the summary.
- **MAJOR 2:** ruling 2 (the distinct blocked nudge) was wired ONLY into the crash-recovery boot path (`recoverCrashOrphanedWorkers`). `resumeFleetOnBoot` — the OTHER, mutually exclusive boot-resume path (`index.ts` picks exactly one per boot; see `9fc41af5`) — never consulted report state at all, so a `blocked` worker resumed via a `daemon_restart` got the same generic "continue your assigned task" text ruling 2 says it must not get. Fixed by applying ruling 2 there too, via the SAME shared `deriveAwaitingReview` (`orchestration/report-resolution.ts`) both boot paths now call, so a blocked worker gets identical treatment regardless of which boot-resume path recovered it.

Both boot paths deliberately do NOT silence the `done`-awaiting-review case identically — `959a5fb7` only ever touched the crash path; widening it to `resumeFleetOnBoot` was carded separately as the broader two-path convergence (see `9f7c59f1`/`90b9e904`/`06ebbb78`) rather than folded into this card's scope.

## Do not

- Do not give a recovered `blocked` worker the generic continue-nudge, and do not silence it either — it needs its own "re-state your blocker" nudge.
- Do not fold a `blocked`-only recovery into the `done`-worded "awaiting your review/merge" summary sentence — tally `awaitingReviewDoneCount`/`awaitingReviewBlockedCount` separately.
- Do not apply the blocked/done nudge distinction to only one of the two mutually-exclusive boot-resume paths — both must consult `deriveAwaitingReview` identically.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `recoverCrashOrphanedWorkers`: lines 4838-4849 as of this tranche's HEAD (tranche 14). Introduced by commit `8bf8f8c2`; MAJOR 1/2 review fixes landed in commit `f5b0dc7c8`.
