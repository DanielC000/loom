# 5d8dea5f — `RESUME_NUDGE_TAIL` drops the bare-"Continue" disclaimer; the daemon sends exactly ONE resume turn

## Narrative

Card 5d8dea5f removed a paragraph from the shared `RESUME_NUDGE_TAIL` (`orchestration/resume-nudge.ts`)
that used to disclaim the engine's own bare "Continue from where you left off." auto-submit — an empty
artifact `claude --resume` emits before the daemon's own `[loom:daemon-restarted]` nudge for an
interrupted transcript. That disclaimer is gone because it is no longer needed: the daemon contributes
EXACTLY ONE resume turn (the `[loom:daemon-restarted]` nudge itself), and that single turn IS the
authoritative resume context — there is nothing left for the agent to reconcile against, so spending a
sentence explaining away an engine artifact was pure noise. Removing it keeps the resume system-message
focused on the two engine-state-reset facts that DO still need disclosing: file-read tracking was reset
(re-Read before Edit), and terminal-tied background shells were killed (a deliberately-detached child,
e.g. the tracked dev-server helper, can still survive — card `0edda303` corrected an earlier
unqualified version of that second claim).

## Do not

- Do not reintroduce a disclaimer about the engine's bare "Continue" auto-submit in the resume nudge tail
  — the daemon's own nudge is the one authoritative resume turn; there is nothing to reconcile it
  against.
- Do not claim the daemon enqueues a standalone bare-continue turn anywhere in the boot-resume path — it
  never does; every resume gets exactly the one `[loom:daemon-restarted]` nudge (or silence, per
  `b5664b5b`).

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`: lines 4420-4421,
as of this tranche's HEAD (tranche 11). Also anchored (extraction tranche 1) at its original, fuller-
narrative site: JSDoc comment above `RESUME_NUDGE_TAIL` in `packages/daemon/src/orchestration/
resume-nudge.ts`, lines 34-40 as of that tranche's HEAD — the `service.ts` copy above is the shorter,
secondary citation.
