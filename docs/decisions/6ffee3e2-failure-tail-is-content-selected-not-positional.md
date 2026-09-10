# 6ffee3e2 — a fail-path output tail is CONTENT-SELECTED, not a plain positional trailing tail

## Narrative

Card 6ffee3e2: on a settled "gate"/"merge" op's `verdict_payload_json`, the `outputTail`/`gateDetail.stderrTail` fields (a stdout+stderr tail, card 361520a0 Half Three) are a plain trailing tail bounded to ~4KB (`OUTPUT_TAIL_BYTES`) on a `"pass"` — a passing step never needs content-selection — but on a `"fail"` this card makes them CONTENT-SELECTED rather than positional, and lets the tail run up to ~16KB (`FAILURE_BLOCK_CAP_BYTES`) when that recovers a real per-file assertion body from a `test-daemon.mjs` `FAILURES:` block that a plain trailing tail would otherwise have truncated off. A bare positional tail of a large test run's output can land past the actual failure detail entirely; selecting on content (the `FAILURES:` block) instead of position is what keeps the recovered text meaningful.

## Decision B: content-selection is a REPLACEMENT for `tail()`, only when `tail()` is lossy (`gate-runner.ts`'s `resolveOutputTail`)

### Narrative

CORRECTED (Code Review, `merge-gate-retry.mjs` case (E) — a real regression a first version of this fix shipped): content-selection is a REPLACEMENT for the plain positional `tail()`, so it only fires when `tail()` is actually LOSSY — i.e. `totalBytesSeen` exceeds `OUTPUT_TAIL_BYTES`, meaning the bounded ring genuinely evicted something. When the WHOLE step's output fits inside the cap, `tail()` IS the complete output (nothing was ever truncated) — falling back to it loses nothing and invents nothing.

The first version always preferred content-selection on any failure, which broke a real, common case: a short gate command (not `test-daemon.mjs`) whose failure line survives ANSI color codes wrapped around it (`\x1b[31mFAIL widget.spec.js\x1b[0m`) — `createFailingTestTracker`'s FAIL-tier pattern requires the line to START with `FAIL` (after optional whitespace), so the leading escape sequence defeats that match and the tracker falls through to a LOWER-priority tier (e.g. a same-run `AssertionError` line) that doesn't name the test — content-selection silently produced WORSE output than the untruncated raw tail it replaced. Bounding this to the genuinely-lossy case removes that regression without reopening the original bug: a verbose ~700-file suite still exceeds the cap by a wide margin, so it always takes the content-selected branch, unchanged from before this fix.

Priority once content-selection DOES apply: (1) the front-anchored `FAILURES:` block, when `test-daemon.mjs`'s own marker was seen — the richest available diagnostic, a real per-file assertion body, not just a name; (2) the single best failing-test/assertion LINE `createFailingTestTracker` already scans for; (3) an EXPLICIT honest-miss string, never a silent fall-through to a positional chunk already known to be missing content. The PASSING path is untouched (still uses `tail()`).

### Do not

- Do not prefer content-selection unconditionally on any failure — gate it on `totalBytesSeen > OUTPUT_TAIL_BYTES` (genuinely lossy), or a short command's ANSI-wrapped `FAIL` line silently loses its test name to a lower-priority tier.

## Do not

- Do not read a ~16KB tail as evidence something is broken — it means content-selection recovered a real per-file `FAILURES:` block, not that the cap silently grew.
- Do not apply the ~16KB `FAILURE_BLOCK_CAP_BYTES` bound on a `"pass"` row — a passing step stays capped at the plain ~4KB `OUTPUT_TAIL_BYTES` trailing tail; content-selection is fail-only.

## Source

Inline comment in `packages/daemon/src/db.ts` (`PendingGateOpVerdict`'s top-of-interface doc, and `gateDetail.stderrTail`'s own field doc): lines 2018-2056 and 2086-2102, as of this tranche's HEAD. Decision B above was originally the JSDoc for `resolveOutputTail` in `packages/daemon/src/orchestration/gate-runner.ts`, lines 625-652 as of tranche 1's HEAD (commit `18bb69e3`); extracted here (same card id) by tranche 2, no wording changed beyond joining wrapped lines and stripping `*` markers.
