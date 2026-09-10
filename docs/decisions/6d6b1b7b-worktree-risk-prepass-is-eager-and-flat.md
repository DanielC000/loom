# 6d6b1b7b — the worktree-at-risk pre-pass runs once, eagerly, ahead of the flat per-entry resume loop

## Narrative

Card `6d6b1b7b` names the same disclosure trap card `ab8b2cc6` closed on the sibling crash-recovery path
(`recoverCrashOrphanedWorkers`), reopened one function over by the very fix that closed it there: a
manager who learns from the crash-path notice that "the restart notice tells me about my worktrees"
would otherwise carry that same expectation into `resumeFleetOnBoot`, where silence would then read as
"checked, nothing to report" when in truth nothing was checked at all. The fix reuses the SAME fs-only
detector as the crash path (`classifyWorktreeIntegrity`, `worktree-vanished-watcher.ts`) rather than
rebuilding it.

Unlike the crash path's already-manager-grouped loop, `resumeFleetOnBoot`'s main per-entry resume loop is
FLAT across every role (worker/manager/platform/auditor/setup/plain) for the whole captured fleet, in
`entries`' own unspecified order — a manager can appear BEFORE its own worker entries in that order.
Building the worktree-checked/at-risk accumulator incrementally INSIDE that main loop (classify-as-you-go)
would therefore make a manager's notice text depend on iteration order: whether its own worker had
already been visited by the time the manager's entry was reached. The fix builds the accumulator as its
own eager pre-pass instead, over the exact same
`entries.filter((e) => e.role === "worker" && e.parentSessionId === managerId)` population
`liveWorkerCount` already reads — so "N of your live workers were resumed" and "of those, K ..." always
describe the identical set, order-independent.

The pre-pass is also deliberately NOT gated on the later `resumeOne()` outcome computed inside the main
loop: `impact.liveWorkersResumed` (the sentence this note qualifies) is itself an unfiltered raw
resume-set count, not filtered by actual `resumeOne` success either — gating the worktree count more
narrowly would make it undercount relative to the very sentence it's meant to qualify. The check is
scoped to `e.role === "worker"` entries only (only workers have worktrees to check), which also bounds
the added sync-fs cost: the main loop already calls `resumeOne()` — a pty spawn — per session, so 2-3
stat-class calls per worker is marginal against work already in that loop.

## Do not

- Do not classify worktree integrity incrementally inside the main per-entry resume loop —that loop is
  FLAT across roles in `entries`' unspecified order, so an incremental accumulator's output would depend
  on iteration order. Build it as an eager pre-pass instead.
- Do not let the crash-recovery path's existing worktree disclosure (`ab8b2cc6`) stand in for this path's
  own check — a manager cannot tell from silence here whether nothing was checked or nothing was found.
- Do not gate the worktree-at-risk count on `resumeOne()`'s own success — `impact.liveWorkersResumed`,
  the count this note qualifies, is itself unfiltered by that outcome.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above the
`worktreeCheckedByManager`/`worktreeAtRiskByManager` pre-pass in `resumeFleetOnBoot`: lines 4477-4499, as
of this tranche's HEAD (tranche 12). Cross-referenced (read-only) against `worktree-vanished-watcher.ts`'s
`classifyWorktreeIntegrity` and `recoverCrashOrphanedWorkers`'s own already-manager-grouped loop (the
sibling this pre-pass deliberately does not mirror in loop shape). Card `ab8b2cc6`'s own decision sites in
this file (its crash-recovery-path disclosure, around lines 5096 and 5205) are referenced here but not
extracted by this tranche.
