import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { Session } from "@loom/shared";
import { clearClaudeRateLimit } from "./usage-awareness.js";
import { bailRateLimitEpisode, type RateLimitBailPty } from "./rate-limit-bail.js";

/** The slice of PtyHost the watcher needs (injectable so the tick logic unit-tests with a stub). */
export interface RateLimitPty extends RateLimitBailPty {
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
    // Card dfef375f item 1 (watcher-side diagnostic): redaction-safe — session id + the reset instant
    // only, never any message text.
    // eslint-disable-next-line no-console
    console.log(`[rate-limit-watcher] ${s.id} resume reset=${s.rateLimitedUntil}`);
    clearClaudeRateLimit();
    this.deps.pty.resumeAfterRateLimit(s.id);
    // card 33d5aef1: durable twins of the transition above — the resume-at column that just carried this
    // information is about to be nulled by a re-cap or the eventual succeed/bail, so record it now.
    const now = new Date().toISOString();
    // Card dfef375f round 2 item 2: stamp the ACTUAL resume instant — stepLoopBreaker's own "quick
    // re-cap" streak reads this to decide whether the NEXT cap (if any) landed suspiciously soon after.
    this.deps.db.recordRateLimitResume(s.id, now);
    this.deps.db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: s.id, kind: "rate_limit_resumed" });
    this.deps.db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: s.id, kind: "usage_latch_cleared", detail: { actor: "watcher" } });
    // card 902d089f: this resume is a genuine limit-clear for s itself — if s is a MANAGER, its own
    // cap-queue may hold an entry that maybeDrainCapQueue requeued on the very UsageLimitError this
    // park came from (worker_spawn parks its own manager on the same usage-limit machinery this watcher
    // resumes). Fire-and-forget + idempotent, exactly like every other maybeDrainCapQueue call site.
    if (s.role === "manager") void this.deps.capQueue?.maybeDrainCapQueue(s.id);
  }

  private succeed(id: string): void {
    this.deps.db.clearRateLimitDeadline(id); // episode resolved — stop tracking it
    // Card dfef375f item 3: a resolved episode must not leave a stale, already-elevated re-cap count
    // for the NEXT, unrelated episode to inherit.
    this.deps.db.clearRateLimitLoopBreakerState(id);
    this.deps.db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(), managerSessionId: id,
      kind: "rate_limit_recovered", detail: { actor: "watcher" },
    });
  }

  private bail(id: string, deadline: string): void {
    // Card dfef375f round 2 item 5: the SAME shared helper the loop breaker's own bail (index.ts's
    // onRateLimited) uses — see its own doc for what it does and does NOT do (deliberately never
    // touches PtyHost's in-memory `live.rateLimited` flag; decision sha:c6338ae1).
    // Card dfef375f round 3 item 4: `reason: "watcher_deadline"` (as opposed to the loop breaker's own
    // `"loop_breaker"`) is what lets the shared helper's nudge name WHICH mechanism actually bailed.
    bailRateLimitEpisode(this.deps.db, this.deps.pty, id,
      `usage limit not cleared by ${deadline} — auto-resume abandoned`, { deadline, reason: "watcher_deadline" });
    // Card dfef375f item 1 (watcher-side diagnostic): redaction-safe — session id + the exceeded
    // deadline only, never any message text.
    // eslint-disable-next-line no-console
    console.log(`[rate-limit-watcher] ${id} bail deadline=${deadline}`);
  }

  start(): void {
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } }, this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
