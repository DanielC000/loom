# 479f449f — `PendingMerge.outcome: "unknown"` is a distinct, honest non-answer, never `"failed"`

## Narrative

Card 479f449f: `"unknown"` is set when `worker_merge_confirm` itself threw and a git-log recheck could not prove either way whether the squash had already landed — NEVER `"failed"`, because a genuine confirmed failure is always a RESOLVED `merged:false` (i.e. `"rejected"`), never a throw. The Board still renders this case with the same red "failed" visual treatment, but via the sibling raw `state` field ("failed" there is an honest fact — an exception WAS thrown — independent of this softer `outcome` string), so `mergeDisplay` needs no separate visual case for `"unknown"`.

This is what lets the Board distinguish a rejected merge (amber) from a merged one (phosphor) instead of both reading as green "merged" via `state === "done"` — and, since the `"cancelled"` outcome (card 361520a0, Half Four) landed, from a cancelled one (neither).

## Why reaching this classification at all is meaningful (site: `confirmWorkerMergeTracked`'s `classifyOutcome`)

The recovery attempt wired into `confirmWorkerMergeTracked`'s own `run` callback already reports a real
`"merged"` whenever the throw can be PROVEN to have struck after a landed squash — so reaching this
`"unknown"` classification at all means that recovery could NOT prove it either way, which is a
MATERIALLY weaker claim than `"failed"` and must not be worded as one. The Board's `mergeDisplay` still
renders a thrown-exception op as "failed" (red) via the entry's own raw `state` field, unaffected by this
classified `outcome` string — deliberately left as-is: `state` is a true, unambiguous fact ("an exception
was thrown"), unlike the softer, honest-non-answer `outcome`.

## Race recovery: why a thrown error in the `attach` run callback does not mean the merge failed

A thrown error here does NOT mean the merge failed — the dead-owner eviction check above (inside `confirmWorkerMergeTracked`, at the `pendingOps.attach` call) is a STATIC "owner exited" test that can evict a genuinely RUNNING op and let THIS call re-mint a fresh `confirmWorkerMerge` while the evicted op's own orphaned `run()` is still executing in the background (`evictDeadOwner` never cancels it — see `PendingOpRegistry`'s DEAD-OWNER RECOVERY doc). `finalizeMerge` removes the worktree BEFORE a fresh mint's own early-idempotency check can catch up to it, so the fresh confirm can throw operating on a directory its own predecessor just deleted — AFTER that predecessor's squash had already committed (`finalizeMerge` only ever runs post-squash, never before). Re-derive the truth from git instead of trusting the throw: if the branch's work is already on main, report the REAL outcome (merged) via the same idempotent path a stale retry already uses (`finishAlreadyMerged`, safe to call redundantly), instead of a false failure for work that already landed. NEVER swallows a genuine failure — if the branch never landed, this falls through and rethrows the original error unchanged, so the classification below still reports it (as `"unknown"`, not `"failed"`).

### Do not (this section)

- Do not treat a thrown error from the `pendingOps.attach` run callback as a confirmed merge failure — the dead-owner eviction check above it can evict a genuinely running op and let a fresh call re-mint while the evicted op's own orphaned `run()` is still executing, so the throw can strike a directory `finalizeMerge` already cleaned up post-squash.
- Do not skip the git re-derive before reporting failure — a stale retry's own idempotent path (`finishAlreadyMerged`) already exists for exactly this case and is safe to call redundantly.
- Do not swallow a genuine failure either — if the branch never landed, the original error is rethrown unchanged so the classification still reports it as `"unknown"`, never silently.

### Source (this section)

Inline comment in `packages/daemon/src/sessions/service.ts`, above the `pendingOps.attach` call inside `confirmWorkerMergeTracked` (the run-callback's "RACE RECOVERY" comment). Relocated by card `f885351f` (service.ts pre-frontier residue); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.

## Do not

- Do not map a `worker_merge_confirm` throw to `outcome: "failed"` — a genuine confirmed failure is always a resolved `merged:false` ("rejected"); a throw whose git-log recheck couldn't prove either way is `"unknown"`, a distinct, honest non-answer.
- Do not add a separate `mergeDisplay` visual case for `"unknown"` — the Board already renders it via the sibling raw `state` field's own "failed" treatment.

## Source

Inline comment in `packages/shared/src/types.ts` (`PendingMerge.outcome`'s field doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
