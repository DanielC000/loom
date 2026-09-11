# 864e79fe — `reapProcessesRootedInWorktree`'s `deps.excludePids`: caller-supplied survivors, worktree-scoped pre-gate cleanup

## Narrative

Code Review finding on card `864e79fe`: `deps.excludePids` lets a caller name additional pids that are genuinely rooted in `worktreePath` but must survive the reap anyway — specifically, a worker's OWN claude pty when `reapProcessesRootedInWorktree` is invoked BEFORE that worker has been stopped (`confirmWorkerMerge`'s worktree-scoped pre-gate cleanup sweep, run while the confirming worker may still be live). Without this, the sweep would kill the worker's own process on every gated confirm — on a subsequent gate FAILURE that would strand a worker meant to survive for re-tasking.

This is deliberately separate from the unconditional `process.pid` self-exclusion (see `8e5a7a5e`'s SELF-EXCLUSION section): that one is a blanket, always-on backstop for the daemon itself; `excludePids` is a caller-supplied, call-site-specific allowance, scoped to whatever pids that ONE caller already knows must survive.

## Do not

- Do not remove `excludePids` in favor of relying on the unconditional `process.pid` self-exclusion alone — the two guard different things: one protects the daemon, the other protects a caller-known survivor (e.g. a still-live worker's own pty) that the daemon-pid check cannot see.
- Do not invoke the pre-gate sweep without passing the confirming worker's own pid(s) via `excludePids` — a gate failure after an unguarded sweep would strand a worker meant to survive for re-tasking.

## Early-idempotency short-circuit: false-negative "build gate failed" after a successful merge

The same card also covers a second mechanism in `confirmWorkerMerge` (`sessions/service.ts`): a stale confirm retry (e.g. a client-timeout on the FIRST call — see `confirmWorkerMergeTracked` — followed by a re-call landing after the pending-op entry already settled and was evicted) re-invokes the method for real, but a PRIOR call may have already merged and finalized this exact worker — worktree removed, branch deleted, task moved to done. Running the gate against that now-gone `worktreePath` used to make the gate fail (its cwd doesn't exist) and falsely report a build-gate failure for a merge that had already SUCCEEDED.

Worktree-gone is not the only proof "this daemon already finished": `removeWorktree`'s dir removal is best-effort (a Windows handle-release race can outlast its own bounded retries), so `finalizeMerge` can complete the ENTIRE merge (branch deleted, task done) while the worktree directory itself lingers on disk for a later GC pass. A stale retry landing in that exact window used to see `fs.existsSync(worktreePath) === true`, skip the idempotency check, and re-run the gate against a leaked/de-registered worktree — which can genuinely fail (broken git state) and misreport a build-gate failure for a worker that had already merged successfully. The worktree-existence check is therefore widened with an OR: the task already being in its terminal (done) lane is an equally authoritative "this daemon's own `finalizeMerge` already ran" signal.

Gated on BOTH signals, never just one — (worktree gone OR task already done) AND the branch's landing independently proven via `findLandedSquashCommit` (the same `Loom-Worker-Branch` trailer signal `mergeBranch`'s own `ALREADY_MERGED` classification uses, including its re-task guard: a branch re-cut onto a prior squash with genuine new work returns `null`, so a live re-task is never short-circuited here). Two `merge-reject-notify-suppress.mjs` scenarios name why NEITHER half of the gate is skipped for a landed-but-still-present worktree:

- **Scenario B** — an out-of-band manual squash-merge racing a daemon confirm whose gate is STILL failing for its own real reason (worktree genuinely present, task NOT yet terminal): the gate must still run and report the real failure; only the manager-facing NOTIFY is reconciled away, via `shouldSuppressMergeReject` — never the return value, and never the gate itself skipped.
- **Scenario C** — the task is already Done for an UNRELATED reason, the gate genuinely still fails, and the branch never actually merged: task-done alone never short-circuits without the independent landing proof above, so this scenario also reports the real failure.

## Do not (early-idempotency)

- Do not treat worktree-gone as the only signal of "already finished" — `removeWorktree`'s best-effort dir removal can lag a completed `finalizeMerge`, so the task's own terminal-lane state is an equally authoritative signal, OR'd in.
- Do not short-circuit on task-done alone (scenario C) or on a still-present worktree with a genuinely-failing gate (scenario B) — the branch's landing must be independently proven via `findLandedSquashCommit` first in both cases.

## Source

Inline doc comment above `reapProcessesRootedInWorktree` in `packages/daemon/src/pty/host.ts` (the `deps.excludePids` paragraph), introduced by commit `6c66390e8147bd85ce2fb1d528f9d7de63e95aa8` ("fix(orchestration): harden worker_merge_confirm gate — worktree-scoped pre-gate cleanup, no-gate warning, fix false post-merge gate-fail"), as of this tranche's HEAD (main `9421720c`). The early-idempotency section above is sourced from the JSDoc above `confirmWorkerMerge` in `packages/daemon/src/sessions/service.ts`, as of this tranche's HEAD before this extraction. Card `864e79fe` is also cited in `test/worktree-process-reap.mjs`, `test/merge-confirm-leaked-worktree-idempotent.mjs`, `test/merge-confirm-stale-retry-idempotent.mjs` — those sites are read-only context here, not edited by this record.
