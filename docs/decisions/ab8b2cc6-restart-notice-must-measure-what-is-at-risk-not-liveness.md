# ab8b2cc6 — the restart notice (and any status derived from it) must measure what's at risk, not session liveness

## Narrative

Card ab8b2cc6, successor to `fe07beef`: a manager's post-restart notice needed a real measurement of
what survived a daemon restart, not just prose reassurance. The standard the card had to meet, stated
verbatim because it is the whole point:

> "A number that is TRUE, REASSURING and IRRELEVANT is the same failure as the free-text sentence —
> with better provenance, which makes it MORE credible and therefore WORSE."

A bare live-session count was explicitly RULED OUT as that exact failure. On the 2026-08-24 08:16Z
restart, a peer's three workers were all `live`/`busy` throughout — and one of them (`90c3d6a9`) had
its worktree emptied and branch deleted 22 seconds after being resumed (the two-pass cascade fixed by
card `40b63f1c`). A live-session count would have counted all three, including the one being destroyed
as it was counted — true (all three really were live), reassuring (a manager reading "3/3 live" would
relax), and irrelevant (liveness said nothing about whether the worktree under that session still
existed).

The DoD this card shipped to: surface a measurement of the THING AT RISK — worktrees, branches,
in-flight work — beside the free-text reason, not any proxy chosen because it's easy to count.
`classifyWorktreeIntegrity`'s three-way `at-risk` / `intact` / `indeterminate` split
(`orchestration/worktree-vanished-watcher.ts`) is downstream of this same standard applied to a single
worktree check: a caller that collapses `indeterminate` (worktree path missing, `.git` not in the
expected pointer shape, content that doesn't parse) into `intact` reports "fine" in exactly the cases
where the check could not actually confirm that — the identical TRUE/REASSURING/IRRELEVANT shape, one
level down from a fleet-wide count to a single boolean-shaped read.

## Do not

- Do not report session/pty liveness as if it answered "did the worker's work survive" — the
  2026-08-24 08:16Z restart is the standing counterexample: liveness said "3/3 fine" while one
  worktree was mid-destruction.
- Do not fold `WorktreeIntegrity`'s `"indeterminate"` status into `"intact"` in any caller. Only
  `"intact"` means the check actually confirmed the worktree looks fine; `"indeterminate"` means the
  check could not tell, which is not the same claim.

## Limits

n=2 overall for the restart-notice incident, both Windows, one host — nothing measures how often a
peer has work in flight at restart time, only that it did on these two occasions. Whether a mid-turn
worker loses in-flight turn state across a restart is a separate, still-unmeasured question; the
notice does not answer it and should not be read as if it did.

## Source

JSDoc comment for `WorktreeIntegrity` in `packages/daemon/src/orchestration/worktree-vanished-watcher.ts`,
lines 25-41, as of this tranche's HEAD (worktree-vanished-watcher.ts, tranche 1).
