import type { Db } from "../db.js";
import type { Session } from "@loom/shared";
import fs from "node:fs";
import { engineTranscriptExists } from "./transcript.js";

/**
 * @decision 08c81809 — the EARLY, DB-ONLY half of the boot-time recovery for a manager/platform recycle
 * settle lost to a daemon restart mid-window (`SessionService.settleRecycleHandoff`'s poll loop is purely
 * in-memory — see its own doc).
 *
 * MUST run in `index.ts` BEFORE `Db.recoverStaleSessions()` — two real boot steps that run before any
 * prior version of this reconcile ever did depend on seeing the CORRECTED lineage, not the stale one:
 *  - `Db.reparentLiveWorkers` (the live in-memory settle loop's own reparent) filters
 *    `process_state = 'live'`. `recoverStaleSessions()` unconditionally flips EVERY session still
 *    'live'/'starting' to 'exited' before a later, SessionService-based reconcile pass could ever run —
 *    a reparent attempted after that flip moves ZERO rows. This module's `reparentAllChildren` sidesteps
 *    the 'live' filter entirely (see its own doc), but that alone isn't sufficient — see the next point.
 *  - `deriveCrashOrphanedWorkers`/`deriveCrashOrphanedManagers` (the crash-path candidate derivation)
 *    consume `recoverStaleSessions()`'s OWN returned snapshot, taken at the moment it runs. A reparent
 *    performed AFTER that call is invisible to it — the crash path's candidate grouping would still
 *    attribute the workers to the dead successor, regardless of how the reparent itself is filtered.
 *
 * `SessionService`/`PtyHost` do not exist yet at this point in boot (constructed far later, after these
 * derivation steps) — so this half can only decide + perform pure DB writes; it can never call `resume()`
 * itself. See `SessionService.finishReconcilingRecycleSettles` (sessions/service.ts) for the LATER half,
 * which runs after `SessionService` exists and does the actual resume attempts + archiving + nudges,
 * consuming this function's returned decision.
 */
export interface RecycleSettleEarlyResult {
  /** Successor never durably reached ready; predecessor is durably resumable (see `isDurablyResumable`).
   *  Already unlinked + reparented (workers/wakes/questions) onto the predecessor. Code Review round 3
   *  finding 4: the durable marker STAYS SET here (this decision is provisional, not final) — only the
   *  LATER phase's `finalizeRecovery` clears it, once it has actually archived the dead successor and
   *  resumed the predecessor. A boot dying between the two phases must still find this lineage pending on
   *  its next boot, not silently forgotten. `reparentedWorkers` is `reparentAllChildren`'s own return,
   *  threaded through so the later phase doesn't need to re-derive it for the `recycle_fleet_recovered`
   *  event detail. */
  recovered: { predecessorId: string; freshId: string; reparentedWorkers: number }[];
  /** Successor DID durably reach ready AND is still LINKED to this predecessor (round 5 MAJOR: NOT
   *  `reachedReadyAt` alone — a row a prior boot already unlinked/partially recovered, then left pending
   *  via a later throw, must never re-qualify here on a later boot) — provisionally the legitimate owner.
   *  Lineage is left COMPLETELY untouched here (no unlink, no reparent) and the durable marker STAYS SET
   *  — the later phase must actually attempt to resume the successor and only fall through to recovering
   *  the predecessor if that attempt genuinely fails (mirrors the live loop's own "ready always wins,
   *  checked first" rule, and the "clear the marker only after the outcome" requirement — a false-negative
   *  here, if reversed incorrectly, would resurrect a genuinely-fine successor's fleet onto the wrong
   *  owner). */
  deferred: { predecessorId: string; freshId: string }[];
  /** The predecessor fails `isDurablyResumable` — but "the successor can't serve either" covers TWO
   *  distinct shapes, told apart by `successorReachedReadyButUnlinked`. FALSE (the successor never
   *  durably reached ready): mirrors `recoverFleetAfterFailedRecycleSuccessor`'s own NEVER RESURRECT
   *  reasoning — it is the only possible EVENTUAL owner, and touching its `recycled_from`/archived state
   *  here would only make that worse. TRUE (card `59bfc939`): the successor DID durably reach ready, but
   *  is no longer LINKED to this predecessor — a PRIOR boot already recovered/superseded it in favor of
   *  this predecessor, and that boot's own later phase never reached its own completion (marker left set
   *  on a throw — see `finalizeRecovery`'s ordering). It is NOT a fallback owner here; it was already
   *  retired, and the predecessor's own resumability failing since is what leaves nobody to serve. Either
   *  way the successor is left COMPLETELY UNTOUCHED by this phase.
   *  Code Review round 3 finding 4: the durable marker STAYS SET here too — the later phase's own
   *  `stampStranded` clears it, once it has actually made the predecessor's stranded state VISIBLE
   *  (the `[loom:orphaned-fleet]` banner survives `snapshotAndArchiveRecovered`'s archive only if the row
   *  is un-archived afterward — see `finishReconcilingRecycleSettles`). */
  stranded: { predecessorId: string; freshId: string; successorReachedReadyButUnlinked: boolean }[];
}

