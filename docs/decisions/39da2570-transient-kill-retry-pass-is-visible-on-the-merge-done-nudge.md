# 39da2570 — a pass via the transient-kill auto-retry is visible on the `[loom:merge-done]` nudge, not just internally

## Narrative

CORRECTED (card 39da2570): an earlier description of the transient-kill auto-retry ([[bcba83a1-classify-gate-failure-so-managers-stop-routing-around-the-gate]]) claimed the manager "never even sees" that a transient kill happened at all. That was true of the SQUASH decision — a pass-after-retry still falls through to the normal squash-merge unaffected — but not, since this card, of the `[loom:merge-done]` nudge: a pass via this retry now sets `transientRetried:true` on the return, which the nudge renders as a WEAKER-PASS note beside the concurrency triple, rather than staying silent about the retry having happened.

`gateRetried` (the flag this correction depends on) is declared at `confirmWorkerMerge`'s own outer scope, above the `if (gate)` block that sets it — needed because the plain GREEN return at the bottom of the method sits OUTSIDE that block, so a `let` declared inside it would be invisible by the time the method needs to report whether the retry that produced a `merged:true` verdict was this one.

## The unlicensed `cgMax` read this card also closes

Before this card, a merge saved by this retry was absorbed silently on the SQUASH decision, but the nudge
still handed a reader the SAME `cap=…/concurrentGates=…/concurrentGatesMax=…` triple `concurrencyNote`
renders, with nothing telling them it describes the retry's own (LATER) admission rather than attempt 1's
— an unlicensed `cgMax` read this card also closes by setting `transientRetried:true` alongside it, so a
reader who sees the weaker-pass note knows the triple beside it describes the retry's admission, not the
first attempt's. This retry note is mutually exclusive with the single-file retry's own `retryNote` — the
two retries can never both fire for the same gate attempt (see `ConfirmMergeResult.transientRetried`'s own
doc) — so at most one of the two notes is ever non-empty on a given nudge.

## Do not

- Do not describe the transient-kill auto-retry as invisible to the manager — the squash decision is unaffected, but a pass still surfaces as a WEAKER-PASS note on the `[loom:merge-done]` nudge via `transientRetried:true`.
- Do not read the concurrency triple beside this note as describing attempt 1 — once `transientRetried:true` is set, the triple describes the retry's own later admission instead.
- Do not assume `retryNote` and this transient-kill note can both fire for the same gate attempt — they are mutually exclusive; at most one is ever non-empty on a given nudge.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`'s TRANSIENT-KILL AUTO-RETRY block (as of this tranche's HEAD; current line numbers, main moves under every tranche). A fuller doc of `gateRetried`'s own outer-scope declaration exists elsewhere in the same method (not edited by this tranche). Condensed and reworded, not verbatim.

## Amended by 68155573

The concurrency triple beside `transientRetried:true` now describes the single admission the retry continued, not a separate later one. See `68155573-a-retry-continues-its-admission-never-re-queues.md`.
