import { resolveConfig, columnKeyForRole, type Session } from "@loom/shared";
import type { Db } from "../db.js";
import { engineTranscriptExists } from "../sessions/transcript.js";
import { deriveAwaitingReview } from "./report-resolution.js";

/**
 * A worker session identified as crash-orphaned at boot — see {@link deriveCrashOrphanedWorkers}.
 * @decision 959a5fb7 — `reportedState`/`awaitingReview` (not the wider report-EXISTENCE signal) gate
 *  the crash-recovery nudge and the "awaiting your review/merge" summary count.
 * @decision db05e657 — computed by the SAME {@link deriveAwaitingReview} predicate `worker_list`'s
 *  own projection uses; also deleted this interface's former report-existence-only `reportedDone`
 *  field, an easily-confused near-duplicate of `reportedState` with zero functional readers of its own.
 */
export interface CrashOrphanedWorker {
  workerSessionId: string;
  managerSessionId: string;
  reportedState: "done" | "blocked" | null;
  awaitingReview: boolean;
}

/**
 * @decision 9fc41af5 — the DB-derived complement to `SessionService.resumeFleetOnBoot`, covering a
 *  genuine daemon CRASH (no captured `RestartIntent`) where in-flight workers used to sit exited +
 *  auto-archived with no non-lossy recovery path otherwise.
 *
 * `recovered` MUST be the exact Session[] `db.recoverStaleSessions()` returns at boot (index.ts), read
 * BEFORE the boot-backstop archive pass runs — every session that was actually `live`/`starting` the
 * instant the process died, i.e. genuinely crash-orphaned by THIS crash (not merely "exited a while
 * ago"). Calling this against a fresh DB re-query instead would see every one of them already archived
 * by that same backstop pass and recover nothing.
 *
 * Recovers a worker iff: it's a `worker` with a captured, non-dead engine id (a cached 'dead' stamp is
 * RE-VERIFIED live rather than trusted outright — see below); wasn't archived BEFORE this
 * crash; has no recycle successor (never resurrect a superseded row — its successor owns the work);
 * its parent is a manager/platform session; and its
 * task still exists and is NOT on the project's resolved terminal/done lane. A worker that reported
 * `done` but whose task hasn't landed yet (crashed between the report and the merge) IS still
 * recovered — excluding it would be worse than resurrecting it: its worktree/branch already hold real
 * committed work (Pass B's worktreeHasWork guard keeps that on disk regardless of session state, and
 * worker_merge/worker_merge_confirm merge purely off the branch + worktree, never checking session
 * liveness or archivedAt), so the only thing recovery adds for a done-but-unmerged worker is
 * VISIBILITY — reappearing in the manager's worker_list instead of sitting silently archived where the
 * manager has no reason to look for it.
 *
 * @decision sha:a9c9a342 — a cached `resumability:'dead'` stamp used to be trusted outright and could
 *  silently exclude a perfectly-healthy worker (and its whole manager) from crash recovery; it is now
 *  always re-verified live instead (see the self-heal below).
 */
