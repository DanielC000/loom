# 7d492f8b — `findGateOpEventsByOpId` is an unindexed scan, accepted because it's boot-time only

⚠️ Spans two decisions: this record (§1, `db.ts`), and `recoverGateOpVerdict` (§2, `sessions/service.ts`),
which consumes what §1 returns. `resolveRecord` serves one file per id; folded here rather than left as a
second unreachable `7d492f8b-*.md` file (card `6de8956e`).

## §1 — Narrative

Card 7d492f8b: `findGateOpEventsByOpId` returns every durable audit event stamped with a given gate/merge op's `opId` (see `confirmWorkerMerge`'s/`runWorkerGate`'s own `evt` closures, which merge `opId` into every emitted `detail` unconditionally) — the read `SessionService.reconcileOrphanedGateOps` needs to recover a genuinely-settled op's real outcome from durable history (see the sibling record on `recoverGateOpVerdict` for how that outcome is derived from the events this returns).

`opId` is a UUID minted once per op (`PendingOpRegistry.attach`'s `onOpMinted`), so an exact `json_extract` match is unambiguous — no `kind` filter needed; a "merge" op can log more than one event under the same `opId` (e.g. `build_gate` then `merge_rejected`), so this returns ALL of them, ordered `seq ASC` (chronological, the never-reused monotonic sequence) so a caller reading them in event order sees them in the order they actually happened. It's an unindexed `json_extract` scan over the whole table — accepted: this is called ONLY from a boot-time sweep, only for the (normally zero, always small) set of rows still `state:'pending'` after a restart, never a hot path (mirrors `listScheduleHistory`'s own precedent for an unindexed `json_extract` filter).

### Do not

- Do not add a `kind` filter to this query — `opId` alone is already an unambiguous match, and a "merge" op legitimately logs more than one event kind under it.
- Do not index this scan or worry about its cost — it only ever runs from the boot-time sweep over the (normally zero, always small) still-pending set, never a hot path.

### Source

Inline comment in `packages/daemon/src/db.ts` (`findGateOpEventsByOpId`): lines 6032-6046, as of this tranche's HEAD.

## §2 — recover a settled gate/merge op's verdict from durable audit events, not just the tombstone

### Narrative

Recovers a genuinely-settled gate/merge op's real verdict from its own durable audit events (§1's `findGateOpEventsByOpId`, keyed off the `opId` every `evt()` closure stamps onto its detail) — the fix for `SessionService.reconcileOrphanedGateOps` misreporting a settled op as `orphaned-by-restart` purely because its `pending_gate_ops` tombstone row never reached `state:'settled'` before a crash. A crash can land in the (normally millisecond-wide) gap between the op's own `evt()` write — unconditional, happens the moment the run genuinely finishes — and the later `PendingOpRegistry.attach()` settle callback that flips the tombstone (`onSettle` → `settlePendingGateOp`); that gap is not always millisecond-wide (e.g. `confirmWorkerMerge` still awaits `rejectNotify` after its `build_gate` write but before `merge_rejected`), so the durable audit trail can be strictly more complete than the tombstone.

For `kind: "gate"` (a worker's own `run_gate` self-check): the single `worker_gate` event IS the op's own terminal signal — nothing follows it in `runWorkerGate` — so whichever one is found is fully recoverable (pass/fail/cancelled), mirroring `deriveWorkerGateVerdict`'s own field mapping. `undefined` only for an "error" audit write — that shape carries no `phase`/`failedStep`/etc. to recover, so it stays unrecovered rather than fabricating a fail with false diagnostic fields.

For `kind: "merge"`: deliberately more conservative, because a passing gate is not the end of a merge — the actual git squash-merge follows it, a step this audit trail never logs.
- A `merge_cancelled` or `merge_rejected` event is a genuine terminal signal: `confirmWorkerMerge` returns immediately after logging either — squash is never reached. `merge_rejected`'s richer detail (failingTest/phase/etc.) is preferred whenever both it and a bare `build_gate` fail exist for the same opId.
- A bare `build_gate`/`build_gate_retry` with `passed:false` and no rejection/cancel is also safely recoverable as a fail (less detail): squash is only reachable once the gate has passed, so the verdict was already decided the instant this event was written.
- A PASSING `build_gate`/`build_gate_retry` with no subsequent rejection/cancel is the one shape deliberately NOT recovered: "the gate passed" is not proof "the merge landed" — the crash could have struck during the unlogged squash step. Falls through to `undefined`; the caller must treat that as "genuinely unrecoverable," never license to fabricate a pass.

`events` is expected in the chronological order §1 already returns (`seq ASC`) — a `.find`/`.reverse().find` over an out-of-order array would still match, just not necessarily the newest one for the bare-fail fallback.

### Do not

- Do not treat a passing `build_gate`/`build_gate_retry` with no subsequent rejection/cancel as a recovered merge pass — the unlogged squash step could still have failed after the crash.
- Do not fabricate a fail with diagnostic fields for an "error" audit write (no `phase`/`failedStep`/etc. captured) — leave it unrecovered.
- Do not call `recoverGateOpVerdict` with an out-of-order `events` array — the bare-gate-fail fallback relies on chronological order to prefer the most recent retry.

### Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`recoverGateOpVerdict`'s top-of-function doc): lines 910-951, as of this tranche's HEAD. Relocated by card `5dcc1e98` (tranche 6). Folded into this pre-existing record by card `6de8956e`.
