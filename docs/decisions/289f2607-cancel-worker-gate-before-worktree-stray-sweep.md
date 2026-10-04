# 289f2607 — cancel a worker's own in-flight/queued gate before sweeping its worktree for strays

## Narrative

`stopWorker`/`killAllWorkers` used to sweep a stopped worker's worktree for stray processes
(`sweepWorktreeStrays`, which calls `reapProcessesRootedInWorktree`) unconditionally, with no awareness
of a live gate. A solo merge confirm (`confirmWorkerMerge`) and the worker's own `run_gate` self-check
(`runWorkerGate`) both spawn their gate command's child process `cwd`-rooted in that SAME worker's own
worktree, and both carry `sessionId: workerSessionId` on their `GateDescriptor` — so a manager stopping a
worker while either was in flight could sweep straight into the gate's own live child.

`reapProcessesRootedInWorktree`'s own decision record (`docs/decisions/8e5a7a5e-*.md`, "Do not (this
section)") states the invariant directly: "Do not invoke `reapProcessesRootedInWorktree` with a worktree
that isn't genuinely about to be removed." A worker's worktree with a live gate is exactly the
"live/protected" case that invariant exists to guard against — `stopWorker`'s own doc already says the
worktree is RETAINED, not removed, on a plain stop.

Worse than merely losing a stray-reap guarantee: `gate-runner.ts`'s cancellation logic (`runGateStep`'s
`cancelling` flag) is set ONLY when a step's settle follows an abort of that run's OWN `cancelSignal` — an
external OS-level kill (the stray sweep's `taskkill`/`SIGKILL`) never touches that signal, so the gate
settles as a genuine `passed:false` FAILURE, never `cancelled:true`. `isMergeGateRed` then reports that as
a real RED attributed to the branch — indistinguishable from an actual test/build failure.

Verified with a hermetic repro (a throwaway sleeper process whose own script path lives inside a scratch
"fake worktree" dir, killed by the real, unmodified `reapProcessesRootedInWorktree` with no exclusion for
it — plus a negative control proving the match is real path-scoping, not vacuous).

## Fix

`stopWorker`/`killAllWorkers` now call `cancelWorkerGateThenSweep` instead of `sweepWorktreeStrays`
directly. It looks up every `GateSemaphore.snapshot()` entry whose `sessionId` matches the worker being
stopped, and cancels ONLY the ones that are the worker's own `run_gate` self-check (`gateType ===
"worker"`, via the shared `isWorkerSelfCheckGate` predicate — `cancelGateOp` reuses the same predicate for
its own `{kind:"own"}` worker-scope refusal, so the two can never drift on what counts as "this worker's
own gate op"). A self-check cancel goes through the SAME verified path `gate_cancel`'s own `cancelGateOp`
uses (`GateSemaphore.cancelRunning` for a running entry, `cancelQueuedForSession` for a queued one) — so a
cancelled self-check settles tagged `cancelled:true` (never a red) — then polls the live registry for up
to `gateCancelVerifyMs` (the same bound `cancelGateOp`'s own RUNNING branch uses, via a new
`stopGateCancelPollMs`-interval poll) before giving up. If a self-check op is STILL live for this worker's
session after that bound, the sweep is SKIPPED entirely — never run against a worktree a gate might still
hold — and logged once.

A solo merge confirm's `GateDescriptor` ALSO carries `sessionId: workerSessionId` (see the Narrative
above), so a bare sessionId filter with no `gateType` conjunct would wrongly let this stop path cancel the
worker's own MERGE/DEPLOY entry too — exactly the regression Round 2 (card 289f2607, Code Review
`c4f345b6`) caught and fixed. It must not: a RUNNING merge/deploy gate ignores an external cancel signal
anyway (`cancelGateOp` itself refuses to cancel a RUNNING merge/deploy for the identical staged-residue
reason), and withdrawing a QUEUED one would silently drop the manager's own `worker_merge_confirm`. So
`cancelWorkerGateThenSweep` checks for any non-self-check (merge/deploy) entry FIRST — if one exists
(running or queued), the sweep is SKIPPED IMMEDIATELY, with no bounded wait at all, and the merge/deploy
entry is left completely untouched.

A BATCHED merge is never reachable by this worktree-scoped sweep either, but not because its
`worktreePath` points at the canonical repo (it does NOT — `mergeBatch` cuts its OWN dedicated worktree
via `createWorktree(finalRepoPath, projectId, batchTaskId)`, and that worktree, not `finalRepoPath`, is
what its `GateDescriptor.worktreePath` carries; `finalRepoPath` rides separately as `repoPath`). The real
reason is `sessionId`: a batch's descriptor carries `sessionId: managerSessionId`, never any worker's own
session, so it can never match the `mine()` filter above regardless of which worktree it names.

Round 3 (hardening before landing, no design change): the non-self-check (merge/deploy) check above ran
only ONCE, against a snapshot taken before the bounded cancel-wait. A merge/deploy entry for this same
`sessionId` that gets enqueued DURING that wait (e.g. a manager's `worker_merge_confirm` landing while the
worker's own self-check is still draining) was invisible to that first check and would fall through to the
sweep once the self-check cleared. `cancelWorkerGateThenSweep` now re-runs the identical non-self-check
lookup a second time, immediately before calling `sweepWorktreeStrays` — catching an entry that arrived
mid-wait, not just one present at the top of the method.

`killAllWorkers` separately latches `control.pause("global")` as its FIRST statement, before any await —
previously it latched only AFTER its own `Promise.all` of per-worker `cancelWorkerGateThenSweep` calls
settled. A hard `pty.stop`'s own process-exit handler fires asynchronously (a real OS event, not a
microtask), and `maybeDrainCapQueue` checks `control.isPaused` synchronously before popping anything — so
the late-latching version left a real window where that handler's own `maybeDrainCapQueue` call could pop
a cap-queued entry and spawn a brand-new worker while "stop everything now" was still mid-stop.

## Do not

- Do not sweep a worker's worktree for stray processes without first cancelling (and bounded-waiting on)
  any WORKER-gateType op whose `GateSemaphore.snapshot()` entry carries that worker's own `sessionId` — an
  unguarded sweep can kill a live gate's own spawned child from outside its `cancelSignal`, which
  `gate-runner.ts` then reports as a genuine FAILURE (a false red attributed to the branch), never
  `cancelled:true`.
- Do not filter that live-entry lookup by `sessionId` alone, with no `gateType` conjunct — a solo merge
  confirm's descriptor carries the worker's own `sessionId` too, so a bare sessionId filter would let a
  stop cancel (or bounded-wait on) the worker's own MERGE/DEPLOY entry, which this stop path must NEVER
  touch. Any merge/deploy entry for this session must make the sweep skip immediately instead — no bounded
  wait, no cancel attempt, entry left exactly as it was.
- Do not await the cancel verification indefinitely — bound it (`gateCancelVerifyMs`, reused rather than a
  second duplicate knob) and SKIP the sweep if a self-check gate is still live after that bound, rather
  than risk reaping a gate child a moment before it would have settled on its own.
- Do not add worktree-path matching for a batched merge's own exclusion from this check — a batch gate's
  `sessionId` is always the manager's, never a worker's, so it is structurally unreachable by the
  `sessionId`-keyed filter above regardless of which worktree its own descriptor names (see the Fix
  section above for the corrected worktreePath/repoPath detail — do not re-cite "worktreePath points at
  the canonical repo" as the reason; it does not).
- Do not latch `killAllWorkers`'s `control.pause("global")` anywhere but the FIRST statement, before any
  await — latching it after the per-worker `Promise.all` leaves a real window for a hard-stopped worker's
  own async exit handler to race `maybeDrainCapQueue` into spawning a brand-new worker mid-kill.
- Do not rely on the non-self-check lookup's FIRST (pre-wait) result alone — re-run it again immediately
  before `sweepWorktreeStrays`, or a merge/deploy entry enqueued for this session during the bounded cancel
  wait (not present at the top of the method) will slip through once the self-check clears.

## Source

`cancelWorkerGateThenSweep`, `isWorkerSelfCheckGate`, and `sweepWorktreeStrays` in
`packages/daemon/src/sessions/service.ts`.
