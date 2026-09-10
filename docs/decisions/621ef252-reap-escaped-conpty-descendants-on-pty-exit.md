# 621ef252 — Reap orphaned pty descendants at `onExit`, the one chokepoint every exit path shares

## Narrative

`reapOrphanedDescendants` (`pty/host.ts`) is a best-effort reap of any descendant process a torn-down
pty's root process leaves behind — the backstop for a child that ESCAPES node-pty's own orphan-free
containment (its conpty kill path walking `_getConsoleProcessList()` on Windows — not a Job Object,
node-pty@1.1.0 has none — or a process-group kill on POSIX) by detaching into its own process
group/session. The motivating case: a `pnpm dev` vite dev-server the agent backgrounds via its own Bash
tool while verifying UI work (Web-Designer/QA workers), which then outlives the session and walks the
port range — board card 621ef252 observed **six stale vite servers** from this class of leak.

Called from the pty's `onExit` — the ONE chokepoint every exit path shares (a graceful/hard stop, a
recycle's predecessor stop, or an unexpected crash) — so it's DURABLE: it runs even when the root process
died without going through `PtyHost.stop()` at all.

By the time this runs the root process is ALREADY DEAD (`onExit` only fires after exit), which rules out
`taskkill /T` on Windows — verified empirically that it refuses to walk the descendant tree once the
given PID is no longer a running process (it just errors "process not found" and stops). What DOES still
work: a process's `ParentProcessId` is stamped at CREATION and stays queryable via WMI/CIM long after the
parent has exited (verified). So the reap enumerates the FULL process list itself — Windows via
`Get-CimInstance Win32_Process` (CIM, not the deprecated `wmic`), POSIX via `ps -eo pid,ppid` — walks the
descendant tree from `rootPid` in-process, and force-kills each survivor directly: each survivor is
already confirmed a live pid by appearing in the enumerated snapshot, so a plain `process.kill` suffices
— no further tree tool is needed on top of it.

Fire-and-forget: spawns a helper process asynchronously and never throws or blocks the caller. A missing
OS tool, an empty process list, or a pid already gone is a silent no-op. Narrow accepted race: OS PID
reuse could in principle attribute an unrelated process's children to a long-dead `rootPid` — the same
class of risk already accepted elsewhere in Loom for pid-keyed process tracking. That SAME reuse race can
also fabricate a parent-map CYCLE (e.g. `A.ppid=B` and `B.ppid=A`) — impossible in a real process tree
but reachable via a reused pid — so the walk tracks a `seen` set and never revisits a pid; without it a
cycle would spin the walk loop forever and freeze the daemon's event loop (the sweep runs synchronously
in-process on the helper's `close` event, not inside the spawned helper itself).

## Do not

- Do not rely on `taskkill /T` for this — it cannot walk a descendant tree once the root PID is already
  dead, which is always true by the time `onExit` fires.
- Do not skip the `seen`-pid guard when walking the parent map — a PID-reuse race can fabricate a cycle
  that would otherwise spin forever and freeze the daemon's event loop.
- Do not treat this as a Job Object equivalent — node-pty@1.1.0 has none; this reap is the backstop for
  exactly what its own containment misses.

## Source

Inline doc comment above `reapOrphanedDescendants` in `packages/daemon/src/pty/host.ts`, introduced by
commit `59e7e7d199` ("fix(sessions): tear down a worker's dev-server (pnpm dev) on session end/recycle —
leaked servers exhaust the port range"), as of main `afce859a`.
