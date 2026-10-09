import type { Db } from "../db.js";
import { currentHaltedSuccessor, openUnresolvedRecycleFleetAlert } from "../orchestration/crash-orphaned-workers.js";
import { isDurablyResumable } from "./recycle-settle-reconcile.js";

/**
 * @decision f1969787 — the EARLY, DB-only half of boot-time recovery for a HALTED manager recycle (see
 * `recycleManager`'s halt branch) whose successor is unresumable across a restart; run BEFORE
 * `Db.recoverStaleSessions()`, same reason as `reconcileStrandedRecycleSettlesEarly`.
 */
export interface HaltedRecycleEarlyResult {
  /** The successor is NOT durably resumable this boot — reparented back onto the predecessor already
   *  (DB-only; `finishReconcilingHaltedRecycleSuccessors` does the rest once SessionService exists). */
  recovered: { predecessorId: string; freshId: string; reparentedWorkers: number }[];
  /** @decision d9512de7 — a durably-resumable successor with a still-open unresolved alert; never
   *  resolved from this DB-only check alone. See the full record for why. */
  pendingResolution: { predecessorId: string; freshId: string }[];
  /** @decision a4c5f234 — both sides unresumable this boot; reparented onto the predecessor as bookkeeping
   *  only (never served). See the full record. */
  consolidated: { predecessorId: string; freshId: string; reparentedWorkers: number }[];
}

export function reconcileHaltedRecycleSuccessorsEarly(db: Db): HaltedRecycleEarlyResult {
  const recovered: HaltedRecycleEarlyResult["recovered"] = [];
  const pendingResolution: HaltedRecycleEarlyResult["pendingResolution"] = [];
  const consolidated: HaltedRecycleEarlyResult["consolidated"] = [];
  for (const predecessorId of db.listWorkerSessionIdsWithEventKind(["recycle_ownership_transfer_failed"])) {
    try {
      // Already resolved (a prior boot's own later phase, or the in-process watch, already reclaimed it) —
      // `hasSuccessor` flips false the moment that happens, so there's nothing left to do here.
      if (!db.hasSuccessor(predecessorId)) continue;
      const predecessor = db.getSession(predecessorId);
      if (!predecessor) continue;
      // `recycle_ownership_transfer_failed` is PERMANENT (never cleared), so a predecessor that halted
      // once, was later cleanly reclaimed (its halted successor died, ownership came back), and was then
      // cleanly re-recycled to a BRAND NEW successor still shows up in listWorkerSessionIdsWithEventKind
      // above. `currentHaltedSuccessor` (shared with `isSupersededByRecycle`) tells that apart from a
      // genuinely still-halted lineage: it returns the successor ONLY when it is the EXACT one the latest
      // halt event named (id — the real discriminator; gen is checked too, but only as a defensive
      // secondary check, ⛔ never simplify the match to gen-only) — a lineage whose CURRENT successor is a
      // DIFFERENT session than the one the halt event named (an id mismatch) is an ordinary clean recycle,
      // handled entirely by `reconcileStrandedRecycleSettlesEarly`'s own settle-pending marker, and must be
      // left untouched here. See that function's own doc comment (orchestration/crash-orphaned-workers.ts)
      // for the full match rule and its decision record (card 386e4eb5).
      const fresh = currentHaltedSuccessor(db, predecessorId);
      if (!fresh) continue;
      // The successor can still be resumed THIS boot — leave the lineage untouched; it'll be attempted via
      // the ordinary resumeFleetOnBoot/crash-recovery paths (nothing excludes a halted-lineage successor),
      // and ownership simply stays split if that attempt succeeds. A later resume FAILURE here is a known,
      // narrow residual this early-only design accepts (mirrors `reconcileStrandedRecycleSettlesEarly`'s
      // own `deferred`-bucket shape, without that bucket's later-phase fallback — out of scope for this pass).
      if (isDurablyResumable(fresh)) {
        // @decision d9512de7 — record the pair ONLY when an unresolved alert is still genuinely open for
        // it; most halted lineages resolve via the live watch long before any restart, and arming an
        // observer for those would be pure waste. See the full record for why this can't be resolved here.
        if (openUnresolvedRecycleFleetAlert(db, predecessorId, fresh.id)) {
          pendingResolution.push({ predecessorId, freshId: fresh.id });
        }
        continue;
      }
      // Shared by both branches below — moving S1's categories onto P is identical bookkeeping whether P
      // turns out resumable (`recovered`) or not (`consolidated`).
      const reparentOntoPredecessor = (): number => {
        if (fresh.recycledFrom === predecessorId) db.setOrchestration(fresh.id, { recycledFrom: null });
        const reparentedWorkers = db.reparentAllChildren(fresh.id, predecessorId);
        db.reparentWakes(fresh.id, predecessorId);
        db.reparentQuestions(fresh.id, predecessorId);
        db.reparentEventTriggerTargets(fresh.id, predecessorId);
        db.reparentPollJobTargets(fresh.id, predecessorId);
        db.reparentWebhookTargets(fresh.id, predecessorId);
        db.reparentPendingOwnerMessage(fresh.id, predecessorId);
        return reparentedWorkers;
      };
      // @decision 08c81809 — NEVER RESURRECT: confirm the predecessor is itself a viable destination
      // (mirrors `reconcileStrandedRecycleSettlesEarly`'s own gate) before deciding which outcome this is.
      if (!isDurablyResumable(predecessor)) {
        // BOTH dead: consolidate anyway (bookkeeping, not serving) instead of leaving ownership split
        // forever — nothing here is resumed.
        //
        // @decision a4c5f234 — see the full record for why P (not S1) is the consolidation target.
        consolidated.push({ predecessorId, freshId: fresh.id, reparentedWorkers: reparentOntoPredecessor() });
        continue;
      }
      recovered.push({ predecessorId, freshId: fresh.id, reparentedWorkers: reparentOntoPredecessor() });
    } catch (e) {
      // A single bad lineage must never abort the whole boot sequence — log and move on.
      console.error(`[halted-recycle-reconcile] early pass failed for predecessor ${predecessorId.slice(0, 8)}: ${(e as Error)?.message ?? e}`);
    }
  }
  return { recovered, pendingResolution, consolidated };
}
