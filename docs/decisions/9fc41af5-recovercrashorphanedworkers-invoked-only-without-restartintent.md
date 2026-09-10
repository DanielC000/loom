# 9fc41af5 — `recoverCrashOrphanedWorkers` runs ONLY when boot captured no `RestartIntent`

## Narrative

Card 9fc41af5 introduced `recoverCrashOrphanedWorkers` as the boot-time crash-recovery ACTION that resumes the candidates `deriveCrashOrphanedWorkers` (`orchestration/crash-orphaned-workers.ts`) derived from the pre-archive `recoverStaleSessions()` snapshot. The caller invokes this function ONLY when no `RestartIntent` was captured this boot — the exit-75 deliberate-restart path already recovers its own fleet (including these same workers) via `resumeFleetOnBoot`, so running both on the same boot would double-nudge the same sessions.

This is the origin of the mutual exclusivity `index.ts`'s boot branch enforces between the two boot-resume paths: exactly one of `resumeFleetOnBoot` (deliberate `daemon_restart`) or `recoverCrashOrphanedWorkers` (crash / OS-restart / clean-stop) runs per boot, keyed on whether a `RestartIntent` was captured. See `9f7c59f1`'s own record for how this relates to the third, always-running path (`CrashRecoveryWatcher.tick`).

`deriveCrashOrphanedWorkers`'s own JSDoc (`orchestration/crash-orphaned-workers.ts`) restates the same motivation at its derivation site, naming the concrete "before" symptom: a genuine crash left those same workers exited and auto-archived (`boot-backstop.ts`) with no non-lossy recovery path — the manager's `worker_list` went empty and it had to re-dispatch the work fresh.

## Do not

- Do not call `recoverCrashOrphanedWorkers` on a boot where a `RestartIntent` was captured (or vice versa) — both recovering the same candidate fleet on one boot double-nudges every affected session.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `recoverCrashOrphanedWorkers`: lines 4811-4816 as of this tranche's HEAD (tranche 14). Introduced by commit `b65d9a5e9d` ("fix(orchestration): recover crash-orphaned workers — boot-reconcile re-parents resumable workers to their live manager"). Also cited (extraction tranche 1) in the JSDoc above `deriveCrashOrphanedWorkers` in `packages/daemon/src/orchestration/crash-orphaned-workers.ts`, lines 22-24 as of this tranche's HEAD.
