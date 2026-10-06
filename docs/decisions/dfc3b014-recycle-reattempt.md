# dfc3b014 — `recycle_reattempt`: re-unite a halted recycle's split ownership

## Narrative

Background: `f1969787` made `recycleManager` retry a failed ownership-transfer handoff once, then HALT
instead of retiring the predecessor if it's still failing — the predecessor stays live, ownership splits
per category between predecessor and successor. Nothing ever retries that handoff automatically; neither
manager has a tool to move ownership; the predecessor can't recycle again (`hasSuccessor` throws forever);
and `peer_message`/`notify_lead`'s "find the live manager" lookups excluded any `hasSuccessor` session,
so fresh traffic boarded instead of reaching the live, still-functioning predecessor. `386e4eb5` closed the
auto-resume side of this (a halted predecessor survives a daemon restart, via `currentHaltedSuccessor`) but
explicitly deferred the manual re-attempt/reunite path to this card, and named the one extension point it
would need: a resolution marker, since a settle-forward path (unlike every existing reclaim path) must
NOT null `recycled_from` — the lineage is real.

This card adds:

1. **`recycle_reattempt`** (self-scoped manager MCP tool, `mcp/orchestration.ts`, takes a REQUIRED
   `handoffNote` mirroring `recycle_me`'s own `continuationPrompt`) — the predecessor's own remedy. Three
   branches depending on the named successor's health:
   - **successor confirmed dead AND NOT durably resumable** (`isDurablyResumable`, same check
     `reconcileHaltedRecycleSuccessorsEarly` already applies to the successor on the boot path) → not a
     retry, a manual RECLAIM: calls the existing `recoverFleetAfterFailedRecycleSuccessor` directly. This
     is also what closes the "halted-predecessor-can't-recycle" gap: once that reclaim nulls
     `recycled_from`, `recycleManager`'s existing, UNCHANGED double-recycle guard naturally allows a fresh
     recycle — no change needed there. It's needed because `watchHaltedRecycleSuccessor`'s own window
     closes the instant `hasReachedReady` is ever observed, so a successor that dies LATER (after reaching
     ready, same daemon uptime) has no automatic reclaim today.
   - **successor confirmed dead BUT durably resumable** (ROUND 2, Code Review MAJOR) → REFUSE, not
     reclaim: a successor that crashed after capturing a real engine id + transcript is exactly what the
     live crash-recovery watchdog or a later `resumeFleetOnBoot` will bring back on its own; reclaiming
     here would stamp it permanently dead (`unlinkAndArchiveDeadRecycleSuccessor`) and lose whatever
     context it held forever — the exact asymmetry `reconcileHaltedRecycleSuccessorsEarly`'s own
     `isDurablyResumable(fresh)` gate already avoids on the boot path, now mirrored live. **ROUND 3
     correction:** the refusal text is now TRUTHFUL about whether anything will actually recover it —
     checks the SAME `isCrashRecoveryEligible` predicate the live watchdog itself consults (role/engine-id/
     resumability/superseded/maxAttempts/pause/attempt-cap) before promising a recovery that may never
     come (an intentional stop, crash recovery exhausted or disabled, or a restart whose boot reconcile
     doesn't cover this specific shape all resolve `isCrashRecoveryEligible` to `false` the same way): when
     eligible, "wait for its automatic recovery, then retry"; otherwise "nothing will recover it
     automatically — escalate: a human must resume successor `<id>`, then retry".
   - **successor alive + ready** → forward retry: re-runs `attemptManagerOwnershipTransfer`, then (only if
     `workers` is now clean) `attemptPendingQueueCarry` (extracted out of `recycleManager`'s own inline
     logic so there is exactly one copy, never two that can drift). If still partially failing: files an
     audit-only `recycle_reattempt_failed` event and returns `{outcome:"still-split", failedSteps}` — no
     nudges are re-sent (the predecessor already has the information in the tool's own return value; the
     successor already learned the split at the original halt). If everything is now clean: files the
     resolution marker (see below) SYNCHRONOUSLY — never swallowed; a failure there refuses the whole call
     rather than proceeding — hands the successor `handoffNote` via a durable nudge, then fires
     `settleRecycleHandoff` WITHOUT awaiting it (ROUND 2, Code Review MAJOR — see below) before returning
     `{outcome:"resolved", reparentedWorkers, successorId}`.
   `recycleManager`'s halt-branch nudges (to both predecessor and successor) now name `recycle_reattempt`
   as the action, closing the "addressed directive" gap a bare notice doesn't.

   **ROUND 2 (Code Review of `db1b9d05`, two blocking Majors):** the first landing (1) reclaimed on bare
   `!pty.isAlive(successor)`, with no `isDurablyResumable` check — wrongly reclaiming (and permanently
   killing) a successor that was merely down-but-recoverable, an asymmetry with the boot-path reconcile's
   own gate; fixed by the branch split above. (2) the `resolved` branch AWAITED `settleRecycleHandoff`,
   which hard-stops the CALLER's own pty before the method's `{outcome:"resolved"}` response could ever
   reach it — the predecessor was retired with no handoff delivered and no response received. Fixed by
   adding the required `handoffNote` param, filing the resolution marker and delivering the handoff BEFORE
   firing `settleRecycleHandoff` unawaited (mirrors `recycleManager`'s own fire-and-forget settle call) —
   the response now reaches the still-live caller first, exactly like `recycle_me` already does.

2. **The resolution marker** — a new `recycle_ownership_transfer_resolved` event kind, filed with the SAME
   `workerSessionId`/`managerSessionId` identity shape as `recycle_ownership_transfer_failed`.
   `currentHaltedSuccessor` (orchestration/crash-orphaned-workers.ts) now filters BOTH kinds and takes the
   chronologically-latest (`.at(-1)`, same `ORDER BY ts, rowid` guarantee already tested) — if the latest
   matching event is the resolved kind, the lineage is no longer an unresolved halt, full stop; only a
   `*_failed` latest proceeds to the existing id/gen match. This is the one case a halt resolves WITHOUT
   `recycled_from` ever being nulled (every other reclaim path nulls it, which alone already makes
   `currentHaltedSuccessor` return `undefined` via its `getSuccessor` check). **ROUND 2 correction:** this
   marker is now filed SYNCHRONOUSLY, before `settleRecycleHandoff` is ever fired (not after it returns —
   see point 1's ROUND 2 note) — a race with that method's own death-during-flush-delay fallback is still
   harmless either way, since that fallback nulls `recycled_from`, and `currentHaltedSuccessor`'s very
   first check (`!db.getSuccessor(sessionId)`) already returns `undefined` before the resolved-kind check
   is ever reached, regardless of whether the marker was filed moments earlier.

3. **`findLiveManagerForProject`** (shared private helper, `sessions/service.ts`) — replaces the two
   near-duplicate `peer_message`/`notify_lead` arrow functions that both excluded ANY `hasSuccessor`
   session unconditionally. A live candidate with no successor is always a match. A live candidate WITH a
   successor is excluded in favor of that successor when the successor is itself live (the ordinary
   in-flight-recycle case — unchanged). When the successor is NOT live, the candidate is still valid IFF
   `currentHaltedSuccessor` confirms it's genuinely the still-unresolved halted owner — otherwise it stays
   excluded (today's conservative default: board the message). This is what lets fresh peer/assistant
   traffic reach a live, still-halted predecessor instead of boarding while its dead-or-not-yet-live
   successor sits unreachable.

4. **Both-dead split lineage**: explicitly OUT OF SCOPE for this card (manager sign-off, 2026-10-06) — no
   live session exists in that state to call `recycle_reattempt` at all, and unifying it is DB-only
   bookkeeping with no serving-traffic concern; tracked as a separate follow-up card.

5. **Stale comments/labels**: the `peer_message`/`notify_lead` comments claiming to mirror
   `redriveQueuedMessage`'s own `hasSuccessor` guard were rewritten (that guard moved to
   `isSupersededByRecycle` under `f1969787`, making the old cross-reference false).
   `currentHaltedSuccessor`'s own doc now states "id is the real discriminator, gen is a defensive
   secondary check" to match `halted-recycle-reconcile.ts`'s identical framing.
   `is-superseded-by-recycle.mjs`'s case (4) label was corrected from "STALE GENERATION (different
   successor id)" to "DIFFERENT SUCCESSOR (id mismatch, via clean re-recycle)" — it's an id mismatch, not
   a generation one (case (5) is the genuine gen-mismatch case and keeps its label). **ROUND 3 (Nit):** case
   (9) relabeled as a PURE TS-ORDERING UNIT CHECK — a halt chronologically after a resolved event for the
   same id+gen is unreachable in production (`recycle_reattempt` only ever files the resolved kind once a
   lineage is clean), but the predicate's own "latest by ts, not by kind" mechanism still needed proving.

6. **ROUND 3 (Code Review of `4c8795fb`, three non-blocking items):** (1) the resumable-down refusal text
   from ROUND 2 (point 1 above) was a dead end whenever nothing would ever actually recover the successor —
   fixed, see point 1's own ROUND 3 note. (2) added the missing test for a `recycle_ownership_transfer_
   resolved` append failure (stubbed `db.appendEvent`): the call throws, the predecessor is never stopped,
   `settleRecycleHandoff` never fires, and `currentHaltedSuccessor` still matches — all deterministic
   (the throw happens synchronously before either of those). (3) the handoff nudge now passes `onOutcome`
   to `enqueueDurableNudge`: on `dispatched:false` it records a new, audit-only
   `recycle_reattempt_handoff_undelivered` event (the ownership transfer + resolution marker are already
   durable and unaffected by this nudge's own fate — this names only the one thing that didn't survive).

## Do not

- Do not AWAIT `settleRecycleHandoff` in the `resolved` branch — it hard-stops the CALLER's own pty, so a
  response built after that await can never reach a caller that no longer exists (ROUND 2, Code Review
  MAJOR). File the resolution marker and deliver the handoff BEFORE firing it, unawaited.
- Do not swallow a failure to file `recycle_ownership_transfer_resolved` — if the append throws, refuse the
  whole call (never proceed to fire `settleRecycleHandoff`) so a predecessor is never stopped without the
  marker that keeps it correctly superseded afterward.
- Do not reclaim a dead successor without first checking `isDurablyResumable(successor)` (ROUND 2, Code
  Review MAJOR) — a successor that crashed after capturing a real engine id + transcript is a live
  crash-recovery/boot-resume candidate, not a reclaim target; reclaiming it permanently stamps it dead and
  discards its context. Refuse instead.
- Do not refuse a resumable-down successor with a flat "wait for its recovery" (ROUND 3) — that is a dead
  end whenever nothing will ever attempt one (an intentional stop, crash recovery exhausted/disabled, or a
  restart the boot reconcile doesn't cover). Check `isCrashRecoveryEligible` and say which is actually true.
- Do not let a nudge's own dispatch failure (ROUND 3) silently vanish into a console line only — pass
  `onOutcome` and record a narrow, audit-only event on `dispatched:false`. Do not let it block or roll back
  the already-durable ownership transfer + resolution marker, which are unaffected by this nudge's fate.
- Do not add `recycle_ownership_transfer_resolved`/`recycle_reattempt_failed` to
  `EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS` — mirrors
  `recycle_ownership_transfer_failed`'s own posture (decision `5a56bb0a`); no wake-mode trigger or
  report-resolution logic should key off a recycle audit trail.
- Do not let `recycle_reattempt_failed`'s id/gen feed `currentHaltedSuccessor`'s match — a retry attempt
  changes neither; only the resolved kind (or a genuinely new halt on a later generation) should.
- Do not loosen `recycleManager`'s `hasSuccessor` double-recycle guard to "fix" the
  halted-predecessor-can't-recycle gap — a predecessor with TWO successors is a real three-way split
  `attemptManagerOwnershipTransfer`/`currentHaltedSuccessor` aren't built to handle. Give the predecessor a
  way to RECLAIM first (closing `hasSuccessor` back to false), then let the existing, unchanged guard do
  its job.
- Do not re-derive the "live manager for project X" lookup inline at a THIRD call site — extend
  `findLiveManagerForProject` instead, or the fix drifts the same way the original two near-duplicates did.
- Do not build the both-dead consolidation here — it is a separate follow-up card by manager sign-off; no
  live caller exists for that state, and reparenting onto an unresumable predecessor needs its own careful
  design (see `386e4eb5`'s own "Both-dead split lineage" section for why it was deferred, twice now).

## Source

`packages/daemon/src/sessions/service.ts` (`reattemptManagerOwnershipTransfer`, `attemptPendingQueueCarry`,
`findLiveManagerForProject`, `recycleManager`'s halt-branch nudges), `packages/daemon/src/mcp/orchestration.ts`
(`recycle_reattempt`), `packages/daemon/src/orchestration/crash-orphaned-workers.ts`
(`currentHaltedSuccessor`), `packages/daemon/src/agents/promptLint.ts` (`ORCH_MANAGER_TOOLS`), and
`packages/shared/src/types.ts` (`OrchestrationEventKind`), landed by card `dfc3b014`.
