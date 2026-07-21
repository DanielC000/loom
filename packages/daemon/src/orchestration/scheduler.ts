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
   * The optional 2nd arg is the schedule's own `prompt` (appended to the agent's startupPrompt) —
   * undefined/null when unset, so an unset schedule composes byte-identical to today.
   */
  startManager: (agentId: string, prompt?: string | null) => { id: string };
  /**
   * Boots the read-and-file-only Platform Auditor session (P5) — the spawn for a schedule whose
   * `kind` is "auditor". Prod-wired to SessionService.startAuditor; a test injects a recording stub.
   * Optional: a schedule defaults to kind "manager", so a wiring that omits this still drives every
   * legacy (manager) schedule correctly — an auditor schedule then falls back to startManager.
   */
  startAuditor?: (agentId: string, prompt?: string | null) => { id: string };
  /**
   * Boots the suggest-only END-USER Workspace Auditor session (B6) — the spawn for a schedule whose
   * `kind` is "workspace-auditor". Prod-wired to SessionService.startWorkspaceAuditor; a test injects a
   * recording stub. Optional, exactly like startAuditor: a wiring that omits it falls back to
   * startManager (so the manager path stays unchanged when the workspace-auditor spawn isn't wired).
   */
  startWorkspaceAuditor?: (agentId: string, prompt?: string | null) => { id: string };
  /** Tick cadence; defaults to 60s. Injectable so a test can drive tick() directly instead. */
  intervalMs?: number;
  /**
   * §19c: "are we near the Claude usage limit?" — defaults to the global awareness record. Injectable
   * so a test can drive the limit-skip deterministically without writing the awareness file. The
   * optional 2nd arg is the resolved recency window (ms); a test stub may ignore it.
   */
  isUsageLimited?: (now: Date, recencyWindowMs?: number) => boolean;
  /**
   * §19a hardening (narrowed by card 53edd8d5): hard cap on concurrently-LIVE, SCHEDULER-SPAWNED
   * managers (`countLiveScheduledManagers` — excludes the standing human/Lead-spawned fleet entirely).
   * Wired from `orchestration.maxConcurrentManagers` in index.ts; defaults to DEFAULT_MAX_CONCURRENT_MANAGERS.
   */
  maxConcurrentManagers?: number;
  /**
   * SEPARATE small budget for concurrently-LIVE AUDITORS (the dev Platform Auditor + the end-user Workspace
   * Auditor). Auditors are read-mostly and lightweight, so they are LIFTED OUT of the manager cap: a fired
   * auditor never consumes a manager slot and is never blocked because the manager cap is full (and vice
   * versa). Defaults to DEFAULT_MAX_CONCURRENT_AUDITORS — a constant default (not config-wired) keeps the
   * surface small while still bounding scheduled audit spawns.
   */
  maxConcurrentAuditors?: number;
}

