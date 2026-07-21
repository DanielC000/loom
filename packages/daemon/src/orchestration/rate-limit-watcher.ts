import type { Db } from "../db.js";
import type { Session } from "@loom/shared";
import { clearClaudeRateLimit } from "./usage-awareness.js";

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests with a stub). */
export interface RateLimitPty {
  isAlive(sessionId: string): boolean;
  /** Re-submit the turn the cap killed; false if the session isn't live (don't resume). */
  resumeAfterRateLimit(sessionId: string): boolean;
}

/** The slice of SessionService the watcher needs (card 902d089f) — injectable so the tick logic
 *  unit-tests claude-free without a real SessionService. */
export interface RateLimitCapQueue {
  /** Fire-and-forget, idempotent + suppression-aware (never throws) — see SessionService.maybeDrainCapQueue. */
  maybeDrainCapQueue(managerSessionId: string): void;
}

export interface RateLimitWatcherDeps {
  db: Db;
  pty: RateLimitPty;
  /**
   * card 902d089f: once a resumed session's usage-limit park clears, drain ITS OWN cap-queue if it's a
   * manager — closes the gap where an entry `maybeDrainCapQueue` requeued on a `UsageLimitError` (the
   * manager parked on the SAME cap this watcher clears) would otherwise sit idle until an UNRELATED
   * worker happened to exit. Optional so an existing stub-pty test that doesn't care about the
   * cap-queue stays byte-identical.
   */
  capQueue?: RateLimitCapQueue;
  /** Tick cadence; defaults to 60s. Injectable so a test can drive tick() directly. */
  intervalMs?: number;
}

/**
 * Usage-limit RESUME watcher (phase-2 §19c-b) — the recovery half of usage-limit survival. ALWAYS
 * ON (recovery ≠ autonomy: a manually-started session can hit the Max 5h cap too), so it runs
 * unconditionally, separate from the opt-in cron Scheduler.
 *
 * Each tick walks the LIVE sessions in an active rate-limit episode (deadline armed) and drives the
 * state machine — a tick-based port of the predecessor's in-process wait→retry→still-limited→deadline loop:
 *   - parked & the reset has passed  → RESUME: clear the park (keep the deadline — episode continues),
 *       relax global awareness, re-submit the held turn (re-arms busy; the pending queue drains).
 *   - parked & past the deadline     → BAIL: abandon auto-resume, mark errored (lastError), clear.
 *   - recovering (resume fired) & idle → SUCCESS: the resumed turn completed without re-capping →
 *       end the episode (clear the deadline). [A re-cap would have re-set the park via the §19c-a
 *       detect path, putting it back in the parked branch.]
 *   - recovering & past the deadline → BAIL (a hung resume).
 * A session that was stopped/killed/exited is NOT live → excluded by the query → never resumed.
 */
export class RateLimitWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: RateLimitWatcherDeps) {}

  tick(now: Date = new Date()): void {
    for (const s of this.deps.db.listRateLimitEpisodes()) {
      // The DB 'live' flag can lag a just-dead pty by a tick; double-check before acting.
      if (!this.deps.pty.isAlive(s.id)) continue;
      const deadlinePassed = !!s.rateLimitDeadline && new Date(s.rateLimitDeadline).getTime() <= now.getTime();

      if (s.rateLimitedUntil != null) {
        // Parked: waiting for the reset.
        if (deadlinePassed) { this.bail(s.id, s.rateLimitDeadline!); continue; }
        if (new Date(s.rateLimitedUntil).getTime() <= now.getTime()) this.resume(s);
        // else: still before the reset — keep waiting.
      } else {
        // Recovering: we already re-submitted; awaiting the turn's outcome.
        if (!s.busy) this.succeed(s.id);          // completed without re-capping → episode over
        else if (deadlinePassed) this.bail(s.id, s.rateLimitDeadline!); // hung past the deadline
      }
    }
  }

  private resume(s: Session): void {
    // Clear the park but KEEP the deadline (the episode continues until success/bail). lastError is
    // cleared (we're actively resuming, not waiting). Relax global awareness so the queue proceeds.
    this.deps.db.setRateLimitedUntil(s.id, null, null);
    clearClaudeRateLimit();
    this.deps.pty.resumeAfterRateLimit(s.id);
    // card 902d089f: this resume is a genuine limit-clear for s itself — if s is a MANAGER, its own
    // cap-queue may hold an entry that maybeDrainCapQueue requeued on the very UsageLimitError this
    // park came from (worker_spawn parks its own manager on the same usage-limit machinery this watcher
    // resumes). Fire-and-forget + idempotent, exactly like every other maybeDrainCapQueue call site.
    if (s.role === "manager") void this.deps.capQueue?.maybeDrainCapQueue(s.id);
  }

  private succeed(id: string): void {
    this.deps.db.clearRateLimitDeadline(id); // episode resolved — stop tracking it
  }

  private bail(id: string, deadline: string): void {
    this.deps.db.setRateLimitedUntil(id, null, `usage limit not cleared by ${deadline} — auto-resume abandoned`);
    this.deps.db.clearRateLimitDeadline(id);
  }

  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
