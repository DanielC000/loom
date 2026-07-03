import { randomUUID } from "node:crypto";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import type { CompanionRoute, Wake } from "@loom/shared";
import { isLikelyNearClaudeUsageLimit } from "./usage-awareness.js";

/** The slice of PtyHost the WakeService needs (injectable so the tick logic unit-tests claude-free). */
export interface WakePty {
  isAlive(sessionId: string): boolean;
  /**
   * Submit text as a turn if the session is idle, else queue it FIFO (drains on the next Stop). The
   * trailing `source`/`onDeliver`/`route`/`kind` mirror PtyHost.enqueueStdin (and HeartbeatPty) so the
   * real pty is assignable directly; a plain 2-arg call (every existing non-companion caller) is
   * byte-identical to before this route-aware fire path existed.
   */
  enqueueStdin(
    sessionId: string,
    text: string,
    source?: "human" | "system",
    onDeliver?: () => void,
    route?: CompanionRoute,
    kind?: "warning" | "agent",
  ): { delivered: boolean; position?: number };
  /**
   * The session's IN-FLIGHT turn's originating companion route, or null when the current turn wasn't
   * formed from a companion inbound / proactive-home submit (mirrors PtyHost.getActiveTurnOrigin).
   * Read at SCHEDULE time (not fire time) and persisted onto the Wake row, so a companion-origin
   * `wake_me` can fire its reminder back through the SAME chat route later, even after the turn that
   * scheduled it has long since ended.
   */
  getActiveTurnOrigin(sessionId: string): CompanionRoute | null;
}

export interface WakeServiceDeps {
  db: Db;
  pty: WakePty;
  /**
   * Re-spawn a stopped-but-resumable session so a fired wake can be delivered to it (auto-resume).
   * Prod-wired to SessionService.resume; throws if the session is unresumable (dead transcript) —
   * the tick treats that as "drop the wake". The test injects a recording stub (keeps this claude-free).
   */
  resume: (sessionId: string) => unknown;
  /** Tick cadence; defaults to 60s. Injectable so a test can drive tick() directly. */
  intervalMs?: number;
  /**
   * "Is the account near its Claude usage limit?" — defaults to the global awareness record. A wake
   * that needs an auto-RESUME is deferred while limited (don't re-spawn into a known cap); a wake to
   * an already-live session fires regardless (it's a self-continuation, not new work). Injectable so
   * a test drives the gate deterministically. The optional 2nd arg is the resolved recency window (ms);
   * a test stub may ignore it.
   */
  isUsageLimited?: (now: Date, recencyWindowMs?: number) => boolean;
}

/** Min delay floor (anti busy-poll: a wake is a WAIT primitive, not a poll loop). */
const MIN_DELAY_SECONDS = 30;
/** Max horizon — beyond this use a cron Schedule, not a one-shot wake. */
const MAX_DELAY_SECONDS = 24 * 60 * 60;
/** Per-session pending-wake cap (runaway guard). */
const MAX_PENDING_PER_SESSION = 10;

export interface ScheduleWakeInput {
  delaySeconds?: number;
  wakeAt?: string;
  note: string;
}

/**
 * WakeService — the one-shot self-scheduled wake-up primitive behind the `wake_me` MCP tool. Owns
 * BOTH the scheduling API (called by the task MCP router) and the trigger ticker. Mirrors the
 * RateLimitWatcher ticker shape + the Scheduler's claim-before-act / missed-fire reconcile.
 *
 * On fire a wake re-submits its `note` as a fresh turn to the session via the existing enqueueStdin
 * nudge channel (busy-gated FIFO — a wake that lands mid-turn just queues). If the target session is
 * not live, it is AUTO-RESUMED first (a stopped session brings itself back). One-shot: a fired wake
 * is deleted (unlike a recurring Schedule).
 */
