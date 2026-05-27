import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { OrchestrationControl } from "./control.js";
import { nextFireAt } from "./cron.js";

export interface SchedulerDeps {
  db: Db;
  control: OrchestrationControl;
  /**
   * Boots a manager session in the topic and returns its id. Prod-wired to
   * SessionService.startManager; the test injects a recording stub (keeps this PR claude-free).
   */
  startManager: (topicId: string) => { id: string };
  /** Tick cadence; defaults to 60s. Injectable so a test can drive tick() directly instead. */
  intervalMs?: number;
}

/**
 * Cron Scheduler (phase-2 Pillar B): the trigger layer. On each minute tick it boots a manager
 * for every enabled, due, non-paused schedule — the self-starting queue. Interactive manager pty
 * only (startManager → SessionService.startManager), NEVER headless `claude -p`.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: SchedulerDeps) {}

  /**
   * One scheduling pass. Fires each enabled, due schedule unless orchestration is globally paused
   * (then it leaves next_fire_at untouched so the next tick retries — mirrors #17a's spawn gate).
   * Per-schedule try/catch: a throwing schedule (bad cron, startManager failure) is logged and
   * skipped, never crashing the loop or blocking the other schedules.
   */
  async tick(now: Date = new Date()): Promise<void> {
    const due = this.deps.db.listDueSchedules(now.toISOString());
    if (due.length === 0) return;
    // Pause gate (global kill/pause switch): hold everything; next_fire_at stays, retried next tick.
    if (this.deps.control.pausedScopes().includes("global")) return;

    for (const s of due) {
      try {
        const mgr = this.deps.startManager(s.topicId);
        this.deps.db.appendEvent({
          id: randomUUID(), ts: now.toISOString(),
          managerSessionId: mgr.id, kind: "schedule_fired",
          detail: { scheduleId: s.id, cron: s.cron },
        });
        this.deps.db.markFired(s.id, now.toISOString(), nextFireAt(s.cron, now));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[scheduler] schedule ${s.id} (${s.cron}) failed to fire:`, (e as Error).message);
      }
    }
  }

  /**
   * Start ticking. First reconciles MISSED fires: any schedule whose next_fire_at is in the past
   * (the daemon was down across its slot) recomputes forward to the next future boundary — so a
   * restart never floods with catch-up fires (run-once-forward, not run-N-times).
   */
  start(now: Date = new Date()): void {
    for (const s of this.deps.db.listSchedules()) {
      if (new Date(s.nextFireAt).getTime() <= now.getTime()) {
        try {
          this.deps.db.updateSchedule(s.id, { nextFireAt: nextFireAt(s.cron, now) });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`[scheduler] could not recompute schedule ${s.id} (${s.cron}):`, (e as Error).message);
        }
      }
    }
    this.timer = setInterval(() => { void this.tick(); }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
