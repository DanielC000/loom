import { randomUUID } from "node:crypto";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import type { EventTrigger, OrchestrationEvent } from "@loom/shared";
import type { OrchestrationControl } from "./control.js";
import { isLikelyNearClaudeUsageLimit } from "./usage-awareness.js";
import { formatEventTriggerBlock } from "./event-trigger-format.js";

/** Mirrors PollService's PollPty seam — the slice of PtyHost this service needs. */
export interface EventTriggerPty {
  isAlive(sessionId: string): boolean;
  enqueueStdin(
    sessionId: string,
    text: string,
    source?: "human" | "system",
    onDeliver?: () => void,
    route?: undefined,
    kind?: "warning" | "agent",
  ): { delivered: boolean; position?: number };
}

export interface EventTriggerServiceDeps {
  db: Db;
  pty: EventTriggerPty;
  /** §17a safety rails: the SAME global pause/kill switch Scheduler gates on (CR fix f5d07121-T2-②) —
   *  global pause is the master kill switch for every autonomous spawn/wake surface, and this is the
   *  most loop-prone one of all. A trigger fire can spawn/wake a claude session exactly like a
   *  worker_spawn, so it MUST stop under a global pause too. */
  control: OrchestrationControl;
  /** Re-spawn a stopped-but-resumable wake-mode target. Prod-wired to SessionService.resume. */
  resume: (sessionId: string) => unknown;
  /** Spawn a fresh spawn-mode session with the matched event(s) as its kickoff (composed with the
   *  target agent's own startup prompt, same as PollService.spawn). Prod-wired to
   *  `(agentId, kickoffPrompt) => sessions.startNew(agentId, { kickoffPrompt })`. */
  spawn: (agentId: string, kickoffPrompt: string) => unknown;
  /** Tick cadence; defaults to 60s. Injectable so a test can drive tick() directly. */
  intervalMs?: number;
  /** Same whole-tick usage-limit gate PollService/Scheduler use (a trigger fire can wake/spawn a claude
   *  session, the same capped resource) — injectable for a deterministic test. */
  isUsageLimited?: (now: Date, recencyWindowMs?: number) => boolean;
}

/** Anti-hammer / anti-loop floor: the minimum interval between two ACTUAL fires of the SAME trigger.
 *  Several allowlisted event kinds are self-retriggerable (a `spawn` on `worker_report` produces a worker
 *  that itself emits `worker_report`; a `spawn` on `idle_report`/`session_rate_limited` can cascade) — this
 *  floor, combined with advance-before-fire below, is what makes a self-feeding loop impossible: at most
 *  one fire per trigger per floor window, ever, regardless of how many matching events land in between. */
export const MIN_EVENT_TRIGGER_INTERVAL_MS = 60_000;
/** Bounds one tick's tail-scan per trigger (mirrors AttentionPushWatcher's EVENT_TAIL_LIMIT) — a
 *  long-idle watermark drains in bounded per-tick chunks rather than one unbounded read. */
const EVENT_TAIL_LIMIT = 200;
/** Cap on matched events summarized into a single fire's kickoff block (mirrors poll's MAX_ITEMS_PER_FIRE). */
const MAX_ITEMS_PER_FIRE = 20;

type EventWithSeq = OrchestrationEvent & { seq: number };

/**
 * EventTriggerService — the always-on dispatcher for local event triggers (Loom Event Triggers
 * subsystem, card f5d07121 T2). Sibling of PollService, but reacts to the INTERNAL
 * `orchestration_events` bus (via `Db.listEventsSince`'s `seq` watermark) instead of an external fetch
 * cadence. Each tick, for every ENABLED trigger: structural guards (deleted target → disable), scan new
 * events since the trigger's watermark, filter to `eventKind` (+ optional `projectId` scope, resolved via
 * the matched event's owning manager session — mirrors AttentionPushWatcher's own project-scope check),
 * and on a match either fire (subject to the anti-hammer floor) or throttle. See `tick()`'s inline doc for
 * the exact advance-before-fire ordering that makes a self-feeding loop structurally impossible.
 */
