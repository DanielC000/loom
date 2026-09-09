# 1d27c3cd — re-fetch immediately before folding closes the git-scan race, and preserves a closure record

## Narrative (site 1: `persistDeferredStateBestEffort`'s re-fetch)

Code Review follow-up: `state` was computed by the CALLER (`listProjectTasks`/`getProjectTask`) from a
task snapshot read BEFORE it awaited `resolveMergedInfo`/`resolveDeferredEffective` — and that chain does
a REAL git-log child process on a cache miss (`resolveMergedInfo` → `getTaskMergedInfo` →
`getMergedCommitMapCached` → `getOrStartMergedMapScan`), a genuine event-loop yield on a READ path any
board list can trigger. Trusting the caller's stale `body`/`deferredReason` across that gap would let a
concurrent `tasks_update({body,...})` land in the window and get silently clobbered by this blind write.
Re-fetching HERE, immediately before folding, shrinks the window to a single synchronous SQLite
read-then-write — the SAME guarantee `updateProjectTask`'s own blind writes
(`heldByPatch`/`deferredAtPatch`) already rely on, not a new or weaker one.

CONSEQUENCE, verified against the code (not assumed): this also makes two near-simultaneous `autoCleared`
reads (A and B, both racing on the SAME still-deferred row) structurally unable to fold TWICE. Each
read's own re-fetch-fold-write is one uninterruptible synchronous JS stretch — whichever of A/B runs it
first clears `deferredReason` to null in the SAME write that applies the fold; the other's re-fetch then
observes `fresh.deferredReason === null` and its `fresh.deferredReason ? … : {}` guard skips the fold
entirely. (The loser still performs a harmless redundant scalar-only rewrite — deferred/
deferredUntilTaskId/deferredStuck/deferredAt/deferredReason all re-written to the SAME values already on
the row, bumping `updatedAt` again but never `version` — it just never touches `body` a second time.)

## Narrative (site 2: `foldReleasedDeferralIntoBody`'s existence)

`deferredReason` is cleared the moment a deferral ends — both on an explicit manual `deferred:false`
(`updateProjectTask`) and on the designed `deferredUntilTaskId` auto-release path
(`persistDeferredStateBestEffort`) — and that clear is CORRECT (a stale "blocked on X" left on a card
that's no longer blocked is its own defect). But the REASON itself is a closure record, not disposable
state, so it's folded into the card BODY — the durable surface a future reader already looks at — as its
own paragraph, before the field is nulled.

## Do not

- Do not fold from a task snapshot read before the git-log-shaped await in `resolveMergedInfo`/
  `resolveDeferredEffective` — re-fetch immediately before composing the write, every time.
- Do not simply discard `deferredReason` when a deferral clears — it's a closure record; fold it into
  `body` before nulling the field, on every release path (manual or auto).

## Source

Inline comments in `packages/daemon/src/mcp/tasks.ts`: `persistDeferredStateBestEffort`, lines 225-243
(site 1); `foldReleasedDeferralIntoBody`'s own doc, lines 273-278 (site 2) — both as of this tranche's
HEAD.
