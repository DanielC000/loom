# 864e79fe — `reapProcessesRootedInWorktree`'s `deps.excludePids`: caller-supplied survivors, worktree-scoped pre-gate cleanup

## Narrative

Code Review finding on card `864e79fe`: `deps.excludePids` lets a caller name additional pids that are genuinely rooted in `worktreePath` but must survive the reap anyway — specifically, a worker's OWN claude pty when `reapProcessesRootedInWorktree` is invoked BEFORE that worker has been stopped (`confirmWorkerMerge`'s worktree-scoped pre-gate cleanup sweep, run while the confirming worker may still be live). Without this, the sweep would kill the worker's own process on every gated confirm — on a subsequent gate FAILURE that would strand a worker meant to survive for re-tasking.

This is deliberately separate from the unconditional `process.pid` self-exclusion (see `8e5a7a5e`'s SELF-EXCLUSION section): that one is a blanket, always-on backstop for the daemon itself; `excludePids` is a caller-supplied, call-site-specific allowance, scoped to whatever pids that ONE caller already knows must survive.

## Do not

- Do not remove `excludePids` in favor of relying on the unconditional `process.pid` self-exclusion alone — the two guard different things: one protects the daemon, the other protects a caller-known survivor (e.g. a still-live worker's own pty) that the daemon-pid check cannot see.
- Do not invoke the pre-gate sweep without passing the confirming worker's own pid(s) via `excludePids` — a gate failure after an unguarded sweep would strand a worker meant to survive for re-tasking.

## Source

Inline doc comment above `reapProcessesRootedInWorktree` in `packages/daemon/src/pty/host.ts` (the `deps.excludePids` paragraph), introduced by commit `6c66390e8147bd85ce2fb1d528f9d7de63e95aa8` ("fix(orchestration): harden worker_merge_confirm gate — worktree-scoped pre-gate cleanup, no-gate warning, fix false post-merge gate-fail"), as of this tranche's HEAD (main `9421720c`). Card `864e79fe` is also cited in `sessions/service.ts` (the pre-gate sweep call site and `confirmWorkerMerge`'s early-idempotency short-circuit) and in `test/worktree-process-reap.mjs`, `test/merge-confirm-leaked-worktree-idempotent.mjs`, `test/merge-confirm-stale-retry-idempotent.mjs` — those sites are read-only context here, not edited by this record (out of this tranche's file fence).