export function deriveCrashOrphanedWorkers(db: Db, recovered: Session[]): CrashOrphanedWorker[] {
  const out: CrashOrphanedWorker[] = [];
  for (const w of recovered) {
    if (w.role !== "worker") continue;
    if (!w.engineSessionId) continue;
    // A cached 'dead' stamp is RE-VERIFIED now rather than trusted outright (see @decision sha:a9c9a342 above) — it
    // may be stale from an earlier watcher race on a transcript that's actually fine. A worker that was
    // NEVER flagged dead skips this fs hit entirely (unchanged from before); `resume()` itself still
    // re-checks live at resume time regardless, so this only closes the "silently excluded on a stale
    // flag before ever reaching resume()" gap without adding a filesystem check to the common path.
    if (w.resumability === "dead") {
      if (engineTranscriptExists(w.cwd, w.engineSessionId, w.harness)) {
        db.setResumability(w.id, "resumable"); // self-heal — the stamp was wrong
      } else {
        console.log(`[crash-recovery] worker ${w.id.slice(0, 8)} excluded from recovery: engine transcript missing (unresumable)`);
        continue;
      }
    }
    if (w.archivedAt) continue; // already archived pre-crash — not this crash's doing
    // TASKLESS intentionally excluded here (CR-flagged asymmetry, card 2514e6e1-follow-up): this whole
    // recovery decision hinges on board-column state (the terminal-lane check below decides "genuinely
    // finished, never resurrect") — meaningless for a worker with no card. A taskless worker (an ad-hoc
    // spike, or a read-only reviewer) is expected to be actively awaited by the manager that spawned it,
    // not auto-resumed across a daemon crash the way a tasked worker's in-flight work is; if it produced
    // commits worth recovering, they're retained on disk (boot-reconcile's Pass B worktreeHasWork guard —
    // service.ts, session-agnostic — applies the same to a taskless worker's worktree as a tasked one's)
    // even though the SESSION itself isn't resurrected.
    if (!w.parentSessionId || !w.taskId) continue;
    if (db.hasSuccessor(w.id)) continue; // recycled/superseded — its successor owns the work
    const manager = db.getSession(w.parentSessionId);
    if (!manager || (manager.role !== "manager" && manager.role !== "platform")) continue;
    const task = db.getTask(w.taskId);
    if (!task) continue;
    const project = db.getProject(w.projectId);
    if (!project) continue;
    const terminalKey = columnKeyForRole(resolveConfig(project.config).kanbanColumns, "terminal");
    if (task.columnKey === terminalKey) continue; // landed — genuinely finished, never resurrect
    // reportedState/awaitingReview (card 959a5fb7, unified by card db05e657): "is the manager still
    // genuinely waiting on this worker's last done/blocked report", computed by the SAME shared predicate
    // worker_list's own projection uses — see deriveAwaitingReview's doc (orchestration/report-resolution.ts)
    // for the two rulings (blocked counts like done; a bare merge_rejected never resolves) that make this
    // call identical to `mcp/orchestration.ts`'s `reportedProjection` for the same events.
    const events = db.listEventsForWorker(w.id);
    const { reportedState, awaitingReview } = deriveAwaitingReview(events);
    out.push({ workerSessionId: w.id, managerSessionId: w.parentSessionId, reportedState, awaitingReview });
  }
  return out;
}

/**
 * @decision sha:a9c9a342 — a manager crash-orphaned in its own right, with no surviving worker to
 *  ride along on, used to never get a resume attempt at all; every manager/platform row in `recovered`
 *  not covered by `orphanedWorkers` now gets ONE independent attempt via this list (`soloManagerIds`).
 *
 * `recoverCrashOrphanedWorkers` groups its resume targets BY MANAGER, keyed off `orphanedWorkers` — see
 * `SessionService.recoverCrashOrphanedWorkers`'s `soloManagerIds` option for how this list is consumed.
 *
 * `recoverStaleSessions()` selects `recovered` purely on `process_state IN ('live','starting')` — it does
 * NOT filter on a missing engine id, archived, or recycle-superseded rows (that's exactly why the WORKER
 * path above guards all three). A manager row can be `live`/`starting` in the DB while caught mid-
 * `starting` at crash time with NO captured engine id yet (there's no transcript to resume into — it can
 * NEVER be resumable, not even in principle), while ALREADY archived pre-crash, or while a `recycle_me`
 * predecessor still shows live/starting even though a successor has since taken over — a crash can freeze
 * any of these shapes. Skipping these guards would either resurrect a dead/retired manager into a
 * duplicate/zombie session, or attempt a resume that structurally cannot succeed (surfacing a misleading
 * "unresumable" failure for a session that was never a real recovery candidate) — so this mirrors the
 * worker path's `engineSessionId`/`archivedAt`/`hasSuccessor` checks exactly.
 */
export function deriveCrashOrphanedManagers(db: Db, recovered: Session[], orphanedWorkers: CrashOrphanedWorker[]): string[] {
  const covered = new Set(orphanedWorkers.map((c) => c.managerSessionId));
  const out: string[] = [];
  for (const s of recovered) {
    if (s.role !== "manager" && s.role !== "platform") continue;
    if (covered.has(s.id)) continue;
    if (!s.engineSessionId) continue; // never captured an engine id — structurally never resumable
    if (s.archivedAt) continue; // already archived pre-crash — not this crash's doing
    if (db.hasSuccessor(s.id)) continue; // recycled/superseded — its successor owns the work
    out.push(s.id);
  }
  return out;
}
