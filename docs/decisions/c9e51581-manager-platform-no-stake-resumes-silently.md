# c9e51581 — a manager/platform with NO stake in an isolated crash resumes SILENTLY (Path C extension of 61cc91c6)

## Narrative

Card c9e51581: `CrashRecoveryWatcher.tick`'s manager/platform branch is a "Path C" extension of card
`61cc91c6`'s stranded-board-work narrowing — a manager or platform/Lead with no real stake in an
isolated crash resumes SILENTLY instead of getting the unconditional re-orient nudge. `causal:false`
is passed to `computeWakeImpact` because an isolated pty death isn't self-requested, unlike a
`daemon_restart` requester. `liveWorkersResumed` is the manager's CURRENT live worker count — this
path has no "resume set" list the way Path A (`resumeFleetOnBoot`) or Path B
(`recoverCrashOrphanedWorkers`) does, since it resumes ONE dead session per candidate, not a fleet;
the natural analog is "does it have live workers to re-check right now".

KNOWN, ACCEPTED gap: if a manager AND one of its own workers crash-die in the SAME tick, this tick's
candidate iteration order isn't guaranteed, so the `liveWorkersResumed` query can undercount if the
manager is processed before its worker's own resume (later in this same tick) lands — the manager
would then resume silently for that ONE tick. Ruled not a correctness bug: the worker still recovers
independently via its own `session_died` trigger, and the manager learns about it shortly after via
`worker_list` or the worker's own report — accepted rather than adding cross-candidate batching for a
rare simultaneous-crash case.

## Do not

- Do not treat this branch's silence as a bug when a manager and its worker crash in the same tick —
  it's a known, accepted one-tick undercount, not a correctness defect; see the gap above before
  "fixing" it with cross-candidate batching.
- Do not drop `causal:false` here — an isolated pty death is not self-requested the way a
  `daemon_restart` is, and `computeWakeImpact` treats the two differently.

## Source

Inline comment in `packages/daemon/src/orchestration/crash-recovery-watcher.ts`, in
`CrashRecoveryWatcher.tick`'s manager/platform branch: lines 478-493, as of this tranche's HEAD
(crash-recovery-watcher.ts, tranche 1).
