# 6ffee3e2 — a fail-path output tail is CONTENT-SELECTED, not a plain positional trailing tail

## Narrative

Card 6ffee3e2: on a settled "gate"/"merge" op's `verdict_payload_json`, the `outputTail`/`gateDetail.stderrTail` fields (a stdout+stderr tail, card 361520a0 Half Three) are a plain trailing tail bounded to ~4KB (`OUTPUT_TAIL_BYTES`) on a `"pass"` — a passing step never needs content-selection — but on a `"fail"` this card makes them CONTENT-SELECTED rather than positional, and lets the tail run up to ~16KB (`FAILURE_BLOCK_CAP_BYTES`) when that recovers a real per-file assertion body from a `test-daemon.mjs` `FAILURES:` block that a plain trailing tail would otherwise have truncated off. A bare positional tail of a large test run's output can land past the actual failure detail entirely; selecting on content (the `FAILURES:` block) instead of position is what keeps the recovered text meaningful.

## Do not

- Do not read a ~16KB tail as evidence something is broken — it means content-selection recovered a real per-file `FAILURES:` block, not that the cap silently grew.
- Do not apply the ~16KB `FAILURE_BLOCK_CAP_BYTES` bound on a `"pass"` row — a passing step stays capped at the plain ~4KB `OUTPUT_TAIL_BYTES` trailing tail; content-selection is fail-only.

## Source

Inline comment in `packages/daemon/src/db.ts` (`PendingGateOpVerdict`'s top-of-interface doc, and `gateDetail.stderrTail`'s own field doc): lines 2018-2056 and 2086-2102, as of this tranche's HEAD.
