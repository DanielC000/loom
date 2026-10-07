# db4b778c — file `recycle_fleet_resolved` from the durable log, not a local `alerted` flag

## The bug

Two ready branches could reach `return` after an unresolved `recycle_fleet_unresolved` alert had already
fired, without ever filing the matching `recycle_fleet_resolved` counterpart (`e07b1b1a`'s own "Do not"
already forbade this, but nothing enforced it on these two paths):

- `watchHaltedRecycleSuccessor`'s own ready branch (`sessions/service.ts`) returned unconditionally on
  `hasReachedReady(freshId)`, never checking whether its own earlier alert (or a sibling instance's) was
  still open.
- `settleRecycleHandoff`'s ready branch filed `recycle_fleet_resolved` only `if (alerted)`, where `alerted`
  is a **local variable scoped to that one loop instance**. `reattemptManagerOwnershipTransfer`'s
  `"resolved"` branch fires a BRAND NEW `settleRecycleHandoff` call (`alerted` starts `false`) whose very
  first iteration already observes `hasReachedReady === true` (checked just above, at the call site) — so
  `alerted` can never become `true` before the ready branch runs, and the resolved event is never filed,
  regardless of whether `watchHaltedRecycleSuccessor` (a completely different loop, possibly minutes
  earlier) already alerted unresolved for this exact lineage.

## The fix

`openUnresolvedRecycleFleetAlert(db, oldId, freshId)` (`orchestration/crash-orphaned-workers.ts`) reads
the durable event log instead of an in-memory flag: the latest `recycle_fleet_*` event for `oldId` must be
`recycle_fleet_unresolved` AND name this exact `freshId` (`detail.deadSuccessorId`). Both ready branches
call it and file `recycle_fleet_resolved` only when it returns a match. This is the SAME shape the
`08c81809` boot-reconcile path (`finishReconcilingRecycleSettles`) already uses for its own deferred-ready
branch — not a new pattern, just applied to the two live-loop ready branches that were missing it.

Unlike `latestMatchingUnresolvedSettleEvent` (which this reuses the `.filter().at(-1)` scan from, via the
shared private `latestRecycleFleetEvent`), this check has NO `reason === "timeout"` / `halted !== true`
restriction — that restriction exists only to scope the escalation-hint mechanism
(`currentUnresolvedSettleSuccessor`/`unresolvedSettleEscalationHint`) to the non-halted case (`91ac2b79`).
This check must fire for the halted case too, which is exactly the scenario the restricted function
excludes.

`settleRecycleHandoff`'s local `alerted`/`alertedAt` are otherwise unchanged — they still gate whether the
unresolved-alert tail fires at all. Only the resolved-filing decision moved off `alerted` onto the durable
read, and `cancelStaleEscalationQuestions`'s cutoff now reads the matched event's own `ts` (mirroring the
`08c81809` precedent) rather than the local `alertedAt`.

## Why `cancelStaleEscalationQuestions` is NOT added to `watchHaltedRecycleSuccessor`'s ready branch

Verified at source before deciding this, per the lead's ruling: `cancelStaleEscalationQuestions` cancels
*every* pending `question_ask` for `oldId` created after a given cutoff, on the premise (stated in
`e07b1b1a`'s own doc) that such a question "can only have gone through the `ca0111a3` escalation
carve-out." That premise holds for `settleRecycleHandoff`'s own (non-halted) caller, where
`isSupersededByRecycle` is `true` and refuses every MCP tool except `question_ask`'s own narrow carve-out
— but it does NOT hold for a halted predecessor: `isSupersededByRecycle(db, sessionId)` is defined as
`hasSuccessor && !currentHaltedSuccessor`, which is **`false`** for a halted lineage (`currentHaltedSuccessor`
is non-empty). `callerSupersededError()` (`mcp/orchestration.ts`) is therefore a no-op for every one of its
~14 call sites while halted — a halted predecessor can call `question_ask`, or any other fleet-write tool,
completely normally, for any reason, not through any carve-out at all. Porting
`cancelStaleEscalationQuestions` into this branch would indiscriminately cancel an ordinary, unrelated
pending question with a message that falsely claims it was about the successor reaching ready.

## Why a "resolved" outcome is also safe from sweeping up an unrelated M1 question

Code Review `9baa9d58` flagged a real, previously undocumented and untested coupling: a clean "resolved"
outcome's safety from `cancelStaleEscalationQuestions` sweeping up an ordinary, unrelated M1 question does
NOT come from anything in this fix. It comes from `attemptManagerOwnershipTransfer`'s own "questions" step
(`db.reparentQuestions(oldId, freshId)`), which moves every question row off M1 onto M2 *before* the
resolution marker is filed and before `settleRecycleHandoff` is fired — so by the time that fresh instance's
ready branch calls `cancelStaleEscalationQuestions(oldId, freshId, unresolved.ts)`, an ordinary pending
question is no longer even in `oldId`'s inbox to be swept up. `test/recycle-fleet-resolved-after-halted-settle.mjs`'s
(R-5) scenario makes this explicit: the question survives, routed to M2, under the real fix; a
positive-control sibling stubs `Db.prototype.reparentQuestions` to a no-op and shows the SAME question
wrongly cancelled, proving the instrument can fire and that the reparent step is the only thing standing in
its way.

## Do not

- Do not file `recycle_fleet_resolved` from a loop's own local `alerted` flag — it is blind to an alert
  filed by a different loop instance/call stack for the same lineage. Use `openUnresolvedRecycleFleetAlert`.
- Do not add `reason`/`halted` restrictions to `openUnresolvedRecycleFleetAlert` — that is
  `latestMatchingUnresolvedSettleEvent`'s own, deliberately narrower, job; this function exists specifically
  to cover the case that one excludes.
- Do not call `cancelStaleEscalationQuestions` from `watchHaltedRecycleSuccessor`'s ready branch — see
  "Why ... is NOT added" above; a halted predecessor's pending questions are not gated by the escalation
  carve-out, so there is nothing safe to assume about why one exists.
- Do not re-derive the `.filter().at(-1)` "latest recycle_fleet_* event" scan at a third call site — reuse
  the shared private `latestRecycleFleetEvent` both `latestMatchingUnresolvedSettleEvent` and
  `openUnresolvedRecycleFleetAlert` build on.
- Do not narrow `reparentQuestions`, or the resolved-outcome step set
  (`attemptManagerOwnershipTransfer`/`reattemptManagerOwnershipTransfer`) — e.g. making the "questions" step
  non-fatal, or reordering it to run after the resolution marker/`settleRecycleHandoff` fires — without
  re-checking this `cancelStaleEscalationQuestions` safety first. See "Why a 'resolved' outcome is also
  safe ..." above and (R-5)/its positive control in `test/recycle-fleet-resolved-after-halted-settle.mjs`.

## Verification

`test/recycle-fleet-resolved-after-halted-settle.mjs` drives the real watch loop / real
`reattemptManagerOwnershipTransfer`: unresolved alert filed, then the lineage settles (either the watch's
own ready branch, or a `recycle_reattempt` "resolved" outcome), asserting exactly one
`recycle_fleet_resolved` event; a sibling scenario with no prior unresolved alert asserts zero; a later,
separate recycle attempt (a new `freshId`) asserts no stray resolved event bleeds across episodes; and
(R-5)/its positive control prove the unrelated-question safety above.
