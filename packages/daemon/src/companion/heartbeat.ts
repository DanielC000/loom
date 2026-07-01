/**
 * Loom Companion — the proactive HEARTBEAT watcher (card 9488951e).
 *
 * A small, daemon-owned per-tick watcher (mirroring orchestration/idle-watcher.ts, rate-limit-watcher.ts,
 * busy-worker-watcher.ts) that periodically WAKES the EXISTING long-lived companion session to run a
 * proactive turn and — only if there's something worth saying — `chat_reply` the HOME channel. It reuses
 * the SAME primitives the WakeService demonstrates: `pty.enqueueStdin` for the turn injection + the
 * rate-limit-park DEFER discipline (never spam a parked session). It does NOT touch the shared Scheduler
 * (which spawns FRESH sessions) or the one-shot WakeService.
 *
 * DEFAULT-OFF: index.ts only arms this when a companion is configured AND a positive cadence is set
 * (`heartbeatIntervalMinutes > 0`). With no cadence configured, no watcher exists and every path is
 * byte-identical.
 *
 * Conservative by construction:
 *   - cadence-gated (a heartbeat fires at most once per `intervalMinutes`; `lastFiredAt` only advances
 *     on an actual fire, so a skipped cycle retries on the next due tick, not a wasted advance);
 *   - never resumes a STOPPED companion just to heartbeat (a non-live session is skipped, retried later);
 *   - DEFERS while the session is rate-limit parked (respects the park; the held cadence retries at reset);
 *   - never STACKS heartbeats (a prior `[loom:heartbeat]` turn still queued/unconsumed suppresses a second).
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";

/** The trusted-daemon framing tag — also the marker the no-stacking guard matches in the pending queue. */
export const HEARTBEAT_TAG = "[loom:heartbeat]";

/** Frame the (trusted) proactive prompt as a clearly-marked heartbeat turn, distinct from untrusted chat. */
export function framedHeartbeat(prompt: string): string {
  return `${HEARTBEAT_TAG} ${prompt}`;
}

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests claude-free). The
 *  enqueueStdin signature MIRRORS PtyHost.enqueueStdin (source/onDeliver/route optional) so the real pty is
 *  assignable directly; the watcher only uses the leading args + the trailing `route` (the HOME route it
 *  pins on the proactive turn, so its chat_reply flows out on the home channel via the per-turn-route path). */
export interface HeartbeatPty {
  isAlive(sessionId: string): boolean;
  /** Submit text as a turn if the session is idle, else queue it FIFO (drains on the next Stop). */
  enqueueStdin(
    sessionId: string,
    text: string,
    source?: "human" | "system",
    onDeliver?: () => void,
    route?: { channel: string; chatId: string },
  ): { delivered: boolean; position?: number };
  /** The session's queued message texts (FIFO) — the no-stacking guard checks for an unconsumed heartbeat. */
  getPending(sessionId: string): string[];
}

export interface HeartbeatWatcherDeps {
  db: Db;
  pty: HeartbeatPty;
  /** The bound companion session id — an EXISTING long-lived session (never spawned/resumed by this watcher). */
  sessionId: string;
  /** Cadence in minutes; MUST be > 0 to arm (index.ts gates this — a 0 never constructs the watcher). */
  intervalMinutes: number;
  /** The framed proactive prompt text (already resolved from config; default in DEFAULT_HEARTBEAT_PROMPT). */
  prompt: string;
  /** Watcher tick cadence in ms; defaults to 60s (mirrors the other per-tick watchers). */
  tickMs?: number;
}

