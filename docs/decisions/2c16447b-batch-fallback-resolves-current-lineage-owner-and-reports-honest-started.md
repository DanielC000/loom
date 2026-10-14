# 2c16447b — a `merge_batch` red/fallback resolves each candidate's CURRENT lineage owner, and never claims routing that didn't start

## Narrative

Specimen from lead `gen 368` (2026-09-23): batch op `d39a7fe7` (4 candidates) settled RED. Its result and
`[loom:merge-batch-failed]` nudge both said "4 candidate(s) routed to an individual worker_merge_confirm
instead", but `gate_queue`/`gate_history`/`worker_list` all showed NO fallback ever ran, and none of the 4
workers were notified — the batch reported routing that never happened. The batch had been fired by a
predecessor manager session that recycled minutes before the red; the fallback spawn was keyed to that
now-gone ORIGINAL owner session id. Introduced by commit `793efe507`, landed as this card's own merge sha.

## Decision

`resolveLineageOwnerForWorker(originalManagerId, workerSessionId)` (`sessions/service.ts`; named
`resolveBatchCandidateOwner` at this card's own landing, renamed by the follow-up card `b7da7aaf` once the
solo path reused it too — see `0771da77`) resolves a worker's CURRENT parent, but **only** when that
parent is `originalManagerId` itself or a `recycled_from` descendant of it (walking `getSuccessor`). Any
other parent, or a vanished worker, yields `null` — it never adopts an unrelated manager's worker.

`runFallback` (the per-candidate `worker_merge_confirm` dispatcher every red/forfeit/dropped-candidate
path routes through) calls this **fresh, per candidate**, at fallback time — not the `managerSessionId`
captured when the batch call started, which may be ~25 minutes stale by the time a gate settles and a
fallback actually fires. A candidate whose resolution returns `null` is reported `started:false` with a
reason naming why (`"worker is not a child of this manager or its recycle lineage"`), rather than being
silently dispatched to nobody or silently dropped.

`MergeBatchResult.fallback[].started` (`true`/`false`) makes this check-able: `true` means the per-branch
confirm was actually kicked off (running, settled, or attached to an in-flight op); `false` means it was
NOT, with `reason` saying why. The settle-nudge's own `fallbackSummary` counts **only** `started` entries
as "routed" — a `started:false` candidate is called out separately as needing a manual re-confirm, never
folded into the same "N routed" count a reader would otherwise read as complete.

The same resolver is used on the GREEN path too: a landed batch candidate's post-gate
`finishAlreadyMerged` call (the purge of stale worker-report/idle nudges, the cap-queue drain) runs under
the worker's resolved current lineage owner, falling back to the captured id only when resolution yields
`null` — so a recycle mid-gate doesn't strand that bookkeeping on a dead manager id either.

## Do not

- Do not pass the `managerSessionId` captured at batch-call-start to any post-await, per-candidate
  ownership-checked call (a fallback confirm, or the green path's `finishAlreadyMerged`) — resolve each
  candidate's CURRENT lineage owner at the point of use instead; a captured id can be ~tens of minutes
  stale by the time a gate settles.
- Do not silently drop or silently "succeed" a candidate whose lineage owner cannot be resolved — report it
  in `fallback` with `started:false` and a reason naming the cause, so a manager reading the result (or the
  nudge) can see exactly which candidates still need a manual `worker_merge_confirm`.
- Do not count an unstarted (`started:false`) candidate in the settle-nudge's "N routed" summary — only
  `started` entries were actually dispatched; the nudge text must never claim routing that did not happen.
- Do not adopt ANY parent other than `originalManagerId` itself or a verified `recycled_from` descendant of
  it — an unrelated manager's worker must never be acted on just because it happens to share a repo or
  project.
- Do not write a second resolver for the solo confirm's own post-await finalize — it reuses this exact
  function (see `0771da77`); a second, independently-maintained copy is how the two paths would drift.

## Related

`0771da77` (the solo-confirm twin of this fix, same resolver) · `b7da7aaf` (renamed the resolver once the
solo path adopted it) · `42daa283` (a separate, later-discovered gap in the SAME specimen's retained-branch
handling).
