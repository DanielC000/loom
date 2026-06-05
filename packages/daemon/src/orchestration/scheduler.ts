import { randomUUID } from "node:crypto";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import type { OrchestrationControl } from "./control.js";
import { nextFireAt } from "./cron.js";
import { isLikelyNearClaudeUsageLimit } from "./usage-awareness.js";

export interface SchedulerDeps {
  db: Db;
  control: OrchestrationControl;
  /**
   * Boots a manager session in the agent and returns its id. Prod-wired to
   * SessionService.startManager; the test injects a recording stub (keeps this PR claude-free).
   */
  startManager: (agentId: string) => { id: string };
  /**
   * Boots the read-and-file-only Platform Auditor session (P5) — the spawn for a schedule whose
   * `kind` is "auditor". Prod-wired to SessionService.startAuditor; a test injects a recording stub.
   * Optional: a schedule defaults to kind "manager", so a wiring that omits this still drives every
   * legacy (manager) schedule correctly — an auditor schedule then falls back to startManager.
   */
  startAuditor?: (agentId: string) => { id: string };
  /** Tick cadence; defaults to 60s. Injectable so a test can drive tick() directly instead. */
  intervalMs?: number;
  /**
   * §19c: "are we near the Claude usage limit?" — defaults to the global awareness record. Injectable
   * so a test can drive the limit-skip deterministically without writing the awareness file. The
   * optional 2nd arg is the resolved recency window (ms); a test stub may ignore it.
   */
  isUsageLimited?: (now: Date, recencyWindowMs?: number) => boolean;
  /**
   * §19a hardening: hard cap on concurrently-LIVE managers the Scheduler will spawn. Wired from
   * `orchestration.maxConcurrentManagers` in index.ts; defaults to DEFAULT_MAX_CONCURRENT_MANAGERS.
   */
  maxConcurrentManagers?: number;
}

/** Fallback manager cap when none is injected (matches the config default). */
const DEFAULT_MAX_CONCURRENT_MANAGERS = 3;

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
   *
   * §19a hardening (3 findings):
   *  - DELETED AGENT (finding 1): a schedule whose agent no longer exists can never fire — disable
   *    it (it has no agent-delete cascade to clean it up) so it stops re-trying every tick.
   *  - CLAIM-BEFORE-SPAWN (finding 2): advance next_fire_at BEFORE the spawn/event side effects, so
   *    if startManager or appendEvent throws the slot is already consumed → no double-spawn next tick.
   *  - MANAGER CAP (finding 3): stop once `maxConcurrentManagers` live managers exist; the remaining
   *    due schedules are deferred to the next tick (next_fire_at untouched) — like the pause gate.
   */
  async tick(now: Date = new Date()): Promise<void> {
    const due = this.deps.db.listDueSchedules(now.toISOString());
    if (due.length === 0) return;
    // Pause gate (global kill/pause switch): hold everything; next_fire_at stays, retried next tick.
    if (this.deps.control.pausedScopes().includes("global")) return;
    // §19c usage-limit gate: don't boot a manager into a known-limited account (whole-queue
    // awareness). Same shape as the pause gate — next_fire_at stays, retried once the limit clears.
    // The recency window is the daemon-global `platform.rateLimit.recencyWindowMs`, resolved LIVE here
    // (an injected test stub ignores the extra arg).
    const recencyWindowMs = resolveConfig(undefined, this.deps.db.getPlatformConfig()).platform.rateLimit.recencyWindowMs;
    if ((this.deps.isUsageLimited ?? isLikelyNearClaudeUsageLimit)(now, recencyWindowMs)) return;

    const cap = this.deps.maxConcurrentManagers ?? DEFAULT_MAX_CONCURRENT_MANAGERS;
    let liveManagers = this.deps.db.countLiveManagers(); // managers persisting from prior ticks

    for (const s of due) {
      // Finding 3 — manager cap: defer the rest of this tick's due schedules (next_fire_at left in
      // the past → they come back due next tick). DB count + in-tick increments cover both axes.
      if (liveManagers >= cap) {
        // eslint-disable-next-line no-console
        console.error(`[scheduler] manager cap (${cap}) reached — deferring remaining due schedules to the next tick`);
        break;
      }
      // Finding 1 — deleted agent: never fireable → disable so it stops re-firing every tick.
      if (!this.deps.db.getAgent(s.agentId)) {
        this.deps.db.updateSchedule(s.id, { enabled: false });
        // eslint-disable-next-line no-console
        console.error(`[scheduler] schedule ${s.id} (${s.cron}) disabled — agent ${s.agentId} no longer exists`);
        continue;
      }
      try {
        // Finding 2 — claim the slot FIRST: advance next_fire_at before any side effect, so a
        // failed spawn/event can't leave the slot un-advanced and re-fire (double-spawn) next tick.
        this.deps.db.markFired(s.id, now.toISOString(), nextFireAt(s.cron, now));
        // P5: route by the schedule's kind. An "auditor" schedule spawns the read-and-file-only Platform
        // Auditor (startAuditor — role locked to "auditor"); everything else (incl. legacy rows that
        // backfilled to "manager") boots a manager. startAuditor is optional in the deps, so a wiring that
        // omits it falls back to startManager (keeps the manager path unchanged when auditor isn't wired).
        const startFn = s.kind === "auditor" && this.deps.startAuditor ? this.deps.startAuditor : this.deps.startManager;
        const spawned = startFn(s.agentId);
        this.deps.db.appendEvent({
          id: randomUUID(), ts: now.toISOString(),
          managerSessionId: spawned.id, kind: "schedule_fired",
          detail: { scheduleId: s.id, cron: s.cron, kind: s.kind },
        });
        // Count every scheduler spawn (manager OR auditor) against the per-tick cap so a fired auditor
        // can't let the loop exceed the bound (the cap is a general scheduler-spawn ceiling here).
        liveManagers++;
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
