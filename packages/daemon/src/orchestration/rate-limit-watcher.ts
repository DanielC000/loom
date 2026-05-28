import type { Db } from "../db.js";
import { clearClaudeRateLimit } from "./usage-awareness.js";

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests with a stub). */
export interface RateLimitPty {
  isAlive(sessionId: string): boolean;
  /** Re-submit the turn the cap killed; false if the session isn't live (don't resume). */
  resumeAfterRateLimit(sessionId: string): boolean;
}

export interface RateLimitWatcherDeps {
  db: Db;
  pty: RateLimitPty;
  /** Tick cadence; defaults to 60s. Injectable so a test can drive tick() directly. */
  intervalMs?: number;
}

/**
 * Usage-limit RESUME watcher (phase-2 §19c-b) — the recovery half of usage-limit survival. ALWAYS
 * ON (recovery ≠ autonomy: a manually-started session can hit the Max 5h cap too), so it runs
 * unconditionally, separate from the opt-in cron Scheduler.
 *
 * Each tick walks the LIVE sessions in an active rate-limit episode (deadline armed) and drives the
 * state machine — a tick-based port of Jinn's in-process wait→retry→still-limited→deadline loop:
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
        if (new Date(s.rateLimitedUntil).getTime() <= now.getTime()) this.resume(s.id);
        // else: still before the reset — keep waiting.
      } else {
        // Recovering: we already re-submitted; awaiting the turn's outcome.
        if (!s.busy) this.succeed(s.id);          // completed without re-capping → episode over
        else if (deadlinePassed) this.bail(s.id, s.rateLimitDeadline!); // hung past the deadline
      }
    }
  }

  private resume(id: string): void {
    // Clear the park but KEEP the deadline (the episode continues until success/bail). lastError is
    // cleared (we're actively resuming, not waiting). Relax global awareness so the queue proceeds.
    this.deps.db.setRateLimitedUntil(id, null, null);
    clearClaudeRateLimit();
    this.deps.pty.resumeAfterRateLimit(id);
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
