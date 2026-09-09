# 7f96aa09 — `WorkerGateResult` routes the worker DoD self-gate through the daemon `GateSemaphore`

## Narrative

`SessionService.runWorkerGate`'s result (card 7f96aa09 — structural fix B for d5c5ccdf: route the worker DoD self-gate through the daemon GateSemaphore). `ran:false` means no gate command is configured for this project at all (the caller should fall back to a raw self-check, pinning `LOOM_GATE_TEST_CONCURRENCY=1` itself); `ran:true` always means the SAME `orchestration.gateCommand` the merge gate itself runs was actually executed, in the worker's own worktree. Reuses `GateRejectionDetail`'s shape on a failure — the same diagnostic enrichment (phase/failedStep/failingTest/stderrTail/exitCode/signal/timedOut) the merge gate's own rejection carries — but this is a single run: unlike `confirmWorkerMerge`, a transient-kill classification is NOT auto-retried here (the worker can just re-call run_gate itself).

## Do not

- Do not auto-retry a transient-kill classification inside `runWorkerGate` — unlike `confirmWorkerMerge`, this is a single run; the worker can just re-call `run_gate` itself.
- Do not fall back to a raw hand-run self-check without pinning `LOOM_GATE_TEST_CONCURRENCY=1` — that fallback path is outside the daemon's `GateSemaphore` budget.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`WorkerGateResult`'s top-of-type doc): lines 664-695, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
