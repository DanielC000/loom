# 59986602 — a merge's pre-admission wait on its worker's self-check is abortable, keyed by the MERGE's own opId; the self-check is never touched

## Narrative

Card 59986602, a Code Review finding on `5f7d7a01` (Round 4 of `docs/decisions/164f7915-*.md`): that round made `confirmWorkerMerge` wait (`pendingOps.waitBriefly`, bounded by `gateTimeoutMs`) for the worker's own RUNNING `run_gate` self-check before its reuse checks run. Pre-`5f7d7a01`, that same duration was spent as a QUEUED merge in `GateSemaphore.runExclusive` — visible in `gate_queue` and cancellable via `gate_cancel`. Post-`5f7d7a01` it became an invisible pre-admission wait: nothing in `GateSemaphore` exists yet for this merge op (its own gate admission only happens later, in the reuse-miss path), so `gate_queue` showed no row for it and `gate_cancel(mergeOpId)` returned `not_found` with misleading text. Precedent: `b9e07a4a`'s Code Review treated an uncancellable merge wait the same way (`findRepoGuardOnlyByOpId`).

## The plan-review ruling (manager, same card) — `gate_cancel(mergeOpId)` cancels the MERGE, never the self-check

An earlier draft of this fix redirected a merge-opId cancel into cancelling the underlying self-check instead. Rejected: (1) a manager who cancels a merge wants it NOT to land — redirecting to the self-check instead lets the merge proceed to a fresh real gate and possibly squash, the opposite of what was asked; (2) it doesn't fix the card's own worst case — when a self-check's kill is unverified, `runWorkerGate`'s own promise never resolves, so cancelling the self-check doesn't free the merge either.

## The fix

`SessionService.parkedMergeWaits` (a `Map<mergeOpId, ParkedMergeWait>`) is the ONE source of truth for "is this merge op genuinely parked, pre-admission, waiting on its worker's self-check right now." `confirmWorkerMerge` registers an entry immediately before racing `pendingOps.waitBriefly('gate:'+workerSessionId, gateTimeoutMs)` against a locally-owned abort signal, and ALWAYS removes it (in a `finally`) regardless of how the race ends — so an entry's mere presence is definitionally "parked in this wait right now," never re-derived from `peek()` plus a scan of `gateSemaphore`'s snapshots.

On abort, `confirmWorkerMerge` returns immediately with the SAME clean `{merged:false, cancelled:true, cancelKind:"manual", reason, opId}` shape a QUEUED merge-gate withdrawal already produces (the `GateCancelledError` catches around `acquireRepoGuardOnly`/`runExclusive` elsewhere in this method) — reusing the EXISTING, generic settle/classify/nudge machinery (`confirmWorkerMergeTracked`'s `classifyOutcome` already branches on `outcome.value.cancelled` first; its `onSettle` callback already fires `[loom:merge-cancelled]` for any result shaped this way) rather than inventing a new outcome kind. Nothing downstream of the abort ever runs: the union-merge (if any) already ran BEFORE this wait, well upstream; the real gate, the inert-diff-skip decision, and the squash are all reached only AFTER this wait returns, so an abort here never lets any of them start.

`gateQueueForManager` gained a sixth, independent array, `waitingOnSelfCheck` (`WaitingOnSelfCheckQueueEntry[]`), built by reading `parkedMergeWaits` directly — never `gateSemaphore` (there is nothing registered there yet for this op). Each row carries the merge's own `opId` (pass this to `gate_cancel`) and the self-check's own `blockingOpId` (informational — cancel it separately, via the SAME tool, if its own verdict should stop too), plus the same cross-project redaction posture `RepoGuardOnlyQueueEntry`/`SquashQueueEntry` already use.

`cancelGateOp` gained a third fallback tier, tried after the ordinary gate registry (`gateSemaphore.findByOpId`) and the repo-guard-only wait (`gateSemaphore.findRepoGuardOnlyByOpId`) both miss, before the final `not_found`: resolve the caller's opId (full id or an unambiguous prefix, via `resolveIdPrefix`, same unscoped-then-project-scoped ambiguity handling as the two fallbacks above it) against `parkedMergeWaits`, then call that entry's own `cancel(detail)`. `cancel()` is idempotent (a `settled` flag guards it) so a stale/duplicate call, or one that loses a genuine race against the wait ending naturally, reports `not_cancelled` rather than a fabricated second cancel. The success response carries an additive `note` field (the ONLY "cancelled" outcome shape that does — every pre-existing caller omits it, byte-identical) naming the self-check's own opId and stating plainly that it was left running.

## Why no admission race is needed in the test

Unlike `5f7d7a01`'s own admission-race test (`merge-confirm-self-check-admission-race.mjs`), this fix's test (`merge-confirm-parked-wait-cancellable.mjs`) needs no cap-saturating holder or timing race at all: a `PendingOpRegistry` entry's `state` is `"running"` from the instant it is MINTED, well before any `GateSemaphore` admission (see `peekPendingMerge`'s own doc) — so a plain `runWorkerGate(workerId)` call already satisfies `confirmWorkerMerge`'s `gate:<id>` "running" check deterministically.

## Do not

- Do not redirect a `gate_cancel(mergeOpId)` call against a parked wait into cancelling the underlying self-check — the manager-ruling above rejected that shape twice: it lets the merge proceed instead of stopping it, and it doesn't even close the card's own worst case (an unverified self-check kill that never resolves).
- Do not touch the self-check from this new `cancelGateOp` branch, ever — it is left running, untouched, on purpose; its own verdict may still be wanted by its worker or a later re-confirm.
- Do not invent a new `ConfirmMergeResult` outcome kind for this abort — reuse the existing `cancelled:true`/`cancelKind:"manual"` shape and the generic settle/classify/nudge machinery that already handles it.
- Do not derive `waitingOnSelfCheck`/the new `cancelGateOp` fallback from `pendingOps.peek()` plus a scan of `gateSemaphore`'s snapshots — both must read `parkedMergeWaits` directly; that map's registration window is the ONE source of truth for "is this merge genuinely parked here right now."
- Do not widen `parkedMergeWaits`' bound past `gateTimeoutMs` (it already races `waitBriefly`'s own existing bound) or make it persist across a restart — it is plain in-memory, same posture as `gateStartStamps`/`lastWorkerGateCheck`; a parked wait that outlives a restart simply has no entry after reboot, and a `gate_cancel` against it then correctly falls through to `not_found`.
- Do not report `note` on any OTHER `cancelGateOp` "cancelled" branch — it is additive and specific to this one fallback; every pre-existing caller must keep omitting it, byte-identical.

## Source

`packages/daemon/src/sessions/service.ts` (`parkedMergeWaits`, `ParkedMergeWait`, `WaitingOnSelfCheckQueueEntry`, the abortable wait in `confirmWorkerMerge`, the `gateQueueForManager`/`cancelGateOp` reads), `packages/daemon/src/mcp/orchestration.ts` (`gate_queue`/`gate_cancel` tool descriptions). Test: `packages/daemon/test/merge-confirm-parked-wait-cancellable.mjs`.
