# afc5cdcc — merge-batch's fallback-registration wait has no elapsed cap, by design

## Do not

- Do not reintroduce a fixed elapsed budget on this wait — a 10s cap ARRIVED LATE (10,376ms) under real
  host contention on gate `48b2f8a8`; a wider guess is the same defect with a longer fuse.
- Do not fix a future occurrence of this shape elsewhere by widening a timeout — remove the elapsed
  dimension entirely (poll a real observable signal with `timeoutMs: Infinity`) instead; see project
  memory on the guessed-margin/fixed-budget defect class.
- Do not change what is asserted — all 3 fallback candidates must still be required in `gate_queue`.
  This is a timing fix, not a scope reduction.

## Narrative

Filed by lead gen 348 (2026-09-18) from a weaker-pass merge gate (`48b2f8a8`). The wait for all 3
fallback candidates to register in `gate_queue` failed in the full suite with `_wait.mjs`'s own ARRIVED
LATE outcome (not ABSENT) — the awaited condition genuinely became true, 376ms past a 10,000ms budget (a
3.8% overshoot) — then passed clean on an isolated retry. The condition was correct; only the clock ran
out.

This is the guessed-margin/fixed-budget defect class already established on this board: a wall-clock
budget raced against an event whose real duration — here, `merge_batch`'s fallback loop doing three
sequential sync-waits — is not capped and stretches under host contention. A generous multiplier is not
a fix; the strongest fix removes the elapsed dimension entirely.

**Fix:** the wait now polls the real `gate_queue` state (`svc.gateQueueForManager`) with no elapsed cap
(`timeoutMs: Infinity`) instead of racing a fixed budget. If the event stops arriving, the wait hangs
loudly and the file's own `TEST_TIMEOUT_MS` is the backstop — a better failure than a generous guess
passing silently. Positive-controlled: deliberately registering only 2 of 3 candidates still fails the
test.

## What is not claimed

No attribution for WHY this run overshot — `concurrentGates:1`/`concurrentGatesMax:1`, so it was not gate
contention, and the semaphore is blind to everything else on the host. n=1 for this file; not a rate.

## Source

`packages/daemon/test/merge-batch-fallback-visibility.mjs:144`, `@decision afc5cdcc`. Merged `8a15b2e`.
Related: `51bc64f2` — a DIFFERENT file (`codex-trust-block-poll`), red in the same retry batch, a
different mechanism (an absent setup write, not an arrived-late budget overshoot); do not conflate.
