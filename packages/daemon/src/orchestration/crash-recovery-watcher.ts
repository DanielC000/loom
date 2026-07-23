import { randomUUID } from "node:crypto";
import { resolveConfig, type SessionRole, type OrchestrationEvent } from "@loom/shared";
import type { Db } from "../db.js";
import type { OrchestrationControl } from "./control.js";
import { RESUME_NUDGE_TAIL } from "./resume-nudge.js";
import { isNoOpManagerWake } from "./restart.js";
import { computeWakeImpact } from "./wake-impact.js";

/**
 * Session roles the crash-recovery watchdog covers — coordination/work sessions worth auto-recovering.
 * EXCLUDES plain (role null), ephemeral `run` (never resume — a restart fails them clean), `auditor`
 * (a fire-once read-and-file session), `setup`, and `workspace-auditor`. Managers are IN scope: the
 * motivating incident was a dead manager. `assistant` (an isolated Companion session) is IN scope too:
 * an unresumed dead Companion sits silently dark with no Mission Control signal until a full daemon
 * restart — see recordUnexpectedExit.
 */
const RECOVERABLE_ROLES: SessionRole[] = ["manager", "worker", "platform", "assistant"];

/**
 * Stability window: a resumed session must stay LIVE this long (since its last crash-recovery activity)
 * before the episode is declared RECOVERED and the attempt counter resets. Default 2 min — comfortably
 * longer than one watcher tick (so we actually observe survival, not just the instant the resume sets the
 * row live), short enough that a genuinely-recovered session re-arms promptly. Injectable so a test resets
 * in milliseconds.
 */
const STABILITY_WINDOW_MS = 2 * 60_000;

/** The slice of PtyHost the watcher needs for the OPTIONAL parent-manager heads-up (injectable, claude-free). */
export interface CrashRecoveryPty {
  /** Nudge text into a (live) session's busy-gated queue. Best-effort — the durable surface is the event. */
  enqueueStdin(sessionId: string, text: string): { delivered: boolean; position?: number };
}

export interface CrashRecoveryDeps {
  db: Db;
  /**
   * Resume a dead session (index.ts passes `(id) => { sessions.resume(id); return true; }`). Returns true
   * on a started resume; may THROW (unresumable: dead transcript / gone worktree / superseded) — the tick
   * catches it and the recorded attempt still counts toward the cap, so a session that can't even start
   * is bounded too. Injectable so the tick logic unit-tests with no real claude.
   */
  resume: (sessionId: string) => boolean;
  /** §17a pause registry — a human-paused session (or its manager) is never auto-resumed (watcher parity). */
  control: OrchestrationControl;
  /** OPTIONAL: enqueue a cheap heads-up to a dead worker's live parent manager on give-up. The required,
   *  role-agnostic surface is the Mission-Control attention event + lastError; this is additive. */
  pty?: CrashRecoveryPty;
  /** Tick cadence; defaults to 60s. Injectable so a test drives tick() directly. */
  intervalMs?: number;
  /** Stability window (ms) before a live resume counts as recovered (counter reset). Injectable for tests. */
  stabilityMs?: number;
}

const lastOfKind = (events: OrchestrationEvent[], kind: OrchestrationEvent["kind"]): OrchestrationEvent | undefined => {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === kind) return events[i];
  return undefined;
};

/**
 * The recovery TRIGGERS the watchdog acts on. Two, both filed under the session-to-resume's id (so
 * listEventsForWorker retrieves them) and both reset by a `session_recovered` marker:
 *   • `session_died`              — an UNEXPECTED pty death while the daemon stayed healthy (the original).
 *   • `worker_report_undelivered` — a worker reported to a since-EXITED parent manager (the strand backstop,
 *      incident 22a44352): keyed on `delivered:false` rather than process-death. Only ever a manager.
 * The whole bound (attempt cap + escalation + stability reset) is shared — only the trigger differs.
 */
const RECOVERY_TRIGGER_KINDS: ReadonlySet<OrchestrationEvent["kind"]> =
  new Set<OrchestrationEvent["kind"]>(["session_died", "worker_report_undelivered"]);

