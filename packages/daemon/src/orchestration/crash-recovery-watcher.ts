import { randomUUID } from "node:crypto";
import { resolveConfig, type SessionRole, type OrchestrationEvent } from "@loom/shared";
import type { Db } from "../db.js";
import type { OrchestrationControl } from "./control.js";

/**
 * Session roles the crash-recovery watchdog covers — coordination/work sessions worth auto-recovering.
 * EXCLUDES plain (role null), ephemeral `run` (never resume — a restart fails them clean), and `auditor`
 * (a fire-once read-and-file session). Managers are IN scope: the motivating incident was a dead manager.
 */
const RECOVERABLE_ROLES: SessionRole[] = ["manager", "worker", "platform"];

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
 * Crash-recovery watchdog. The complement of resumeFleetOnBoot: where THAT auto-resumes the whole fleet on
 * a daemon RESTART, THIS auto-recovers an ISOLATED session whose pty died UNEXPECTEDLY while the daemon
 * stayed HEALTHY — the gap that left a manager dead ~2.5h until a human noticed. The trigger is the durable
 * `session_died` event (recorded by recordUnexpectedExit ONLY for an unexpected death of a resumable
 * coordination/work session — see there for why intended stops + whole-daemon restarts are excluded).
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
 * Never hard-kills anything; only resumes + surfaces. Skips silently when: the session never died
 * unexpectedly (no `session_died`); the project disabled it (`crashRecoveryMaxAttempts === 0`); the session
 * was recycled/superseded; it or its manager is human-paused; or it isn't a resumable, recoverable role.
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

    // listResumeCandidates: every session with a captured engine id that isn't `dead` — includes LIVE ones
    // (needed for the stable-resume reset) and EXITED ones (the resume targets). A normal session that
    // never died short-circuits below (no `session_died`), so the scan stays cheap.
    for (const s of db.listResumeCandidates()) {
      if (!s.role || !RECOVERABLE_ROLES.includes(s.role)) continue;       // plain / run / auditor → not ours
      if (db.hasSuccessor(s.id)) continue;                                // superseded by a recycle successor → intended

      const project = db.getProject(s.projectId);
      if (!project) continue;
      const maxAttempts = resolveConfig(project.config).orchestration.crashRecoveryMaxAttempts;
      if (maxAttempts <= 0) continue;                                     // disabled for this project

      // Human-paused (the session's own scope, its manager's, or global) → never auto-resume (watcher parity).
      if (control.isPaused(s.id) || (s.parentSessionId && control.isPaused(s.parentSessionId))) continue;

      const events = db.listEventsForWorker(s.id);                       // chronological (ts, rowid)
      const lastDeath = lastOfKind(events, "session_died");
      if (!lastDeath) continue;                                          // never died unexpectedly → not our concern

      const lastRecovered = lastOfKind(events, "session_recovered");
      // RESOLVED: a recovery recorded at/after the latest death closed the episode (counter already reset).
      if (lastRecovered && lastRecovered.ts >= lastDeath.ts) continue;

      // Counter = resume attempts since the last reset marker (episodeStart). "" sorts before any ISO ts.
      const episodeStart = lastRecovered?.ts ?? "";
      const attemptEvents = events.filter((e) => e.kind === "session_resume_attempt" && e.ts > episodeStart);
      const attempts = attemptEvents.length;

      if (s.processState === "live") {
        // Running. Has it stayed live long enough since the last crash-recovery activity to declare the
        // episode RECOVERED (reset the counter)? Reference the latest of {last attempt, the death} — this
        // also re-arms after an EXTERNAL resume (resumeFleetOnBoot / a human) that left no attempt event.
        const lastAttempt = attemptEvents[attemptEvents.length - 1];
        const refMs = Date.parse(lastAttempt ? lastAttempt.ts : lastDeath.ts);
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
        const note = s.role === "worker"
          ? `[loom:auto-recovered] Your session died unexpectedly and Loom auto-resumed it — your worktree WIP is ` +
            `intact. Continue your assigned task from where you left off. If you had already finished, call ` +
            `worker_report (done/blocked) so your manager isn't left waiting.`
          : `[loom:auto-recovered] Your session died unexpectedly and Loom auto-resumed it — your worktrees are ` +
            `intact. Re-check your workers' state (some may need attention) and continue orchestrating from where ` +
            `you left off.`;
        try { pty.enqueueStdin(s.id, note); } catch { /* not ready yet — the resume stands */ }
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
