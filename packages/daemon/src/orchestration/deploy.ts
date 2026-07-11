// Scoped per-project DEPLOY rate limiter (design [[Scoped Per-Project Deploy — Design]], 13235b62).
// A per-MANAGER-SESSION sliding-window cap on `deployOwnProject` calls, so a looping/compromised agent
// can't hammer its project's `deployCommand` (host exec) into a spam/DoS loop. Same in-memory sliding-
// window SHAPE as connections/request.ts's per-connection rate limiter (`rateLimitState` /
// `checkRateLimit`) — a `Map<string, number[]>` of recent-attempt timestamps, filtered to the window on
// each check. In-memory + daemon-process-lifetime, exactly like that limiter: a daemon restart clears
// it, which is fine — a fresh process is a fresh budget, and deploys are a human-approved, low-frequency
// action, not a security perimeter that needs to survive a restart.
const deployRateLimitState = new Map<string, number[]>();

/** Max deploy attempts a single manager session may make within {@link DEPLOY_RATE_LIMIT_WINDOW_MS}. */
export const DEPLOY_RATE_LIMIT_MAX = 5;
/** Sliding window (ms) the cap above applies over. Default 10 minutes. */
export const DEPLOY_RATE_LIMIT_WINDOW_MS = 10 * 60_000;

/** True if `managerSessionId` may attempt another deploy now; records the attempt when it can. */
export function checkDeployRateLimit(managerSessionId: string, now: number): boolean {
  const cutoff = now - DEPLOY_RATE_LIMIT_WINDOW_MS;
  const recent = (deployRateLimitState.get(managerSessionId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= DEPLOY_RATE_LIMIT_MAX) {
    deployRateLimitState.set(managerSessionId, recent);
    return false;
  }
  recent.push(now);
  deployRateLimitState.set(managerSessionId, recent);
  return true;
}

/** TEST-ONLY: clear all in-memory deploy rate-limit state between test cases. */
export function __resetDeployRateLimitState(): void {
  deployRateLimitState.clear();
}
