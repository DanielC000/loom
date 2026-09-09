# 4c5bf820 — A settled merge-kind gate row derives its verdict too, and payload fields stay honest-null when absent

⚠️ Spans three decisions across `db.ts`/`sessions/service.ts`: this record (§1), plus two more originally
filed together as one dark file — `steps`/`outputTail` forwarding on PASS (§2) and the tombstone-write
shape derivation (§3). `resolveRecord` serves one file per id; folded here rather than left as a second
unreachable `4c5bf820-*.md` file (card `6de8956e`).

## §1 — Narrative

SETTLED VERDICT (card 4c5bf820, widened by 9f6598dd): populated for a "gate" row via deriveWorkerGateVerdict, and — since 9f6598dd — for a "merge" row too, via deriveMergeGateVerdict (previously a "merge" row's verdict/verdictPayload stayed NULL by construction; that was exactly Finding 1). A legacy row (from before either card) predates the columns entirely, and a not-yet-settled row never has one either. `payload` itself is honest-null on a corrupt/unparseable stored blob (see `Db.toPendingGateOp`) — either way this spreads nothing rather than a fabricated shape. `settledAt`/`totalDurationMs`/`extended` (card 9f6598dd) are independently optional on `payload` regardless of `verdict` kind — currently only ever set by the merge-kind derivation, so they spread through for "pass"/"fail" today and are simply absent for "cancelled"/"error"/a "gate" row, never fabricated.

### Do not

- Do not leave a `merge`-kind gate row's `verdict`/`verdictPayload` NULL by construction (Finding 1) — derive it via `deriveMergeGateVerdict`, the same as a `gate` row's `deriveWorkerGateVerdict`.
- Do not fabricate `payload`, `settledAt`, `totalDurationMs`, or `extended` when they're absent — a legacy row, a not-yet-settled row, or a corrupt stored blob must spread through as honest-null/absent, never a made-up shape.

### Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`): lines 5061-5070, as of commit `6faf27824c7f550d57bfdeb9e4724c7070b82315`. Relocated by card `5b8d2b0c`; no wording changed.

## §2 — `steps`/`outputTail` are forwarded on a passing worker self-check too, not just a failure

### Narrative

`steps`/`outputTail` are forwarded verbatim from `GateSequentialResult` — set on EVERY `ran:true` outcome, PASS included: before this card the pass path discarded both (gate-runner.ts itself never even retained an `outputTail` on its green return), leaving a passing worker self-check with nothing durable to show for itself beyond a bare "gate passed" — the exact asymmetry this card fixes. `outputTail` is sanitized of control chars the same way the failure path's tail already is.

### Do not

- Do not discard `steps`/`outputTail` on the PASS path — before this card a passing worker self-check had nothing durable to show for itself beyond a bare "gate passed"; both must be forwarded verbatim on every `ran:true` outcome.

### Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`WorkerGateResult.steps`/`outputTail`, lines 664-695), as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`.

## §3 — the durable tombstone write derives from the same four shapes as the completion nudge

### Narrative

Derive the durable `pending_gate_ops.verdict`/`verdict_payload_json` write from a settled `runWorkerGate` op's `attach()` outcome — the SAME four shapes the completion-nudge builder (right below this closure's own call site) already branches on, so the tombstone and the nudge can never tell two different stories about the same settle. Returns `undefined` ONLY for the `ran:false` shape (no gateCommand configured / the circuit-breaker short-circuit) — neither ever reaches this closure in practice (both return BEFORE `pendingOps.attach` is ever called, so no op — and no tombstone row — exists for them at all), but this stays a fail-closed "record nothing" rather than guessing at a shape for a case that shouldn't occur.
- a thrown exception (`outcome.ok:false`) → `"error"`, `reason` only (nothing else was computed before whatever point the throw struck).
- a cancelled run (`outcome.value.cancelled`) → `"cancelled"`, `reason` only — mirrors the nudge's own "NOT a failure — no verdict was reached" wording; must never be read as `"fail"`.
- `outcome.value.passed` → `"pass"`, carrying `durationMs`/`validatedHead`/`headWarning`/`steps`/`outputTail` — no `gateDetail` (nothing to diagnose on a green run).
- otherwise → `"fail"`, the same fields PLUS `gateDetail` (the rich phase/failedStep/failingTest/exitCode/signal/timedOut diagnosis the `[loom:gate-failed]` nudge already embeds).

### Do not

- Do not build the tombstone write and the completion-nudge from two independently-branching shape checks — both must branch on the SAME four shapes (error/cancelled/pass/fail), or they can tell two different stories about the same settle.
- Do not read a `"cancelled"` verdict as `"fail"` — it mirrors the nudge's own "NOT a failure — no verdict was reached" wording.

### Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the tombstone-write derivation, lines 693-710), as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`. Folded into this pre-existing record by card `6de8956e`.
