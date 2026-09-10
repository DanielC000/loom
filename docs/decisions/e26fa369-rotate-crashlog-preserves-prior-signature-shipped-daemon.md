# e26fa369 — `rotateCrashlog` preserves the shipped daemon's prior crash signature across auto-restart

## Narrative

`rotateCrashlog` moves an existing `crash.log` to `crash.log.prev` (overwriting any older `.prev`) so the SHIPPED end-user daemon — which runs under the OS service manager, NOT the dev/self-host supervisor — preserves the prior crash signature across a crash→auto-restart. Without this, the restarted daemon would overwrite `crash.log` on its next crash and the user would keep only the most recent signature — exactly the crash-loop case the crashlog exists to diagnose.

Called once at boot from `installCrashHandlers`, BEFORE the handlers are installed, so it runs before `writeCrashlog` can lay down a fresh record. It rotates ONLY a crash.log that exists at boot, which makes the two-caller interaction safe: under the dev supervisor, `rotateCrashlog` in `scripts/daemon-supervisor.mjs` already moved crash.log→.prev PRE-LAUNCH, so at daemon boot there is no crash.log left to re-rotate (harmless no-op — no double-rotation, the just-preserved `.prev` is untouched). On the shipped path this daemon-side rotation is the ONLY one and does the job.

## Do not

- Do not remove the only-if-`crash.log`-exists guard on the theory that it's redundant with the supervisor's own pre-launch rotation — the guard is exactly what makes the two callers (this function and `scripts/daemon-supervisor.mjs`'s own `rotateCrashlog()`) safe to both exist without double-rotating or clobbering a preserved `.prev`.
- Do not move this call to run AFTER `installCrashHandlers` wires its handlers — it must run first, or `writeCrashlog` can lay down a fresh `crash.log` before the prior run's record is rotated away.

## Source

JSDoc comment in `packages/daemon/src/crashlog.ts`, above `rotateCrashlog`: originally lines 142-157 (tranche 1). Introduced by commit `e26fa36944f56d989d31ca7385e2264a144f2b1e` ("fix(daemon): rotate crash.log daemon-side at boot so the shipped (supervisor-less) daemon keeps a prior crash record"). Cites no board card; keyed by commit sha per the extraction program's `sha:` grammar.
