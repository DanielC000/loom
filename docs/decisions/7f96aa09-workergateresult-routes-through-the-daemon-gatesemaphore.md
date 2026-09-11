# 7f96aa09 — `WorkerGateResult` routes the worker DoD self-gate through the daemon `GateSemaphore`

## Narrative

`SessionService.runWorkerGate`'s result (card 7f96aa09 — structural fix B for d5c5ccdf: route the worker DoD self-gate through the daemon GateSemaphore). `ran:false` means no gate command is configured for this project at all (the caller should fall back to a raw self-check, pinning `LOOM_GATE_TEST_CONCURRENCY=1` itself); `ran:true` always means the SAME `orchestration.gateCommand` the merge gate itself runs was actually executed, in the worker's own worktree. Reuses `GateRejectionDetail`'s shape on a failure — the same diagnostic enrichment (phase/failedStep/failingTest/stderrTail/exitCode/signal/timedOut) the merge gate's own rejection carries — but this is a single run: unlike `confirmWorkerMerge`, a transient-kill classification is NOT auto-retried here (the worker can just re-call run_gate itself).

Routing through the daemon `GateSemaphore`/`maxConcurrentGates` cap (the SAME cap the merge/deploy gates already share) means N parallel workers self-gating can no longer structurally exceed the total-lane budget, regardless of whether each worker remembers the `LOOM_GATE_TEST_CONCURRENCY=1` fallback convention.

`runWorkerGate` REUSES `gateCommand` rather than adding a second "worker DoD command" config field: `gateCommand` already runs in the worker's own worktree at merge-confirm time (after main is merged into it), so calling `run_gate` pre-merge just previews the SAME command a little earlier, against the branch's own pre-merge state — avoiding a divergence footgun where a worker's self-check and the actual merge gate could silently differ.

A single `run_gate` call is a preview/rehearsal, not the merge gate itself: unlike `confirmWorkerMerge` it performs no union-merge, no stranded-work check, and no squash/finalize, in addition to no transient-kill auto-retry.

LONG-RUNNING, mirroring `confirmWorkerMergeTracked`: wrapped in `PendingOpRegistry.attach` under kind "gate", key `gate:${workerSessionId}` — a fast run (under `SYNC_ATTACH_BUDGET_MS`) returns inline; a genuinely slow one degrades to `{settled:false, op, attachedToInFlight, staleAgainstWorktree}` and, on its eventual settle, pushes a `[loom:gate-done]`/`[loom:gate-failed]` nudge straight to the WORKER's own session (not a manager — the caller and the beneficiary are the same session here). The key is single-flight per worker and needs no dead-owner eviction: unlike the "merge" kind (owned by a manager distinct from the worker being confirmed), a "gate" op's only possible caller IS the session named by its own key.

## Do not

- Do not auto-retry a transient-kill classification inside `runWorkerGate` — unlike `confirmWorkerMerge`, this is a single run; the worker can just re-call `run_gate` itself.
- Do not fall back to a raw hand-run self-check without pinning `LOOM_GATE_TEST_CONCURRENCY=1` — that fallback path is outside the daemon's `GateSemaphore` budget.
- Do not add a second "worker DoD command" config field — reuse `gateCommand` so a worker's pre-merge preview and the actual merge gate can never silently diverge.
- Do not perform a union-merge, stranded-work check, or squash/finalize inside `runWorkerGate` — it is a preview/rehearsal only, never a second merge gate.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`WorkerGateResult`'s top-of-type doc): lines 664-695, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

The REUSES/single-run/LONG-RUNNING paragraphs above are from a second site citing the same card: `runWorkerGate`'s own JSDoc in `packages/daemon/src/sessions/service.ts` (tranche 61, ~lines 15506-15521 as of this tranche's HEAD) — genuinely new nuance (why `gateCommand` is reused rather than duplicated, the preview/rehearsal framing, and the `PendingOpRegistry` single-flight mechanism) not previously captured by this record; anchored there, not duplicated as a second file, per the one-record-per-id rule.
