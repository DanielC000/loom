# f944d4e4 — `mergeBatchTracked` is keyed through `PendingOpRegistry.attach` so a client-timeout retry re-attaches instead of cutting a second worktree

## Narrative

Card f944d4e4, following card `46ebdf20`'s DoD-3 finding: a client-side timeout on `mergeBatchTracked`
(it awaits the whole batch synchronously) used to have no cheap re-poll — a re-fire minted a fresh `opId`
and cut a whole new batch worktree before the pre-existing per-repo merge-admission guard (`GateSemaphore`'s
`activeMergeRepos`) serialized it behind the first call, wasting real work every time (safe, never
corrupting, but wasteful — see that card's own measurement).

The method is now keyed through `PendingOpRegistry.attach` — kind `"merge"`, key
`merge-batch:${managerSessionId's LINEAGE ROOT}:` plus the SORTED, comma-joined LINEAGE ROOTS of the
resolved `chosen` batch's `workerSessionId`s (computed AFTER ownership/repo/stranded-work filtering, i.e.
the set that will actually be gated together, not the raw request) — so a re-fire with the SAME resolved
candidate set re-attaches to the already-running (or just-settled) op instead of starting a second one: no
second worktree cut, no second `opId` minted, no second gate run. Two things are DELIBERATELY excluded from
the key: `baseMainSha` (main can legitimately advance between a call and its retry — folding it in would
make a genuine retry mint a fresh op, defeating the point) and the caller's raw, unsorted
`workerSessionIds` array (an identical logical set reordered across a retry must still dedupe-hit). See
[[3a2dac9c-recycle-never-aliases-key-walk-the-ancestor-chain]] for why the roots are LINEAGE roots and not
raw session ids — a card `3a2dac9c` refinement of this same key, needed because a mid-batch recycle became
an ordinary event once card `81d795de` widened the finalize window.

RESIDUAL (intentionally left open, not closed by more machinery — scope narrowed by the lineage-rooting
fix above): if the resolved `chosen` set itself changes between attempt 1 and attempt 2 — a candidate
dropping out via ownership/repo/stranded-work filtering in between (a mid-batch RECYCLE of the manager or a
candidate no longer does this) — the key differs and the retry runs fresh. This is believed correct (a
different resolved set is a genuinely different batch), and stable for the ordinary client-timeout case (a
`done`+`awaitingReview` candidate doesn't change resolution between a call and its retry) — but it is a
real, named gap, not a proven-closed one.

This dedupe/attach primitive is orthogonal to the batch path's own finalize logic — see
[[3d2afb53-batched-merge-gate-emit-compare-reads-detail-not-verdict-payload]]'s "do not" on this point.

## Do not

- Do not mint a fresh `opId`/cut a second batch worktree on a client-timeout retry with the SAME resolved candidate set — key through `PendingOpRegistry.attach` so the retry re-attaches instead.
- Do not fold `baseMainSha` into the dedupe key — main can legitimately advance between a call and its retry, and folding it in would defeat the dedupe.
- Do not key on the caller's raw, unsorted `workerSessionIds` array — sort it first, or an identical logical set reordered across a retry fails to dedupe-hit.
- Do not assume the RESIDUAL gap above is closed by the lineage-rooting fix — a genuinely changed resolved `chosen` set between attempts still mints a fresh op, by design, and remains a real, named gap.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `mergeBatchTracked`'s own JSDoc header, as of this tranche's HEAD.
