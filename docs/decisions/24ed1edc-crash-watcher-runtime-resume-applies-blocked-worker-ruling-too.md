# 24ed1edc — the crash-recovery watchdog's RUNTIME auto-resume applies `db05e657`'s blocked/done ruling too, not just the two boot paths

## Narrative

`db05e657`'s MAJOR 2 unified the blocked/done resume-nudge ruling across the two mutually-exclusive BOOT paths (`resumeFleetOnBoot` vs `recoverCrashOrphanedWorkers`; `index.ts` picks exactly one per boot). `CrashRecoveryWatcher` (`orchestration/crash-recovery-watcher.ts`) is neither — it is the continuous RUNTIME per-session auto-resume that runs on every boot regardless of which boot branch fired, and the ruling had never reached it: a worker that reported `blocked` and then had its pty die (the node-pty ConPTY race `084d1cd4` hardened against) was auto-resumed and told to "continue your assigned task from where you left off" — the exact failure ruling 2 exists to prevent — and the done-awaiting-review case was handled in the OTHER wrong direction (nudged here, silenced at boot).

Fix: reuse the SAME `deriveAwaitingReview(events)` predicate the boot paths already call (the `events` value was already in hand in the same loop body, so this costs zero extra queries) in the watcher's worker-resume branch, and apply the identical done/blocked treatment. This card explicitly does NOT re-derive the ruling — `db05e657` already decided what a `blocked` report means; a third independently-written predicate would be the exact defect this card family exists to remove.

Because the shared-text extraction (`cfffeda6`) had not yet landed when this card shipped, the watcher's own blocked-resume nudge necessarily became a FOURTH literal copy of the sentence — see `cfffeda6` for how that got folded back into one function afterward.

## Do not

- Do not leave the crash-recovery watchdog's runtime auto-resume path unaware of `deriveAwaitingReview` — it is a third path alongside the two boot paths, not a missed spot in either of them.
- Do not re-implement the blocked/done ruling independently for this path — call the shared `deriveAwaitingReview` and apply `db05e657`'s ruling as-is.

## Source

`packages/daemon/src/orchestration/crash-recovery-watcher.ts`, the worker-resume branch around lines 412-439 (JSDoc/inline comments at lines 414-427) — this record does not modify that file (outside this tranche's file fence). Also referenced from the JSDoc above `buildBlockedResumeNudgeBody` in `packages/daemon/src/orchestration/resume-nudge.ts`, lines 116-117, as of this tranche's HEAD (tranche 1). Card merged as commit `d35dfbd`. Related: `db05e657`, `cfffeda6`.
