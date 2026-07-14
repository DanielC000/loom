import { resolveConfig, columnKeyForRole, type SessionRole } from "@loom/shared";
import type { Db } from "../db.js";
import type { RestartWakeImpact } from "./restart.js";

/**
 * Shared manager/platform wake-impact classification (card c9e51581), extracted from
 * `SessionService.resumeFleetOnBoot`'s original inline closures (61cc91c6) so the SAME "does this
 * session actually have a stake in this wake" logic can be reused by every resume path that brings a
 * manager/platform back and would otherwise unconditionally burn a full re-orient turn on it:
 *   - Path A — `resumeFleetOnBoot` (a `daemon_restart` fleet resume, restart.ts's RestartIntent)
 *   - Path B — `SessionService.recoverCrashOrphanedWorkers` (a genuine crash / OS-restart, no intent)
 *   - Path C — `CrashRecoveryWatcher.tick` (an isolated unexpected pty death)
 * Each path derives its OWN `causal`/`liveWorkersResumed`/`queuedIoReplayed` (there is no single
 * "resume set" shape that fits all three — see each call site), then feeds them through
 * {@link computeWakeImpact} to get the SAME `hasUnconsumedAnswer`/`strandedBoardWork` derivation,
 * feeding `isNoOpManagerWake` (restart.ts) for the actual silent-vs-full decision. Pure DB reads, `db`
 * passed explicitly (no SessionService dependency) so a DI-only consumer like CrashRecoveryWatcher
 * (which holds no SessionService reference, only injected functions) can call this directly.
 */

/**
 * Actionable board work: a task whose column is NOT the terminal lane AND is NOT held AND is NOT
 * deferred (every other non-held/non-deferred lane — intake/defaultLanding/workReady/active/review/
 * parked — is pending work a manager should drive; a held card is the owner's brake and `deferred` is
 * the manager's own sequencing marker, neither ever counts, in any column) AND is NOT in a column
 * flagged `excludeFromIdleWatchdog` (a genuine dead-end/parking lane, e.g. "Dropped" — discounted the
 * same way, without per-card `deferred:true` toil). Raw signal only — see {@link strandedBoardWork} for
 * whether it actually forces the restart nudge. Mirrors the idle-watcher's actionable-count definition
 * (orchestration/idle-watcher.ts) so the two stay consistent.
 */
export function hasPendingBoardWork(db: Db, id: string): boolean {
  try {
    const projectId = db.getSession(id)?.projectId;
    if (!projectId) return true; // unknown project → assume pending (a full nudge never stalls)
    const project = db.getProject(projectId);
    if (!project) return true;
    const cols = resolveConfig(project.config).kanbanColumns;
    const terminalKey = columnKeyForRole(cols, "terminal");
    const excludedColumnKeys = new Set(cols.filter((c) => c.excludeFromIdleWatchdog === true).map((c) => c.key));
    return db.listTasks(projectId).some(
      (t) => t.columnKey !== terminalKey && !t.held && t.deferred !== true && !excludedColumnKeys.has(t.columnKey),
    );
  } catch {
    return true; // defensive: a board-read fault must never produce a false "no-op" stall
  }
}

/**
 * A genuinely NEW per-session event distinct from generic board content: an ANSWERED question this
 * session itself asked that it hasn't `question_pull`ed yet. Non-destructive PEEK (listQuestionsForSession
 * reads all states without flipping anything) — the wake classification must never consume the queue
 * it's only checking.
 */
export function hasUnconsumedAnswer(db: Db, id: string): boolean {
  try {
    return db.listQuestionsForSession(id).some((q) => q.state === "answered");
  } catch {
    return true; // defensive: a read fault must never silently drop a real pending answer
  }
}

/**
 * Was this session's CURRENT 'suppressed' idle-nudge policy reached via the idle-watcher's
 * unanswered-nudge-cap ESCALATION (idle-watcher.ts, the manager stopped responding to nudges) rather
 * than a deliberate idle_report('done')? Both set policy='suppressed' with no distinguishing DB field,
 * so this replays the session's own event history: the escalation path appends 'idle_escalated' WITHOUT
 * resetting state first (idle-watcher.ts), while EVERY idle_report call (incl. 'done') appends
 * 'idle_report' via resetIdleNudgeState-then-set (recordIdleReport). Whichever of the two kinds is MOST
 * RECENT for this session tells us which state it's actually in.
 */
