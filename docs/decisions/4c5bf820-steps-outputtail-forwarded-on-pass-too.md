# 4c5bf820 — `steps`/`outputTail` are forwarded on a passing worker self-check too, not just a failure

## Narrative

`steps`/`outputTail` (card 4c5bf820) are forwarded verbatim from `GateSequentialResult` — set on EVERY `ran:true` outcome, PASS included: before this card the pass path discarded both (gate-runner.ts itself never even retained an `outputTail` on its green return), leaving a passing worker self-check with nothing durable to show for itself beyond a bare "gate passed" — the exact asymmetry this card fixes. `outputTail` is sanitized of control chars the same way the failure path's tail already is.

## Do not

- Do not discard `steps`/`outputTail` on the PASS path — before card 4c5bf820 a passing worker self-check had nothing durable to show for itself beyond a bare "gate passed"; both must be forwarded verbatim on every `ran:true` outcome.

## Narrative (2): the durable tombstone write derives from the same four shapes as the completion nudge

Card 4c5bf820: derive the durable `pending_gate_ops.verdict`/`verdict_payload_json` write from a settled `runWorkerGate` op's `attach()` outcome — the SAME four shapes the completion-nudge builder (right below this closure's own call site) already branches on, so the tombstone and the nudge can never tell two different stories about the same settle. Returns `undefined` ONLY for the `ran:false` shape (no gateCommand configured / the circuit-breaker short-circuit) — neither ever reaches this closure in practice (both return BEFORE `pendingOps.attach` is ever called, so no op — and no tombstone row — exists for them at all), but this stays a fail-closed "record nothing" rather than guessing at a shape for a case that shouldn't occur.
- a thrown exception (`outcome.ok:false`) → `"error"`, `reason` only (nothing else was computed before whatever point the throw struck).
- a cancelled run (`outcome.value.cancelled`) → `"cancelled"`, `reason` only — mirrors the nudge's own "NOT a failure — no verdict was reached" wording; must never be read as `"fail"`.
- `outcome.value.passed` → `"pass"`, carrying `durationMs`/`validatedHead`/`headWarning`/`steps`/`outputTail` — no `gateDetail` (nothing to diagnose on a green run).
- otherwise → `"fail"`, the same fields PLUS `gateDetail` (the rich phase/failedStep/failingTest/exitCode/signal/timedOut diagnosis the `[loom:gate-failed]` nudge already embeds).

## Do not (2)

- Do not build the tombstone write and the completion-nudge from two independently-branching shape checks — both must branch on the SAME four shapes (error/cancelled/pass/fail), or they can tell two different stories about the same settle.
- Do not read a `"cancelled"` verdict as `"fail"` — it mirrors the nudge's own "NOT a failure — no verdict was reached" wording.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`WorkerGateResult.steps`/`outputTail`, lines 664-695; the tombstone-write derivation, lines 693-710): as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
