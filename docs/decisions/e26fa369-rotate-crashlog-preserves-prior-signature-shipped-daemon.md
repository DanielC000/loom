# e26fa369 — `rotateCrashlog` preserves the shipped daemon's prior crash signatures across auto-restart

## Narrative

`rotateCrashlog` shifts an existing `crash.log` through numbered generations (`crash.log.1` newest .. `crash.log.5` oldest, card `9c8ce2b2`) so the SHIPPED end-user daemon — which runs under the OS service manager, NOT the dev/self-host supervisor — preserves the last several crash signatures across repeated crash→auto-restart cycles. Without this, the restarted daemon would overwrite `crash.log` on its next crash and the user would keep only the most recent signature — exactly the crash-loop case the crashlog exists to diagnose. (Before card `9c8ce2b2`, this rotated to a single `crash.log.prev` slot, which could hold only ONE prior crash — a second crash before anyone read `.prev` destroyed the first, which is what actually happened on 2026-09-16 and is why this now retains N=5.)

Called once at boot from `installCrashHandlers`, BEFORE the handlers are installed, so it runs before `writeCrashlog` can lay down a fresh record. It rotates ONLY a crash.log that exists at boot, which makes the two-caller interaction safe: under the dev supervisor, `rotateCrashlog` in `scripts/daemon-supervisor.mjs` already rotated crash.log through the same numbered generations PRE-LAUNCH, so at daemon boot there is no crash.log left to re-rotate (harmless no-op — no double-rotation, the already-rotated generations are untouched). On the shipped path this daemon-side rotation is the ONLY one and does the job.

## Do not

- Do not remove the only-if-`crash.log`-exists guard on the theory that it's redundant with the supervisor's own pre-launch rotation — the guard is exactly what makes the two callers (this function and `scripts/daemon-supervisor.mjs`'s own `rotateCrashlog()`) safe to both exist without double-rotating or clobbering already-rotated generations.
- Do not move this call to run AFTER `installCrashHandlers` wires its handlers — it must run first, or `writeCrashlog` can lay down a fresh `crash.log` before the prior run's record is rotated away.
- Do not let `CRASHLOG_MAX_GENERATIONS` drift between this file and `scripts/daemon-supervisor.mjs`'s duplicate constant — the two functions must rotate to the SAME depth or one path's boot-time view of "how many priors exist" disagrees with the other's.

## Source

JSDoc comment in `packages/daemon/src/crashlog.ts`, above `rotateCrashlog`: originally lines 142-157 (tranche 1). Introduced by commit `e26fa36944f56d989d31ca7385e2264a144f2b1e` ("fix(daemon): rotate crash.log daemon-side at boot so the shipped (supervisor-less) daemon keeps a prior crash record"). Cites no board card; keyed by commit sha per the extraction program's `sha:` grammar. Updated for numbered-generation rotation by card `9c8ce2b2`.
