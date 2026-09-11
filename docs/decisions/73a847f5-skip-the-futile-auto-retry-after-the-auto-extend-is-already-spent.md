# 73a847f5 — skip the transient-kill auto-retry when a timeout already spent its one auto-extend

## Narrative

BUDGET-EXCEEDED SHORT-CIRCUIT (card 73a847f5): a timeout that already consumed its one output-gated auto-extend (`anyExtended` — card `24642c3d`, the auto-extend's own card) cannot pass the transient-kill auto-retry ([[bcba83a1-classify-gate-failure-so-managers-stop-routing-around-the-gate]]), which always runs with `allowExtend:false` — it is a hard-bounded rerun of a run that only survived its first attempt because of the extension net it no longer has. Running it anyway burns up to a full `gateTimeoutMs` of the daemon's shared, capped `GateSemaphore` lane (a co-tenant may be queued behind it) to reach a foregone conclusion, then reports a generic "gate failed" that recruits the wrong fix.

The skip applies to ONLY this exact precondition. A "kill" classification, or a "timeout" that never got to extend, are both untouched and still retry exactly as before — the existing no-extension rationale for the retry itself (the 4x-worst-case wall-clock reasoning) is unchanged.

This is NOT "don't re-fire a failed merge": a manager re-firing `worker_merge_confirm` mints a brand-new op — a new first attempt with its own full budget, including its own one auto-extend — and is completely unaffected by this skip. That distinction is spelled out explicitly in the rejection wording itself (see the "budget-exceeded" branch of the retry-outcome text) because a peer manager once misread this same card's title as the broader claim.

## Do not

- Do not run the transient-kill auto-retry when the failing timeout already consumed its one auto-extend — it always runs `allowExtend:false` and cannot pass; skip it and report the budget-exceeded reason instead of burning a full `gateTimeoutMs` on a foregone conclusion.
- Do not read this skip as discouraging a manager from re-firing `worker_merge_confirm` — a re-fire is a brand-new admission with its own full budget and is unaffected.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`'s BUDGET-EXCEEDED SHORT-CIRCUIT block, immediately above the `gateRetrySkippedFutile` computation (as of this tranche's HEAD; current line numbers, main moves under every tranche). Condensed and reworded, not verbatim.