export class WakeService {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: WakeServiceDeps) {}

  /**
   * Schedule a one-shot wake. Validates: exactly one of delaySeconds/wakeAt; a non-empty note; the
   * [floor, horizon] window; the per-session cap. Throws (surfaced as `{ error }` by the MCP tool)
   * on any violation — no row is written. Returns the new wake's id + resolved fire instant.
   */
  schedule(sessionId: string, input: ScheduleWakeInput, now: Date = new Date()): { wakeId: string; wakeAt: string } {
    if (!this.deps.db.getSession(sessionId)) throw new Error("session not found");
    const note = (input.note ?? "").trim();
    if (!note) throw new Error("note is required (it's the message you'll be re-prompted with on wake)");

    const hasDelay = input.delaySeconds !== undefined;
    const hasAt = input.wakeAt !== undefined;
    if (hasDelay === hasAt) throw new Error("provide exactly one of delaySeconds or wakeAt");

    let wakeAtMs: number;
    if (hasDelay) {
      const d = input.delaySeconds!;
      if (!Number.isFinite(d)) throw new Error("delaySeconds must be a number");
      wakeAtMs = now.getTime() + d * 1000;
    } else {
      wakeAtMs = new Date(input.wakeAt!).getTime();
      if (Number.isNaN(wakeAtMs)) throw new Error("wakeAt must be a valid ISO timestamp");
    }

    const deltaSec = (wakeAtMs - now.getTime()) / 1000;
    if (deltaSec < MIN_DELAY_SECONDS) throw new Error(`wake must be at least ${MIN_DELAY_SECONDS}s out (use it to wait, not to poll)`);
    if (deltaSec > MAX_DELAY_SECONDS) throw new Error(`wake must be within ${MAX_DELAY_SECONDS}s (~24h); for longer cadences use a schedule`);
    if (this.deps.db.countPendingWakes(sessionId) >= MAX_PENDING_PER_SESSION) {
      throw new Error(`too many pending wakes (max ${MAX_PENDING_PER_SESSION}); cancel one first`);
    }

    // SERVER-DERIVED route capture: read the CURRENT turn's originating companion route (if any) at
    // schedule time — never from agent input (the wake_me tool has no route param) — so a companion
    // session's wake_me fires back to the SAME chat later, even after this turn has ended.
    const route = this.deps.pty.getActiveTurnOrigin(sessionId) ?? undefined;
    const wake: Wake = {
      id: randomUUID(), sessionId,
      wakeAt: new Date(wakeAtMs).toISOString(), note,
      createdAt: now.toISOString(),
      ...(route ? { route } : {}),
    };
    this.deps.db.insertWake(wake);
    this.deps.db.appendEvent({
      id: randomUUID(), ts: now.toISOString(),
      managerSessionId: sessionId, kind: "wake_scheduled",
      detail: { wakeId: wake.id, wakeAt: wake.wakeAt },
    });
    return { wakeId: wake.id, wakeAt: wake.wakeAt };
  }

  /** Cancel one of THIS session's wakes (scoped: a session can only touch its own). */
  cancel(sessionId: string, wakeId: string): { cancelled: boolean } {
    const w = this.deps.db.getWake(wakeId);
    if (!w || w.sessionId !== sessionId) return { cancelled: false };
    this.deps.db.deleteWake(wakeId);
    return { cancelled: true };
  }

  /** This session's pending wakes. */
  list(sessionId: string): Wake[] {
    return this.deps.db.listWakesForSession(sessionId);
  }

  /**
   * One trigger pass: deliver every due wake. CLAIM-FIRST (delete before any side effect, per the
   * Scheduler's finding-2) so a throwing delivery can't re-fire the same wake next tick.
   *   - live           → enqueue the nudge.
   *   - not live + usage-limited → DEFER (re-insert; don't auto-resume into a known cap).
   *   - not live + ok  → auto-resume, then enqueue.
   *   - unresumable (resume throws) → drop (wake_dropped event).
   */
  async tick(now: Date = new Date()): Promise<void> {
    const due = this.deps.db.listDueWakes(now.toISOString());
    if (due.length === 0) return;
    // Recency window = daemon-global `platform.rateLimit.recencyWindowMs`, resolved LIVE (a test stub
    // ignores the extra arg).
    const recencyWindowMs = resolveConfig(undefined, this.deps.db.getPlatformConfig()).platform.rateLimit.recencyWindowMs;
    const usageLimited = (this.deps.isUsageLimited ?? isLikelyNearClaudeUsageLimit)(now, recencyWindowMs);

    for (const w of due) {
      this.deps.db.deleteWake(w.id); // claim the slot first
      try {
        if (!this.deps.pty.isAlive(w.sessionId)) {
          if (usageLimited) { this.deps.db.insertWake(w); continue; } // defer — don't resume into a cap
          await this.deps.resume(w.sessionId); // throws if unresumable → caught below → dropped
        }
        // Route-aware fire: a companion-origin wake (route captured at schedule time) delivers a
        // [loom:reminder] turn through the SAME per-turn route path the heartbeat uses — carrying the
        // route into enqueueStdin so a later chat_reply resolves back to this exact chat. Every OTHER
        // wake (route undefined — the overwhelming majority) takes the EXACT plain enqueueStdin call
        // that ran before this feature existed: byte-identical.
        // kind:"agent" — a scheduled wake-up carries the agent's own arbitrary, specific note-to-self
        // (or, when routed, a companion reminder); it must land as its own turn, never mashed with
        // anything else queued behind it.
        if (w.route) {
          this.deps.pty.enqueueStdin(w.sessionId, framedReminder(w), "system", undefined, w.route, "agent");
        } else {
          this.deps.pty.enqueueStdin(w.sessionId, framedNote(w), "system", undefined, undefined, "agent");
        }
        this.deps.db.appendEvent({
          id: randomUUID(), ts: now.toISOString(),
          managerSessionId: w.sessionId, kind: "wake_fired",
          detail: { wakeId: w.id, wakeAt: w.wakeAt },
        });
      } catch (e) {
        // Unresumable / delivery failed — the session is gone. Drop the wake (already claimed) + record.
        this.deps.db.appendEvent({
          id: randomUUID(), ts: now.toISOString(),
          managerSessionId: w.sessionId, kind: "wake_dropped",
          detail: { wakeId: w.id, wakeAt: w.wakeAt, reason: (e as Error).message },
        });
      }
    }
  }

  /** Start ticking. A wake whose wake_at is already in the past (daemon was down across it) fires on
   *  this first tick — deliver late, not never (one-shot, so no catch-up flood). */
  start(now: Date = new Date()): void {
    void this.tick(now);
    this.timer = setInterval(() => { void this.tick().catch(() => { /* never let a bad tick kill the loop */ }); }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

function framedNote(w: Wake): string {
  return `[loom:wake] Your scheduled wake-up (set ${w.createdAt}) fired. Your note: "${w.note}". If you were waiting on a process or condition, check it now.`;
}

/** Companion-route variant of framedNote — distinctly tagged so a wake fired back into a chat route
 *  reads as a reminder-to-continue-the-conversation, not a bare internal nudge. */
function framedReminder(w: Wake): string {
  return `[loom:reminder] Your scheduled wake-up (set ${w.createdAt}) fired. Your note: "${w.note}". If you were waiting on a process or condition, check it now.`;
}