const lastTriggerOf = (events: OrchestrationEvent[]): OrchestrationEvent | undefined => {
  for (let i = events.length - 1; i >= 0; i--) if (RECOVERY_TRIGGER_KINDS.has(events[i]!.kind)) return events[i];
  return undefined;
};

/**
 * Strand backstop (incident 22a44352; gate broadened by card fc9a27d5): record the DURABLE
 * `worker_report_undelivered` wake trigger when a worker's report reached NO live FIFO. Called from
 * SessionService.workerReport after the framed notify came back `boarded` — `delivered:false` with NO
 * queue position, i.e. the manager's pty isn't alive (it idle-reaped after dispatching its last worker, or
 * its pty is otherwise gone while the row still lags `live`). A live-but-busy/parked manager (`queued`,
 * delivered:false WITH a position) is NOT a strand — its FIFO drains on its next turn — so that case never
 * records a trigger. The watchdog then bounded-auto-resumes the manager (once its row is exited) via the
 * SAME machinery as a `session_died`.
 *
 * Guards (mirroring recordUnexpectedExit) so we never record a useless trigger: the manager must be a
 * recoverable, resumable role with a captured engine id, not superseded by a recycle successor, and NOT
 * usage-limit parked (a parked manager is owned by the rate-limit watcher — waking it early would fight the
 * usage hold; when its park elapses it resumes and sees the now-in-`review` task anyway). Pure DB + never
 * throws (the caller's report path must not be disturbed). Returns whether it recorded a trigger.
 */
export function recordUndeliveredReport(
  db: Db,
  manager: { id: string; role?: SessionRole | null; engineSessionId?: string | null; resumability?: string; parentSessionId?: string | null; taskId?: string | null; rateLimitedUntil?: string | null },
  ctx: { reportingWorkerId: string; taskId?: string | null },
): boolean {
  if (!manager.role || !RECOVERABLE_ROLES.includes(manager.role)) return false; // not a recoverable role
  if (!manager.engineSessionId || manager.resumability === "dead") return false; // never resumable
  if (db.hasSuccessor(manager.id)) return false;                                 // recycled — successor owns it
  if (manager.rateLimitedUntil && manager.rateLimitedUntil > new Date().toISOString()) return false; // parked
  db.appendEvent({
    id: randomUUID(), ts: new Date().toISOString(),
    managerSessionId: manager.parentSessionId ?? manager.id, // a manager files under itself (no parent)
    workerSessionId: manager.id,                             // SUBJECT = the manager to resume
    taskId: ctx.taskId ?? null,
    kind: "worker_report_undelivered",
    detail: { role: manager.role, reportingWorker: ctx.reportingWorkerId, taskId: ctx.taskId ?? null },
  });
  return true;
}

/**
 * onExit hook (called from index.ts onExit, AFTER the row is marked `exited`): record the DURABLE
 * `session_died` trigger IFF the death was UNEXPECTED (`intended === false`) and the session is a
 * recoverable, resumable coordination/work session. An INTENDED stop (graceful / idle / user-stop /
 * recycle / merge-stop / run-teardown — every pty.stop(), which sets `live.stopping`) records NOTHING, so
 * the watchdog leaves it untouched. A whole-daemon restart / crash / SIGTERM never reaches this code path
 * (the process dies → no JS onExit runs), so those are excluded BY CONSTRUCTION — recoverStaleSessions
 * marks them `exited` with no `session_died`, and resumeFleetOnBoot owns the daemon_restart fleet. This
 * is what scopes the watchdog precisely to "a single pty died while the daemon stayed healthy".
 *
 * Filed with workerSessionId = the dead session (so listEventsForWorker retrieves it for ANY role), and
 * managerSessionId = its parent for a worker, else its own id (a manager/platform has no parent). Pure DB
 * + never throws (the caller already guards the exit path). Returns whether it recorded a death.
 */