export class EventTriggerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: EventTriggerServiceDeps) {}

  /**
   * One trigger pass over every ENABLED event trigger. Per-trigger try/catch: one bad trigger (a throwing
   * resume/spawn) never blocks or disables another. See the inline comments below for the crash-safety /
   * anti-loop ordering — this is the load-bearing core of the subsystem.
   */
  async tick(now: Date = new Date()): Promise<void> {
    const due = this.deps.db.listDueEventTriggers();
    if (due.length === 0) return;
    // Pause gate (§17a global kill/pause switch, mirrors Scheduler.tick()): hold everything while
    // globally paused — every trigger's watermark stays put, fully re-scanned once the pause lifts.
    if (this.deps.control.pausedScopes().includes("global")) return;
    const recencyWindowMs = resolveConfig(undefined, this.deps.db.getPlatformConfig()).platform.rateLimit.recencyWindowMs;
    if ((this.deps.isUsageLimited ?? isLikelyNearClaudeUsageLimit)(now, recencyWindowMs)) return;

    for (const trigger of due) {
      try {
        // Structural guards: a trigger whose wake/spawn target is GONE can never fire again — disable it
        // instead of retrying forever (mirrors PollService's deleted-connection/session/agent handling).
        if (trigger.mode === "wake" && !this.deps.db.getSession(trigger.targetSessionId ?? "")) {
          this.deps.db.updateEventTrigger(trigger.id, { enabled: false });
          // eslint-disable-next-line no-console
          console.error(`[event-trigger] trigger ${trigger.id} disabled — target session ${trigger.targetSessionId} no longer exists`);
          continue;
        }
        if (trigger.mode === "spawn" && !this.deps.db.getAgent(trigger.agentId ?? "")) {
          this.deps.db.updateEventTrigger(trigger.id, { enabled: false });
          // eslint-disable-next-line no-console
          console.error(`[event-trigger] trigger ${trigger.id} disabled — target agent ${trigger.agentId} no longer exists`);
          continue;
        }

        const scanned = this.deps.db.listEventsSince(trigger.lastSeq, EVENT_TAIL_LIMIT) as EventWithSeq[];
        if (scanned.length === 0) continue;
        const lastScannedSeq = scanned[scanned.length - 1]!.seq;

        const matches = scanned.filter((e) => {
          if (e.kind !== trigger.eventKind) return false;
          if (trigger.projectId) {
            // Project scope resolves through the matched event's owning MANAGER session (mirrors
            // AttentionPushWatcher's own `db.getSession(e.managerSessionId)?.projectId` scope check — the
            // established "which project does this event belong to" precedent).
            const projectId = this.deps.db.getSession(e.managerSessionId)?.projectId;
            if (projectId !== trigger.projectId) return false;
          }
          return true;
        });

        if (matches.length === 0) {
          // Every row in `scanned` is now PERMANENTLY classified (never re-classifies differently later) —
          // advance past the whole window even though nothing matched (mirrors AttentionPushWatcher's
          // stall-fix: a long run of non-matching events must not wedge the watermark).
          this.deps.db.advanceEventTriggerSeq(trigger.id, lastScannedSeq);
          continue;
        }

        const lastFiredMs = trigger.lastFiredAt ? new Date(trigger.lastFiredAt).getTime() : null;
        const canFire = lastFiredMs === null || now.getTime() - lastFiredMs >= MIN_EVENT_TRIGGER_INTERVAL_MS;
        if (!canFire) {
          // ANTI-HAMMER / ANTI-LOOP: the floor hasn't elapsed. The matched event(s) are CONSUMED (the
          // watermark advances) WITHOUT firing — deliberately DROPPED, not queued for a later batched
          // release. Queueing would let a sustained burst/self-retriggering loop build an ever-growing
          // backlog that still eventually drains into unbounded fires once the floor clears; dropping
          // instead caps this trigger at exactly one fire per MIN_EVENT_TRIGGER_INTERVAL_MS, period,
          // regardless of how many matching events arrive.
          this.deps.db.advanceEventTriggerSeq(trigger.id, lastScannedSeq);
          this.emit("", now, "event_trigger_throttled", { eventTriggerId: trigger.id, matchedCount: matches.length });
          continue;
        }

        // ADVANCE-BEFORE-FIRE — deliberately the OPPOSITE of PollService's deliver-before-commit (poll
        // commits its cursor only AFTER a successful delivery, so a throwing resume/spawn retries the
        // same item next tick). Here the watermark AND lastFiredAt are stamped BEFORE calling fire(): a
        // crash/throw between this line and delivery DROPS that one fire but can NEVER double-fire the
        // same event. For a trust-boundary wake/spawn surface reacting to arbitrary internal lifecycle
        // events (several of them self-retriggerable), a missed fire is far safer than a duplicate or
        // looping one — this ordering is what makes the anti-loop guarantee crash-safe, not just
        // tick-to-tick-safe.
        this.deps.db.advanceEventTriggerSeq(trigger.id, lastScannedSeq, now.toISOString());
        const { sessionId } = await this.fire(trigger, matches);
        this.emit(sessionId, now, "event_trigger_fired", { eventTriggerId: trigger.id, matchedCount: matches.length, mode: trigger.mode });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[event-trigger] trigger ${trigger.id} failed:`, (e as Error).message);
      }
    }
  }

  /** Deliver one already-matched batch: wake the existing session, or spawn a fresh one. Throws (never
   *  internally swallowed) so the caller's per-trigger try/catch covers this too. */
  private async fire(trigger: EventTrigger, matches: EventWithSeq[]): Promise<{ sessionId: string }> {
    const capped = matches.slice(0, MAX_ITEMS_PER_FIRE);
    const overflow = matches.length - capped.length;
    const block = formatEventTriggerBlock(capped, trigger.eventKind, overflow);

    if (trigger.mode === "wake") {
      const sessionId = trigger.targetSessionId!;
      if (!this.deps.pty.isAlive(sessionId)) await this.deps.resume(sessionId);
      // kind:"agent" — a trigger-driven nudge is its own turn, never mashed with anything else queued.
      this.deps.pty.enqueueStdin(sessionId, block, "system", undefined, undefined, "agent");
      return { sessionId };
    }

    const session = (await this.deps.spawn(trigger.agentId!, block)) as { id: string };
    return { sessionId: session.id };
  }

  private emit(
    sessionId: string,
    now: Date,
    kind: "event_trigger_fired" | "event_trigger_throttled",
    detail: Record<string, unknown>,
  ): void {
    this.deps.db.appendEvent({ id: randomUUID(), ts: now.toISOString(), managerSessionId: sessionId, kind, detail });
  }

  /** Start ticking. Fires an immediate pass (mirrors PollService/WakeService) so a daemon restart doesn't
   *  wait a full cadence before a trigger reacts to any events it missed while down. */
  start(now: Date = new Date()): void {
    void this.tick(now).catch(() => { /* never let a bad tick kill the loop */ });
    this.timer = setInterval(() => { void this.tick().catch(() => { /* never let a bad tick kill the loop */ }); }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