export function isEscalatedSuppression(db: Db, id: string): boolean {
  try {
    let lastEscalated: string | null = null;
    let lastReport: string | null = null;
    for (const e of db.listEvents(id)) {
      if (e.kind === "idle_escalated") lastEscalated = e.ts;
      else if (e.kind === "idle_report") lastReport = e.ts;
    }
    if (!lastEscalated) return false;
    return !lastReport || lastEscalated > lastReport;
  } catch {
    return true; // defensive: never silently downgrade a genuinely stuck manager
  }
}

/**
 * Is the idle-watcher actually ticking for this session's project? Mirrors idle-watcher.ts's OWN
 * resolution (`resolveConfig(project.config).orchestration.idleNudgeMinutes`) exactly — a project can
 * set idleNudgeMinutes:0 to disable the watcher entirely (shared/config.ts), and idle-watcher.ts's
 * `continue`s on that BEFORE any nudge/snooze-expiry/escalation logic runs — so for that project NOTHING
 * re-engages a 'watching'/'snoozed' manager, and {@link strandedBoardWork} below must not assume coverage
 * that doesn't exist. Fails SAFE (false = watcher not confirmed active) on any lookup fault, biasing
 * toward the nudge, never toward silently stranding the queue.
 */
export function isWatcherActiveForSession(db: Db, id: string): boolean {
  try {
    const projectId = db.getSession(id)?.projectId;
    if (!projectId) return false;
    const project = db.getProject(projectId);
    if (!project) return false;
    return resolveConfig(project.config).orchestration.idleNudgeMinutes > 0;
  } catch {
    return false;
  }
}

/**
 * Board work is a wake STAKE only when NOTHING ELSE will ever re-surface it (61cc91c6). A 'manager' OR
 * 'platform' session's idle-watchdog (idle-watcher.ts, platform coverage added by card 98b3725c) already
 * independently covers 'watching' (nudges on its own cadence regardless of any wake) and 'snoozed'
 * (self-expires via the SAME ticker) — PROVIDED the watcher is actually active for that project
 * ({@link isWatcherActiveForSession}); if idleNudgeMinutes is 0 for the project, neither case has ANY
 * natural re-arm, so board work stays stranded. 'suppressed' via a deliberate idle_report('done') is the
 * session's own considered judgment call — re-litigating it every wake is waste, not a safety net. Only
 * 'suppressed' reached via the escalation-cap has no natural re-arm (better to over-nudge a stuck
 * manager/Lead than strand it). The `role` param is now used only to select which idle-nudge accessors
 * apply (they're role-agnostic columns, so in practice the SAME logic runs for both roles) — no more
 * role-conditional early return.
 */
export function strandedBoardWork(db: Db, id: string, role: SessionRole | null): boolean {
  if (!hasPendingBoardWork(db, id)) return false;
  const state = db.getIdleNudgeState(id);
  if (!state) return true; // defensive: no idle-nudge row → can't confirm coverage, assume stranded
  if (state.policy === "watching" || state.policy === "snoozed") return !isWatcherActiveForSession(db, id);
  return isEscalatedSuppression(db, id); // policy === "suppressed"
}

/**
 * One session's full wake impact, combining the path-specific inputs (`perPath` — see each call site
 * for what `causal`/`liveWorkersResumed`/`queuedIoReplayed` mean on that path) with the shared,
 * session-scoped `hasUnconsumedAnswer`/`strandedBoardWork` derivation. Feed the result into
 * `isNoOpManagerWake` (restart.ts) for the silent-vs-full decision.
 */
export function computeWakeImpact(
  db: Db,
  id: string,
  role: SessionRole | null,
  perPath: { causal: boolean; liveWorkersResumed: number; queuedIoReplayed: number },
): RestartWakeImpact {
  return {
    causal: perPath.causal,
    liveWorkersResumed: perPath.liveWorkersResumed,
    queuedIoReplayed: perPath.queuedIoReplayed,
    hasUnconsumedAnswer: hasUnconsumedAnswer(db, id),
    strandedBoardWork: strandedBoardWork(db, id, role),
  };
}