export function recordUnexpectedExit(db: Db, sessionId: string, intended: boolean): boolean {
  if (intended) return false; // a deliberate Loom stop() — not a crash; nothing to recover
  const s = db.getSession(sessionId);
  if (!s) return false;
  if (!s.role || !RECOVERABLE_ROLES.includes(s.role)) return false; // plain / run / auditor → out of scope
  if (!s.engineSessionId || s.resumability === "dead") return false; // never resumable → nothing to resume
  if (db.hasSuccessor(sessionId)) return false; // recycled/superseded — its successor took over (intended)
  db.appendEvent({
    id: randomUUID(), ts: new Date().toISOString(),
    managerSessionId: s.parentSessionId ?? s.id, // a worker files under its manager; a manager under itself
    workerSessionId: s.id, taskId: s.taskId ?? null,
    kind: "session_died", detail: { role: s.role },
  });
  return true;
}

/**
 * Is `session` presently crash-recovery ELIGIBLE — would the watchdog's next tick attempt (or is it still
 * within its bound to attempt) an auto-resume of it, given its CURRENT event history? Shared by the tick
 * loop's own bookkeeping and by SessionService.notifyManagerOfExitedWorker (card 289586c7): a worker the
 * watchdog is about to try to save must NOT ALSO get the definitive "will NOT come back, re-dispatch"
 * nudge — the two raced in production (worker a1c71a86: the false nudge landed immediately before three
 * auto-recovery re-confirmation worker_reports from that SAME worker). Mirrors the tick's own gates
 * (role/resumability/successor/project-config/pause/attempt-cap) without requiring a trigger to already be
 * filed. Pure DB read, never throws.
 */
export function isCrashRecoveryEligible(
  db: Db,
  control: OrchestrationControl,
  session: { id: string; role?: SessionRole | null; parentSessionId?: string | null; projectId: string; engineSessionId?: string | null; resumability?: string },
): boolean {
  if (!session.role || !RECOVERABLE_ROLES.includes(session.role)) return false;
  if (!session.engineSessionId || session.resumability === "dead") return false;
  if (db.hasSuccessor(session.id)) return false;
  const project = db.getProject(session.projectId);
  if (!project) return false;
  const maxAttempts = resolveConfig(project.config).orchestration.crashRecoveryMaxAttempts;
  if (maxAttempts <= 0) return false;
  if (control.isPaused(session.id) || (session.parentSessionId && control.isPaused(session.parentSessionId))) return false;
  const events = db.listEventsForWorker(session.id);
  const lastRecovered = lastOfKind(events, "session_recovered");
  const episodeStart = lastRecovered?.ts ?? "";
  const attempts = events.filter((e) => e.kind === "session_resume_attempt" && e.ts > episodeStart).length;
  return attempts < maxAttempts; // at/over the cap ⇒ the watchdog has abandoned (or is about to) — not eligible
}

/**
 * Crash-recovery watchdog. The complement of resumeFleetOnBoot: where THAT auto-resumes the whole fleet on
 * a daemon RESTART, THIS auto-recovers an ISOLATED session whose pty died UNEXPECTEDLY while the daemon
 * stayed HEALTHY — the gap that left a manager dead ~2.5h until a human noticed. It acts on EITHER of two
 * durable triggers (see RECOVERY_TRIGGER_KINDS), sharing one bound:
 *   • `session_died`              — an unexpected pty death (recordUnexpectedExit; intended stops + whole-
 *      daemon restarts are excluded — see there).
 *   • `worker_report_undelivered` — STRAND BACKSTOP (incident 22a44352): a worker reported `done` to a
 *      since-EXITED parent manager so the report reached nobody (`delivered:false`) and its branch sat
 *      unmerged. recordUndeliveredReport files it; the watchdog resumes the manager so it merges the work.
 *      This is the "keyed on delivered:false rather than process-death" recovery: a CLEANLY idle-exited
 *      manager has no `session_died`, so only this trigger can re-wake it.
 *
 * BOUNDED + CRASH-LOOP SAFE (the load-bearing property). Auto-resume is capped at `crashRecoveryMaxAttempts`
 * (per project; 0 = off) via a PERSISTED counter — the count of `session_resume_attempt` events since the
 * last `session_recovered` reset marker, so it survives a daemon restart (mirrors busy-worker's
 * once-per-episode mark in the events table). The attempt event is recorded BEFORE the resume, so a resume
 * that instantly re-crashes still counts — the loop can NEVER under-count and run away. After N re-deaths
 * the watchdog STOPS resuming and escalates ONCE: a loud `session_recovery_abandoned` event PLUS a crash-loop
 * banner stamped on the session's `lastError`, so Mission Control surfaces it role-agnostically off the
 * session row (a dead manager has no live parent to nudge — the attention event is the uniform surface). A
 * stable, still-live resume (live for `stabilityMs` since the last attempt) records `session_recovered`,
 * resetting the counter so a later, unrelated crash starts fresh.
 *
 * Never hard-kills anything; only resumes + surfaces. Skips silently when: the session has no live recovery
 * trigger (neither `session_died` nor an unconsumed `worker_report_undelivered`); the project disabled it
 * (`crashRecoveryMaxAttempts === 0`); the session was recycled/superseded; it or its manager is human-paused;
 * or it isn't a resumable, recoverable role.
 */
