# cfffeda6 — the blocked-worker resume-nudge SENTENCE is written in exactly ONE place, `buildBlockedResumeNudgeBody`

## Narrative

Independent code review of `db05e657` (reviewer `7ee1b828`) found that card had unified the `awaitingReview` PREDICATE (`deriveAwaitingReview`, `report-resolution.ts`) but not the resume-nudge TEXT itself: the "you reported blocked, don't resume as if nothing happened" sentence existed as three independent literal copies across three call sites (the daemon-restart boot path, and the crash boot path's two `cleanStop` variants, in `sessions/service.ts`), so a re-wording on one path could silently drift from the others — each path's own test asserted only a loose `/re-state your blocker/i` match, permissive enough to hide exactly the drift this card family exists to remove.

Card `cfffeda6` extracted the shared sentence into `buildBlockedResumeNudgeBody(prefix, extra)` in `orchestration/resume-nudge.ts` — already the home for `RESUME_NUDGE_TAIL`/`DRAFT_LOSS_NOTE`, shared across the same call sites — so all four (the three original plus the crash-recovery watchdog's isolated-resume path, once `24ed1edc` landed and needed the same text) produce byte-identical text. `prefix` carries everything genuinely specific to the call site (the `[loom:tag]` and the lead-in sentence describing how the daemon/session came back); `extra` is appended after the final period with no separator. The function deliberately does NOT include `RESUME_NUDGE_TAIL` or the draft note — callers append those themselves, since not every call site attaches them the same way (the watchdog path appends `RESUME_NUDGE_TAIL` afterward rather than inline).

By the time this card shipped, `24ed1edc` had already landed and been forced to add a FOURTH literal copy of the same text (measured: `git grep -c "Re-state your blocker"` found 4 copies across 2 files) because this extraction had not yet landed and there was nowhere shared to put it — the card's own thesis (a unified predicate without a unified string just relocates where the next copy appears) playing out in real time between the two cards.

## Do not

- Do not re-word the blocked-worker resume-nudge sentence at any individual call site — edit `buildBlockedResumeNudgeBody` in `orchestration/resume-nudge.ts`, the one place it is written.
- Do not add a new resume-nudge call site with its own literal copy of this sentence — call `buildBlockedResumeNudgeBody` instead.
- Do not rely on a loose `/re-state your blocker/i` regex to catch wording drift between call sites — pin the shared constant/function itself in any new test.

## Source

JSDoc comment above `buildBlockedResumeNudgeBody` in `packages/daemon/src/orchestration/resume-nudge.ts`, lines 115-133 as of this tranche's HEAD (tranche 1). Card merged as commit `3f0c269`. Related: `db05e657`, `24ed1edc`.
