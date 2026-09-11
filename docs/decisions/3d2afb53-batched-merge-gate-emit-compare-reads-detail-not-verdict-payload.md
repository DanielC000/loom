# 3d2afb53 — a BATCHED merge gate's emit-compare fields read `detail`, not the verdict payload

## Narrative

Card 3d2afb53: `toGateHistoryRow`'s `emitCompareReduced` derivation deliberately does NOT read from the raw `detail` field for an ordinary merge gate — the raw `build_gate` event only ever stamps `emitCompareReduced` when `true` (a conditional spread at the producer, see `service.ts`'s `evt("build_gate", ...)` call site), never an explicit `false`, so `detail` alone can't tell "genuinely full run" from "reduction never computed". `pending_gate_ops.verdict_payload_json` (joined in as `verdictPayloadJson`, shared with `failingTest`'s own fallback) is the one place `deriveMergeGateVerdict` persists the real tri-state — see [[6ca4b1a0-gate-history-emit-compare-fields-come-from-pending-gate-ops-not-detail-json]] for the full discipline this projects.

A BATCHED merge gate (`detail.batched === true`) is the one exception to that rule — it never routes through `confirmWorkerMergeTracked`/`PendingOpRegistry` at all (see `mergeBatch`'s own header doc, `sessions/service.ts`). CORRECTED (card be260976, see [[be260976-batch-verdict-derivation-closes-the-never-existed-gap]]): `verdictPayload` is NO LONGER always empty for a batch row — `mergeBatch` now mints+settles its own `pending_gate_ops` tombstone directly, so a real `verdictPayload` exists here too. `deriveBatchGateVerdict` (`service.ts`) still deliberately OMITS `emitCompareReduced`/`emitCompareIdenticalCount`/`emitCompareTestFiles` from what it writes — a deliberate choice to keep the SAME `detail.batched === true` fallback this whole block already uses for `emitCompareReduced` the single source of truth for all three batch fields, rather than risk two producers disagreeing.

A batch's own `build_gate` event stamps a genuine DECIDABLE tri-state directly in `detail` instead (mirrors `confirmWorkerMerge`'s own `emitCompareStructuredFields`, gated on `gateRan && !notApplicable` — never the true-only-else-absent shape the general rule above warns about), so recovering it from `detail` is safe ONLY for this one kind: every non-batched row's own `detail.emitCompareReduced` stays legacy true-only (never an honest `false`), so falling back to it there would silently fabricate a tri-state the producer never actually computed.

`mergeBatchTracked`'s own dedupe/coalesce primitive (card `f944d4e4`'s `PendingOpRegistry.attach()` key,
see [[f944d4e4-mergebatchtracked-dedupe-attach-key]]) does NOT reverse this card's "kept out of
`confirmWorkerMergeTracked`/`PendingOpRegistry`'s finalize machinery" ruling — the dedupe/coalesce
primitive (a same-key call already running is awaited, never re-invoked) is orthogonal to finalize logic
and, if anything, extends this card's own "no extra gate run" goal from per-call to per-batch-attempt.

CORRECTED (card `be260976`, see [[be260976-batch-verdict-derivation-closes-the-never-existed-gap]]): before that card, `verdictPayload` was always empty for a batch row, so `toGateHistoryRow` stamped `durationMs`/`gateCap`/`concurrentGates`/`concurrentGatesMax` straight off the `build_gate` event's own `detail`. `be260976` mints+settles a real `pending_gate_ops` tombstone for a batch op too, but that tombstone exists for `gate_status(opId)` to resolve a settled batch op at all (the defect it closed — `gate_status` used to return `"never_existed"` for one) — it does NOT change what `gate_history` reads for these four fields; `toGateHistoryRow` still reads them off `detail`, regardless of gate kind, exactly as before `be260976`. Stamping them in the `build_gate` event (mirroring `confirmWorkerMerge`'s own `evt("build_gate", ...)` call) stays necessary regardless: first measured missing on the first live batch run (opId `1cfb5219`, row `ed9bf9a0` — every one of these four read back `null`).

## Do not

- Do not assume `be260976`'s tombstone row changes what `gate_history` reads for `durationMs`/`gateCap`/`concurrentGates`/`concurrentGatesMax` on a batch row — it exists only so `gate_status(opId)` can resolve a settled batch op; these four fields still read off the `build_gate` event's own `detail`, unchanged by that card.
- Do not read `emitCompareReduced`/etc. from a non-batched row's raw `detail` — it can never carry an honest `false`, only `true`-or-absent; use `verdictPayload` instead.
- Do not extend the `detail.batched === true` fallback to a non-batched row — it is safe ONLY because a batch's `build_gate` event is the one producer that stamps a genuine decidable tri-state directly into `detail`.
- Do not duplicate `emitCompareReduced`/`emitCompareIdenticalCount`/`emitCompareTestFiles` onto `deriveBatchGateVerdict`'s own written payload — that would risk two producers (the `detail` stamp and the verdict payload) disagreeing on a future edit to either.
- Do not read the `f944d4e4` dedupe/coalesce primitive (`PendingOpRegistry.attach()`) as reversing this card's "kept out of finalize machinery" ruling — it is orthogonal to finalize logic, extending this card's own "no extra gate run" goal from per-call to per-batch-attempt, not new finalize logic.

## Source

Inline comment in `packages/daemon/src/db.ts` (`toGateHistoryRow`'s `emitCompareReduced` derivation), as of this tranche's HEAD.

### Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts`, `mergeBatchTracked`'s own JSDoc header, as of
this tranche's HEAD.
