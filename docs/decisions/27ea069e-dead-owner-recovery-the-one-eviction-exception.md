# 27ea069e — dead-owner recovery: the ONE exception to evict-on-settle-only

## Narrative

Evict-on-settle (deleting an entry from the map the moment it settles, inside `run()`'s own `.then`/`.catch`) is right for the normal case, but a `run()` invocation can outlive the manager session that started it — that manager crashed, was stopped, or is otherwise gone — with no live caller left who could ever be handed its outcome through the normal settle path. `evictDeadOwner()` force-removes such an entry AHEAD of its own settlement, letting a fresh `attach()` on the same `key` start a genuinely new invocation instead of dedup-attaching to (or spin-polling) one that can never be delivered. See `SessionService.confirmWorkerMergeTracked` (per-call defensive check) and `reconcileDeadOwnerMergeOps` (boot-time sweep).

**Accepted tradeoff:** `evictDeadOwner` can only remove the MAP ENTRY, never cancel the orphaned `run()` itself (there's no handle to cancel a bare Promise) — the old op's real work keeps executing in the background, unreachable, until it eventually settles on its own. That late settle is harmless: `attach()`'s identity-guarded delete (`this.entries.get(key) === fresh`) means it can only clear its OWN (already-detached) entry, never the successor `evictDeadOwner` made room for — so the tradeoff trades "stuck pending forever" for a lingering, functionally-inert background call, not a resurrected/duplicated result. The remaining host-load question — could the orphaned run and its successor both drive a real gate command CONCURRENTLY — is bounded by the daemon-global `GateSemaphore` (`orchestration.maxConcurrentGates`): it serializes actual gate RUNS across the whole daemon, so the orphaned run and the fresh one can't execute gates at the same time even though both are technically "in flight" JS-side.

## Do not

- Do not treat `evictDeadOwner` as cancelling the orphaned invocation — it only detaches the map entry; the old `run()` keeps executing in the background until it settles on its own, harmlessly, because the identity-guarded delete can only clear its own entry.

## Source

Inline comments in `packages/daemon/src/orchestration/pending-ops.ts`: the class doc's "DEAD-OWNER RECOVERY" paragraph (lines 244-250) and `evictDeadOwner`'s own "ACCEPTED TRADEOFF" paragraph (lines 487-497), as of commit `507e966583ff18068f5e7e56942acfe67001ee94`. Relocated by card `a1491009` (tranche 1); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
