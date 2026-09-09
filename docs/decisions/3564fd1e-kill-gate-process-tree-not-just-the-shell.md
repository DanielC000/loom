# 3564fd1e — a gate timeout must kill the whole process TREE, not just the shell `spawn` returns

## Narrative

`killGateProcessTree` force-kills a gate step's process TREE, not just the shell `spawn` returned as `child`. Root cause of card 3564fd1e (the 2026-07-21 fleet-wide gate death spiral): `shell:true` makes `child` a `cmd.exe` (win32) or `sh`/`bash` (posix) whose DESCENDANTS — e.g. `pnpm` → `vitest` → a forked test-worker pool — a plain `child.kill()` never reaches. A gate timeout used to kill only that shell, leaving its grandchildren running immortally; repeated timeouts/retries against the same hanging test each leaked another survivor, and by the time enough had accumulated the host itself saturated, starving every OTHER project's gate into timing out too.

Platform-specific mechanism: on win32, `taskkill /pid <child.pid> /T /F` kills the whole subtree rooted at the shell. On posix, the step is spawned with `detached:true`, making `child.pid` the process GROUP id — `process.kill(-pid, "SIGKILL")` signals the whole group, not just the shell. A plain `process.kill(pid, "SIGKILL")` here would reproduce the SAME leak on posix. This is a DELIBERATE choice, not the accidental gap `killProcessById` (`pty/host.ts`) has on ITS posix branch — that function is fine for its own use (a worktree-path reap), where a survivor left behind is caught by the NEXT sweep regardless of which single pid was targeted; a gate timeout has no such backstop inside this file — only the caller's own worktree-path sweep (see `sessions/service.ts`) does, and only as a belt-and-suspenders catch for whatever already detached before THIS kill lands.

`killGateProcessTree` resolves once the kill has been ISSUED (awaits the win32 `taskkill` helper's own exit, so a caller can treat the tree as gone once this settles) — best-effort: an already-exited pid is a silent no-op.

## Do not

- Do not kill only the shell process (`child.kill()`/a bare pid signal) — its descendants (pnpm/vitest/forked workers) survive and accumulate, eventually saturating the host for every project's gate.
- Do not use a plain `process.kill(pid, "SIGKILL")` on posix — it must be `process.kill(-pid, "SIGKILL")` against the process GROUP id, which requires the step to have been spawned with `detached:true`.

## Source

JSDoc comment in `packages/daemon/src/orchestration/gate-runner.ts`, above `killGateProcessTree`: originally lines 878-897, as of this tranche's HEAD. Relocated by card `b80a2d76` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
