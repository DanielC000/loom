import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";

/** The slice of PtyHost the shared bail helper needs — a best-effort owner nudge only. */
export interface RateLimitBailPty {
  enqueueStdin?(sessionId: string, text: string): void;
}

/**
 * Card dfef375f round 2 item 5: ONE shared "abandon auto-resume" routine for both bail call sites — the
 * loop breaker's own override inside index.ts's `onRateLimited`, and `RateLimitWatcher.bail()` (the
 * pre-existing deadline-based give-up). Clears the DB park state + loop-breaker counters, records
 * `rate_limit_bailed`, and best-effort nudges the owning parent (manager/lead) session if one exists.
 *
 * @decision sha:c6338ae1 — deliberately does NOT touch PtyHost's in-memory `live.rateLimited` flag. A
 * round-1 version of this routine did, and that was the CRITICAL bug a Code Review caught (see this
 * decision record's round-2 section).
 */
export function bailRateLimitEpisode(
  db: Db, pty: RateLimitBailPty, sessionId: string, lastError: string,
  detail: Record<string, unknown> = {},
): void {
  db.setRateLimitedUntil(sessionId, null, lastError);
  db.clearRateLimitDeadline(sessionId);
  db.clearRateLimitLoopBreakerState(sessionId);
  // Card dfef375f round 3 item 1: the durable "needs a human" marker — the above nulls rate_limited_until,
  // so without this a bailed LIVE session is unreachable from the UI and skipped by the clear-usage-hold
  // cascade (both keyed on rate_limited_until). Cleared only by an explicit human clear (the two REST
  // clear routes) or onExit — never by this function again, and never by resumeAfterRateLimit's in-memory
  // flag clear (decision sha:c6338ae1), which is a separate, in-memory-only concern.
  db.setRateLimitBailedAt(sessionId, new Date().toISOString());
  db.appendEvent({
    id: randomUUID(), ts: new Date().toISOString(), managerSessionId: sessionId,
    kind: "rate_limit_bailed", detail,
  });
  // Best-effort owner-attention nudge to the owning manager, mirroring context-watcher.ts's own pattern
  // (ContextWatcher.checkWorkerContextInterrupt) — the durable event above already stands regardless of
  // delivery; this is additive, not the sole signal.
  //
  // Card dfef375f round 3 item 4: the tag/wording names WHICH of the two bail call sites actually fired —
  // the loop breaker's own CONSECUTIVE-quick-re-cap trip (`detail.reason === "loop_breaker"`, index.ts's
  // onRateLimited) vs the pre-existing, independent `RateLimitWatcher` deadline give-up (`"watcher_deadline"`,
  // RateLimitWatcher.bail()) — rather than a single tag that always claimed the loop breaker regardless of
  // which mechanism actually abandoned the episode.
  const isLoopBreaker = detail.reason === "loop_breaker";
  const tag = isLoopBreaker ? "rate-limit-loop-breaker" : "rate-limit-watcher-deadline";
  const mechanism = isLoopBreaker ? "the usage-limit loop breaker" : "the usage-limit watcher's give-up deadline";
  const parentId = db.getSession(sessionId)?.parentSessionId;
  if (parentId) {
    try {
      pty.enqueueStdin?.(parentId, `[loom:${tag}] session ${sessionId} hit ${mechanism} — auto-resume has been abandoned; see its lastError.`);
    } catch { /* best-effort — the durable event above already stands */ }
  }
}
