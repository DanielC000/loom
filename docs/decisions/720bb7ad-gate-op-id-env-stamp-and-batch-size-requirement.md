# 720bb7ad — `gateOpIdEnvOverride` stamps `LOOM_GATE_OP_ID` (and a required `LOOM_GATE_BATCH_SIZE`) onto every gate child

## Narrative

Card 720bb7ad DoD-3: stamp this op's `opId` onto the gate child's environment as `LOOM_GATE_OP_ID` — `scripts/test-daemon.mjs` reads it and, when present, includes it on its own `kind:"run-summary"` NDJSON row, so that row can finally be joined back to the `gate_status`-visible op that produced it (previously: no producer of that row carried any correlating id at all, and two runs admitted close together at `maxConcurrentGates>=2` were indistinguishable by timestamp alone — see the card's own §ATTRIBUTION). Merges additively on top of any base override a call site already needs (e.g. the worker self-gate's own `WORKER_GATE_ENV_OVERRIDE`) — `LOOM_GATE_OP_ID` always wins if `base` somehow already set it, since object spread order places it last.

The `{ ...base, ... }` spread is also load-bearing for a second, unrelated reason: at the worker self-gate call site, `base` is `WORKER_GATE_ENV_OVERRIDE`, which carries the `LOOM_GATE_TEST_CONCURRENCY: "3"` host-starvation pin (see docs/decisions/68920f5b-worker-gate-concurrency-pin-matches-merge-gate.md) — one unpinned gate at 8 lanes starved the host on 2026-07-15. Replacing this spread with a plain `{ LOOM_GATE_OP_ID: opId }` assignment would silently drop that pin for every caller that passes a `base`.

`batchSize` (card dbc6f660, accepted peer request from Codescape) also stamps `LOOM_GATE_BATCH_SIZE` — required (not optional), so no call site can forget it: Codescape's gate-variance baseline lives on a duration column that would otherwise silently mix a 1-branch run with an up-to-4-branch batched one, with nothing in the row telling them apart. Stamped on every gate child, not merely batched ones — an ordinary solo merge passes `1`, a worker self-check or deploy gate (neither is a merge, neither has a branch count) passes `0`, a real batch passes the actual post-assembly landed-branch count (never the requested K — see `runBatchedMerge`'s own doc). A field present on every row means absence has exactly one meaning ("produced by a build older than this change"), never a second, ambiguous one.

## Do not

- Do not replace the `{ ...base, ... }` spread with a plain `{ LOOM_GATE_OP_ID: opId }` assignment — that silently drops any `base` override (e.g. the `LOOM_GATE_TEST_CONCURRENCY` host-starvation pin) for every caller that passes one.
- Do not make `batchSize` optional — an absent `LOOM_GATE_BATCH_SIZE` on some rows and present on others reintroduces the ambiguity Codescape's duration column can't otherwise resolve.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`gateOpIdEnvOverride`'s top-of-function doc, minus the class-A cross-project-contract guard left inline): lines 1090-1118, as of this tranche's HEAD. Relocated by card 5dcc1e98 (tranche 6); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
