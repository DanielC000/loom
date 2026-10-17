# 914c9363 — scenario B4's guard enumeration is fabricated, not real, and why that's not a weakening

Card `914c9363` (epic `24608d33`): `pty-root-reap-test-tripwire.mjs` scenario (B4) calls the real,
exported `reapOrphanedDescendants` directly (not through the `onExit` chokepoint) on a genuinely live
spawned pid. Under real gate load, that call's own `assertReapTargetIsOwnLiveDescendantUnderTest` guard
runs a REAL `powershell.exe` enumeration (`enumerateLivePidPpidRowsForTestGuard`) which can ETIMEDOUT —
and because `refuseReapTarget` throws fail-closed whenever the calling process has a test-spawn registry
(decision `b1ea823d`), that failure crashes the whole test file. Seen twice in one day (lead gen 421 on
main `6c046aeb`, env-unset; worker `53f2d52d` under `LOOM_DEV=1` with the gate cap saturated).

## Why the guard's own enumeration isn't B4's subject

B4a/B4b's own header comment, and their originating decision record (`85ae7768`, "MINOR 2 (CR
85360986)"), both state the scenario's actual point: proving `computeOrphanSweepPlan`'s live-root-abort
↔ walk AGREEMENT-check transition via the injected `deps.enumerate` seam, compared against a REAL
win32-captured creationTime (`awaitRootCreationCapture`). Neither source says anything about needing the
GUARD's own real-OS enumeration to succeed.

But `reapOrphanedDescendants` calls that guard UNCONDITIONALLY, before `deps.enumerate` is ever reached
(`pty/host.ts`, `assertReapTargetIsOwnLiveDescendantUnderTest(rootPid, ...)` ahead of the `sweep`
closure). That call is a structural precondition every direct `LOOM_TEST` call makes — not something B4
itself is testing. It's this guard's own real spawn, not B4's actual target, that flakes under load.

## Scenario (A, positive control) is the unpatched coverage

The real-guard-enumeration-plus-ancestry path, exercised against a genuinely live descendant with an
UNPATCHED `execFileSync`, is already independently proven elsewhere in this same file: scenario "(A,
positive control)" calls `reapOrphanedDescendants(realChildPid)` through the real guard and asserts it
does not throw. Fabricating B4's guard enumeration loses no coverage — that path stays proven, for real,
right above it.

## The G1/G2/G3/H precedent

This file already monkeypatches `cp.execFileSync` to feed the guard's own enumeration a fabricated,
deterministic snapshot for exactly this reason, in scenarios G1/G2/G3 (feeding `reapExitedDescendants`'s
`onExit` chokepoint) and H (a direct call, the closest structural match to B4). G2's own comment states
the rationale verbatim: a real `powershell.exe`/`ps` call can itself ETIMEDOUT under the load this card's
epic targets, making an assertion flake for a reason unrelated to what it's checking. B4 adopts the same
technique, just scoped to a case where the guard must also PASS (prove ancestry + agree on creationTime)
rather than fail or skip.

## Install-after-capture and scope-to-the-two-calls

The patch is installed strictly AFTER `awaitRootCreationCapture(liveRootPid)` has already settled and
`capturedCreationTime` is in hand — the real async win32 CIM capture that arms the test-spawn registry's
creationTime must never itself see the patched `execFileSync` (it has its own independent code path, but
installing the patch before the capture settles would conflate two independently-timed reads for no
reason and make the ordering harder to reason about). The patch is also scoped to wrap ONLY the two
`reapOrphanedDescendants` calls (B4a and B4b) in a `try`/`finally` that restores the original
`execFileSync` (plus `syncBuiltinESMExports()`) immediately after — nothing else in the block (the
capture call, `deps.enumerate`/`deps.kill`, `waitUntil`, which only polls `capturedLines`) goes through
the patched function.

## The row format

Verified against the real parser rather than inferred from G3/H: `parseOrphanSweepLine`
(`pty/win32-root-creation.ts`) matches `/^(\d+)[,\s]+(\d+)(?:[,\s]+(-?\d+))?$/`,
i.e. one line of `pid,ppid,ticks`. `ticks` is raw .NET `DateTime.Ticks` as produced by
`WIN32_SWEEP_FOREACH_BODY`'s own PowerShell one-liner (`.ToUniversalTime().Ticks`), decoded by
`parseWin32SweepTicks` as `Math.round((ticks - 621_355_968_000_000_000) / 10_000)` (epoch-ms). The fix's
fabricated row sets `ppid` to `process.pid` (proving ancestry in one hop, same shape as the unit tests'
`isDescendantPid([{pid:5,ppid:1}],5,1)` case) and `ticks` to `capturedCreationTime * 10_000 +
621_355_968_000_000_000` — an exact integer round trip (ms is always a whole number, so there is no
rounding loss against `ROOT_CREATION_MATCH_TOLERANCE_MS`'s default of 1ms).

## The negative control

Run manually (not committed): with the fix in place, temporarily changed the fabricated row's `ppid` to
`SENTINEL_PID` (wrong ancestry, creationTime left agreeing) via a `git diff`-captured patch +
`git checkout HEAD --`/`git apply` restore (never `git stash`). Result: the guard's real ancestry check
fired against the fabricated row and REFUSED — `reapOrphanedDescendants` threw synchronously inside
B4a's call (uncaught), crashing the file with the same `[pty-reap-test-guard] REFUSED ... not a live
descendant ...` shape as the original bug report, exit code 1. This proves the guard's own branch
genuinely runs against the fabricated row rather than being bypassed or short-circuited by the patch.

## Do not

- Do not install the `execFileSync` patch before `awaitRootCreationCapture(liveRootPid)` has settled —
  the real async win32 capture that arms `capturedCreationTime` must complete against the REAL
  enumeration path it actually uses, untouched by this scenario's own later patch.
- Do not widen the patch's scope beyond the two `reapOrphanedDescendants` calls (B4a/B4b) — in particular,
  never let it leak into the capture call above it or into any other scenario in this file; always
  restore `cp.execFileSync` (plus `syncBuiltinESMExports()`) in a `finally` immediately after those two
  calls, exactly as G1/G2/G3/H already do.
- Do not replace scenario "(A, positive control)"'s unpatched real-guard run with a fabricated one — that
  scenario is the one place in this file that still proves the real `powershell.exe` enumeration plus
  ancestry walk works end-to-end against a genuinely live descendant. B4's fabrication is only safe
  BECAUSE that coverage survives elsewhere.
- Do not hand-derive the row format from G3/H's own usage — read `parseOrphanSweepLine` /
  `WIN32_SWEEP_FOREACH_BODY` (`pty/win32-root-creation.ts`) directly; a hand-copied format can drift from
  the real parser silently.
