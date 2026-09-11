# 8fb05b2d — suppress a stale merge-rejected notification only when the situation already resolved out-of-band

## Narrative

A `[loom:merge-rejected]` pty notification can otherwise fire long after the situation it describes has already resolved out-of-band — e.g. a client-timeout on `worker_merge_confirm` leaves the manager to manually squash-merge the task itself, then the ORIGINAL `confirmWorkerMerge` run (or a retry that re-invoked it from scratch once the pendingOps entry had already settled and been evicted) finishes and delivers a stale "build gate failed" — burning the manager's turns confirming an echo of something already resolved.

`shouldSuppressMergeReject` (`packages/daemon/src/sessions/service.ts`) reconciles BEFORE notifying. It suppresses the NOTIFY only — never the caller's `merged:false`/`reason` return value, nor the `merge_rejected` event, both of which stay accurate bookkeeping regardless — when any of:

1. the task's card is already in its project's terminal (Done) lane — the situation resolved another way; or
2. the branch's work is already reachable from main, reusing the SAME ancestry check the ALREADY_MERGED path derives from (`findLandedSquashCommit`'s deterministic `Loom-Worker-Branch` trailer scan) rather than a second, independent one; or
3. an identical rejection (same worker + reason + sha) was already recorded for this task, so a stale re-run reproducing the same failure doesn't notify twice — see [[e21c756a-merge-reject-dedupe-discriminator-is-validated-sha]] for why the identity check here is keyed on the validated sha, not on worker+reason alone or on `opId`.

Fails safe throughout: any read or git error along the way is treated as "not resolved yet" — never as license to suppress a genuine first notification just because a check happened to be flaky.

## Do not

- Do not suppress the return value or the `merge_rejected` event — only the pty NOTIFY is suppressed; the bookkeeping must stay accurate even when the human-facing ping is swallowed.
- Do not treat a read/git error as "resolved" — fail toward notifying, never toward silently swallowing a real failure.
- Do not re-derive the merged-to-main check independently — reuse `findLandedSquashCommit`, the same check the ALREADY_MERGED path already relies on, rather than a second ancestry check that could disagree with it.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `shouldSuppressMergeReject`: originally lines 11316-11333, as of service.ts tranche 40's HEAD. Extracted by tranche 40.
