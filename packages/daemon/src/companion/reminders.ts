/**
 * Loom Companion — the RECURRING reminders watcher (Companion Memory & Reminders Design, Surface 2 s3).
 *
 * Generalizes `CompanionHeartbeatWatcher` (ONE cadence+prompt) into N independently-cadenced,
 * independently-routed named cron jobs — the `companion_reminders` table rows. Deliberately a SIBLING
 * watcher, not an extension of CompanionHeartbeatWatcher: the heartbeat's shape (one cadence/prompt
 * pinned on its own CompanionConfig, armed/disarmed as a single unit by the controller's cfg diff) does
 * not generalize cleanly to a per-row table with its own enable flag and independent cron cadence per
 * row — trying to fold both into one class would conflate two different arm/disarm lifecycles. Instead
 * this watcher REUSES the heartbeat's disciplines verbatim (live-only, rate-limit-park defer-once,
 * no-stacking, restart-seed, route-carry) generalized to iterate the reminder set each tick, and reuses
 * the SAME `HeartbeatPty` pty-slice shape (identical to what it needs) rather than duplicating it.
 *
 * Cron due-ness reuses `orchestration/cron.ts`'s `nextFireAt` (the SAME validation + next-fire math the
 * Scheduler uses for `schedules`) — never hand-rolled. Unlike the Scheduler it does NOT spawn a fresh
 * session; a reminder always fires into its OWN existing companion session via `enqueueStdin`.
 *
 * DEFAULT-OFF: with zero `companion_reminders` rows for a session, every tick is a no-op — byte-identical
 * to a world where this watcher was never armed.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { HeartbeatPty } from "./heartbeat.js";
import { nextFireAt } from "../orchestration/cron.js";
import type { CompanionReminder } from "./types.js";

/** The trusted-daemon framing tag — shared with the one-shot route-aware `wake_me` reminder framing
 *  (orchestration/wake.ts `framedReminder`), so every daemon-driven reminder turn — one-shot or
 *  recurring — reads identically to the agent. Also the prefix the no-stacking guard matches on. */
export const REMINDER_TAG = "[loom:reminder]";

/** Per-reminder marker embedded right after REMINDER_TAG (`"${REMINDER_TAG}:${id}"`) — lets the
 *  no-stacking guard test THIS reminder's own pending entry when N reminders coexist in the same FIFO,
 *  while every fired turn still starts with the exact shared REMINDER_TAG prefix. */
export function reminderMarker(id: string): string {
  return `${REMINDER_TAG}:${id}`;
}

/** Frame a reminder's prompt as a clearly-marked, per-reminder-unique reminder turn. */
export function framedReminder(reminder: Pick<CompanionReminder, "id" | "prompt">): string {
  return `${reminderMarker(reminder.id)} ${reminder.prompt}`;
}

/**
 * A reminder's next scheduled fire time (ISO), for DISPLAY (the reminder_create/reminder_list MCP tools —
 * s4's concern), mirroring the watcher's OWN due-ness anchor: strictly after its most recent durable
 * `companion_reminder_fired` event, or its `createdAt` when it has never fired (the SAME anchor isDue
 * uses, scanned from the durable event log the same way seedLastFired does on restart). Returns null on an
 * invalid cron — defensive; reminder_create validates at the boundary so this should never be reached from
 * a row this engine created.
 */
export function reminderNextFireAt(db: Db, reminder: Pick<CompanionReminder, "id" | "sessionId" | "cron" | "createdAt">): string | null {
  let from = new Date(reminder.createdAt);
  for (const e of db.listEvents(reminder.sessionId)) {
    if (e.kind !== "companion_reminder_fired") continue;
    if ((e.detail as { reminderId?: string } | undefined)?.reminderId !== reminder.id) continue;
    const ms = new Date(e.ts).getTime();
    if (!Number.isNaN(ms) && ms > from.getTime()) from = new Date(ms);
  }
  try {
    return nextFireAt(reminder.cron, from);
  } catch {
    return null;
  }
}

export interface ReminderWatcherDeps {
  db: Db;
  pty: HeartbeatPty;
  /** The bound companion session id every reminder in scope targets (an EXISTING long-lived session). */
  sessionId: string;
  /** Watcher tick cadence in ms; defaults to 60s (mirrors the other per-tick watchers). */
  tickMs?: number;
}