export class CrashRecoveryWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly stabilityMs: number;
  constructor(private deps: CrashRecoveryDeps) {
    this.stabilityMs = deps.stabilityMs ?? STABILITY_WINDOW_MS;
  }

  tick(now: Date = new Date()): void {
    const { db, resume, control, pty } = this.deps;
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const fileEvent = (s: { id: string; parentSessionId?: string | null; taskId?: string | null }, kind: OrchestrationEvent["kind"], detail?: Record<string, unknown>): void => {
      db.appendEvent({
        id: randomUUID(), ts: nowIso,
        managerSessionId: s.parentSessionId ?? s.id, workerSessionId: s.id, taskId: s.taskId ?? null,
        kind, detail,
      });
    };

    // Candidate set (bf0b902c): derive it from ONE indexed query over the trigger kinds
    // (idx_orch_events_kind) instead of scanning db.listResumeCandidates() (every resumable session in
    // the fleet — 2500+ on a real install). A session that never died/orphaned can NEVER pass the
    // `lastTrigger` check below regardless — the OLD comment here claimed that short-circuit "stays
    // cheap", but it ran only AFTER listEventsForWorker had already paid a full unindexed table scan +
    // sort (the actual bug: 2558 candidates × ~3.2ms = ~8.2s of synchronous event-loop blocking per tick,
    // every 60s). Asking "which sessions ever recorded a trigger" FIRST (typically a handful, not
    // thousands) and only THEN pulling each one's full history is both correct (same end result — a
    // session with no trigger event was always going to be skipped) and cheap by construction, not by an
    // ordering claim that turned out false.
    for (const id of db.listWorkerSessionIdsWithEventKind([...RECOVERY_TRIGGER_KINDS])) {
      const s = db.getSession(id);
      if (!s) continue;                                                   // session since hard-deleted
      if (!s.engineSessionId || s.resumability === "dead") continue;      // no longer a resume candidate
      if (!s.role || !RECOVERABLE_ROLES.includes(s.role)) continue;       // plain / run / auditor → not ours
      if (db.hasSuccessor(s.id)) continue;                                // superseded by a recycle successor → intended

      const project = db.getProject(s.projectId);
      if (!project) continue;
      const maxAttempts = resolveConfig(project.config).orchestration.crashRecoveryMaxAttempts;
      if (maxAttempts <= 0) continue;                                     // disabled for this project

      // Human-paused (the session's own scope, its manager's, or global) → never auto-resume (watcher parity).
      if (control.isPaused(s.id) || (s.parentSessionId && control.isPaused(s.parentSessionId))) continue;

      const events = db.listEventsForWorker(s.id);                       // chronological (ts, rowid)
      const lastTrigger = lastTriggerOf(events);                         // session_died OR worker_report_undelivered
      if (!lastTrigger) continue;                                        // defensive only — id came from a trigger-kind query, so this can't actually miss

      const lastRecovered = lastOfKind(events, "session_recovered");
      // RESOLVED: a recovery recorded at/after the latest trigger closed the episode (counter already reset).
      if (lastRecovered && lastRecovered.ts >= lastTrigger.ts) continue;

      // Counter = resume attempts since the last reset marker (episodeStart). "" sorts before any ISO ts.
      const episodeStart = lastRecovered?.ts ?? "";
      const attemptEvents = events.filter((e) => e.kind === "session_resume_attempt" && e.ts > episodeStart);
      const attempts = attemptEvents.length;

      if (s.processState === "live") {
        // Running. Has it stayed live long enough since the last crash-recovery activity to declare the
        // episode RECOVERED (reset the counter)? Reference the latest of {last attempt, the death} — this
        // also re-arms after an EXTERNAL resume (resumeFleetOnBoot / a human) that left no attempt event.
        const lastAttempt = attemptEvents[attemptEvents.length - 1];
        const refMs = Date.parse(lastAttempt ? lastAttempt.ts : lastTrigger.ts);
        if (nowMs - refMs >= this.stabilityMs) {
          fileEvent(s, "session_recovered", { afterAttempts: attempts });
          db.setLastError(s.id, null); // clear any crash-loop banner now that it's healthy again
          // eslint-disable-next-line no-console
          console.log(`[crash-recovery-watcher] ${s.id} stably resumed after ${attempts} attempt(s) — counter reset`);
        }
        continue;                                                        // a live session is never resumed
      }

      if (s.processState !== "exited") continue;                         // 'starting' = mid-(re)spawn → settle next tick

      // Exited with an UNRECOVERED death.
      if (attempts >= maxAttempts) {
        // CRASH-LOOP SAFETY: cap reached — STOP resuming; escalate ONCE per episode (loud on Mission Control).
        const abandoned = events.some((e) => e.kind === "session_recovery_abandoned" && e.ts > episodeStart);
        if (!abandoned) {
          fileEvent(s, "session_recovery_abandoned", { role: s.role, attempts });
          db.setLastError(
            s.id,
            `[loom:crash-loop] ${s.role} ${s.id.slice(0, 8)} died ${attempts}× after auto-resume — Loom STOPPED ` +
            `auto-resuming (crash-loop safety). It will NOT come back on its own: inspect its log, fix the cause, ` +
            `then resume it manually.`,
          );
          // Additive, cheap heads-up to a LIVE parent manager (a worker only) — the event + lastError above
          // are the durable, role-agnostic surface; this just saves the manager a poll.
          if (s.role === "worker" && s.parentSessionId && pty) {
            const parent = db.getSession(s.parentSessionId);
            if (parent?.processState === "live") {
              try {
                pty.enqueueStdin(
                  s.parentSessionId,
                  `[loom:crash-loop] Your worker ${s.id.slice(0, 8)}${s.taskId ? ` (task ${s.taskId.slice(0, 8)})` : ""} ` +
                  `died ${attempts}× after auto-resume — Loom STOPPED auto-resuming it (crash-loop safety). It will ` +
                  `NOT come back on its own. Inspect its log, then recycle/re-task it or fix the cause.`,
                );
              } catch { /* parent not live/ready — the event + lastError stand */ }
            }
          }
          // eslint-disable-next-line no-console
          console.log(`[crash-recovery-watcher] GAVE UP on ${s.id} (${s.role}) after ${attempts} re-death(s) — escalated on Mission Control`);
        }
        continue;                                                        // never resume past the cap
      }

      // Under the cap → record the attempt FIRST (so a resume that instantly re-crashes still counts —
      // crash-loop bounding must never under-count), THEN resume. A throw from resume (unresumable) is
      // caught: the attempt still counts, so even a never-starting session is bounded → escalates after N.
      const attemptNo = attempts + 1;
      fileEvent(s, "session_resume_attempt", { attempt: attemptNo, maxAttempts });
      let started = false;
      let error: string | undefined;
      try { started = resume(s.id); } catch (e) { error = (e as Error).message; }
      // A bare resume injects NOTHING (resume-injects-nothing), so the recovered session would sit idle —
      // and a worker is caught by neither the idle-watcher (managers only) nor the stranded-worker hook
      // (it can't see a resume's direct setBusy(false)). So nudge it to actually continue, mirroring
      // resumeFleetOnBoot's per-role continuation nudges. Ready-gated (host.ts queues it until the resumed
      // TUI boots, then drains). Best-effort — the resume itself is the recovery; the nudge just re-engages it.
      if (started && pty) {
        if (s.role === "worker" || s.role === "assistant") {
          // Worker/assistant nudges stay UNCONDITIONAL (card c9e51581 scopes the stake-aware silencing to
          // manager/platform only — a worker/assistant has no board/idle-nudge concept to classify against).
          const note = s.role === "worker"
            ? `[loom:auto-recovered] Your session died unexpectedly and Loom auto-resumed it — your worktree WIP is ` +
              `intact. Continue your assigned task from where you left off. If you had already finished, call ` +
              `worker_report (done/blocked) so your manager isn't left waiting.`
            : `[loom:auto-recovered] Your session died unexpectedly and Loom auto-resumed it — pick up where you left ` +
              `off with the human.`;
          // Same engine reality as resumeFleetOnBoot: a `claude --resume`'d session gets a bare "Continue"
          // turn + a reset file-read set, so carry the SHARED RESUME_NUDGE_TAIL (PL Auditor #11) here too.
          try { pty.enqueueStdin(s.id, note + RESUME_NUDGE_TAIL); } catch { /* not ready yet — the resume stands */ }
        } else {
          // manager or platform — card c9e51581 (Path C extension of 61cc91c6): a manager/platform with NO
          // stake in this isolated crash resumes SILENTLY instead of the unconditional re-orient nudge below.
          // causal:false (an isolated pty death isn't self-requested, unlike a daemon_restart requester).
          // liveWorkersResumed = the manager's CURRENT live worker count — this path has no "resume set"
          // list like Path A/B (it resumes ONE dead session per candidate), so "workers resumed alongside
          // it" doesn't exist; the natural analog is "does it have live workers to re-check right now".
          // KNOWN, ACCEPTED gap: if this manager AND one of its workers crash-die in the SAME tick, this
          // tick's candidate iteration order isn't guaranteed, so this query can undercount if the manager
          // is processed before its worker's own resume (later in this same tick) lands — the
          // manager would then resume silently for this ONE tick. Not a correctness bug: the worker still
          // recovers independently via its own `session_died` trigger, and the manager learns about it
          // shortly after via worker_list / the worker's own report — accepted rather than adding
          // cross-candidate batching for a rare simultaneous-crash case.
          // queuedIoReplayed: a `worker_report_undelivered` trigger IS a specific queued/undelivered worker
          // report waiting on this manager — real work waiting, so it maps onto queuedIoReplayed and forces
          // the full nudge through the standard field rather than a bolt-on special case.
          const liveWorkersResumed = db.listWorkers(s.id).filter((w) => w.processState === "live").length;
          const impact = computeWakeImpact(db, s.id, s.role ?? null, {
            causal: false,
            liveWorkersResumed,
            queuedIoReplayed: lastTrigger.kind === "worker_report_undelivered" ? 1 : 0,
          });
          if (!isNoOpManagerWake(impact)) {
            // Tailor the manager nudge to the trigger: a `worker_report_undelivered` wake means a worker's
            // report reached nobody while this manager was stopped — point it straight at the review/merge
            // it missed (the task is already in `review`), not the generic "died unexpectedly" copy.
            const note = lastTrigger.kind === "worker_report_undelivered"
              ? `[loom:auto-recovered] Loom resumed you because a worker reported while you were stopped — its report ` +
                `reached nobody and its branch is waiting. Call worker_list: one or more workers are awaiting your ` +
                `review (the task is already in 'review'). Run the review→gate→merge loop on it, then continue orchestrating.`
              : s.role === "platform"
                ? `[loom:auto-recovered] Your session died unexpectedly and Loom auto-resumed it — re-orient from ` +
                  `your home board and your living resume doc, then continue your platform work from where you ` +
                  `left off.`
                : `[loom:auto-recovered] Your session died unexpectedly and Loom auto-resumed it — your worktrees are ` +
                  `intact. Re-check your workers' state (some may need attention) and continue orchestrating from where ` +
                  `you left off.`;
            try { pty.enqueueStdin(s.id, note + RESUME_NUDGE_TAIL); } catch { /* not ready yet — the resume stands */ }
          }
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[crash-recovery-watcher] auto-resume ${s.id} (${s.role}) attempt ${attemptNo}/${maxAttempts} → ${started ? "started" : `failed${error ? ` (${error})` : ""}`}`);
    }
  }

  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
