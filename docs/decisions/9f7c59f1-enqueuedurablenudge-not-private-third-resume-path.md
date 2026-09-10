# 9f7c59f1 — `enqueueDurableNudge` is NOT `private`: a third resume-and-nudge path reuses it directly

## Narrative

Card 9f7c59f1: `enqueueDurableNudge` (card 597903fc) is deliberately not `private` — it's also wired into `CrashRecoveryDeps.enqueueDurableNudge` (`index.ts`, at `CrashRecoveryWatcher` construction, via an arrow wrapper), so the THIRD resume-and-nudge path (the continuous runtime per-session auto-resume `CrashRecoveryWatcher.tick` performs) reuses this same MCP-seen-gated + durable dispatch instead of the raw `pty.enqueueStdin` it used to call directly. That old direct call was a real, if narrower, instance of the exact silent-loss-on-give-up-exhaustion gap card 597903fc was built to close — `CrashRecoveryWatcher` just hadn't been converged onto the fix yet.

## Do not

- Do not mark `enqueueDurableNudge` `private` — `CrashRecoveryWatcher` (via `CrashRecoveryDeps.enqueueDurableNudge`) depends on calling it directly from outside `SessionService`, and reverting to a raw `pty.enqueueStdin` there reopens the give-up-exhaustion silent-loss gap card 597903fc closed.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `enqueueDurableNudge`: lines 4371-4379, as of this tranche's HEAD (tranche 10).
