# 936dd348 — resume() refuses a worker onto a task that already has a live worker

`worker_spawn` and `worker_recycle` refuse through `claimTaskWorktreeRefusal` (the one-live-worker-per-task
guard); `resume()` did not, so the human REST resume and archive restore (both `allowSuperseded:true`) could
put a second engine on one card (and one deterministic worktree). `resume()` now runs the same predicate for a
`role:"worker"` row with a taskId (`resumeTaskClaimRefusal`), excluding the row itself, plus a refusal while a
spawn/recycle is in flight for the task (`inFlightSpawnTaskIds` — the createWorktree window before any row is
live; the same set `spawnMintConflict` already treats as part of the claim).

## The inherited merge-in-flight half (kept)

`claimTaskWorktreeRefusal` also refuses while a merge for the task is in flight (641cc62c's hazard: the
worktree is about to be squashed and deleted). That half is deliberately kept for resume: resuming a worker
into a worktree a merge is consuming is the same two-writers hazard. The in-memory set is empty at boot, so
it only ever bites a wake / rate-limit / human resume landing inside a merge window, and clears when it settles.

## How each automatic caller accounts for the refusal

- `crash-recovery-watcher`: `findTaskClaimRefusal` (optional dep, checked for workers BEFORE
  `session_resume_attempt` is filed, beside the 63edeb55 manager skip). A held task never burns an attempt
  and never pages `[loom:crash-loop]`; the skip is live every tick, not sticky.
- `resumeFleetOnBoot` and `recoverCrashOrphanedWorkers`: the refusal is a SKIPPED, not-a-failure outcome. It
  is kept out of `failed`/`failedCount` (so no `fleet_resume_failed` page) the same way 39b58667 kept the
  setup collapse out; `resumeFleetOnBoot` reports it in `taskClaimSkipped` with its reason, and both paths log
  it. No new event kind was added.
- Wake, poll, event-trigger, rate-limit resume: unchanged — they throw out of `resume()` into their existing
  error paths (a dropped wake, the rate-limit watcher's own failure handling).
- Boot order for two rows on one task: after boot-reconcile every row is `exited`, so the FIRST resumed row
  takes the task and the second is refused (and skipped per above). Which of the two wins follows the
  unspecified entry order; either surviving is acceptable — exactly one engine holds the task.

## Do not

- Do not judge this on the raw DB `process_state` flag — pass the verified `pty.isAlive` predicate (like
  39b58667): a phantom-live row, or a sibling flipped live moments earlier in a boot loop, must not refuse a
  legitimate resume.
- Do not gate it on `allowSuperseded` — that flag lifts retirement bookkeeping, not "accept two workers on
  one task". A human stops the other worker first.
- Do not pass `verifyLive` from spawn/recycle — they keep the raw flag and the "re-spawn" wording on purpose
  (their own rows are flipped under their own locks); only resume passes it and says "resuming"/"resume".
- Do not count this refusal as a crash anywhere: no `session_resume_attempt`, no `failed` bucket, no
  `[loom:crash-loop]` / `fleet_resume_failed` page.
- Do not change the refusal's leading text without updating `TASK_CLAIM_RESUME_REFUSAL_PREFIX`: the REST
  resume/restore routes and both boot paths classify the refusal by that prefix.
