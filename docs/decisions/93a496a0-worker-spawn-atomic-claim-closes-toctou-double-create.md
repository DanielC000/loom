# sha:93a496a0 — `worker_spawn`'s per-taskId claim is a TRUE mutex, not a narrower TOCTOU window

## Narrative

`liveSessionIdForTask` is a single NON-atomic SELECT taken BEFORE `await createWorktree`, and the live
row is inserted only AFTER it — so two CONCURRENT or RETRIED `worker_spawn` calls for one `taskId` could
both observe `liveHolder=null` across that `await` gap and both create a worktree+session: TWO live
workers sharing ONE branch (silent work-loss). The fix is an in-memory, synchronous, per-taskId claim
that is a TRUE MUTEX, not merely a tighter check.

ATOMICITY PROOF: Node runs each turn to completion on a single thread; a turn yields ONLY at an `await`
(or return). The test-and-set — `if (has(taskId)) throw; add(taskId)` — contains NO `await` between the
`.has()` and the `.add()`, so it executes as one INDIVISIBLE step: no other call can be scheduled in
between. Calling `spawnWorker(...)` runs its synchronous prefix immediately up to the FIRST `await`
(`createWorktree`, below the claim). So for two racing calls A and B on one `taskId`, whichever's
synchronous prefix runs first reaches `.add(taskId)` and only THEN yields at `createWorktree`; the other's
prefix then runs with the claim already present and is rejected before it can `createWorktree`. They
cannot interleave inside the check-and-claim, so at most one ever proceeds.

Single-process-sufficient: the daemon is ONE process and `spawnWorker` is the only worker-spawn path
(boot-resume resumes by id, never inserts) — so an in-memory `Set` needs no cross-process lock. A DB
unique index would be equivalently strong but would have to thread the legitimate multi-row-per-task
history of exited/recycled rows, which the in-memory claim avoids.

The claim happens BEFORE `createWorktree`, so the LOSER never creates an orphan worktree/branch at all —
nothing to clean up. Released in the `finally` once the row is live (the liveHolder guard then owns
exclusion) or on failure.

## Do not

- Do not weaken this to a "tighter check" (a narrower TOCTOU window) — the check-and-claim must have NO
  `await` between the `.has()` and the `.add()`, or two racing calls can still both pass.
- Do not move the claim to AFTER `createWorktree` — the loser must never create an orphan worktree/branch;
  claiming first is what makes cleanup unnecessary.
- Do not replace the in-memory `Set` with a DB unique index without also handling the legitimate
  multi-row-per-task history of exited/recycled rows — the in-memory claim sidesteps that entirely.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`worker_spawn`'s atomic spawn-claim,
opening paragraphs): lines 6023-6043, as of commit `93a496a055b07a2ceb3c2a897ea5deaccc5e6c17`
(`fix(orchestration): close the worker_spawn TOCTOU double-create race with an atomic per-task claim`).
No board card cited anywhere in the block or the introducing commit — sha-keyed per `CLAUDE.md`'s comment
taxonomy, verified with `git cat-file -t 93a496a055` (a real commit). Relocated by card `61632c05`
(tranche 15); no wording changed, wrapped source lines joined into a flowing paragraph and the `//`
comment markers stripped.
