# 171297dc — a CANCELLED settle is not a verdict; it must never be cached and replayed forever

## Narrative

A CANCELLED settle (`gate_cancel` withdrew a QUEUED merge confirm — `confirmWorkerMergeTracked`'s own `classifyOutcome` maps that shape to exactly the string `"cancelled"`) is NOT a verdict — no gate ever ran, nothing was validated — so there is nothing here for a later plain re-call to safely reuse, unlike a real PASS/REJECTION. Before this card, `PendingOpRegistry`'s until-superseded write was truly unconditional: a cancelled outcome got cached exactly like a real one and replayed to every future re-call FOREVER (that map has no expiry) — a manager re-calling per the tool's own documented retry contract kept being handed back the SAME stale "cancelled by manager … via gate_cancel" reason, tens of minutes after the fact, with no new op ever minted. `"cancelled"` is also the exact string every "no verdict reached" settle across this codebase already converges on (`ConfirmMergeResult.cancelled`/`WorkerGateResult.cancelled`, `gate_status`'s own `outcome` field) — so `NEVER_CACHED_OUTCOMES` needed no new service-layer opt-in to take effect against it.

## Do not

- Do not cache a `"cancelled"` classified outcome in the until-superseded verdict cache (or serve it from the TTL'd retained cache) — it is not a verdict, and a manager's documented retry ("just re-call") would otherwise be handed the same stale cancellation forever.

## Source

Inline comment in `packages/daemon/src/orchestration/pending-ops.ts` (the class doc's `"cancelled"` paragraph): lines 317-329, as of commit `507e966583ff18068f5e7e56942acfe67001ee94`. Relocated by card `a1491009` (tranche 1); no wording changed beyond joining wrapped source lines into a flowing paragraph and stripping `*` comment markers.