export class CompanionHeartbeatWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Epoch ms of the last ACTUAL fire; null until the first fire (or a durable seed on start()). */
  private lastFiredAt: number | null = null;
  /**
   * Have we already emitted a `companion_heartbeat_deferred` event for the CURRENT defer streak? Since
   * lastFiredAt is (correctly) NOT advanced on a defer, the cadence gate stays open and EVERY tick re-enters
   * a defer branch — so without this the event log would grow ~1 row/tick INDEFINITELY on a wedged pending
   * or long park. We emit AT MOST ONCE per streak (the first defer since the last real fire; its reason is
   * representative) and stay silent thereafter — matching wake.ts's silent-defer discipline. Set on emit,
   * CLEARED on a real fire (which re-arms the next streak's one emit).
   */
  private deferredSinceLastFire = false;

  constructor(private deps: HeartbeatWatcherDeps) {}

  /**
   * One trigger pass. Conservative order: cadence gate → session exists → live → not parked → not stacking
   * → fire. Every non-fire path leaves `lastFiredAt` untouched so the cadence simply retries on a later
   * due tick. Never throws (the interval swallows anyway).
   */
  tick(now: Date = new Date()): void {
    const intervalMs = this.deps.intervalMinutes * 60_000;
    if (intervalMs <= 0) return; // OFF (defensive — index.ts never arms a 0-cadence watcher).

    // Cadence gate: not yet due → no-op (this is ALSO the primary no-stacking guard for the common case).
    if (this.lastFiredAt != null && this.lastFiredAt + intervalMs > now.getTime()) return;

    const session = this.deps.db.getSession(this.deps.sessionId);
    if (!session) return; // the companion session row is gone — nothing to heartbeat.

    // Not live → SKIP (do NOT resume a stopped companion just to heartbeat). Retry next due tick.
    if (!this.deps.pty.isAlive(this.deps.sessionId)) return;

    // Rate-limit PARKED → DEFER (respect the park; don't enqueue → no spam). Retry next due tick.
    if (session.rateLimitedUntil != null) {
      this.deferOnce(now, { reason: "rate-limited", until: session.rateLimitedUntil });
      return;
    }

    // No-stacking: a prior heartbeat still queued/unconsumed (busy session) → don't stack a second.
    if (this.deps.pty.getPending(this.deps.sessionId).some((t) => t.startsWith(HEARTBEAT_TAG))) {
      this.deferOnce(now, { reason: "pending" });
      return;
    }

    // Fire: enqueue ONE framed proactive turn, CARRYING the configured HOME route so the turn's chat_reply
    // delivers to the home channel via the per-turn-route path (multi-channel routing). No home configured ⇒
    // no route ⇒ a proactive reply has nowhere to go (chat_reply → no-target), which is correct. If the
    // session is busy, enqueueStdin queues it FIFO (the no-stacking guard above ensures at most one pending).
    // Record lastFiredAt + emit the durable event. A real fire ends the current defer streak.
    const home = this.deps.db.getCompanionHome();
    this.deps.pty.enqueueStdin(this.deps.sessionId, framedHeartbeat(this.deps.prompt), "system", undefined, home ?? undefined);
    this.lastFiredAt = now.getTime();
    this.deferredSinceLastFire = false;
    this.emit(now, "companion_heartbeat_fired", { intervalMinutes: this.deps.intervalMinutes });
  }

  /**
   * Arm the interval. Seeds `lastFiredAt` from the most recent DURABLE `companion_heartbeat_fired` event so
   * a daemon restart does NOT re-fire immediately (conservative across restarts). A brand-new companion with
   * no prior fire fires on its first due tick. No immediate tick (unlike WakeService, there is no past-due
   * one-shot to reconcile) — the periodic cadence owns firing.
   */
  start(now: Date = new Date()): void {
    this.seedLastFired();
    void now; // (signature parity with the watcher family; seeding uses the durable event, not `now`)
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.tickMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Seed lastFiredAt from the last durable fired event (so the cadence survives a daemon restart). */
  private seedLastFired(): void {
    const fired = this.deps.db.listEvents(this.deps.sessionId).filter((e) => e.kind === "companion_heartbeat_fired");
    const last = fired[fired.length - 1]; // listEvents is chronological (ts, rowid)
    if (last) {
      const ms = new Date(last.ts).getTime();
      if (!Number.isNaN(ms)) this.lastFiredAt = ms;
    }
  }

  /** Emit a `companion_heartbeat_deferred` event AT MOST ONCE per defer streak (bounded log growth — see
   *  the deferredSinceLastFire doc). The first defer since the last fire records its reason; later ticks of
   *  the same streak stay silent (but still don't fire, and don't advance lastFiredAt → the retry is intact). */
  private deferOnce(now: Date, detail: Record<string, unknown>): void {
    if (this.deferredSinceLastFire) return; // already emitted for this streak — stay silent
    this.deferredSinceLastFire = true;
    this.emit(now, "companion_heartbeat_deferred", detail);
  }

  private emit(now: Date, kind: "companion_heartbeat_fired" | "companion_heartbeat_deferred", detail: Record<string, unknown>): void {
    this.deps.db.appendEvent({
      id: randomUUID(), ts: now.toISOString(),
      managerSessionId: this.deps.sessionId, kind, detail,
    });
  }
}
