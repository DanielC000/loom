# 5172fe3a — `archiveOldCodexRollouts` cannot race `restoreArchivedCodexRollout`

## Do not

- Do not assume a restored rollout's refreshed mtime protects it from a re-archive — a same-device restore (`fs.renameSync`) only changes the directory entry, not the inode's own timestamps, so the file stays "stale" by the archiver's own age filter.
- Do not couple `archiveOldCodexRollouts` to the sessions DB to "fix" this — it isn't needed; see the proof below. If that proof ever stops holding (a second call site is added, or the sweep is moved to run after the listener opens), re-derive this decision rather than assuming it still applies.

## Why it can't race, today

`archiveOldCodexRollouts` has exactly ONE call site in the whole daemon: `index.ts`'s boot sequence. It runs there synchronously (no `await` inside the function itself — every operation is a sync `fs.*Sync` call), strictly BEFORE `startGatewayListeners(...)` binds the port.

`restoreArchivedCodexRollout` has exactly one path that can ever reach it: `PtyHost.createCodexPty`, called only when a codex spawn's argv would include `resume <uuid>` — which itself is only ever reached via `SessionService.resume()` (every automatic resume caller — `resumeFleetOnBoot`, the crash-recovery watcher, webhook ingress, event triggers, companion revive — and the one human REST path all converge on that single method; `forkSession()` refuses codex outright before ever building a resume-shaped spawn, and `worker_revive`'s `fork:true` spread excludes the `resume <uuid>` branch of `buildCodexResumeArgs` regardless of harness).

Nothing can call `SessionService.resume()` before the gateway listener is open — REST, MCP tool calls, and webhook ingress all arrive through that same listener. `resumeFleetOnBoot` itself runs even later in the same boot sequence, after the listener is already open. So within one daemon process's lifetime: the archive sweep runs exactly once, and it always runs strictly before the earliest possible restore. There is no window in which both can be in flight at once.

Structural proof (AST-based ordering, not timing): `test/codex-archive-sweep-precedes-listen.mjs`.

## The one residual this does not cover

A codex child process that somehow survives a daemon restart into the NEXT boot's own sweep (before the new daemon process has any relationship to it) is not ruled out by this argument — that's an orphaned-process window the project already discloses elsewhere (`reapOrphanedDescendants`'s own backstop, and node-pty's lack of a Job Object on Windows). It predates this card and isn't newly introduced by the restore mechanism; `archiveOldCodexRollouts` sweeping a genuinely-still-written-to orphan is a pre-existing risk class, not something `restoreArchivedCodexRollout` makes worse.