export class CompanionReminderWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Epoch ms of each reminder's last ACTUAL fire, by reminder id; absent until its first fire (or a
   *  durable seed on start()). */
  private lastFiredAt = new Map<string, number>();
  /** Per-reminder defer-once-per-streak tracking — see HEARTBEAT's `deferredSinceLastFire` for the
   *  bounded-log-growth rationale; generalized to a Set keyed by reminder id. */
  private deferredSinceLastFire = new Set<string>();

  constructor(private deps: ReminderWatcherDeps) {}

  /**
   * One trigger pass over every enabled reminder for this session. Per-reminder conservative order:
   * cadence gate → live → not parked → not stacking → fire. A non-fire path never advances that
   * reminder's lastFiredAt, so its own cadence simply retries on a later due tick. Never throws (the
   * interval swallows anyway).
   */
  tick(now: Date = new Date()): void {
    const session = this.deps.db.getSession(this.deps.sessionId);
    if (!session) return; // the companion session row is gone — nothing to remind.

    const reminders = this.deps.db.listEnabledCompanionReminders(this.deps.sessionId);
    if (reminders.length === 0) return; // DEFAULT-OFF fast path — no db.getPending call even needed.

    // Not live → SKIP every due reminder this tick (do NOT resume a stopped companion just to remind).
    // Session-wide, checked once (mirrors the heartbeat's single-cadence not-live branch).
    const live = this.deps.pty.isAlive(this.deps.sessionId);
    const pending = live ? this.deps.pty.getPending(this.deps.sessionId) : [];

    for (const reminder of reminders) {
      if (!this.isDue(reminder, now)) continue;
      if (!live) continue; // retry next due tick, no event (matches heartbeat: a plain skip, not a defer).

      // Rate-limit PARKED → DEFER (respect the park; don't enqueue → no spam). Retry next due tick.
      if (session.rateLimitedUntil != null) {
        this.deferOnce(reminder.id, now, { reason: "rate-limited", until: session.rateLimitedUntil });
        continue;
      }
      // No-stacking: a prior unconsumed turn for THIS SAME reminder → don't stack a second. Matched WITH
      // the trailing space `framedReminder` always emits after the marker (never a bare `reminderMarker`
      // prefix) so this stays collision-proof once ids can be lexical prefixes of one another (e.g. id "1"
      // vs id "10": "[loom:reminder]:10 …" does NOT start with "[loom:reminder]:1 ", only with the
      // unterminated "[loom:reminder]:1").
      if (pending.some((t) => t.startsWith(`${reminderMarker(reminder.id)} `))) {
        this.deferOnce(reminder.id, now, { reason: "pending" });
        continue;
      }

      this.fire(reminder, now);
    }
  }

  /**
   * Arm the interval. Seeds every reminder's lastFiredAt from its most recent durable
   * `companion_reminder_fired` event so a daemon restart does not re-fire immediately (conservative
   * across restarts) — the multi-reminder generalization of the heartbeat's seedLastFired.
   */
  start(): void {
    this.seedLastFired();
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.tickMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // ---- internals -------------------------------------------------------------------------------

  /** Due iff the next cron boundary strictly after this reminder's last fire (or its creation, when it
   *  has never fired) is at/before `now`. An invalid cron (should never happen — create-time validation
   *  is s4's concern) defensively never fires rather than throwing out of the tick. */
  private isDue(reminder: CompanionReminder, now: Date): boolean {
    const last = this.lastFiredAt.get(reminder.id);
    const from = last != null ? new Date(last) : new Date(reminder.createdAt);
    try {
      return new Date(nextFireAt(reminder.cron, from)).getTime() <= now.getTime();
    } catch {
      return false;
    }
  }

  /** Fire ONE framed proactive turn, CARRYING the reminder's own route (or none — a reminder created
   *  with no route then has nowhere to chat_reply, same as an unconfigured heartbeat home). Records
   *  lastFiredAt + emits the durable event; a real fire ends that reminder's current defer streak. */
  private fire(reminder: CompanionReminder, now: Date): void {
    // kind:"agent" — a user-authored recurring reminder prompt; must land as its own turn.
    this.deps.pty.enqueueStdin(this.deps.sessionId, framedReminder(reminder), "system", undefined, reminder.route ?? undefined, "agent");
    this.lastFiredAt.set(reminder.id, now.getTime());
    this.deferredSinceLastFire.delete(reminder.id);
    this.emit(reminder.id, now, "companion_reminder_fired", { cron: reminder.cron, label: reminder.label });
  }

  /** Seed lastFiredAt for every reminder id seen in the durable fired-event log (so the cadence survives
   *  a daemon restart). listEvents is chronological, so the LAST write per id wins (the latest fire). */
  private seedLastFired(): void {
    for (const e of this.deps.db.listEvents(this.deps.sessionId)) {
      if (e.kind !== "companion_reminder_fired") continue;
      const reminderId = (e.detail as { reminderId?: string } | undefined)?.reminderId;
      if (!reminderId) continue;
      const ms = new Date(e.ts).getTime();
      if (!Number.isNaN(ms)) this.lastFiredAt.set(reminderId, ms);
    }
  }

  /** Emit a `companion_reminder_deferred` event AT MOST ONCE per defer streak, per reminder (bounded log
   *  growth — see the heartbeat's `deferredSinceLastFire` doc for the rationale this mirrors). */
  private deferOnce(reminderId: string, now: Date, detail: Record<string, unknown>): void {
    if (this.deferredSinceLastFire.has(reminderId)) return;
    this.deferredSinceLastFire.add(reminderId);
    this.emit(reminderId, now, "companion_reminder_deferred", detail);
  }

  private emit(reminderId: string, now: Date, kind: "companion_reminder_fired" | "companion_reminder_deferred", detail: Record<string, unknown>): void {
    this.deps.db.appendEvent({
      id: randomUUID(), ts: now.toISOString(),
      managerSessionId: this.deps.sessionId, kind, detail: { reminderId, ...detail },
    });
  }
}
