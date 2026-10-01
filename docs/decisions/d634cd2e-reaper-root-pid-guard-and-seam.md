# d634cd2e — `reapOrphanedDescendants` root-pid guard, plus an injectable seam for the shared fake-pty fixture

## Narrative

Review finding M4 (lane b14d3441): `reapOrphanedDescendants(live.pid)` (`pty/host.ts`) ran unconditionally
at the pty's `onExit`, with no check on `rootPid` at all. `test/_seam-host-fixture.mjs`'s shared fake pty
— used by ~279 test files — returns a fixed `pid: 4242` and its `kill()` synchronously fires the real
`onExit` callback registered by `PtyHost.spawn()`/`spawnCodex()`. So every hermetic test using that
fixture's `kill()` ran a REAL `ps -eo pid,ppid` / `Get-CimInstance Win32_Process` enumeration and
SIGKILL-walked the real descendants of whatever pid 4242 happens to be on the host running the test — on
Windows dev boxes 4242 is reliably not a live pid, but a real pid 4242 on Ubuntu CI is entirely plausible,
which would make this a Linux-only flaky/destructive lane (the card 4e762baf class this project already
tracks). Separately, ~29 other test files set a fake `pid: 1` for unrelated reasons; any one of those that
also reached `kill()` would have walked from the kernel/init process and sweep every process the runner
user owns.

Two independent fixes, because they close different gaps:

1. **A structural guard inside `reapOrphanedDescendants` itself** — refuses `rootPid <= 1`, a
   non-integer, or a pid equal to `process.pid`/`process.ppid`, before spawning the enumeration helper at
   all. This is a last-resort backstop against the worst-case roots (pid 0/1/negative, or the daemon's own
   process/parent) reachable from ANY caller, test or production — not scoped to one fixture.
2. **An injectable seam on `PtyHost` itself**, `reapExitedDescendants(rootPid)` — a `protected` instance
   method both `onExit` handlers now call (`this.reapExitedDescendants(live.pid)`) instead of calling the
   free function directly. It defaults to calling the real `reapOrphanedDescendants`, so every existing
   subclass (including `dev-server-teardown.mjs`'s own local `TestPtyHost`, which deliberately wires a
   REAL spawned process's pid through this exact `onExit` path to prove the real reap works end to end) is
   byte-equivalent to the old unconditional call. `test/_seam-host-fixture.mjs`'s `createSeamHost` is the
   ONE place that overrides it to a no-op — closing the actual defect (a fabricated pid like `4242` is >1
   and not the daemon's own pid, so guard (1) alone does not catch it; only the seam can, because only the
   seam knows the pid is fictional).

The guard and the seam are deliberately NOT redundant: the guard protects every caller against a narrow
set of catastrophic root pids; the seam protects the specific population of tests whose fake pid is
plausible-but-fictional and would otherwise pass the guard cleanly.

Scope note: a further ~28 test files (besides `_seam-host-fixture.mjs`) independently define their own
local `class X extends PtyHost` with a hardcoded `pid: 4242` fake, bypassing the shared fixture entirely —
discovered during this fix but out of this card's scope (card d634cd2e named the shared fixture
specifically). Those carry the same theoretical CI-collision risk and are a candidate follow-up card.

## Do not

- Do not treat the `rootPid` guard in `reapOrphanedDescendants` as sufficient on its own — it only catches
  `<= 1`/non-integer/`process.pid`/`process.ppid`; a plausible fictional pid (e.g. a fixture's `4242`)
  passes it cleanly and must be kept out at the `reapExitedDescendants` seam instead.
- Do not add a default no-op to `reapExitedDescendants` itself — production, and any test that
  deliberately wires a REAL process through the `onExit` path (e.g. `dev-server-teardown.mjs`), depend on
  the default being the real reaper.
- Do not override `reapExitedDescendants` anywhere outside `test/_seam-host-fixture.mjs` without a reason
  as strong as this one — a test that wires a real process through this path (to prove the real reap
  works) must NOT override it to a no-op, or it silently stops testing anything.

## Source

`packages/daemon/src/pty/host.ts` (`reapOrphanedDescendants`, `PtyHost.reapExitedDescendants`),
`packages/daemon/test/_seam-host-fixture.mjs`, discovered-from review lane `b14d3441`, finding M4.