/** Fallback manager cap when none is injected (matches the config default). */
const DEFAULT_MAX_CONCURRENT_MANAGERS = 3;
/** Fallback auditor budget — small: auditors are read-mostly, so a couple concurrent is plenty. */
const DEFAULT_MAX_CONCURRENT_AUDITORS = 2;

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
   *  - MANAGER CAP (finding 3, NARROWED by card 53edd8d5): stop once `maxConcurrentManagers` live
   *    SCHEDULER-SPAWNED managers exist (`countLiveScheduledManagers`) — NOT the daemon-wide live-manager
   *    count. A standing human/Lead-spawned fleet never counts against this budget, however large it
   *    grows, so it can never permanently starve a cadence (the bug this narrowing fixes: the cap used
   *    to count every live manager, so an account with ≥cap standing managers could never fire a
   *    schedule again). The remaining due schedules are deferred to the next tick (next_fire_at
   *    untouched) — like the pause gate — and the deferral is recorded (see DEFERRAL OBSERVABILITY below).
   *  - AUDITOR BUDGET: auditor-kind schedules ('auditor' / 'workspace-auditor') draw from a SEPARATE small
   *    budget, NOT the manager cap — a read-mostly audit run never burns a manager slot and is never blocked
   *    by a full manager cap (and vice versa). An over-budget auditor is `continue`-skipped (left due),
   *    NOT a `break`, so a manager later in the due list can still fire (and vice versa).
   *  - DEFERRAL OBSERVABILITY (card 53edd8d5): a budget-deferred schedule stamps `lastDeferredAt`/
   *    `lastDeferredReason` (Db.markDeferred) and emits a `schedule_fire_deferred` event — but ONLY on a
   *    TRANSITION into deferred (first defer, or the reason changing since last tick), never once per
   *    tick for a schedule that stays blocked for the SAME reason. A schedule starved for hours would
   *    otherwise write a near-identical event every 60s tick, flooding the event log. Both are cleared by
   *    `markFired` on the schedule's next successful fire.
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
    const auditorCap = this.deps.maxConcurrentAuditors ?? DEFAULT_MAX_CONCURRENT_AUDITORS;
    // Scheduler-spawned managers ONLY (card 53edd8d5) — a standing human/Lead-spawned fleet is excluded.
    let liveManagers = this.deps.db.countLiveScheduledManagers();
    let liveAuditors = this.deps.db.countLiveAuditors(); // auditors (both kinds) — their OWN budget

    for (const s of due) {
      const isAuditor = s.kind === "auditor" || s.kind === "workspace-auditor";
      // Budget gate (finding 3 + the auditor split): managers and auditors each defer against their OWN
      // count. `continue` (not `break`) so hitting one budget never blocks the other kind later in the list;
      // a deferred schedule keeps its past next_fire_at → it comes back due next tick. DB count + in-tick
      // increments cover both axes (pre-existing live + already-fired-this-tick).
      if (isAuditor ? liveAuditors >= auditorCap : liveManagers >= cap) {
        const reason = isAuditor ? `auditor budget (${auditorCap}) reached` : `manager cap (${cap}) reached`;
        // eslint-disable-next-line no-console
        console.error(`[scheduler] ${reason} — deferring schedule ${s.id} to the next tick`);
        // Deferral observability: record ONLY on a TRANSITION (first defer, or the reason changed) — a
        // still-deferred-same-reason schedule writes NOTHING on this tick, so a schedule starved for
        // hours doesn't flood the row/event log with a near-identical write every 60s. Best-effort: a
        // failing durable-record write must never crash the per-schedule loop (mirrors the failure path
        // below).
        if (s.lastDeferredReason !== reason || !s.lastDeferredAt) {
          try {
            this.deps.db.markDeferred(s.id, now.toISOString(), reason);
            this.deps.db.appendEvent({
              id: randomUUID(), ts: now.toISOString(),
              managerSessionId: "", kind: "schedule_fire_deferred",
              detail: { scheduleId: s.id, cron: s.cron, kind: s.kind, reason },
            });
          } catch { /* never let the durable-record write itself crash the tick */ }
        }
        continue;
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
        // P5/B6: route by the schedule's kind. An "auditor" schedule spawns the dev read-and-file-only
        // Platform Auditor (startAuditor — role locked to "auditor"); a "workspace-auditor" schedule spawns
        // the end-user suggest-only Workspace Auditor (startWorkspaceAuditor — role locked to
        // "workspace-auditor"); everything else (incl. legacy rows that backfilled to "manager") boots a
        // manager. Both auditor start-fns are optional in the deps, so a wiring that omits either falls back
        // to startManager (keeps the manager path unchanged when the auditor spawn isn't wired).
        const startFn =
          s.kind === "workspace-auditor" && this.deps.startWorkspaceAuditor ? this.deps.startWorkspaceAuditor
          : s.kind === "auditor" && this.deps.startAuditor ? this.deps.startAuditor
          : this.deps.startManager;
        const spawned = startFn(s.agentId, s.prompt);
        this.deps.db.appendEvent({
          id: randomUUID(), ts: now.toISOString(),
          managerSessionId: spawned.id, kind: "schedule_fired",
          detail: { scheduleId: s.id, cron: s.cron, kind: s.kind },
        });
        // Count the spawn against the budget for ITS kind (auditors have their own; see above).
        if (isAuditor) liveAuditors++; else liveManagers++;
      } catch (e) {
        // Durable failure record (mirror of the schedule_fired success event): a spawn that throws used to
        // ONLY stderr-log, so a cadence could silently never run with no surfaced reason. Emit a queryable
        // `schedule_fire_failed` event so the failure is visible (listEvents) like a successful fire. No
        // manager session was spawned, so managerSessionId is left EMPTY (the session-less-event convention —
        // see resolveQueuedMessage et al.) rather than overloaded with the SCHEDULE id, which would mis-join
        // any consumer treating managerSessionId as a session foreign key. The scheduleId is carried in
        // `detail` (below). The slot is already claimed (markFired above) so this never double-spawns, and we
        // deliberately do NOT disable: a transient spawn failure must not permanently kill a cadence (only the
        // deleted-agent case disables). Best-effort: a failing audit write must never crash the per-schedule loop.
        try {
          this.deps.db.appendEvent({
            id: randomUUID(), ts: now.toISOString(),
            managerSessionId: "", kind: "schedule_fire_failed",
            detail: { scheduleId: s.id, cron: s.cron, kind: s.kind, error: (e as Error).message },
          });
        } catch { /* never let the durable-record write itself crash the tick */ }
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
