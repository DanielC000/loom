# dbc6f660 — `batch_merge_forfeited` is the ONE failure mode batching makes strictly worse than solo merges

## Narrative

Card dbc6f660: the batch-merge-gate FORFEIT case — canonical main advanced between a batch worktree being cut and its post-gate fast-forward, so the batch's single gate never validated main's real current tree. The batch is abandoned (never landed) and every candidate falls back to its own individual gate, exactly like today.

`detail` carries `{ opId, repoPath, baseMainSha, currentMainSha, reason, branches: [{ workerSessionId, taskId, branch }] }`. `currentMainSha` is the canonical HEAD `fastForwardCanonicalMain` observed instead of `baseMainSha`; it is typed optional (mirroring `RunBatchedMergeResult`) but in practice is ALWAYS present whenever this event fires, since `forfeited` and `currentMainSha` are only ever set together — an absent value would be OMITTED from `detail` (not emitted as `null` or `"undefined"`), matching how `appendEvent` (db.ts) already drops any undefined-valued key on `JSON.stringify`.

The per-branch identity list is what keeps "which branches did this one batch opId cover" recoverable (`LOOM_GATE_OP_ID` is a cross-project contract read by Codescape's gate child; batching re-means its per-run unit from "one branch" to "up to maxWorkers branches" without renaming/dropping it — see `gateOpIdEnvOverride`'s own doc in `sessions/service.ts`). This is the ONE failure mode batching makes strictly worse than today (1 branch's gate wasted → up to K), so it is instrumented distinctly from an ordinary `merge_rejected`/`build_gate` failure rather than folded into either.

## Do not

- Do not fold a batch forfeit into an ordinary `merge_rejected`/`build_gate` failure kind — it is instrumented distinctly because it is the one failure mode batching makes strictly worse than a solo merge (up to K branches' gates wasted, not just 1).
- Do not emit `currentMainSha` as `null`/`"undefined"` when absent — omit the key entirely, matching `appendEvent`'s existing `JSON.stringify` behavior.

## Source

Inline comment in `packages/shared/src/types.ts` (`OrchestrationEventKind`'s `batch_merge_forfeited` case doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
