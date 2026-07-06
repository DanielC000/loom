import { resolveConfig, columnKeyForRole, type Session } from "@loom/shared";
import type { Db } from "../db.js";

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
 * Recovers a worker iff: it's a `worker` with a captured, non-dead engine id; wasn't archived BEFORE
 * this crash; has no recycle successor (never resurrect a superseded row — its successor owns the
 * work); its parent is a manager/platform session; and its task still exists and is NOT on the
 * project's resolved terminal/done lane. A worker that reported `done` but whose task hasn't landed
 * yet (crashed between the report and the merge) IS still recovered — excluding it would be worse than
 * resurrecting it: its worktree/branch already hold real committed work (Pass B's worktreeHasWork guard
 * keeps that on disk regardless of session state, and worker_merge/worker_merge_confirm merge purely
 * off the branch + worktree, never checking session liveness or archivedAt), so the only thing recovery
 * adds for a done-but-unmerged worker is VISIBILITY — reappearing in the manager's worker_list instead
 * of sitting silently archived where the manager has no reason to look for it.
 */
export function deriveCrashOrphanedWorkers(db: Db, recovered: Session[]): CrashOrphanedWorker[] {
  const out: CrashOrphanedWorker[] = [];
  for (const w of recovered) {
    if (w.role !== "worker") continue;
    if (w.resumability === "dead") continue;
    if (!w.engineSessionId) continue;
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
