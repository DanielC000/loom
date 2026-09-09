# 19256231 — `fallbackOfBatchOpId` marks a batch's per-branch fallback merge so it isn't mistaken for an ordinary solo merge

## Narrative

Card 19256231: set ONLY on a per-branch MERGE gate that `mergeBatchTracked`'s own `runFallback` spawns (via `confirmWorkerMergeTracked`) after a batch's shared gate already ran and produced an outcome that needs individually-gated candidates (a RED gate, a forfeit, or a green batch's own dropped/overflow/stranded candidates) — carrying that batch's OWN `opId` (the same id its `[loom:merge-batch-*]` settle nudge already names). A fallback descriptor otherwise looks IDENTICAL to an ordinary solo `worker_merge_confirm` (real `taskId`, real `branch`, a real `workerLabel` — never the batch's own `taskId:null`/`branch:null` shape `batchBranches` marks), so the documented "look for taskId:null/branch:null/workerLabel:Orchestrator" trick for finding a live batch op is structurally BLIND to these rows: it was written to find the batch's own gate, and filters out exactly the rows a rejected batch spawns. This field lets a `gate_queue` reader recognize one of those rows as "spawned by MY batch op X" rather than mistaking it for an unrelated, ordinary merge. `undefined`/absent on a batch's own gate descriptor (self-identifies via `batchBranches` instead), on every genuinely ordinary solo merge, and on the two early-return batch fallback paths (too few eligible candidates, no `gateCommand` configured) — neither ever mints a batch op to point back to.

## Do not

- Do not rely on the "taskId:null/branch:null/workerLabel:Orchestrator" heuristic to find a batch's per-branch fallback rows in `gate_queue` — it finds only the batch's OWN gate and structurally misses every fallback row `fallbackOfBatchOpId` marks.

## Source

Inline comment in `packages/daemon/src/orchestration/gate-semaphore.ts` (`GateDescriptor.fallbackOfBatchOpId`): lines 139-153, as of commit `5f6d9fd981336bfafd530fada633b229677aa081`. Relocated by card `9641742e`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