/**
 * Pure, DB/filesystem-only replica of `resume()`'s own three up-front resumability preconditions
 * (`engineSessionId` set, its engine transcript exists, its `cwd` exists) — deliberately NOT
 * `pty.isAlive`/`hasSuccessor`, neither of which is meaningful pre-boot or relevant here. Lets the EARLY,
 * DB-only reconcile pass decide "would `resume()` even attempt this" before `SessionService`/`PtyHost`
 * exist. NOT a substitute for actually calling `resume()`: it cannot catch a failure mode `resume()`
 * itself only discovers by trying (e.g. a `pty.spawn` throw) — the LATER phase's own real `resume()`
 * attempt, wrapped in try/catch, is what actually decides success for the row this function green-lit.
 */
export function isDurablyResumable(session: Pick<Session, "engineSessionId" | "cwd" | "harness">): boolean {
  if (!session.engineSessionId) return false;
  if (!engineTranscriptExists(session.cwd, session.engineSessionId, session.harness)) return false;
  if (!fs.existsSync(session.cwd)) return false;
  return true;
}

export function reconcileStrandedRecycleSettlesEarly(db: Db): RecycleSettleEarlyResult {
  const recovered: RecycleSettleEarlyResult["recovered"] = [];
  const deferred: RecycleSettleEarlyResult["deferred"] = [];
  const stranded: RecycleSettleEarlyResult["stranded"] = [];
  for (const { predecessorId, freshId } of db.listRecycleSettlePending()) {
    try {
      const predecessor = db.getSession(predecessorId);
      if (!predecessor) { db.clearRecycleSettlePending(predecessorId); continue; } // hard-deleted; nothing to reconcile
      const fresh = db.getSession(freshId);
      // @decision 08c81809 — round 5 MAJOR: `deferred` requires the successor still LINKED
      // (`recycledFrom === predecessorId`), not `reachedReadyAt` alone — a prior boot's already-unlinked-
      // and-partially-recovered row must never be re-classified `deferred` on a later boot.
      const stillLinked = fresh != null && fresh.recycledFrom === predecessorId;
      if (fresh?.reachedReadyAt && stillLinked) {
        deferred.push({ predecessorId, freshId });
        continue;
      }
      if (!isDurablyResumable(predecessor)) {
        // Code Review round 3 finding 4: do NOT clear the marker here — a boot that dies between this
        // early, DB-only pass and the LATER phase (SessionService.finishReconcilingRecycleSettles, ~1100
        // boot lines further on in index.ts) must not lose the only durable trace of this lineage before
        // the later phase ever gets to un-archive the predecessor and stamp its [loom:orphaned-fleet]
        // banner. `stampStranded` (the later phase's own handler) clears it once that actually happens —
        // mirrors the `deferred` bucket just above, which already never cleared it here either.
        // Card 59bfc939: `fresh?.reachedReadyAt` here means the successor DID durably reach ready but
        // isn't `stillLinked` — the row is already past the `deferred` check above, so this can only be
        // the already-superseded shape (see `stranded`'s own doc), never "never became ready".
        stranded.push({ predecessorId, freshId, successorReachedReadyButUnlinked: !!fresh?.reachedReadyAt });
        continue;
      }
      if (fresh && fresh.recycledFrom === predecessorId) db.setOrchestration(freshId, { recycledFrom: null });
      const reparentedWorkers = db.reparentAllChildren(freshId, predecessorId);
      db.reparentWakes(freshId, predecessorId);
      db.reparentQuestions(freshId, predecessorId);
      // Card df9d1c71: same direction as reparentWakes/reparentQuestions above.
      db.reparentEventTriggerTargets(freshId, predecessorId);
      db.reparentPollJobTargets(freshId, predecessorId);
      db.reparentWebhookTargets(freshId, predecessorId);
      // Code Review round 3 finding 4: same reasoning as the `stranded` branch above — the marker stays
      // set until the LATER phase's `finalizeRecovery` actually archives the dead successor and resumes
      // the predecessor. A boot dying between the two phases with this cleared would silently lose the
      // trace: the successor would be left neither archived nor `resumability:"dead"`, and nothing would
      // re-attempt this reconcile on the next boot.
      recovered.push({ predecessorId, freshId, reparentedWorkers });
    } catch (e) {
      // Card 08c81809 DoD-4: a single bad row must never abort the whole boot sequence (index.ts calls
      // this before `main()`'s own broader error handling exists) — log and move on to the next pending
      // row. Code Review round 3 finding 4: do NOT clear the marker here either — an early-phase failure
      // means the LATER phase never even sees this row (it isn't in any of the three buckets), so clearing
      // it would permanently lose the only trace that this lineage is unresolved. Leaving it set means the
      // NEXT boot retries the same row (and, if the underlying fault persists, logs the same error again)
      // rather than silently forgetting it — visible-and-noisy beats invisible-and-lost.
      console.error(`[recycle-settle-reconcile] early pass failed for predecessor ${predecessorId.slice(0, 8)}: ${(e as Error)?.message ?? e}`);
    }
  }
  return { recovered, deferred, stranded };
}
