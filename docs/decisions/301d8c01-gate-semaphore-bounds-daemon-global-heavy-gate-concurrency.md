# 301d8c01 — `GateSemaphore` bounds every HEAVY, daemon-executed gate run across every project, in one place

## Narrative

Card 301d8c01: `GateSemaphore` is a daemon-global, in-memory concurrency limiter for HEAVY, daemon-EXECUTED gate runs — the merge-confirm gate (`confirmWorkerMerge`), the scoped-deploy gate (`deployOwnProject`), and the worker DoD self-check (`runWorkerGate` / the `run_gate` tool), all of which invoke `runGateSequential` with an arbitrary human-set build/test command. It bounds how many of these can run AT ONCE across EVERY project on the host, so N concurrent gate calls can't pile up heavy build/test processes and starve a live sibling service on a self-hosting host. Before this card, that was enforced only by manager discipline — sequencing merges by hand — not code: nothing structurally prevented two managers on two different projects from each kicking off a heavy gate at the same moment.

## Do not

- Do not assume gate concurrency across projects is bounded by anything other than this one semaphore — before card 301d8c01 it was enforced only by manager discipline (sequencing merges by hand), which is not a structural guarantee.

## Source

Inline comment in `packages/daemon/src/orchestration/gate-semaphore.ts` (module-level doc, lines 1-8), commit `252d25bb51`, as of `beeeb7c2`. Relocated by card `772735d2` (tranche 2); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
