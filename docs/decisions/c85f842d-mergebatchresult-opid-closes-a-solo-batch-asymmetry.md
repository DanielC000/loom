# c85f842d — `MergeBatchResult.opId` closes the solo-vs-batch asymmetry a Code Review surfaced

## Narrative

Card c85f842d — mirrors `ConfirmMergeResult.opId`, closing the asymmetry a Code Review of card `553ea58c` surfaced: the solo merge path has always echoed its `opId` on the sync-settled return, but this batch sibling never did, so a manager whose batch settled INLINE (the common case, under `syncAttachBudgetMs`) had no id to pass to `gate_status(opId)` at all — exactly the durable, post-hoc reader a recycle/restart/successor manager depends on. Set ONLY from inside `mergeBatchTracked`'s own `run(opId)` closure (both the `ok:true` landed return and the `ok:false` rejected/forfeited return) — i.e. only once `pendingOps.attach()` has actually minted a real op for this batch. `undefined` on every EARLIER bail-out this method takes BEFORE ever calling `attach()` (ownership/repo-mismatch refusals, "fewer than 2 eligible candidates", "no gateCommand configured") — those return a synthesized `MergeBatchResult` with no op ever minted, so there is genuinely no id in scope there, unlike the solo path (`ConfirmMergeResult.opId`), which is non-optional because `confirmWorkerMergeTracked` pushes ALL of its own equivalent validation inside `confirmWorkerMerge`, called only from within its own `attach()` closure — this type stays OPTIONAL rather than mirroring that non-optionality, precisely because this method's early bail-outs are real and have no analogous solo-path counterpart. A cached verdict (`r.cacheHit` set) still carries the ORIGINATING op's `opId` here (embedded inside the cached `value` at the settle that first produced it) — a real, resolvable historical op, not a fabricated one.

## Do not

- Do not make `MergeBatchResult.opId` non-optional to mirror `ConfirmMergeResult.opId` — this method has real early bail-outs (ownership/repo-mismatch, too-few-candidates, no gateCommand) that return before `attach()` ever mints an op, with genuinely no id in scope, unlike the solo path.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`MergeBatchResult.opId`): lines 454-469, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
