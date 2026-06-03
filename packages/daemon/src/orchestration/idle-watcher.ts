import { resolveConfig, contextWindowForModel } from "@loom/shared";
import type { OrchestrationEventKind } from "@loom/shared";
import type { Db } from "../db.js";
import type { OrchestrationControl } from "./control.js";

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests claude-free). */
export interface IdlePty {
  isAlive(sessionId: string): boolean;
  /** Nudge text into the session's busy-gated queue (waits if the manager is mid-turn). */
  enqueueStdin(sessionId: string, text: string): { delivered: boolean; position?: number };
}

export interface IdleWatcherDeps {
  db: Db;
  pty: IdlePty;
  /** §17a pause registry — a human-paused manager is never nudged (parity with worker_spawn). */
  control: OrchestrationControl;
  /** ContextWatcher's recycle ratio: a manager at/over it has a recycle nudge pending → idle defers. 0 = no recycle nudges. */
  recycleRatio: number;
  /** Tick cadence; defaults to 60s. Injectable so a test drives tick() directly. */
  intervalMs?: number;
}

/**
 * Manager orchestration-event kinds that prove the manager is BACK AT THE WHEEL (genuine new work).
 * A nudged manager that produces one of these AFTER its last nudge is re-armed (resetIdleNudgeState).
 * Deliberately excludes `idle_report` (the manager's ANSWER to a nudge — it sets policy itself, and
 * counting it as "activity" would undo the snooze/suppress it just chose) and the system-driven
 * `schedule_fired`/`wake_*` events (not the manager waking up on its own).
 */
const ORCH_ACTIVITY_KINDS: ReadonlySet<OrchestrationEventKind> = new Set<OrchestrationEventKind>([
  "spawn_worker", "message_worker", "stop_worker",
  "merge_request", "merge_done", "merge_rejected",
  "recycle_begin", "recycle_complete", "build_gate", "kill_switch",
]);

/**
 * Asleep-at-the-Wheel watcher (idle-manager watchdog). Structural twin of ContextWatcher: each tick,
 * for every LIVE manager that is idle (`busy=false` + `lastActivity` older than the project's
 * `idleNudgeMinutes`) with NO live workers, it injects a ONE-TIME-per-episode busy-gated nudge asking
 * the manager WHY it is idle and to `idle_report` its state (then resume the loop). Agent-in-the-loop:
 * Loom can't know why a manager is idle, so it asks; the manager answers over MCP (`idle_report`).
 *
 * Unlike ContextWatcher's in-memory `nudged` Set, the "once per episode" mark is PERSISTED
 * (`last_idle_nudge_at`): a re-nudge only fires after another full `idleNudgeMinutes` of continued
 * idleness, and at most `maxUnansweredNudges` times before backing off (the Task-4 escalation path —
 * here we simply stop). This survives a daemon restart, so a snooze/cap is honored across boots.
 *
 * Skips silently when: snoozed/suppressed (policy ≠ watching, or an active snooze window); the manager
 * has a live worker (legitimately waiting on a building worker); human-paused; at/over the unanswered
 * cap; a context-recycle nudge is pending (recycle takes precedence); or the project disabled it
 * (`idleNudgeMinutes === 0`). Reset-on-activity re-arms a manager that returned to real work.
 */
