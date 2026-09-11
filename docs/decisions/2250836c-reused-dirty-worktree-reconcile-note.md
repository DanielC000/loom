# 2250836c — a worker reusing a dirty leftover worktree gets an injected reconcile note

## Narrative

`reusedDirtyWorktree` on `composeWorkerStartupPrompt` is OPTIONAL: `undefined` omits the block entirely (byte-identical to before this param existed) — a fresh worktree or a clean reuse never sets it. When present, this spawn REUSED a worktree retained from a prior hard-stopped (or rejected-merge) attempt on the task, and it still carries real leftover uncommitted work. A reconcile note is injected naming the leftover paths.

This is what removes the need for a manager to hand-instruct a `git status; reconcile` note on every retry — the finding this card fixes: before it, a worker resuming into a dirty reused worktree had no built-in signal that uncommitted work from a prior attempt was already sitting there, and a manager had to notice and say so by hand each time.

## Do not

- Do not silently hand a worker a reused worktree with leftover uncommitted changes — inject the reconcile note naming the leftover paths so the worker sees it before making new edits.
- Do not make a manager hand-instruct "check git status and reconcile" on every retry — this is now the daemon's own signal, not a per-case manager reminder.

## Source

JSDoc comment above `composeWorkerStartupPrompt` in `packages/daemon/src/sessions/worker-prompt.ts`: originally lines 101-106, as of this tranche's HEAD. Introduced by commit `2ba2c9ed39cd1db3d0e90f9ffb2a185b3eca8a74` (`fix(orchestration): clean-or-flag a dirty worktree reused after worker_stop(hard) before the next worker_spawn`). Relocated by card `36641df4` ("sessions prompt-composer files, tranche 1").

This is distinct from card `13cc2300`'s `discardedOnRecut` block, the OPPOSITE fact — see that card's own record.
