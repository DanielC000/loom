# 06ebbb78 — `resumeFleetOnBoot` routes every continuation nudge through `enqueueDurableNudge` too

## Narrative

Card 06ebbb78: `resumeFleetOnBoot` now routes ALL of its continuation nudges through `enqueueDurableNudge` (card 597903fc) — the plain, non-durable `enqueueNudge`/`deferredNudge` helpers it used to call are gone. Every boot-resume nudge in the codebase now shares this one durable dispatch, closing the same give-up-exhaustion silent-loss gap for the deliberate-restart (`daemon_restart`) path that card 9f7c59f1 had already closed for the crash-recovery path.

## Do not

- Do not reintroduce `enqueueNudge`/`deferredNudge` (or any other non-durable dispatch) inside `resumeFleetOnBoot` — every continuation nudge it sends must route through `enqueueDurableNudge`, or a give-up exhaustion during a whole-fleet restart silently drops it with nothing but a console line.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `enqueueDurableNudge`: lines 4374-4378, as of this tranche's HEAD (tranche 10).
