# a1a8c5c4 — `ConfirmMergeResult.outputTail` covers only the two dominant paths; use `gateExtended` to detect any gate run

## Narrative

Card a1a8c5c4: the merge gate's own last-step tail (the SAME value `gate-runner.ts` already computes on every outcome, pass or fail) — bounded to `OUTPUT_TAIL_BYTES` (~4KB) on a PASS, but CONTENT-SELECTED since card 6ffee3e2 on a FAIL, where it can run up to `FAILURE_BLOCK_CAP_BYTES` (~16KB) when that recovers a real per-file assertion body from a `test-daemon.mjs` `FAILURES:` block. Set on the two DOMINANT return paths only — a plain gate-fail rejection and a plain successful merge — NOT on every path where a gate genuinely spawned (`gateRan:true`): a rarer post-gate-PASS rejection (`merge.conflict`, `gateBaseInvalidated`, an orphaned/stage-empty no-op) still returns `outputTail:undefined` even though a gate ran and produced output right before it. So `undefined` here does NOT mean "no gate spawned" — it means "no gate spawned, OR one spawned on a path this card didn't wire up"; use `gateExtended` (`undefined` ONLY when no gate spawned) to tell those apart, never this field's absence. Before this card the merge gate's PASS path discarded this value entirely on EVERY path (see `deriveMergeGateVerdict`'s own doc for where it now lands durably) — a passing merge gate left NOTHING behind to show for itself, which is the exact absent-channel gap the card measured; closing the two dominant paths was judged worth it even leaving the rarer ones as a named, deliberate gap (see the card for why: minimal diff, real-world coverage). A FAIL still also carries its own richer `gateDetail.stderrTail` (identical bytes) — this field exists so the PASS side has an equivalent.

## Do not

- Do not read `outputTail:undefined` as proof no gate spawned — a rarer post-gate-PASS rejection (merge conflict, gate-base-invalidated, an orphaned/stage-empty no-op) also leaves it undefined even though a gate ran; check `gateExtended` instead, which is undefined ONLY when no gate spawned.
- Do not leave the merge-verdict derivation's "pass"/"fail" branches without `outputTail` — before this card widened both, a "merge" row's verdict never persisted ANY gate output, on either outcome, unlike the sibling "gate" (worker self-check) row, which has carried it on both outcomes since card 4c5bf820.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`ConfirmMergeResult.outputTail`, lines 513-529; the merge-verdict derivation's outputTail widening, lines 726-769): as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
