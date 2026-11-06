# c5b4dbfb — swallow the test-guard lineage refusal at the onExit reap chokepoint

`PtyHost.reapExitedDescendants` is called fire-and-forget from both pty `onExit` handlers. Under `LOOM_TEST` with a test spawn registry, `assertReapTargetIsOwnLiveDescendantUnderTest` throws a lineage refusal ("not a live descendant of this test process"). That throw escaped as an unhandled rejection and killed the whole test process (exit 1, no FAIL line) in `mcp-config-secret-lifecycle.mjs`, where a fake-claude `.cmd` wrapper dies (0xC000013A) and orphans its node child. The `AttachConsole failed` lines are unrelated stderr noise from node-pty's console-list helper (10-12 per run, pass or fail).

**Measured rate, honestly:** the crash was seen in 1 of 15 and 1 of 30 solo runs. Two small samples; no rate estimate beyond "roughly 3-7% with a very wide interval" is supportable.

## Mechanism: UNATTRIBUTED

An earlier version of this record said the refused pid was a descendant orphaned by its dead parent. That does not follow from the code. The guard is called only on `rootPid`, never on a descendant, and a dead registered root returns `true` (`!isLiveNow && wasSpawnedByThisTestProcess`). So the refused pid must have been either LIVE at the guard's enumeration and not provably ours, or unregistered. Candidates, none verified:

- pid reuse of the root's number by an unrelated process before the guard's enumeration (no creation time was available to prove it);
- an early `onExit` while the root was still alive (a ConPTY quirk);
- a root that was never in the test spawn registry.

The swallow does not depend on which one it is: the refusal already prevents the kill.

## Decision

The lineage refusal gets its own `code` (`LOOM_REAP_TEST_GUARD_LINEAGE_REFUSED`). The exit chokepoint catches only that code and the existing enumeration-failure code; for the lineage one it logs `lineage refusal at exit reap; nothing was killed` (pid + session id only). The refusal still prevents the kill.

Detection is kept without the crash:

- `refuseReapTarget` bumps `globalThis.__LOOM_TEST_REAP_LINEAGE_REFUSALS__` when it throws the lineage code. That is the ONE chokepoint, so root-verify's lineage refusals (`verifyRootDeadOrForceKill`'s sweep and `killSingleProcessById`, already swallowed by their own `.catch`) are counted too.
- `test/_guard.mjs` initialises the tally to 0 and its `process.on("exit")` hook prints one loud `[test-guard] LINEAGE REFUSALS: N` line when it is nonzero. It never changes the exit code.
- `dev-server-teardown.mjs` asserts the tally is 0 (it pushes real registered pids through the real reap path).

This reverses b1ea823d's "a lineage refusal at this chokepoint must still propagate" (b1ea823d's record is amended to say so): that loudness only ever crashed the process.

## Do not
- Do not catch broadly at the chokepoint: every error other than these two codes must still propagate (G2b pins it).
- Do not match the refusal by message text.
- Do not make the swallow reachable outside test mode: the throw is gated by `inTestMode()` plus a registry, so production is unchanged.
- Do not make the refusal kill anything to "compensate" for the swallow.
- Do not bump the tally anywhere but `refuseReapTarget`, and do not make the exit hook fail the process.
