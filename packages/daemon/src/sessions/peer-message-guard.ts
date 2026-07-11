/**
 * In-memory sliding-window rate limiter for `peer_message` (board card 2349d90c) — caps how often a
 * single origin manager session may message a linked peer project, so the new cross-project write can't
 * become a spam/probe vector against a linked project. Mirrors the shape of the connections P2
 * authenticated-request limiter (`connections/request.ts`), scoped to the CALLING manager session id
 * rather than a connection id. Daemon-process lifetime, not persisted — a restart resets it, which is fine
 * for an abuse guard (not a durable accounting ledger).
 */

/** Sliding-window bound: a manager may send at most this many peer_message calls per window. */
export const PEER_MESSAGE_RATE_MAX = 20;
/** Window width in milliseconds. */
export const PEER_MESSAGE_RATE_WINDOW_MS = 60_000;

const rateLimitState = new Map<string, number[]>();

/** True if `managerSessionId` may send another peer_message now; records the attempt when it can. */
export function checkPeerMessageRateLimit(managerSessionId: string, now: number = Date.now()): boolean {
  const cutoff = now - PEER_MESSAGE_RATE_WINDOW_MS;
  const recent = (rateLimitState.get(managerSessionId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= PEER_MESSAGE_RATE_MAX) {
    rateLimitState.set(managerSessionId, recent);
    return false;
  }
  recent.push(now);
  rateLimitState.set(managerSessionId, recent);
  return true;
}

/** TEST-ONLY: clear all in-memory rate-limit state between test cases. */
export function __resetPeerMessageRateLimitState(): void {
  rateLimitState.clear();
}
