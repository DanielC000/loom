# 47a22d40 — dead-owner eviction needs a stuck-past-ceiling gate, not just a dead owner

## Narrative

Dead OWNERSHIP of a `PendingOpRegistry` merge op is never, by itself, proof that the op has stopped
progressing — a `state:"running"` entry is PROCESS-LOCAL and always backed by a currently-executing
`run()` promise in this process, so it will settle on its own. `SessionService.isDeadOwnerOpStuck`
additionally requires the op to have outlived `SessionService.deadOwnerEvictionCeilingMs` — the SAME
ceiling `confirmWorkerMergeUntilSettled` already gives up waiting at (`gateCommandTimeoutMs * 6`, else
`DEFAULT_REST_MERGE_CEILING_MS`), resolved through one shared helper so `confirmWorkerMergeTracked`'s
per-call check and `reconcileDeadOwnerMergeOps`'s boot sweep can never diverge on the policy. Below the
ceiling, a dead-owner'd RUNNING entry is left alone — the caller falls through to the ordinary
`pendingOps.attach()` dedupe instead of evicting-and-reminting it.

The full incident — the production race this closes, and the correction to decision `27ea069e`'s own
prior (wrong) reasoning about why eviction was safe — is recorded there:
`docs/decisions/27ea069e-dead-owner-recovery-the-one-eviction-exception.md` (see its "Card `47a22d40`"
section). This file exists only so the `@decision 47a22d40` anchors in `sessions/service.ts`
(`deadOwnerEvictionCeilingMs`, `isDeadOwnerOpStuck`, and the two call sites) resolve to a real record —
`resolveRecord`'s file lookup matches by FILENAME prefix against the id, so an id's own narrative living
only as a section inside a DIFFERENT id's file would otherwise never be found for this one.

CORRECTED (Round 2, Code Review 8c0d76c6): `startedAt` is stamped at MINT time inside
`PendingOpRegistry.attach` (before `run()` is ever invoked), which means elapsed-since-mint is
`queueWaitTime + realRunningTime` — LARGER than the op's own real running time alone. That makes the
ceiling comparison LEAN TOWARD EVICTING SOONER than a measurement from actual admission would, never
"erring toward never evicting" (an earlier version of this note claimed the opposite). An op that sat
queued for a while before its real work even started crosses the ceiling sooner than its own compute time
alone would justify. Accepted as a known, narrow approximation — measuring from admission instead is
optional future work, not required — because the ceiling itself is large relative to any ordinary queue
wait, so in practice it rarely matters.

## Do not

- Do not evict a RUNNING `PendingOpRegistry` entry on dead ownership alone — always gate eviction on
  `isDeadOwnerOpStuck` (elapsed time since mint past the shared ceiling) too.
- Do not re-derive the ceiling (`gateCommandTimeoutMs * 6` / `DEFAULT_REST_MERGE_CEILING_MS`) at a second
  call site — both `confirmWorkerMergeTracked` and `reconcileDeadOwnerMergeOps` must resolve it through
  the SAME `SessionService.deadOwnerEvictionCeilingMs` helper, or the two can silently diverge.
