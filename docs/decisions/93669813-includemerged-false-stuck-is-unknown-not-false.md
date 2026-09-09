# 93669813 — `includeMerged:false` means `stuck` was never measured, not `false`

## Narrative

`resolveDeferredEffective`'s `includeMerged:false` branch (the companion board's latency-sensitive skip
— see `resolveMergedInfo`'s own doc) means the blocker's merged state was NEVER RESOLVED on that read:
`stuck` is UNKNOWN there, not `false`. This has to be its OWN branch, separate from the `!raw`/
`!deferredUntilTaskId` cases — those two ARE genuine "not stuck" determinations, independent of merged
state, and correctly self-heal a stale persisted `deferredStuck`.

Collapsing all three into one "return not-stuck" path would assert a measurement that was never taken,
and the write-through persist would then PERSIST that false assertion, silently clearing a
genuinely-stuck card's flag the next time anything reads with `includeMerged:false`.

Review finding on this card: the companion board's `listProjectTasks`/`getProjectTask` calls do exactly
this — a routine companion board read must never be able to un-stick a stuck card. So the
`includeMerged:false` branch PRESERVES whatever `stuck` was already persisted and reports
`stuckChanged:false` unconditionally — never writes, whichever way the stored value happens to read.

## Do not

- Do not fold the `includeMerged:false` case into the `!raw`/`!deferredUntilTaskId` "not stuck" branches
  — it is an unmeasured unknown, not a determination, and folding it would let a latency-sensitive read
  (the companion board) silently un-stick a genuinely stuck card.

## Source

Inline JSDoc in `packages/daemon/src/mcp/tasks.ts` (`resolveDeferredEffective`'s own doc, lines 137-147
as of this tranche's HEAD).
