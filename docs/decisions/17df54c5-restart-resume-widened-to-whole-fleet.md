# 17df54c5 — `daemon_restart` resumes the WHOLE live fleet across ALL projects, not just the requester's own workers

## Narrative

Card 17df54c5 (P1) widened what a `daemon_restart` resume captures and re-spawns. Before this card, a
restart intent carried only the requesting manager's own flat `workerSessionIds` list — every OTHER
live session daemon-wide (other managers, other projects' workers, the Platform Lead) was left for dead
until something else happened to notice and re-resume it. That was a real data-loss trigger: a session
with no other watcher could sit orphaned indefinitely after any deploy.

The fix splits into two halves, both in `sessions/service.ts`: `liveFleetResumeSet` (the capture half)
snapshots every LIVE session across every project — `listAllSessions` is already cross-project and
excludes archived rows, so only a `live`/non-`run`/worktree-still-present filter is needed — carrying
each entry's role (so the MCP surface returns correctly) and, for a worker, its manager
(`parentSessionId`), so a later resume can re-parent it correctly. `resumeFleetOnBoot` (the resume half)
re-spawns that whole captured set, injecting nothing into the resume itself (the resume-injects-nothing
invariant — `resume()` passes no startup prompt).

Backward compatibility: an OLD on-disk `restart-intent.json` written before this card lands (the
pre-change, requester-plus-flat-workerSessionIds shape) is still tolerated — it degrades to resuming the
requester and its own workers only, rather than crashing on an unrecognized shape. The superseded
per-requester capture helper is kept `@deprecated` for exactly this reason, not for reuse.

## Do not

- Do not assume a `daemon_restart` only needs to resume the requesting manager's own subtree — the whole
  live fleet, across every project, must be captured and resumed, or an unrelated session can be silently
  orphaned by someone else's restart.
- Do not remove the old-restart-intent-format tolerance without checking whether a `restart-intent.json`
  written before this card could still be sitting on disk somewhere it would be read.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`: lines 4310-4315,
as of this tranche's HEAD (tranche 11). Cross-referenced (read-only) against `orchestration/restart.ts`
(lines 46, 96) and `index.ts` (lines 599, 1464), which cite the same card for the same widening.
