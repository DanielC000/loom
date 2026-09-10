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

## `Task.deferredStuck`: what the field means and its fail-toward-visible posture

`deferredStuck` is a DERIVED (but persisted, self-healing) signal that `deferred`'s own release
condition ("until `deferredUntilTaskId` MERGES") can no longer be reached: the blocker is gone (deleted,
or cross-project — a dangling reference), OR the blocker has already reached the project's
`terminal`-role column while its `merged` is still null (the doctrine-sanctioned 0-commit `done`
outcome — no squash commit ever lands, so `merged` never resolves). Meaningless while `deferred` is
false. Per card 022659ac (multiple blockers — see
docs/decisions/022659ac-deferreduntiltaskid-multiple-blockers-and-are-across-all.md), this is the OR
across every named blocker: ANY one of them being dangling/closed-with-no-merge sets this true, even
while the others are still cleanly, reachably pending; it never waits for all of them to independently
go bad.

It DOES NOT REDEFINE WHEN `deferred` CLEARS — `deferred` stays keyed on `merged` exactly as before (see
docs/decisions/793ac76d-deferreduntiltaskid-auto-clears-deferred-on-observed-merge.md); a 0-commit close
is a legitimate outcome and this field must never auto-clear `deferred`, only make the stuck state
VISIBLE (previously nothing surfaced it anywhere, and `deferred:true` is independently discounted from
the idle watchdog's actionable count, so the card was invisible in exactly the direction that would
reveal the problem).

`merged === null` has THREE causes per `getTaskMergedInfo`'s contract: never merged, landed outside the
git scan window, or a git read failure — so a blocker sitting in the terminal column that genuinely DID
ship (just outside the scan window, or during a transient git failure) can still read
`deferredStuck:true`. This is a DELIBERATE fail-toward-VISIBLE choice, not a proof of unreachability: a
card wrongly surfaced is noticed and dismissed in seconds, while a card wrongly hidden stays invisible
forever (the original defect this card fixes). Read this field as "cannot currently be SHOWN to have
shipped, and its blocker has already closed" — never as "proven unreachable."

Computed in `resolveDeferredEffective` off the SAME blocker + merged-state lookup already performed for
the `deferred` auto-clear — no extra git call. Write-through persisted on a genuine transition only
(mirrors `deferred`'s own auto-clear guard), so a raw-DB reader (the idle watchdog,
`hasPendingBoardWork`) self-heals without knowing anything about `deferredUntilTaskId`.

## Do not

- Do not fold the `includeMerged:false` case into the `!raw`/`!deferredUntilTaskId` "not stuck" branches
  — it is an unmeasured unknown, not a determination, and folding it would let a latency-sensitive read
  (the companion board) silently un-stick a genuinely stuck card.
- Do not read `deferredStuck:true` as "proven unreachable" — `merged === null` can also mean "shipped
  outside the scan window" or "a transient git read failure"; read it as "cannot currently be shown to
  have shipped, and its blocker has already closed."
- Do not let `deferredStuck` auto-clear `deferred` — a 0-commit close is a legitimate outcome, and
  `deferred` stays keyed on `merged` exactly as it always was.

## Source

Inline JSDoc in `packages/daemon/src/mcp/tasks.ts` (`resolveDeferredEffective`'s own doc, lines 137-147
as of this tranche's HEAD).

The "`Task.deferredStuck`" section above was appended by tranche 3 on `packages/shared/src/types.ts`
(card 555f817f), extracted from `Task.deferredStuck`'s own doc comment — same decision, the type-level
field contract, folded into this existing file per the one-record-per-id rule rather than a new one.