export class IdleWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: IdleWatcherDeps) {}

  tick(now: Date = new Date()): void {
    const { db, pty, control, recycleRatio } = this.deps;
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    for (const m of db.listLiveManagers()) {
      const project = db.getProject(m.projectId);
      if (!project) continue;
      const cfg = resolveConfig(project.config).orchestration;
      const idleMinutes = cfg.idleNudgeMinutes;
      if (idleMinutes === 0) continue; // disabled for this project

      // Reset-on-activity: a manager that produced genuine orchestration work AFTER its last nudge is
      // back at the wheel — re-arm it (watching / unanswered 0 / snooze clear) before we evaluate.
      let state = db.getIdleNudgeState(m.id);
      if (!state) continue;
      if (state.lastIdleNudgeAt && this.producedActivitySince(m.id, state.lastIdleNudgeAt)) {
        db.resetIdleNudgeState(m.id);
        state = db.getIdleNudgeState(m.id);
        if (!state) continue;
      }

      // Timed snooze expiry: a manager that reported `waiting` is silent only UNTIL snooze_until
      // ("silent until then" — reuses wake_me semantics; persisted, so honored across a restart).
      // Once it elapses, re-arm to 'watching' (clears the snooze) so the normal predicate evaluates
      // it again this/next tick. ONLY for 'snoozed' — 'suppressed' (blocked_human/done) stays sticky
      // until genuine activity or a human reclaims it (Task 4). unanswered is already 0 for a manager
      // that answered `waiting`, so the reset is safe.
      if (state.policy === "snoozed" && state.snoozeUntil && nowIso >= state.snoozeUntil) {
        db.resetIdleNudgeState(m.id);
        state = db.getIdleNudgeState(m.id);
        if (!state) continue;
      }

      // --- the full trigger predicate (skip silently if ANY fails) ---
      if (m.busy) continue;                                              // mid-turn → not idle
      if (state.policy !== "watching") continue;                         // snoozed (within window) / suppressed
      if (state.snoozeUntil && nowIso < state.snoozeUntil) continue;     // defensive: active snooze on a watching row
      if (state.unanswered >= cfg.maxUnansweredNudges) continue;         // at/over cap → Task-4 escalation, not here
      if (control.isPaused(m.id)) continue;                              // human-paused

      // No live workers — a manager waiting on a building worker is legitimately idle (don't nudge).
      const liveWorkers = db.listWorkers(m.id).filter((w) => w.processState === "live").length;
      if (liveWorkers > 0) continue;

      // Competing recycle nudge: a near-full manager should recycle, not spawn. Mirror ContextWatcher's
      // own predicate (ratio of measured context to the model window) so we never double-fire.
      if (recycleRatio > 0 && m.ctxInputTokens != null) {
        if (m.ctxInputTokens / contextWindowForModel(m.model) >= recycleRatio) continue;
      }

      // Idle long enough? The re-nudge cadence is gated on the LATER of lastActivity and the last
      // nudge, so a fired nudge isn't repeated for another full idleNudgeMinutes window.
      const lastActivityMs = Date.parse(m.lastActivity);
      const lastNudgeMs = state.lastIdleNudgeAt ? Date.parse(state.lastIdleNudgeAt) : 0;
      const idleSinceMs = Math.max(lastActivityMs, lastNudgeMs);
      const idleForMin = (nowMs - idleSinceMs) / 60_000;
      if (idleForMin < idleMinutes) continue;

      if (!pty.isAlive(m.id)) continue;

      const openTodos = db.listTasks(m.projectId).filter((t) => t.columnKey === "todo").length;
      const n = Math.round((nowMs - lastActivityMs) / 60_000);
      const msg =
        `[loom:idle] You've been idle ~${n} min with no live workers and ${openTodos} open todo task(s). ` +
        `Why are you idle? If you simply dropped the orchestration loop, pick up the next task NOW. ` +
        `Then call idle_report with your state: 'working' (back at it), 'waiting' (on a long worker or ` +
        `external thing — optionally pass minutes), 'blocked_human' (need a human decision/credential/access), ` +
        `or 'done' (the queue is genuinely drained). Resume the loop if appropriate.`;
      try { pty.enqueueStdin(m.id, msg); } catch { /* manager not live */ }
      db.recordIdleNudge(m.id, nowIso); // stamp last_idle_nudge_at + increment idle_nudge_unanswered
      // eslint-disable-next-line no-console
      console.log(`[idle-watcher] nudged idle manager ${m.id} (~${n}m idle, ${openTodos} todo, unanswered→${state.unanswered + 1})`);
    }
  }

  /** True if the manager appended a genuine orchestration-work event strictly after `sinceIso`. */
  private producedActivitySince(managerId: string, sinceIso: string): boolean {
    for (const e of this.deps.db.listEvents(managerId)) {
      if (e.ts > sinceIso && ORCH_ACTIVITY_KINDS.has(e.kind)) return true;
    }
    return false;
  }

  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
