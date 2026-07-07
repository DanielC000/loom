import { resolveConfig, columnKeyForRole, type Session } from "@loom/shared";
import type { Db } from "../db.js";
import { engineTranscriptExists } from "../sessions/transcript.js";

/**
 * A worker session identified as crash-orphaned at boot — see {@link deriveCrashOrphanedWorkers}.
 * `reportedDone` lets the resume action (SessionService.recoverCrashOrphanedWorkers) withhold the
 * "continue your task" nudge for a worker that's actually just awaiting merge review.
 */
export interface CrashOrphanedWorker {
  workerSessionId: string;
  managerSessionId: string;
  reportedDone: boolean;
}

/**
 * Boot-time crash recovery (card 9fc41af5) — the DB-derived complement to
 * SessionService.resumeFleetOnBoot. That path only recovers a manager's in-flight workers when a
 * RestartIntent was captured (the exit-75 self-restart, orchestration/restart.ts); a genuine daemon
 * CRASH leaves no intent at all, so those same workers sat exited + auto-archived (boot-backstop.ts)
 * with no non-lossy recovery path — the manager's worker_list went empty and it had to re-dispatch fresh.
 *
 * `recovered` MUST be the exact Session[] `db.recoverStaleSessions()` returns at boot (index.ts), read
 * BEFORE the boot-backstop archive pass runs — every session that was actually `live`/`starting` the
 * instant the process died, i.e. genuinely crash-orphaned by THIS crash (not merely "exited a while
 * ago"). Calling this against a fresh DB re-query instead would see every one of them already archived
 * by that same backstop pass and recover nothing.
 *
 * Recovers a worker iff: it's a `worker` with a captured, non-dead engine id (a cached 'dead' stamp is
 * RE-VERIFIED live rather than trusted outright — see DIAGNOSIS below); wasn't archived BEFORE this
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
 * DIAGNOSIS (inconsistent boot recovery, board evidence: "[watch] marked N session(s) dead" then an
 * Orchestrator + its Web-Designer worker sat exited-and-unresumed while a sibling project's identical
 * shape came back clean): this used to gate on the cached `resumability` column instead of a live
 * check. `resumability:'dead'` is written by TWO places — this module's own transcript-missing branch
 * below, and `sessions/liveness.ts`'s `sweepDeadSessions` (the boot sweep AND the continuous
 * `watchClaudeProjects` chokidar watcher, debounced 1500ms off ANY `.jsonl` unlink anywhere under
 * `~/.claude/projects`) — and it is STICKY: nothing ever clears it back once set except a brand-new
 * `setEngineSessionId` capture. The debounced watcher re-sweeps EVERY resume candidate on an unrelated
 * file event, so a transient TOCTOU miss (Claude's own atomic rewrite of a DIFFERENT session's
 * transcript, an AV/indexer lock, a concurrent `--resume` spawn touching the same directory tree) can
 * permanently stamp a perfectly-healthy worker `dead` at some point during normal operation — long
 * before any crash. On the NEXT crash, this function used to trust that stale stamp and silently
 * exclude the worker with no logged reason. Because {@link CrashOrphanedWorker}s are grouped BY MANAGER
 * downstream (`SessionService.recoverCrashOrphanedWorkers`), a manager whose ONLY worker got excluded
 * this way never even got a resume ATTEMPT — not because the manager itself was unresumable, but
 * because it had no surviving worker to ride along on. `resume()` (service.ts) never trusted the cached
 * column to begin with — it always re-verifies live — so this function now uses the SAME real-time
 * source of truth instead of a second, staler one.
 */
export function deriveCrashOrphanedWorkers(db: Db, recovered: Session[]): CrashOrphanedWorker[] {
  const out: CrashOrphanedWorker[] = [];
  for (const w of recovered) {
    if (w.role !== "worker") continue;
    if (!w.engineSessionId) continue;
    // A cached 'dead' stamp is RE-VERIFIED now rather than trusted outright (see DIAGNOSIS above) — it
    // may be stale from an earlier watcher race on a transcript that's actually fine. A worker that was
    // NEVER flagged dead skips this fs hit entirely (unchanged from before); `resume()` itself still
    // re-checks live at resume time regardless, so this only closes the "silently excluded on a stale
    // flag before ever reaching resume()" gap without adding a filesystem check to the common path.
    if (w.resumability === "dead") {
      if (engineTranscriptExists(w.cwd, w.engineSessionId)) {
        db.setResumability(w.id, "resumable"); // self-heal — the stamp was wrong
      } else {
        console.log(`[crash-recovery] worker ${w.id.slice(0, 8)} excluded from recovery: engine transcript missing (unresumable)`);
        continue;
      }
    }
    if (w.archivedAt) continue; // already archived pre-crash — not this crash's doing
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
    // reportedDone: the LAST of {worker_report, merge_rejected} decides — a `merge_rejected` more recent
    // than any prior `worker_report(done)` means the manager sent the worker back to fix something (a
    // failed gate/conflict/stranded-work rejection), so a "done" report before that rejection is STALE
    // and must NOT withhold the continue-nudge (the worker is actually still mid-fix, not awaiting
    // review). Scanning backward, the first of either kind we hit settles it.
    let reportedDone = false;
    const events = db.listEventsForWorker(w.id);
    for (let i = events.length - 1; i >= 0; i--) {
      const kind = events[i]!.kind;
      if (kind === "merge_rejected") break; // a rejection after any prior report supersedes it
      if (kind === "worker_report") { reportedDone = events[i]!.detail?.status === "done"; break; }
    }
    out.push({ workerSessionId: w.id, managerSessionId: w.parentSessionId, reportedDone });
  }
  return out;
}

/**
 * Manager/platform sessions crash-orphaned in their OWN right, with NO surviving worker candidate to
 * ride along on. `recoverCrashOrphanedWorkers` groups its resume targets BY MANAGER, keyed off
 * `orphanedWorkers` — so a manager whose entire worker set is legitimately excluded (all landed, all
 * recycled, all archived pre-crash) never gets a resume attempt at all, even though it was just as much
 * a live/starting victim of the SAME crash as any manager that happens to still have a worker. Every
 * manager/platform row in `recovered` not already covered by `orphanedWorkers` gets ONE independent
 * attempt via this list — see `SessionService.recoverCrashOrphanedWorkers`'s `soloManagerIds` option.
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
