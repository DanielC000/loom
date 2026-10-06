# b4080777 — a refused batch ff's terminal event is `merge_landing_aborted`, never `merge_rejected`

## Narrative

Follow-up to `1ac74580`, which fires `merge_landing_started` once per landed batch candidate right before
`fastForwardCanonicalMain`. That card's "Known residual" section named the gap this card closes: when the
fast-forward is refused, every candidate in `landed` was left at `merge_landing_started`, nothing
following. If that worker later becomes a stale generation, `resolveStaleGenerationOwnLanding` attempts
attribution and — when it can't verify a landing — raises a false `[loom:merge-orphaned] … may need to be
redone` nudge. Not a regression (the pre-`1ac74580` code escalated the same row too, via a cruder check),
but a genuine gap.

## Why not just reuse `merge_rejected`

The obvious fix — append a `merge_rejected` event per landed candidate on every refusal — was rejected
after auditing what that kind drives beyond a lifecycle-terminal marker. `merge_rejected` is a member of
`EVENT_TRIGGER_EVENT_KINDS` (a user outbound webhook), `attention-push.ts`'s `classify()` → `"merge-gate"`
(a companion push alert), and `lib/fleet.ts`'s `buildLatestMergeMap` (the fleet "latest merge" UI); also
`auditReplay.tsx`'s RED tone, `ORCH_ACTIVITY_KINDS`, `DURABLE_AUDIT_EVENT_KINDS` — but NOT
`GATE_HISTORY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS`. `merge_landing_aborted` keeps the harmless bookkeeping
but is EXCLUDED from the webhook/alert/fleet-flip, with its own amber `auditReplay.tsx` treatment (never
red). `classifyOutcome` reads `outcome.value` in memory, never a DB kind, so is unaffected either way.

This matters most for `forfeited`/the generic ff-failure shape: both reach the generic `if (!result.ok)`
handler, which calls `runFallback` WITHOUT `noStart` — it genuinely starts a real solo fallback that may
well succeed, so firing a `merge_rejected`-keyed webhook/alert/fleet-flip there would be actively
misleading. A per-event skip-flag on `merge_rejected` was rejected as broader-blast-radius instead.

## The `landingStarted` field, not an inference off `batchHeadSha`

`RunBatchedMergeResult.landingStarted` is `true` on every return AFTER `onBeforeFastForward?.(landed)`
runs. `batchHeadSha !== undefined` would have worked as a proxy today too, but was rejected: inferring a
load-bearing fact from another field's happenstance presence is what `quarantined`/`branchDiverted` avoid.

## `mayHaveLanded` — three shapes deliberately excluded; the ff may have landed

Per `1ac74580`'s own residual note, `unverified` means the `--ff-only` call did not throw (the landing
most likely DID happen), only the post-ff re-read failed — writing `merge_landing_aborted` there would be
a false claim. Confirmed (by reading, not by name) that `attributeStaleGenerationOwnLanding` (card
`e5458ccd`) already covers it: a trailer-based content-match scan of mainline for a `Loom-Worker-Branch`
trailer, which `landBranchCommitsIndividually` stamps on every batch candidate commit.

Round 2 (Code Review) found TWO MORE shapes sharing this property: an ff-level `quarantined` from
`treeDeathUnconfirmed` (its own `reason` already says main may be at `targetSha` if the merge landed
before the kill), and a POST-ff `branchDiverted` whose `post.sha !== targetSha` — the `--ff-only` call
itself succeeded (no throw), so our content WAS placed on main; the mismatch means something else
advanced main further before the re-read, not that our landing never happened. A third, narrower gap: the
generic ff-failure path's own post-failure HEAD re-read can itself fail, leaving no way to tell — only
THAT sub-case gets the flag; a re-read that succeeded and simply disagrees with `targetSha` does not.

`FastForwardResult`/`RunBatchedMergeResult` both carry an explicit `mayHaveLanded?: boolean`, set at
exactly these three sites plus `unverified`. The branch-mismatch `branchDiverted` sub-case
(`post.branch !== expectedBaseBranch`, `post.sha === targetSha`) is UNCHANGED — that content landed, but
never onto the real mainline ref, so attribution would never find it there anyway. `mergeBatchTracked`'s
centralized abort write gates on `result.mayHaveLanded`, never the narrower `result.unverified` alone.

## Do not

- Do not write `merge_rejected` for a refused batch fast-forward — see above.
- Do not write `merge_landing_aborted` for a `mayHaveLanded:true` outcome (`unverified`, an ff-level
  unconfirmed-kill `quarantined`, or a post-ff sha-mismatched `branchDiverted`) — the ff may have landed.
- Do not set `mayHaveLanded` on a generic ff-failure whose post-failure HEAD re-read SUCCEEDED and simply
  disagrees with `targetSha`, or on the branch-mismatch-but-sha-matches `branchDiverted` sub-case — both
  are confirmed non-landings (the latter landed, but never onto the real mainline ref).
- Do not infer "did `onBeforeFastForward` fire" from `batchHeadSha`'s presence — use the explicit
  `RunBatchedMergeResult.landingStarted` field.
- Do not stamp a `branch` field on `merge_landing_aborted`'s `detail` — same rule as `merge_landing_started`.
- Do not add `merge_landing_aborted` to `EVENT_TRIGGER_EVENT_KINDS`, the companion `classify()`, or
  `buildLatestMergeMap` — all three deliberately exclude it.
- Do not move the centralized write after the per-outcome branches — fires once, ahead of all of them.

Tests: `merge-landing-aborted-batch-refusal.mjs` — (A) forfeited (latest-wins), (B) branchDiverted
(pre-ff), (C)/(E) ff-quarantined (confirmed vs. unconfirmed kill), (D) unverified, (F) post-ff
sha-mismatched branchDiverted, all through REAL `mergeBatchTracked`; (D)/(E)/(F) re-task + reconcile to
prove attribution resolves without escalating. `worktree-recycle-alias-protection.mjs` (fixture Z).
