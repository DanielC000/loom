# cf62c1ef — clearing `deferredUntilTaskId` on auto-clear stops a silent re-defer from self-clearing

## Narrative

`persistDeferredStateBestEffort`'s `autoCleared` write also nulls `deferredUntilTaskId` in the SAME
write — once a named blocker's merge has been observed and acted on, the companion field has served its
purpose.

Leaving it set was a footgun: a LATER, unrelated `tasks_update(deferred:true)` (with no new
`deferredUntilTaskId`) would silently inherit the stale blocker reference, and since that blocker is
already merged, the very next read would auto-clear the manager's fresh, deliberate re-defer without ever
reporting it. Clearing the companion field here means a re-defer always starts clean — it lands on the
plain "deferred with no blocker" path (never auto-clears) unless the caller explicitly names a NEW
blocker.

A `stuckChanged`-only write (deferred stays true) leaves `deferredUntilTaskId` untouched — the blocker
reference is still exactly what made it stuck.

## Do not

- Do not persist an `autoCleared` transition without also nulling `deferredUntilTaskId` — the stale
  blocker reference would silently re-arm and swallow a future, unrelated manual re-defer.

## Source

Inline JSDoc in `packages/daemon/src/mcp/tasks.ts` (`persistDeferredStateBestEffort`'s own doc, lines
203-211 as of this tranche's HEAD).
