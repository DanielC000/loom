# c21487e8 — pre-gate worktree reap prevents a spurious EPERM on the gate's own install/build step

## Narrative

Before running the build/DoD gate inside `confirmWorkerMerge`, `sessions/service.ts` reaps any process still rooted in the worker's own `worktreePath` — reusing, unchanged, the exact same worktree-scoped predicate `reapProcessesRootedInWorktree` (`pty/host.ts`) already uses to clear a worktree right before removal (task [[8e5a7a5e-worktreespruned-counts-actual-removals-not-retries|8e5a7a5e]], wired through the same injectable `reapWorktreeProcesses` seam `gcWorktreeDir` uses). Matched strictly by executable path / cwd / command line rooted under THIS worker's own `worktreePath`, at a path-segment boundary — never a bare image-name or port match, and never the daemon's own pid (see that function's own SAFETY doc for the full scoping proof). No new kill logic is introduced here; this is the identical, already safety-reviewed helper applied at an earlier point in the same worker lifecycle (worktree removal — and now, also, pre-gate).

THE PROBLEM THIS CLOSES: a lingering dev-server/build process the worker left running (an escaped vite/esbuild that detached from the pty's own process tree) can hold a lock on the worktree's `node_modules`, making the gate's own install/build step fail with a spurious EPERM/sharing-violation even though the worker's actual code change is fine. Reaping right before the gate runs clears that lock before it can ever be hit.

## Do not

- Do not introduce new kill logic for this — reuse `reapProcessesRootedInWorktree` unchanged; a second, gate-specific reap implementation would duplicate a predicate already safety-reviewed for exactly this class of match.
- Do not match by image name or port — strictly by path/cwd/command-line rooted under this worker's own `worktreePath`, at a path-segment boundary (see [[8e5a7a5e-worktreespruned-counts-actual-removals-not-retries|8e5a7a5e]]'s own SAFETY section).

## Consequences

A worker's own leftover build/dev-server process no longer causes the gate to fail with a misleading EPERM that looks like a real code defect.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`'s pre-gate cleanup block (the "PRE-GATE CLEANUP" paragraph), as of this tranche's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed.
