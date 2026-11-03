import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { RateLimitConfig, UsageLimitsStatus } from "@loom/shared";
import { recordClaudeRateLimit } from "./usage-awareness.js";
import { decideRateLimitPark } from "./usage-limit.js";
import { bailRateLimitEpisode, type RateLimitBailPty } from "./rate-limit-bail.js";

/** The slice of UsageStatusPoller this handler needs — injectable so a test double never needs the real poller. */
export interface RateLimitCapUsageStatus {
  getStatus(): UsageLimitsStatus;
}

export interface RateLimitCapDeps {
  db: Db;
  pty: RateLimitBailPty;
  usageStatus: RateLimitCapUsageStatus;
}

/** The slice of PtyHostEvents.onRateLimited's own `detail` this handler actually reads. */
export interface RateLimitCapDetail {
  resetsAtSeconds?: number;
  type?: string;
  detector: "stop_failure" | "weekly_text_sentinel";
}

/**
 * Card dfef375f round 3 item 3: the exported core of `index.ts`'s `onRateLimited` — composes
 * `decideRateLimitPark` (usage-limit.ts), persists the loop-breaker state, arms GLOBAL usage-awareness on
 * EVERY cap (bail included), and bails or parks. Extracted so a test can drive THIS function directly
 * rather than hand-mirroring its composition — a hand-mirrored copy can diverge from production silently
 * (e.g. a mutant moving `recordClaudeRateLimit` below the bail `return` would never be caught by a copy
 * that never contained that ordering risk in the first place). `index.ts` still owns deriving `rl` (the
 * resolved `platform.rateLimit` config) via `resolveConfig`, since that needs `db` in a scope this
 * function deliberately doesn't open on its own — see the caller.
 */
export function handleRateLimitedCap(
  deps: RateLimitCapDeps,
  sessionId: string,
  detail: RateLimitCapDetail,
  rl: RateLimitConfig,
  now: Date = new Date(),
): void {
  const { db, pty, usageStatus } = deps;
  const prevBreaker = db.getRateLimitLoopBreakerState(sessionId);
  const decision = decideRateLimitPark(
    { resetsAtSeconds: detail.resetsAtSeconds, type: detail.type },
    usageStatus.getStatus(), prevBreaker, prevBreaker?.lastResumedAt, now, rl,
  );
  db.setRateLimitLoopBreakerState(sessionId, decision.breakerState.lastCapAt, decision.breakerState.recapCount);

  // Card dfef375f round 2 item 4: GLOBAL awareness arms on EVERY cap, bail included — a bailed episode
  // must not leave the Scheduler/worker_spawn gate blind to a still-capped account.
  recordClaudeRateLimit(decision.globalResetsAtSeconds);
  // card 33d5aef1: the durable twin of the (re)arm itself — the file above is overwritten silently on
  // every hit, so without this event nothing records that the global cross-session latch was touched.
  db.appendEvent({
    id: randomUUID(), ts: now.toISOString(), managerSessionId: sessionId,
    kind: "usage_latch_armed", detail: { resetsAtSeconds: decision.globalResetsAtSeconds },
  });

  // Card dfef375f item 1: redaction-safe park-site diagnostic — session id, the resolved reset + which
  // source supplied it, and the (bounded, enum-shaped) type label if the hook carried one; never any
  // message text. Round 2 item 5 (fixes minor 8): logs the REAL resolved values on a bail too, never the
  // hardcoded "resetsAtSeconds=none source=default" round 1 shipped.
  const resetsLabel = decision.resolvedResetsAtSeconds ?? "none";

  if (decision.bail) {
    bailRateLimitEpisode(
      db, pty, sessionId,
      `usage-limit loop breaker: ${decision.breakerState.recapCount} consecutive quick re-caps — auto-resume abandoned`,
      { reason: "loop_breaker" },
    );
    // eslint-disable-next-line no-console
    console.log(`[rate-limit] ${sessionId} resetsAtSeconds=${resetsLabel} source=${decision.resumeResetSource} type=${decision.typeLabel} loopBreaker=bail recapCount=${decision.breakerState.recapCount}`);
    return;
  }

  db.setRateLimitedUntil(sessionId, decision.until!, `usage limit — resumes ${decision.until}`);
  db.armRateLimitDeadline(sessionId, decision.deadline!);
  // eslint-disable-next-line no-console
  console.log(`[rate-limit] ${sessionId} resetsAtSeconds=${resetsLabel} source=${decision.resumeResetSource} type=${decision.typeLabel}`
    + (decision.backoffMs !== undefined ? ` loopBreaker=tripped recapCount=${decision.breakerState.recapCount} backoffMs=${decision.backoffMs}` : ""));
  // Event-emit twin (attention-push signal source, Lead fork 2b) — additive, no existing consumer
  // (alert-webhook's events[] allowlist, web attention) lists this new kind, so this is inert for them.
  // `detector` (card 33d5aef1) is PtyHost's own attribution of which park site fired — passed straight
  // through, never re-derived here.
  db.appendEvent({
    id: randomUUID(), ts: now.toISOString(), managerSessionId: sessionId,
    kind: "session_rate_limited", detail: { until: decision.until, deadline: decision.deadline, detector: detail.detector },
  });
}
