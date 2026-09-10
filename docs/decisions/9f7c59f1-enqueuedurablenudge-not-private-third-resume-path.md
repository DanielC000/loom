# 9f7c59f1 — `enqueueDurableNudge` is NOT `private`: a third resume-and-nudge path reuses it directly

## Narrative

Card 9f7c59f1: `enqueueDurableNudge` (card 597903fc) is deliberately not `private` — it's also wired into `CrashRecoveryDeps.enqueueDurableNudge` (`index.ts`, at `CrashRecoveryWatcher` construction, via an arrow wrapper), so the THIRD resume-and-nudge path (the continuous runtime per-session auto-resume `CrashRecoveryWatcher.tick` performs) reuses this same MCP-seen-gated + durable dispatch instead of the raw `pty.enqueueStdin` it used to call directly. That old direct call was a real, if narrower, instance of the exact silent-loss-on-give-up-exhaustion gap card 597903fc was built to close — `CrashRecoveryWatcher` just hadn't been converged onto the fix yet.

## Do not

- Do not mark `enqueueDurableNudge` `private` — `CrashRecoveryWatcher` (via `CrashRecoveryDeps.enqueueDurableNudge`) depends on calling it directly from outside `SessionService`, and reverting to a raw `pty.enqueueStdin` there reopens the give-up-exhaustion silent-loss gap card 597903fc closed.
- Do not assume the three resume-and-nudge paths this card converged onto `enqueueDurableNudge` share every other behavior — see the second section below; only durability + the MCP-seen gate are the shared facet.

## Which of the three paths `resumeFleetOnBoot` is, and what is (and isn't) shared

`resumeFleetOnBoot` (`sessions/service.ts`) is the DELIBERATE-RESTART (`daemon_restart`) instance of the three paths this card converged. It is strictly mutually exclusive per boot with `SessionService.recoverCrashOrphanedWorkers` (the crash / OS-restart / clean-stop path) — `index.ts`'s boot branch runs exactly one of the two, never both. The third, `CrashRecoveryWatcher.tick`, is a continuous RUNTIME per-session auto-resume that runs on every boot regardless of which of the other two fired, recovering an isolated session that died while the daemon stayed healthy.

All three answer genuinely different questions, so they are NOT expected to converge on everything — `report-resolution.ts`'s own header doc already tells this exact "three read as exhaustive and wasn't" story once (card `cfffeda6`); don't repeat "three" here as a completeness claim. Differences are ruled per-facet, never assumed to be bugs:

- **Report-state handling (`blocked`/`done`):** CONVERGED — all three call the same `deriveAwaitingReview` (`report-resolution.ts`) and give a `blocked` worker its own re-state-your-blocker nudge; a `done` worker gets SILENCE (nothing left for it to continue). `merge_rejected` never resolves a report, for all three, by that same shared predicate.
- **Worker nudge text (`blocked` case):** CONVERGED — all three build from the shared `buildBlockedResumeNudgeBody` (`orchestration/resume-nudge.ts`).
- **Durability of the enqueue itself:** CONVERGED, per this card and `06ebbb78`/`90b9e904`.
- **Ordering:** DELIBERATELY NOT converged, for a documented reason. `resumeFleetOnBoot` resumes everyone EXCEPT the requesting manager first, then the requester LAST (its own summary nudge needs the rest of the fleet's resume outcome, e.g. `failed.length`, already computed). `recoverCrashOrphanedWorkers` resumes each candidate's MANAGER before its own workers (a worker's manager must be live before the worker un-archives into a parent that can see it). `CrashRecoveryWatcher` has no cross-session ordering at all — it recovers one isolated dead session per candidate, with no "fleet" or "manager-then-workers" concept to order.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `enqueueDurableNudge`: lines 4371-4379, as of this tranche's HEAD (tranche 10). Second section's source: JSDoc comment above `resumeFleetOnBoot`, lines 4316-4335 and 4369-4375, as of this tranche's HEAD (tranche 11).
