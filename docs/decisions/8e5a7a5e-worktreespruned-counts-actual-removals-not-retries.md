# 8e5a7a5e — boot-reconcile's `worktreesPruned` counts only an ACTUAL removal, not a retried attempt

Scoped narrowly to the boot-reconcile summary line's counter semantics (`index.ts`) — task `8e5a7a5e` is
a broader dangling-worktree-prevention effort with sites elsewhere (`pty/host.ts`'s `reapProcessesRootedInWorktree`,
`sessions/service.ts`'s worktree-wedge retry threshold); this record covers only the counter-wording facet.
A future extraction on those other sites should add a clearly-labelled new section here, not a second file.

## Narrative

`worktreesPruned`, in the boot-time orchestration-reconcile summary line, counts only an ACTUAL worktree
removal. Before this fix, a boot pass whose only activity was retrying an already-wedged worktree (still
held, not yet actually removed) left every one of the summary's counters at 0 and silently skipped the
whole line — there was no way to tell "nothing to do" from "tried and failed, still wedged" from the log
alone. `worktreesStillWedged` is now included in the line's own gate condition (alongside `mergesFinished`,
`mergesFailed`, `staleMergesResolved`, `worktreesPruned`, `worktreesKept`, `worktreesNeedsHuman`) so a
retry-only pass still surfaces, and is reported as its own separate count rather than folded into the
"pruned" wording — which now means something narrower than before: an ACTUAL removal, never merely a
retried-but-still-held attempt.

## Do not

- Do not fold a retried-but-not-yet-removed worktree into `worktreesPruned` — that count means an actual
  removal happened, and blurring it back to "any reconcile activity" reintroduces the silent-skip bug this
  fixed (a wedged-only pass reads as 0 on every counter and the summary line vanishes).
- Do not drop `worktreesStillWedged` from the summary line's gate condition — it is what makes a
  retry-only pass (all other counters 0) still print a line at all.

## Consequences

A boot pass that only retried an already-wedged worktree removal now still logs a summary line (via
`worktreesStillWedged` in the gate), and `worktreesPruned` in that line can be trusted to mean an actual
removal happened, not merely that removal was attempted.

## Source

Inline comment in `packages/daemon/src/index.ts`, immediately after the boot-time orchestration-reconcile
kick-off, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing
paragraph, `//` comment markers stripped, no wording changed.