- Do not read `GateSemaphore` as covering anything outside the gate COMMAND itself — the union-merge,
  worktree-stamp read, and squash/finalize around it are unserialized against a concurrent op on the same
  worktree (see `27ea069e`'s own appended section for the full reasoning).
- Do not pass a `deadOwnerEvictionCeilingMs` override in a test that is supposed to be proving the
  PRODUCTION formula is correct (e.g. a mutation to that formula) — an overridden test can never catch a
  regression in the formula itself. Use the override only to decouple an unrelated timing claim (a real
  git merge's own speed) from the ceiling; pin the formula's actual arithmetic separately, with no
  override and no real git (see `merge-rest-route-tracked.mjs` scenario (9)).

## Known gap: no targeted escape for a genuinely stuck op below the ceiling

Below the ceiling, a dead-owner op that happens to be GENUINELY stuck (not merely slow — a real hang, no
timeout anywhere in its own call chain) has no targeted recovery: `gate_cancel` refuses to cancel a
RUNNING merge gate (only a QUEUED one), and `daemon_restart` wipes the whole in-memory
`PendingOpRegistry` — a blunt, fleet-wide instrument, not a per-op one. This is the SAME posture a
live-owner's stuck op already had before this card (nothing here regresses it) — a live owner's op was
never evictable either, stuck or not. Accepted as a known gap, not fixed by this card: it earns its own
board card only if a real wedge is ever actually observed in practice, rather than being speculatively
built against now.

## Reparent trace (Round 2, item 6)

Every place that reassigns a worker's (or a manager's) `parent_session_id` — forward (the ordinary
recycle handoff) or reverse (recovering a failed/halted recycle successor back onto its predecessor) —
stays strictly WITHIN one recycle lineage, confirmed by reading each call site:

- **Forward, the ordinary case:** `SessionService.recycleManager`/`recyclePlatformLead` call
  `Db.reparentLiveWorkers(oldManagerId, freshId)` (`service.ts:13664` area) — `oldManagerId` and `freshId`
  are predecessor/successor by construction (the recycle call itself mints `freshId` FROM `oldManagerId`).
- **Forward, on-demand self-heal:** `mcp/orchestration.ts`'s `selfHealWorkerLink` calls
  `Db.relinkWorkerToManager` only after its own `workerReadableByManager` check passes — that check
  requires `lineageRootId(callingManager) === lineageRootId(worker.parentSessionId)` (`mcp/orchestration.ts:2686-2693`)
  — it can only repair a STALE link within an ALREADY-shared lineage, never move a worker to an unrelated one.
- **Reverse, failed-successor recovery:** `SessionService.recoverFleetAfterFailedRecycleSuccessor`
  (`service.ts:13374`, `reparentLiveWorkers(freshId, oldId)`) and its platform/recycle-settle sibling
  (`service.ts:13593`, `reparentAllChildren(freshId, predecessorId)`) reparent WORKERS BACK from a
  successor that died/failed before taking over, onto the (confirmed-still-alive) predecessor — both
  guarded by `fresh.recycledFrom === predecessorId`/an equivalent lineage check before touching anything,
  and by confirming the destination (`isDurablyResumable`/`pty.isAlive`) is actually viable first.
- **Reverse, boot-time halted/stranded recycle reconcile:** `halted-recycle-reconcile.ts:49` and
  `recycle-settle-reconcile.ts:113` (both `reparentAllChildren(fresh.id, predecessorId)`) run the
  identical pattern at boot — `fresh.recycledFrom === predecessorId` checked immediately before, and
  `isDurablyResumable` checked on BOTH sides (never resurrecting onto an equally-unresumable predecessor).

None of these can ever produce a worker whose `parentSessionId` points outside the lineage its merge op
was originally minted under. Combined with `confirmWorkerMergeTracked`'s own `sameManagerLineage`
pre-check (any caller must share that SAME lineage root to reach the dead-owner check at all) and
`isManagerLineageDead`'s own whole-lineage walk, this is why plain attach-without-reown is sufficient for
the RESULT every caller gets: there is no code path that hands a running op to a genuinely different,
unrelated manager mid-flight. A settle-time push notification to a lineage with no live member at all
still goes nowhere useful — pre-existing, accepted, best-effort behavior, unchanged by this card.

## Source

`packages/daemon/src/sessions/service.ts`: the `@decision 47a22d40` anchors at
`confirmWorkerMergeTracked`'s dead-owner check, `reconcileDeadOwnerMergeOps`, `deadOwnerEvictionCeilingMs`,
and `isDeadOwnerOpStuck`. Discovering card `19f959ea`; project memory
`mrt-dead-owner-release-flake-pre-existing`. Regression tests:
`packages/daemon/test/merge-rest-route-tracked.mjs` scenarios (8) (the real race, real production
formula, real git) and (9) (the ceiling formula pinned directly, no real git); `packages/daemon/test/merge-confirm-dead-owner-recovery.mjs`
scenario (6) (the converse — still under the ceiling, both recovery paths leave it alone).
