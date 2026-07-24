/**
 * In-memory sliding-window rate limiter shared by cross-session relay writes that a session drives
 * server-side without per-call human confirmation — `peer_message` (board card 2349d90c, manager↔manager
 * across linked projects) and `notify_lead` (board card 2db23c4d, assistant→own-project-manager). Each gets
 * its OWN dedicated bucket (a separate `Map`, keyed by the same factory) rather than sharing counters — a
 * flood on one relay must never spend down the other's budget, and `notify_lead`'s caller (role
 * "assistant") is the most injection-exposed surface in Loom, so its budget is deliberately its own.
 * Mirrors the shape of the connections P2 authenticated-request limiter (`connections/request.ts`), scoped
 * to the CALLING session id. Daemon-process lifetime, not persisted — a restart resets it, which is fine
 * for an abuse guard (not a durable accounting ledger).
 */

interface SlidingWindowLimiter {
  check(sessionId: string, now?: number): boolean;
  reset(): void;
}

function createSlidingWindowLimiter(max: number, windowMs: number): SlidingWindowLimiter {
  const state = new Map<string, number[]>();
  return {
    check(sessionId: string, now: number = Date.now()): boolean {
      const cutoff = now - windowMs;
      const recent = (state.get(sessionId) ?? []).filter((t) => t > cutoff);
      if (recent.length >= max) {
        state.set(sessionId, recent);
        return false;
      }
      recent.push(now);
      state.set(sessionId, recent);
      return true;
    },
    reset(): void {
      state.clear();
    },
  };
}

/** Sliding-window bound: a manager may send at most this many peer_message calls per window. */
export const PEER_MESSAGE_RATE_MAX = 20;
/** Window width in milliseconds. */
export const PEER_MESSAGE_RATE_WINDOW_MS = 60_000;

const peerMessageLimiter = createSlidingWindowLimiter(PEER_MESSAGE_RATE_MAX, PEER_MESSAGE_RATE_WINDOW_MS);

/** True if `managerSessionId` may send another peer_message now; records the attempt when it can. */
export function checkPeerMessageRateLimit(managerSessionId: string, now: number = Date.now()): boolean {
  return peerMessageLimiter.check(managerSessionId, now);
}

/** TEST-ONLY: clear all in-memory rate-limit state between test cases. */
export function __resetPeerMessageRateLimitState(): void {
  peerMessageLimiter.reset();
}

/** Sliding-window bound: an assistant-role session may send at most this many notify_lead calls per window. */
export const NOTIFY_LEAD_RATE_MAX = 20;
/** Window width in milliseconds. */
export const NOTIFY_LEAD_RATE_WINDOW_MS = 60_000;

const notifyLeadLimiter = createSlidingWindowLimiter(NOTIFY_LEAD_RATE_MAX, NOTIFY_LEAD_RATE_WINDOW_MS);

/** True if `assistantSessionId` may send another notify_lead now; records the attempt when it can. Its OWN
 *  bucket (never shared with peer_message's) — a flood from one relay can't spend down the other's budget. */
export function checkNotifyLeadRateLimit(assistantSessionId: string, now: number = Date.now()): boolean {
  return notifyLeadLimiter.check(assistantSessionId, now);
}

/** TEST-ONLY: clear all in-memory rate-limit state between test cases. */
export function __resetNotifyLeadRateLimitState(): void {
  notifyLeadLimiter.reset();
}
