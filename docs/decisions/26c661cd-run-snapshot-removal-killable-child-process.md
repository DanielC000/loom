# 26c661cd — Run-snapshot removal moved off retry loops, onto a killable child process

## Narrative

### `removeRunSnapshot` (per-session teardown)

The prior implementation retried a hung `fs.promises.rm` up to 40× — a genuinely WEDGED directory handle never lets that promise settle at all, so the retries never even start; the call just occupies a libuv threadpool slot (default pool size 4) FOREVER, invisibly, since this is fire-and-forget (`void removeRunSnapshot(...)` at `sessions/service.ts`) and the fallback warning was therefore unreachable in exactly the case that mattered.

This is a `bd9fc808`-shaped fix: it adopts `removeWorktree`'s already-proven, already-tested shape (`git/worktrees.ts`, `killableRemoveDir`) — the removal runs in a SEPARATE OS process (a wedged handle blocks only that child, never a daemon thread) and is force-killed on timeout; the outer `withTimeout` additionally fails SAFE to `killed:true` if the (real or injected) `removeDir` seam itself never settles, so a hang is NEVER retried in a loop here — a genuinely wedged dir is simply left on disk for the next boot sweep, and (since `killableRemoveDir` always resolves) the warning is now reachable even in the wedged case, closing the "unreportable by construction" gap the old retry loop had.

### `sweepAllRunSnapshots` (boot sweep)

The prior implementation was `fs.rmSync(..., { maxRetries: 10, retryDelay: 100 })` — SYNCHRONOUS on the main thread, so a single wedged dir at boot blocked the ENTIRE daemon (every request, every session) for up to its full retry budget before anything could be served.

This is now async and uses the same `killableRemoveDir`-backed bound as `removeRunSnapshot` (a separate OS process per removal, force-killed on timeout), and — deliberately — the caller (`reconcileRunsOnBoot`) fires this WITHOUT awaiting it: boot must never block on a stubborn dir, so a wedge here is simply skipped-and-deferred to the next boot sweep rather than serialized in front of `app.listen()`. The failure this buys: a run snapshot dir can still be mid-removal in the background for up to `timeoutMs` after boot reports ready; this is safe because `runSnapshotDir` is keyed by session id, which is never reused, so a fresh run can never collide with an orphaned dir still being cleaned up.

## Do not

- Do not go back to a retrying `fs.promises.rm`/`fs.rmSync` as the removal path for either `removeRunSnapshot` or `sweepAllRunSnapshots` — a wedged handle would leak a threadpool slot forever (per-session path) or block the whole daemon synchronously at boot (sweep path).
- Do not make `reconcileRunsOnBoot` await `sweepAllRunSnapshots` — it runs before `app.listen()` and must stay synchronous-safe; a wedged dir must never delay boot readiness.

## Consequences

Both the per-session teardown and the boot sweep now bound a wedged directory handle to a disposable, force-killable child process instead of a libuv-threadpool slot or the main thread — closing the same class of starvation `bd9fc808` (see below) first fixed for worktree removal.

## Related

`bd9fc808` (`docs/decisions/bd9fc808-killable-child-process-removal-replaces-threadpool-rm.md`) is the earlier, `git/worktrees.ts`-side incident and fix that introduced `killableRemoveDir`. This card (`26c661cd`) is the SEPARATE decision to adopt that already-proven shape for run-snapshot removal in `runs/snapshot.ts` — not the same decision, not the same file, but the same fix pattern.

## Source

Inline comments in `packages/daemon/src/runs/snapshot.ts`: `removeRunSnapshot`'s own doc comment (lines 108–125) and `sweepAllRunSnapshots`'s own doc comment (lines 139–154), both as of commit `1cb19d24221744f5d27b5a2e23f51118d6cafe75` (2026-09-01). Other sites citing this card (`sessions/scratch-gc.ts`, `sessions/service.ts`, `test/agent-runs-primitive.mjs`, `test/run-snapshot-remove-bound.mjs`) carry only short pointer references, not long-form narrative — `runs/snapshot.ts` held the last two full sites. Wrapped source lines joined into flowing paragraphs, `*` comment markers stripped, no wording changed.
