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

## Real-spawn confirmation (card `7306e109`, 2026-10-02)

The original failure this card fixes (`thread/resume failed: no rollout found for thread id <uuid> (code -32600)`) was already real-spawn-proven during this card's own development, but until `7306e109` nobody had watched the FIX itself succeed against a real `codex resume` process — both of this card's own tests (`codex-rollout-archive.mjs`, `codex-resume-archive-restore-chokepoint.mjs`) drive a fixture CLI, never the real one.

`test/codex-rollout-archive-restore-real-spawn.mjs` closes that gap: it spawns one real, authenticated codex conversation, submits one real turn, stops it, moves (by hand — never via the production `archiveOldCodexRollouts` sweep, which must never run against a real, shared `~/.codex`) ONLY that one rollout file into a disposable scratch archive root, then resumes the same conversation (same Loom session id, same cwd, same engine conversation id) through the real `PtyHost.spawn({resumeId}) → createCodexPty` path. Result (2026-10-02, one real trial): `restoreArchivedCodexRollout` moved the rollout back to its exact original live path synchronously, before the real `codex resume <uuid>` child ever ran; that child reached its ready placeholder with no `-32600` and no `"no rollout found"` text anywhere in its captured output; the real `~/.codex` ended the run byte-identical (config.toml hash) and file-identical (rollout back at its original path) to how it started. All 15 checks in that file passed on the first run.

This is an n=1 real-process observation, not a statistical claim — it establishes that the fix mechanism works end-to-end against the real CLI at least once, closing the specific "nobody has watched it succeed" gap `7306e109` was filed to close. It does not supersede or narrow the structural "cannot race" argument above, which remains the actual correctness argument for why no window exists for the two to collide.

**This test is OPT-IN, not a standing gate member** (manager-requested follow-up, 2026-10-02): left to run freely it would spend a real codex conversation on every gate wherever codex is installed, inside a suite already near its 60-minute ceiling, and join the real-spawn family's own measured ~31% per-gate flake rate (card `427590d2`) for no new signal beyond what it already proved once above. It skips by default; re-run it deliberately (e.g. after a codex CLI upgrade) with:

```
LOOM_RUN_CODEX_RESTORE_REAL_SPAWN=1 node packages/daemon/test/codex-rollout-archive-restore-real-spawn.mjs
```
