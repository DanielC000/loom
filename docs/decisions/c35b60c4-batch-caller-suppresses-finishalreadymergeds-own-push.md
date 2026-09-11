# c35b60c4 — `mergeBatchTracked` suppresses `finishAlreadyMerged`'s own per-branch push via `suppressNotify`

## Narrative

`mergeBatchTracked` calls `finishAlreadyMerged` once per LANDED branch, and on that path every one of those branches legitimately resolves ALREADY_MERGED — the batch's own single fast-forward already put every branch's work on main (see `mergeBatchTracked`'s own header doc). None of them is a stale retry, so the STALE-REDELIVERY `alreadyFinalized` guard (card `369d8824`) is `false` for every one of them, and `finishAlreadyMerged`'s own push would otherwise fire K times for one batch — measured live on a real specimen. `suppressNotify` (set ONLY by `mergeBatchTracked`) skips this method's own per-branch push entirely; `mergeBatchTracked` sends ONE aggregate notice for the whole batch instead, once, naming every landed branch, from its own settle callback. This is a NEW, EXPLICIT opt-out, not a widening of the `alreadyFinalized` guard (which stays reserved for the stale-retry case it was built for) — every non-batch caller omits this flag and keeps today's push behavior byte-identical.

## Do not

- Do not widen the stale-retry `alreadyFinalized` guard to also cover the batch-landed case — it is a deliberately separate opt-out (`suppressNotify`), not an extension of that guard.
- Do not let `finishAlreadyMerged` push its own per-branch notice when called from a batch landing — that floods the manager with K separate notices; the aggregate notice belongs to the caller.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `finishAlreadyMerged`'s own JSDoc ("BATCH CALLER SUPPRESSION"), as of this tranche's HEAD.
