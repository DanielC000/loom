# 68920f5b — `WORKER_GATE_ENV_OVERRIDE` pins the worker self-gate's test-lane concurrency to match the merge gate

## Narrative

Forced onto the worker self-gate's own spawned child (card 7f96aa09, revised by 68920f5b, raised again by 2ff32b5c), additive to whatever env the worker's shell already has — pins the daemon test runner's own internal test-lane pool per gate invocation to match the merge gate's own unpinned default (`DEFAULT_CONCURRENCY` in `scripts/test-daemon.mjs`). Owner decision 68920f5b (request 3d73c2a8): `run_gate` was running the same suite at half the merge gate's parallelism against the same `gateCommandTimeoutMs`, making it structurally more timeout-prone than the merge gate it feeds — a `run_gate` timeout did not predict a merge rejection. Raising this to 2 (and then, by card 2ff32b5c, to 3 alongside `DEFAULT_CONCURRENCY`'s own 2->3 raise) removes that asymmetry.

Still safe: `orchestration.maxConcurrentGates` (code default 1, current live owner-set value 2 — see `CLAUDE.md`) admits gate runs — merge, deploy, and `run_gate` — through the same `gateSemaphore`, so a 3-lane `run_gate` peaks at the same lanes a merge gate already reaches today, whatever the resolved cap is. The 2026-07-15 8-lane incident was one gate's pool defaulting to full core count (no `LOOM_GATE_TEST_CONCURRENCY` pin at all), not concurrent gates — this override still pins a bound, just 3 instead of unbounded. At the owner's current live `maxConcurrentGates=2`, the real host-load budget is `maxConcurrentGates × 3` = 6 concurrent test processes — below the documented 8-lane failure level (see `DEFAULT_CONCURRENCY`'s own doc in `scripts/test-daemon.mjs` for the full product-math table); that only changes if someone raises `maxConcurrentGates` further, which carries the identical exposure for the merge gate too — no new risk class.

This is deliberately different from the raw-Bash fallback pin (still `LOOM_GATE_TEST_CONCURRENCY=1`, documented in `CLAUDE.md`): a raw self-check run via Bash is outside the semaphore entirely — N concurrent raw gates is N × lanes with no structural bound, so its pin stays conservative at 1. This override is admitted through the semaphore, so it can safely match the merge gate's default.

Card ba3c9580: renamed from the generic `LOOM_TEST_CONCURRENCY` — that name was indistinguishable from a name any other project's own test harness might independently choose, so it was unconditionally injected into every project's gate child regardless of whether anything there was meant to read it. `LOOM_GATE_TEST_CONCURRENCY` is unambiguously Loom's own gate-runner convention.

## Do not

- Do not raise `WORKER_GATE_ENV_OVERRIDE`'s pin without re-deriving `maxConcurrentGates × pin` against the documented 8-lane failure level — the safety arithmetic is a function of the live `maxConcurrentGates` cap, not a fixed fact.
- Do not confuse this semaphore-admitted pin with the raw-Bash fallback pin (`LOOM_GATE_TEST_CONCURRENCY=1`) — they differ in value deliberately because only this one is admitted through the `gateSemaphore`.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`WORKER_GATE_ENV_OVERRIDE`'s top-of-const doc): lines 1059-1087, as of this tranche's HEAD. Relocated by card 5dcc1e98 (tranche 6); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
