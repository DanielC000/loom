# 0f1920e0 — a batch's gate child keeps the `LOOM_GATE_OP_ID` cross-project contract; `LOOM_GATE_BATCH_SIZE` is new

## Narrative

Card 0f1920e0 (re-affirmed on card `dbc6f660`): `LOOM_GATE_OP_ID` is NOT renamed or dropped for a batch gate
run — `mergeBatchTracked`'s `runGate` call stamps it via the SAME `gateOpIdEnvOverride` every other gate
call site uses (a cross-project contract read by Codescape's gate child; see that function's own doc for
why this is unconditional on EVERY gate child, not merely batched ones). New on top: it also passes the
ACTUAL post-assembly landed-branch count (never the requested K) as `LOOM_GATE_BATCH_SIZE` (accepted peer
request, same card) — a real batch stamps that count, an ordinary solo merge stamps `1`, a worker
self-check/deploy gate stamps `0`.

Batching also RE-MEANS `LOOM_GATE_OP_ID`'s own per-run unit: one `opId` now covers up to
`maxConcurrentWorkers` branches, not one. The per-branch `branches` list on `mergeBatchTracked`'s own
`build_gate`/`batch_merge_forfeited` events (see [[dbc6f660-batch-merge-forfeited-is-the-one-failure-mode-batching-worsens]])
is what keeps that recoverable. `gate_history`'s `branch` column is NOT set by this event's own `detail` —
it's a JOIN onto the SUBJECT session's `sessions.branch` (see `Db.listGateEvents`) — and a batch event is
filed under the MANAGER (there is no single subject worker), so `gate_history.branch` reads **null** for a
batch gate row, same as any other manager-subject event. This is a DELIBERATE, honest consequence of there
being no single branch to name, not an oversight — the real per-branch set lives in `detail.branches`.

## Do not

- Do not rename or drop `LOOM_GATE_OP_ID` for a batch gate child — it stays the same cross-project contract every other gate call site stamps, via the same `gateOpIdEnvOverride`.
- Do not stamp `LOOM_GATE_BATCH_SIZE` with the requested K — stamp the ACTUAL post-assembly landed-branch count; a solo merge stamps `1`, a worker self-check/deploy gate stamps `0`.
- Do not treat a `null` `gate_history.branch` on a batch row as a bug — it is a deliberate consequence of a batch event being filed under the manager (no single subject worker); read `detail.branches` for the real per-branch set instead.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `mergeBatchTracked`'s own JSDoc header, as of this tranche's HEAD.
