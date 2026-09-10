# 06ebbb78 — `resumeFleetOnBoot` routes every continuation nudge through `enqueueDurableNudge` too

## Narrative

Card 06ebbb78: `resumeFleetOnBoot` now routes ALL of its continuation nudges through `enqueueDurableNudge` (card 597903fc) — the plain, non-durable `enqueueNudge`/`deferredNudge` helpers it used to call are gone. Every boot-resume nudge in the codebase now shares this one durable dispatch, closing the same give-up-exhaustion silent-loss gap for the deliberate-restart (`daemon_restart`) path that card 9f7c59f1 had already closed for the crash-recovery path. This card RULED the old split accidental, not a considered asymmetry: card 597903fc's own stated rationale for adding durability to the crash path ("a boot-time notice ... must not vanish ... exactly the contended moment [give-up exhaustion] is most likely") applies at least as strongly here — a whole-fleet `daemon_restart` is at least as contended as a crash-orphaned recovery, and it is the MORE common path (it runs after every deliberate `daemon_restart`, i.e. every self-hosting deploy), yet card 9f7c59f1 (which converged the other two paths) had left this one on the old, non-durable dispatch — no comment anywhere ever claimed that split was deliberate.

Worker nudges pass the worker's own `taskId` (mirroring `recoverCrashOrphanedWorkers`'s worker-branch calls); every other role omits it (defaults to `null`), also mirroring that function's manager-notice call.

**CORRECTED** (was wrong in the first draft of this card): a freshly-resumed session's pty is NEVER `ready` this early (`pty/host.ts`'s `live.ready` gate — SessionStart hasn't fired yet), so EVERY continuation nudge dispatched here is ALWAYS held and therefore ALWAYS persists a fresh `session_message_queued` record — this is the COMMON case, not the rare one. That in turn means `recoverUndeliveredMessagesOnBoot` (`index.ts`, run right after this function in the SAME boot with no `await` between them) would otherwise find that just-minted record and redrive it AGAIN — a real, reproduced duplicate delivery (a follow-up to this same card). `recoverUndeliveredMessagesOnBoot`'s `mintedBefore` cutoff (`index.ts` passes its own `bootStartedAt`) is what actually guarantees single delivery: it skips any undelivered record minted during THIS boot's own resume pass, since such a record already has a live in-memory FIFO entry from its own dispatch and needs no help. A record genuinely predating this boot (a real crash/sender-death leftover) is unaffected and still redrives normally.

## Do not

- Do not reintroduce `enqueueNudge`/`deferredNudge` (or any other non-durable dispatch) inside `resumeFleetOnBoot` — every continuation nudge it sends must route through `enqueueDurableNudge`, or a give-up exhaustion during a whole-fleet restart silently drops it with nothing but a console line.
- Do not assume a freshly-resumed session's pty could ever be `ready` at the moment this function enqueues — it never is this early, so every nudge here always takes the held/durable path, never the immediate one.
- Do not change `recoverUndeliveredMessagesOnBoot`'s `mintedBefore` cutoff (or call it before this function, or with an `await` between them) without checking for the exact duplicate-delivery bug this ordering prevents: a record minted during this same boot's resume pass must be skipped, not redriven again.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `enqueueDurableNudge`: lines 4374-4378, as of this tranche's HEAD (tranche 10). Extended section's source: JSDoc comment above `resumeFleetOnBoot`, lines 4341-4368, as of this tranche's HEAD (tranche 11).
