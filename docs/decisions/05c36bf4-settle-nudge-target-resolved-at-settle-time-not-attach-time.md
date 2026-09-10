# 05c36bf4 — a settle nudge re-resolves its target lineage AT SETTLE TIME, never at attach() time

## Narrative

Card 05c36bf4: `resolveSettleNudgeTarget` is the single choke point BOTH `PendingOpRegistry` settle
callbacks (`confirmWorkerMergeTracked`'s manager-owned "merge" nudge, `runWorkerGate`'s worker-owned
"gate" nudge) route their `pty.enqueueStdin` target through, instead of each hand-rolling its own
lineage walk. Reuses `liveLineageSuccessor` — the SAME primitive `deliverSessionMessage` already uses
for the card-`2ca18433` durable-message precedent — so there is still exactly ONE place that walks a
`recycledFrom`/successor chain; this is only a thin fallback wrapper around it.

Real incident (finding `2e42ae6b`): a merge op's settle callback closes over the ASKING manager's session
id at `attach()`-call time; if that manager recycles before the async gate/merge settles, the callback
fired its `[loom:merge-done]` at the now-dead predecessor — the successor never heard it, and instead
spent 30 minutes re-deriving the outcome from git and nearly re-drove an already-merged branch. Calling
`resolveSettleNudgeTarget` immediately before `enqueueStdin` re-resolves to whoever is CURRENTLY live in
the lineage at settle time, not whoever asked when the op started.

Three outcomes: `sessionId` itself if still live (never recycled, or IS the live end of its own chain) →
returned unchanged, so the common (non-recycled) case is byte-identical to before this existed. Recycled
with a live successor → the live successor's id. WHOLE lineage dead (no live session anywhere, including
`sessionId` itself) → `sessionId` UNCHANGED, so the caller's existing best-effort `enqueueStdin` try/catch
still silently no-ops exactly as it did before — deliberately NOT widened into `deliverSessionMessage`'s
board-a-task fallback here (out of scope for this card); the fully-dead-lineage case is already covered
by `confirmWorkerMergeTracked`'s own dead-owner eviction sweep (card `27ea069e`) on the NEXT confirm call,
and by `tasks_get`'s git-derived `merged` field either way.

## Do not

- Do not resolve a settle nudge's target at `attach()`-call time and hold onto it — resolve it AT SETTLE
  TIME (immediately before `enqueueStdin`), or a manager/worker recycle mid-flight fires the nudge at a
  now-dead predecessor and the live successor never hears it.
- Do not widen the whole-lineage-dead case into `deliverSessionMessage`'s board-a-task fallback here —
  that case is already covered by the dead-owner eviction sweep and `tasks_get`'s git-derived `merged`
  field; out of scope for this card.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `resolveSettleNudgeTarget`: lines
6333-6356, as of main `1cbc0d74`. Relocated by card `61632c05` (tranche 15); no wording changed, wrapped
source lines joined into a flowing paragraph and the `*` comment markers stripped.
