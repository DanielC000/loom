# 3564fd1e — the fleet-wide gate-timeout death spiral fix: TWO decisions, one card id

This record anchors TWO distinct fixes for the SAME 2026-07-21 incident, at two different sites in the
codebase, merged into one record because they share a card id (`decision-records.mjs`'s `resolveRecord`
resolves exactly one record per id, via `.sort()[0]` over candidate filenames — a second `3564fd1e-*.md`
file would silently shadow one of these two decisions rather than adding to them).

## Decision A: per-branch consecutive gate-timeout streak breaks the death spiral

### Narrative

Per-branch consecutive-gate-TIMEOUT streak — the circuit breaker for the fleet-wide gate-timeout death spiral: a genuinely hanging test can never pass no matter how many times the gate re-runs it, and each re-run risks leaking another process-tree survivor even with Decision B's tree-kill fix (below). After `GATE_TIMEOUT_BREAKER_THRESHOLD` consecutive `timedOut` results on the same branch at the same commit, `confirmWorkerMerge`/`runWorkerGate` stop spawning the gate for it (see `checkGateTimeoutBreaker`) and report a distinct "likely hanging test" failure instead.

In-memory only, daemon-uptime-scoped: it only needs to survive long enough to break a live spiral. A restart resetting it is an acceptable cold-start cost, not a correctness gap (worst case: one extra timeout before it re-trips) — not worth a DB table for a transient host-load guard.

Keyed by branch, not workerSessionId: the failure is a property of the branch's CODE, so a worker resume/recycle on the same branch inherits the trip rather than getting a fresh budget for free. The tracked `sha` records the worktree HEAD the streak was last observed against; `checkGateTimeoutBreaker` clears the whole entry once that HEAD advances — a new commit is the plausible fix, so the breaker must give it a clean slate rather than locking the branch out for the rest of the daemon's uptime.

### Do not

- Do not persist this streak to the DB — it is deliberately in-memory, daemon-uptime-scoped; a restart resetting it (one extra timeout before re-trip) is an accepted cost, not a gap to fix.
- Do not key this streak by `workerSessionId` — it must stay keyed by branch, so a resume/recycle on the same failing branch inherits the trip instead of getting a fresh budget.
- Do not clear the streak on anything but the worktree HEAD advancing — a new commit is the plausible fix; nothing else should give the branch a clean slate.

### Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the `gateTimeoutStreak` field doc, `SessionService`): originally lines 1856-1873, as of tranche 7's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## Decision B: kill the whole process TREE, not just the shell

### Narrative

`killGateProcessTree` force-kills a gate step's process TREE, not just the shell `spawn` returned as `child`. Root cause of the SAME 2026-07-21 fleet-wide gate death spiral Decision A above also fixes: `shell:true` makes `child` a `cmd.exe` (win32) or `sh`/`bash` (posix) whose DESCENDANTS — e.g. `pnpm` → `vitest` → a forked test-worker pool — a plain `child.kill()` never reaches. A gate timeout used to kill only that shell, leaving its grandchildren running immortally; repeated timeouts/retries against the same hanging test each leaked another survivor, and by the time enough had accumulated the host itself saturated, starving every OTHER project's gate into timing out too.

Platform-specific mechanism: on win32, `taskkill /pid <child.pid> /T /F` kills the whole subtree rooted at the shell. On posix, the step is spawned with `detached:true`, making `child.pid` the process GROUP id — `process.kill(-pid, "SIGKILL")` signals the whole group, not just the shell. A plain `process.kill(pid, "SIGKILL")` here would reproduce the SAME leak on posix. This is a DELIBERATE choice, not the accidental gap `killProcessById` (`pty/host.ts`) has on ITS posix branch — that function is fine for its own use (a worktree-path reap), where a survivor left behind is caught by the NEXT sweep regardless of which single pid was targeted; a gate timeout has no such backstop inside `gate-runner.ts` — only the caller's own worktree-path sweep (see `sessions/service.ts`) does, and only as a belt-and-suspenders catch for whatever already detached before THIS kill lands.

`killGateProcessTree` resolves once the kill has been ISSUED (awaits the win32 `taskkill` helper's own exit, so a caller can treat the tree as gone once this settles) — best-effort: an already-exited pid is a silent no-op.

### Do not

- Do not kill only the shell process (`child.kill()`/a bare pid signal) — its descendants (pnpm/vitest/forked workers) survive and accumulate, eventually saturating the host for every project's gate.
- Do not use a plain `process.kill(pid, "SIGKILL")` on posix — it must be `process.kill(-pid, "SIGKILL")` against the process GROUP id, which requires the step to have been spawned with `detached:true`.

### Source

JSDoc comment in `packages/daemon/src/orchestration/gate-runner.ts`, above `killGateProcessTree`: originally lines 878-897, as of gate-runner.ts tranche 1's HEAD. Relocated by card `b80a2d76` (gate-runner.ts tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. Folded into this pre-existing Decision A record (rather than kept as a separate file) by the same card, after the merge-time discovery that `resolveRecord`'s `.sort()[0]` resolution means only one `3564fd1e-*.md` file can ever be live — see `docs/decisions/` convention notes.
