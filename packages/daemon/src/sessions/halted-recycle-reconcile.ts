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
   *  (DB-only; `finishReconcilingHaltedRecycleSuccessors` does the rest once SessionService exists).
   *  @decision 54434e27 — `reparentedWorkers` is 0, not the true historical count, when this entry came
   *  from a prior boot's pending marker rather than a fresh reparent this boot. See the full record. */
  recovered: { predecessorId: string; freshId: string; reparentedWorkers: number }[];
  /** @decision d9512de7 — a durably-resumable successor with a still-open unresolved alert; never
   *  resolved from this DB-only check alone. See the full record for why. */
  pendingResolution: { predecessorId: string; freshId: string }[];
  /** @decision a4c5f234 — both sides unresumable this boot; reparented onto the predecessor as bookkeeping
   *  only (never served). Same `reparentedWorkers` caveat as `recovered` above.
   *  @decision 54434e27 */
  consolidated: { predecessorId: string; freshId: string; reparentedWorkers: number }[];
}

/**
 * @decision 54434e27 — Code Review `9fe8f672` m1: a pending marker is STALE once the predecessor has
 * genuinely moved on — it now has a CURRENT successor (any), or its latest
 * `recycle_ownership_transfer_failed` event names a DIFFERENT successor than the marker's own `freshId`.
 * Both shapes mean the marker's own lineage decision (recovered/consolidated for `freshId`) is no longer
 * the live situation on the predecessor — acting on it would stamp a stale banner/nudge/event about a
 * successor that is no longer current, or clobber a predecessor that is genuinely LIVE again under a new
 * successor. `hasSuccessor` alone cannot catch the second shape: a NEW successor that has ITSELF already
 * been unlinked — by a LATER BOOT's own reconcile, OR by the live, same-process IN-PROCESS reclaim watch
 * (`watchHaltedRecycleSuccessor`, armed from `recycleManager`'s halt branch — no reboot required at all)
 * — leaves `hasSuccessor` false again even though a newer halt event already superseded this marker.
 */
function isHaltedRecyclePendingMarkerStale(db: Db, predecessorId: string, freshId: string): boolean {
  if (db.hasSuccessor(predecessorId)) return true;
  const latestHalt = db.listEventsForSession(predecessorId)
    .filter((e) => e.kind === "recycle_ownership_transfer_failed" && e.workerSessionId === predecessorId)
    .at(-1);
  return !!latestHalt && latestHalt.managerSessionId !== freshId;
}

export function reconcileHaltedRecycleSuccessorsEarly(db: Db): HaltedRecycleEarlyResult {
  const recovered: HaltedRecycleEarlyResult["recovered"] = [];
  const pendingResolution: HaltedRecycleEarlyResult["pendingResolution"] = [];
  const consolidated: HaltedRecycleEarlyResult["consolidated"] = [];
  // @decision 54434e27 — a predecessor with a durable marker from a PRIOR boot's reparent that never
  // reached the later phase must be handled HERE, never left to the event-kind loop below (it can't
  // rediscover a lineage whose `recycled_from` this marker's own reparent already nulled).
  const pendingPredecessorIds = new Set<string>();
  for (const { predecessorId, freshId } of db.listHaltedRecyclePending()) {
    try {
      const predecessor = db.getSession(predecessorId);
      if (!predecessor) { db.clearHaltedRecyclePending(predecessorId); continue; } // hard-deleted; nothing to reconcile
      // @decision 54434e27 — Code Review m1: a STALE marker is cleared WITHOUT acting, and — critically —
      // predecessorId is NOT added to pendingPredecessorIds, so the event-kind loop below is free to
      // reconcile whatever the predecessor's CURRENT lineage actually is.
      if (isHaltedRecyclePendingMarkerStale(db, predecessorId, freshId)) {
        console.error(`[halted-recycle-reconcile] stale halted-recycle-pending marker for predecessor ${predecessorId.slice(0, 8)} (named successor ${freshId.slice(0, 8)}) — the predecessor has since moved on; clearing without acting`);
        db.clearHaltedRecyclePending(predecessorId);
        continue;
      }
      pendingPredecessorIds.add(predecessorId);
      const reparentedWorkers = db.reparentHaltedRecycleLineage(freshId, predecessorId);
      if (!isDurablyResumable(predecessor)) {
        consolidated.push({ predecessorId, freshId, reparentedWorkers });
      } else {
        recovered.push({ predecessorId, freshId, reparentedWorkers });
      }
    } catch (e) {
      // Mirrors the catch below: leave the marker set so the NEXT boot retries this row rather than
      // silently losing the only durable trace that this lineage is unresolved.
      console.error(`[halted-recycle-reconcile] early pass (pending marker) failed for predecessor ${predecessorId.slice(0, 8)}: ${(e as Error)?.message ?? e}`);
    }
  }
  for (const predecessorId of db.listWorkerSessionIdsWithEventKind(["recycle_ownership_transfer_failed"])) {
    if (pendingPredecessorIds.has(predecessorId)) continue; // already handled via the marker loop above
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
      // @decision 54434e27 — `reparentHaltedRecycleLineage` moves S1's categories onto P AND stamps the
      // durable completion marker, atomically — shared by both branches below, identical bookkeeping
      // whether P turns out resumable (`recovered`) or not (`consolidated`).
      // @decision 08c81809 — NEVER RESURRECT: confirm the predecessor is itself a viable destination
      // (mirrors `reconcileStrandedRecycleSettlesEarly`'s own gate) before deciding which outcome this is.
      if (!isDurablyResumable(predecessor)) {
        // BOTH dead: consolidate anyway (bookkeeping, not serving) instead of leaving ownership split
        // forever — nothing here is resumed.
        //
        // @decision a4c5f234 — see the full record for why P (not S1) is the consolidation target.
        consolidated.push({ predecessorId, freshId: fresh.id, reparentedWorkers: db.reparentHaltedRecycleLineage(fresh.id, predecessorId) });
        continue;
      }
      recovered.push({ predecessorId, freshId: fresh.id, reparentedWorkers: db.reparentHaltedRecycleLineage(fresh.id, predecessorId) });
    } catch (e) {
      // A single bad lineage must never abort the whole boot sequence — log and move on.
      console.error(`[halted-recycle-reconcile] early pass failed for predecessor ${predecessorId.slice(0, 8)}: ${(e as Error)?.message ?? e}`);
    }
  }
  return { recovered, pendingResolution, consolidated };
}
