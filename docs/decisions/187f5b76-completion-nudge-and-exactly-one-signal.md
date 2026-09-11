# 187f5b76 — EXACTLY-ONE-SIGNAL: the completion nudge (fb8df559 Part 2) never lands alongside a rich direct push for the same op

## Narrative

The completion nudge originates in card `fb8df559` Part 2: when `confirmWorkerMergeTracked` degrades to
the pending path, the asking manager is left to spin-poll (re-call this tool /
`worker_list.pendingMerge`) to learn the outcome. `pendingOps.attach`'s `onSettledAfterPending` fires
exactly once, only for a key that was actually surfaced pending, straight from the op's terminal settle —
so a manager that went off and did something else instead of polling still gets pushed a turn the moment
the gate/merge actually finishes. `kind:"warning"` because this is a Loom operational nudge (same-route
coalescing is correct), mirroring the decision-inbox answer nudge / answered-stuck watchdog's use of the
same `enqueueStdin` rail. The FAST (already-fast) path never reaches this callback at all — that caller
already has the outcome inline via its own return value.

Cards `369d8824` and `187f5b76` each separately WIDEN that fb8df559 Part 2 nudge (two distinct widenings
of the same base decision, not one widening the other).

## EXACTLY-ONE-SIGNAL — card 187f5b76's own decision

`outcome.value.notified`/the `opId` param are threaded from the SAME single `confirmWorkerMerge`
invocation this callback is reporting on, so this generic echo and any rich direct push
(`rejectNotify`'s `[loom:merge-rejected]`, `finishAlreadyMerged`'s `[loom:already-merged]`) can never
both land for one op — see `notified`'s own doc (card `9eea3901`, cited in the surrounding code, not in
this removed comment) for exactly which branches set it. `opId` is echoed on EVERY branch (including the
synchronously-thrown-error branch, which has no `outcome.value` of its own to carry one) so a manager
running several concurrent merges can always match this nudge back to the `worker_merge_confirm` call
that produced it.

## Do not

- Do not let a manager degraded to the pending path spin-poll for the outcome — `onSettledAfterPending`
  pushes it a turn the moment the op actually settles.
- Do not fire both the generic completion echo and a rich direct push for the same op — `notified` gates
  the generic echo so exactly one signal ever lands per op (EXACTLY-ONE-SIGNAL, card 187f5b76's own).

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMergeTracked`'s own JSDoc
header (the "COMPLETION NUDGE" and "EXACTLY-ONE-SIGNAL" paragraphs), as of commit `672c0e12f5`. The
`card 9eea3901` cross-reference in EXACTLY-ONE-SIGNAL is sourced from the surrounding CODE (`notified`'s
own doc comment, `service.ts` ~line 399, and its consuming site ~line 15014 as of this tranche's HEAD),
not from the removed comment itself.
