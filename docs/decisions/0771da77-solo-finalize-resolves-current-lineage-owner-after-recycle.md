# 0771da77 — a solo `worker_merge_confirm`'s post-await finalize also resolves the worker's CURRENT lineage owner

## Narrative

Found by card `2c16447b`'s own audit (worker `cefbd68b`, 2026-09-23), not independently reproduced by the
lead at filing time. A SOLO `worker_merge_confirm` is not broken across a manager recycle at its FRONT —
its ownership check runs once at call time before admission, its attach key is lineage-resolved
(`3a2dac9c`), and its settle nudge is lineage-resolved (`05c36bf4`). But its post-await
`finalizeMerge`/`finishAlreadyMerged` calls still received the CAPTURED (possibly by-then-dead)
`managerSessionId`, so after a recycle mid-confirm:

- `purgeQueuedWorkerReportNudgesOnMerge`/`purgeQueuedWorkerIdleNudges` ran `findAnyLive(deadId)` and
  no-opped, letting stale worker-report/idle nudges survive into the successor's queue as redundant turns;
- `maybeDrainCapQueue(deadId)` targeted the dead session, so the successor's own cap-queued spawns might
  not auto-fire on the freed slot;
- the `merge_done` event was attributed to the dead id instead of the session actually doing the work now.

Introduced by commit `ce1b65578`, landed (via this card's own merge sha `c90b99c`) the same day `2c16447b`
fixed the identical tail on the batch green path.

## Decision

The solo confirm's post-await finalize reuses `2c16447b`'s own resolver (`resolveLineageOwnerForWorker` —
named `resolveBatchCandidateOwner` at the time this card landed, renamed by the follow-up card `b7da7aaf`
once both paths used it) rather than a second, independently-written one. Two call sites in
`sessions/service.ts` resolve it, both falling back to the captured `managerSessionId` only when
resolution yields `null`:

- the **ALREADY_MERGED** finish (`amOwner`, just before `finishAlreadyMerged`'s idempotent bookkeeping);
- the **GREEN / real-landing** finish (`owner`, right after the gate/merge awaits resolve, before the
  stale-idle-nudge purge and the hard stop) — this is the site the `@decision 0771da77` anchor sits on.

Everything downstream of that resolution — the stale worker-report/idle nudge purge, the cap-queue drain,
and the `merge_done` event's attribution — runs under the resolved CURRENT owner, so a manager recycle
that happens while a solo confirm's gate/merge is in flight no longer strands that bookkeeping on a
session that is already gone.

## Do not

- Do not pass the `managerSessionId` captured when a solo confirm started to any call made AFTER its
  gate/merge awaits resolve — a manager can recycle during that wait; resolve the worker's current lineage
  owner at the point of use instead, exactly like the batch path's own fallback dispatch (`2c16447b`).
- Do not write a second resolver for this — reuse the one function both the batch and solo paths share;
  a second, independently-maintained copy is how the two would silently drift apart.
- Do not skip resolving on the ALREADY_MERGED finish just because no new commit lands there — the same
  stale-nudge-purge and cap-queue-drain tail runs on that path too, under the identical dead-id risk.
- Do not fall back to `null` itself when resolution fails — fall back to the originally captured
  `managerSessionId`, same as every other caller of this resolver; a bookkeeping call with no manager id
  at all is worse than one addressed to a session that may already be gone.

## Related

`2c16447b` (the batch-path sibling fix; this card applies the identical resolver to the solo path) ·
`b7da7aaf` (renamed the shared resolver once this card made it a two-path function) · `3a2dac9c` /
`05c36bf4` (the solo confirm's own earlier lineage-resolution fixes, at attach and at the settle nudge,
that this card's post-await gap had not yet closed).
