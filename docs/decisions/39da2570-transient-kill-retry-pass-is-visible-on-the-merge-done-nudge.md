# 39da2570 — a pass via the transient-kill auto-retry is visible on the `[loom:merge-done]` nudge, not just internally

## Narrative

CORRECTED (card 39da2570): an earlier description of the transient-kill auto-retry ([[bcba83a1-classify-gate-failure-so-managers-stop-routing-around-the-gate]]) claimed the manager "never even sees" that a transient kill happened at all. That was true of the SQUASH decision — a pass-after-retry still falls through to the normal squash-merge unaffected — but not, since this card, of the `[loom:merge-done]` nudge: a pass via this retry now sets `transientRetried:true` on the return, which the nudge renders as a WEAKER-PASS note beside the concurrency triple, rather than staying silent about the retry having happened.

`gateRetried` (the flag this correction depends on) is declared at `confirmWorkerMerge`'s own outer scope, above the `if (gate)` block that sets it — needed because the plain GREEN return at the bottom of the method sits OUTSIDE that block, so a `let` declared inside it would be invisible by the time the method needs to report whether the retry that produced a `merged:true` verdict was this one.

## Do not

- Do not describe the transient-kill auto-retry as invisible to the manager — the squash decision is unaffected, but a pass still surfaces as a WEAKER-PASS note on the `[loom:merge-done]` nudge via `transientRetried:true`.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`'s TRANSIENT-KILL AUTO-RETRY block (as of this tranche's HEAD; current line numbers, main moves under every tranche). A fuller doc of `gateRetried`'s own outer-scope declaration exists elsewhere in the same method (not edited by this tranche). Condensed and reworded, not verbatim.
