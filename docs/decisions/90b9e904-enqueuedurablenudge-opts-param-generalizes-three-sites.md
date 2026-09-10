# 90b9e904 — `enqueueDurableNudge`'s optional `opts` param generalizes it for three more resume-and-nudge sites

## Narrative

Card 90b9e904: the optional 5th param `opts` on `enqueueDurableNudge` generalizes it for THREE MORE resume-and-nudge sites — `orchestration/wake.ts` (`WakeService.tick`), `orchestration/poll.ts` (`PollService.fire`), and `orchestration/event-triggers.ts` (`EventTriggerService.fire`, wake mode). Each independently resumes a not-live session and then enqueues, and before this card did so via a bare `pty.enqueueStdin` (event-triggers, which also lacked durability) or the durable-but-ungated `enqueueSystemNudge` (wake/poll) — the exact gap card 9f7c59f1 closed for the crash-recovery path, just unconverged at these three more call sites until now.

All three of the new sites dispatch `kind:"agent"` (a wake note / poll item / matched event is its own turn, never coalesced with anything else queued), and a companion-origin wake also carries a `route` — neither fits this method's original `kind:"warning"` default, hence the `opts` param rather than a hardcoded value. Every pre-existing caller (all `kind:"warning"`, no route) is unaffected: `opts` defaults to `{}`, reproducing the old hardcoded behavior byte-for-byte. Each of the three new call sites wires this in via its own optional injected dep (mirroring `CrashRecoveryDeps.enqueueDurableNudge`'s shape) with a byte-identical raw fallback for every existing hermetic test double that doesn't inject it.

## Do not

- Do not hardcode `kind:"warning"` inside `enqueueDurableNudge` — the wake/poll/event-trigger call sites need `kind:"agent"` (and a companion wake needs `route` too); use the `opts` param, which defaults to `{}` and reproduces the old behavior byte-for-byte for every pre-existing caller.
- Do not skip the optional-injected-dep + byte-identical-raw-fallback shape at a new call site — every existing hermetic test double that doesn't inject the dep must keep working unchanged.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `enqueueDurableNudge`: lines 4380-4394, as of this tranche's HEAD (tranche 10).
