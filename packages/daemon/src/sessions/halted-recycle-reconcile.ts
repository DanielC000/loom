import type { Db } from "../db.js";
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
}

export function reconcileHaltedRecycleSuccessorsEarly(db: Db): HaltedRecycleEarlyResult {
  const recovered: HaltedRecycleEarlyResult["recovered"] = [];
  for (const predecessorId of db.listWorkerSessionIdsWithEventKind(["recycle_ownership_transfer_failed"])) {
    try {
      // Already resolved (a prior boot's own later phase, or the in-process watch, already reclaimed it) —
      // `hasSuccessor` flips false the moment that happens, so there's nothing left to do here.
      if (!db.hasSuccessor(predecessorId)) continue;
      const predecessor = db.getSession(predecessorId);
      if (!predecessor) continue;
      const fresh = db.getSuccessor(predecessorId);
      if (!fresh) continue;
      // `recycle_ownership_transfer_failed` is PERMANENT (never cleared), so a predecessor that halted
      // once, was later cleanly reclaimed (its halted successor died, ownership came back), and was then
      // cleanly re-recycled to a BRAND NEW successor still shows up in listWorkerSessionIdsWithEventKind
      // above — `hasSuccessor` is true again (pointing at the new, unrelated successor), and nothing here
      // may touch that lineage: it's an ordinary clean recycle, handled entirely by
      // `reconcileStrandedRecycleSettlesEarly`'s own settle-pending marker. Only proceed when the
      // predecessor's CURRENT successor is the EXACT successor the latest halt event named — both by id
      // and by gen, so a coincidental id reuse (never happens with real UUIDs, but mirrors the event's own
      // pairing) can't paper over a generation mismatch either.
      const latestHalt = db.listEventsForSession(predecessorId)
        .filter((e) => e.kind === "recycle_ownership_transfer_failed" && e.workerSessionId === predecessorId)
        .at(-1);
      if (!latestHalt) continue;
      if (fresh.id !== latestHalt.managerSessionId || fresh.gen !== (latestHalt.detail as { gen?: number } | undefined)?.gen) continue;
      // The successor can still be resumed THIS boot — leave the lineage untouched; it'll be attempted via
      // the ordinary resumeFleetOnBoot/crash-recovery paths (nothing excludes a halted-lineage successor),
      // and ownership simply stays split if that attempt succeeds. A later resume FAILURE here is a known,
      // narrow residual this early-only design accepts (mirrors `reconcileStrandedRecycleSettlesEarly`'s
      // own `deferred`-bucket shape, without that bucket's later-phase fallback — out of scope for this pass).
      if (isDurablyResumable(fresh)) continue;
      // @decision 08c81809 — NEVER RESURRECT: confirm the predecessor is itself a viable destination
      // (mirrors `reconcileStrandedRecycleSettlesEarly`'s own gate) before touching the successor's
      // lineage — a predecessor ALSO unresumable this boot leaves nobody to serve; leave both alone.
      if (!isDurablyResumable(predecessor)) continue;
      if (fresh.recycledFrom === predecessorId) db.setOrchestration(fresh.id, { recycledFrom: null });
      const reparentedWorkers = db.reparentAllChildren(fresh.id, predecessorId);
      db.reparentWakes(fresh.id, predecessorId);
      db.reparentQuestions(fresh.id, predecessorId);
      db.reparentEventTriggerTargets(fresh.id, predecessorId);
      db.reparentPollJobTargets(fresh.id, predecessorId);
      db.reparentWebhookTargets(fresh.id, predecessorId);
      db.reparentPendingOwnerMessage(fresh.id, predecessorId);
      recovered.push({ predecessorId, freshId: fresh.id, reparentedWorkers });
    } catch (e) {
      // A single bad lineage must never abort the whole boot sequence — log and move on.
      console.error(`[halted-recycle-reconcile] early pass failed for predecessor ${predecessorId.slice(0, 8)}: ${(e as Error)?.message ?? e}`);
    }
  }
  return { recovered };
}
