# 119019d3 — a by-key clear sweeps cross-hash residue once per freed key, so secondary armed keys are covered

Sibling of `f8e11853` and `cdcd55c2` (read both first).

The question: `deleteMergeQuarantineLatchByKey` passes only `new Set([key])` as the trailing sweep's `freedKeys`, never the entry's secondary `armedKeys`. Could a foreign tmp residue that canonicalises onto a secondary key stay unarmed in-process while a reboot arms it?

Finding: no. Every caller invokes the function once per key it frees (`clearMergeQuarantineByKey` over `keysToLift` and over each pending twin's `plan.ownedArmedKeys`, `clearMergeQuarantineByToken` over `plan.ownedArmedKeys`, `clearMergeQuarantineByRecordedPath`'s pending branch over `pendingOwnedArmedKeys`), so each secondary key is swept with itself as the freed key. The by-id clear needed `cdcd55c2` only because it made ONE sweep call with no per-key loop.

Pinned by `packages/daemon/test/merge-quarantine-119019d3-secondary-key-sweep.mjs` (dual-armed active entry via clear-by-key; pending twin via clear-by-key's pending loop; in-process verdict compared against a snapshot + fresh-module reboot). The test's behavioural RED was proven with a mutant that passes an empty freed-key set to the trailing sweep.

## Do not

- Do not pass the full lifted-key set into each per-key call to "cover" secondary keys: the relevance predicate is deliberately the single key being freed (`f8e11853`), and the per-key loop already unions to the same set.
- Do not drop the per-key loop at a caller in favour of one call with a union without passing the union as `freedKeys` — that is exactly the `cdcd55c2` shape.
