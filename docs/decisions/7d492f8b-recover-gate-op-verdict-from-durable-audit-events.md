# 7d492f8b — recover a settled gate/merge op's verdict from durable audit events, not just the tombstone

## Narrative

Card 7d492f8b: recovers a genuinely-settled gate/merge op's real verdict from its own durable audit events (`Db.findGateOpEventsByOpId`, keyed off the `opId` every `evt()` closure now stamps onto its detail) — the fix for `SessionService.reconcileOrphanedGateOps` misreporting a settled op as `orphaned-by-restart` purely because its `pending_gate_ops` tombstone row never reached `state:'settled'` before a crash. A crash can land in the (normally millisecond-wide) gap between the op's own `evt()` write — unconditional, happens the moment the run genuinely finishes — and the later `PendingOpRegistry.attach()` settle callback that flips the tombstone (`onSettle` → `settlePendingGateOp`); that gap is not always millisecond-wide in practice (e.g. `confirmWorkerMerge` still awaits `rejectNotify` after its `build_gate` write but before `merge_rejected`), so the durable audit trail can be strictly more complete than the tombstone — this recovers from it instead of discarding it.

For `kind: "gate"` (a worker's own `run_gate` self-check): the single `worker_gate` event IS the op's own terminal signal — nothing follows it in `runWorkerGate` — so whichever one is found is fully recoverable (pass/fail/cancelled), mirroring `deriveWorkerGateVerdict`'s own field mapping off the identical detail shape that function's live caller populates. `undefined` only for an "error" audit write (the audit-on-error site in `runWorkerGate`, `evt({passed:false, error, ...})`) — that shape carries no `phase`/`failedStep`/etc. to recover, so it is intentionally left unrecovered rather than fabricating a fail with false diagnostic fields.

For `kind: "merge"`: deliberately more conservative than "gate", because a passing gate is not the end of a merge — it is followed by the actual git squash-merge, a step this audit trail never logs at all.
- A `merge_cancelled` or `merge_rejected` event is a genuine terminal signal: `confirmWorkerMerge` returns immediately after logging either one (see its own cancel/rejection branches) — squash is never reached on either path. `merge_rejected`'s richer detail (failingTest/phase/etc., logged only for a `reason:"gate"` rejection) is preferred whenever both it and a bare `build_gate` fail exist for the same opId.
- A bare `build_gate`/`build_gate_retry` event with `passed:false` and no rejection/cancel event is also safely recoverable as a fail (with less detail): the code path that logs it can only go on to the rejection branch next (the squash is only reachable once the gate has passed), so the verdict was already decided the instant this event was written — the crash (if any) struck only the richer notify/evt calls that were about to follow, never the outcome itself.
- A passing `build_gate`/`build_gate_retry` with no subsequent rejection/cancel is the one shape this deliberately does NOT recover: "the gate passed" is not proof "the merge landed" — the crash could have struck during the unlogged squash step. Falls through to `undefined`, which the caller must treat as "outcome genuinely unrecoverable," never as license to fabricate a pass.

`events` is expected in the chronological order `Db.findGateOpEventsByOpId` already returns (`seq ASC`); the function does not itself depend on that order beyond documenting intent (a `.find`/`.reverse().find` over an out-of-order array would still return a match, just not necessarily the newest one for the bare-fail fallback — keep the caller passing chronological order).

## Do not

- Do not treat a passing `build_gate`/`build_gate_retry` with no subsequent rejection/cancel as a recovered merge pass — the unlogged squash step could still have failed after the crash.
- Do not fabricate a fail with diagnostic fields for an "error" audit write (no `phase`/`failedStep`/etc. captured) — leave it unrecovered.
- Do not call `recoverGateOpVerdict` with an out-of-order `events` array — the bare-gate-fail fallback relies on chronological order to prefer the most recent retry.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`recoverGateOpVerdict`'s top-of-function doc): lines 910-951, as of this tranche's HEAD. Relocated by card 5dcc1e98 (tranche 6); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
