# 547fcaaa — the worker boot-resume nudge no longer asserts unconditional worktree integrity

## Narrative

Card 547fcaaa corrected an over-claim in the wording of the worker boot-resume nudge. The nudge
previously read as asserting (or was interpreted as asserting) that the worker's worktree had been
verified intact across the restart. In fact `resumeFleetOnBoot` never checked worktree integrity at
all — no such check exists anywhere in the boot-resume path. The nudge text was corrected to a plain
"re-check your worktree's state, continue your task" instruction: it asks the worker to verify for
itself, rather than implying the daemon already did.

## Do not

- Do not reintroduce wording in the worker boot-resume nudge that implies the daemon verified worktree
  integrity on resume — it does not check this; the nudge only tells the worker to re-check its own
  worktree state.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`: lines 4398-4399,
as of this tranche's HEAD (tranche 11).
