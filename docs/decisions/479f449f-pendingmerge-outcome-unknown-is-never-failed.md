# 479f449f — `PendingMerge.outcome: "unknown"` is a distinct, honest non-answer, never `"failed"`

## Narrative

Card 479f449f: `"unknown"` is set when `worker_merge_confirm` itself threw and a git-log recheck could not prove either way whether the squash had already landed — NEVER `"failed"`, because a genuine confirmed failure is always a RESOLVED `merged:false` (i.e. `"rejected"`), never a throw. The Board still renders this case with the same red "failed" visual treatment, but via the sibling raw `state` field ("failed" there is an honest fact — an exception WAS thrown — independent of this softer `outcome` string), so `mergeDisplay` needs no separate visual case for `"unknown"`.

This is what lets the Board distinguish a rejected merge (amber) from a merged one (phosphor) instead of both reading as green "merged" via `state === "done"` — and, since the `"cancelled"` outcome (card 361520a0, Half Four) landed, from a cancelled one (neither).

## Do not

- Do not map a `worker_merge_confirm` throw to `outcome: "failed"` — a genuine confirmed failure is always a resolved `merged:false` ("rejected"); a throw whose git-log recheck couldn't prove either way is `"unknown"`, a distinct, honest non-answer.
- Do not add a separate `mergeDisplay` visual case for `"unknown"` — the Board already renders it via the sibling raw `state` field's own "failed" treatment.

## Source

Inline comment in `packages/shared/src/types.ts` (`PendingMerge.outcome`'s field doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
