/**
 * Access-story Phase C (card 6bc02f50) — the remote-interface rate limiter. Two independent controls,
 * both consulted ONLY from the trust-tier onRequest hook (gateway/server.ts) — after its loopback-peer
 * early-return, so the loopback fast path never touches this module at all:
 *   1. A per-ip AND per-token SLIDING-WINDOW request cap (in-memory; a daemon restart resets it — a
 *      request-rate cap doesn't need to survive a restart, unlike the auth-failure lockout below).
 *   2. An auth-failure LOCKOUT keyed on the caller's ip, backed by db.ts's `gateway_auth_attempts` table,
 *      which shares the SAME sliding-window-lockout primitive (security/lockout.ts) the companion
 *      DM-pairing coordinator uses — generalized, not forked.
 */
import type { Db } from "../db.js";
import { isLockedOut } from "../security/lockout.js";

export interface RemoteRateLimitPolicy {
  perIpPerMin: number;
  perTokenPerMin: number;
  authFailLockout: { maxAttempts: number; windowMs: number; lockoutMs: number };
}

/**
 * In-memory per-key sliding-window counter (60s window). Not persisted — see module doc.
 *
 * Eviction (CR follow-up on card 6bc02f50): a key touched once and never again (the common shape of a
 * volumetric attacker cycling through many distinct source ips/tokens, each hit once) would otherwise sit
 * in the Map FOREVER — a lazy "delete on next empty-window touch" never fires for a key that's never
 * touched again. Instead, once the map crosses `SWEEP_THRESHOLD` entries, `allow()` sweeps the WHOLE map
 * and drops every key whose window has fully expired — self-triggered by actual growth, no timer to leak
 * across a `buildServer()`-per-test lifecycle, and deterministic to unit-test.
 */
export class SlidingWindowCounter {
  private hits = new Map<string, number[]>();
  private static readonly SWEEP_THRESHOLD = 2000;
  /** true = allowed (and recorded this hit); false = the key is already at its per-minute cap. */
  allow(key: string, limitPerMin: number, nowMs: number): boolean {
    const windowStart = nowMs - 60_000;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    const allowed = kept.length < limitPerMin;
    if (allowed) kept.push(nowMs);
    if (kept.length > 0) this.hits.set(key, kept); else this.hits.delete(key);
    if (this.hits.size > SlidingWindowCounter.SWEEP_THRESHOLD) this.sweep(nowMs);
    return allowed;
  }
  /** Number of live (non-empty) keys currently tracked — exposed for the eviction test. */
  get size(): number {
    return this.hits.size;
  }
  private sweep(nowMs: number): void {
    const windowStart = nowMs - 60_000;
    for (const [key, hits] of this.hits) {
      const kept = hits.filter((t) => t > windowStart);
      if (kept.length === 0) this.hits.delete(key); else this.hits.set(key, kept);
    }
  }
}

export interface RemoteRateLimiter {
  /** Sliding-window request cap — call for EVERY remote request (after the loopback exemption), before
   *  the token-verify step. false ⇒ the caller should reply 429 without doing any further auth work. */
  allowRequest(ip: string, token: string | undefined, nowMs: number): boolean;
  /** Is this ip currently locked out from repeated auth failures? Checked BEFORE re-verifying a token,
   *  mirroring the pairing coordinator's own lockout-gate-before-load ordering. */
  isIpLockedOut(ip: string, nowMs: number): boolean;
  /** Record an auth failure for this ip (bumps/locks per policy.authFailLockout). Call ONLY when a
   *  non-empty token was actually presented and failed verification — an entirely absent token is
   *  ordinary unauthenticated first contact, not a credential-guessing signal. */
  recordAuthFailure(ip: string, nowMs: number): void;
  /** Clear this ip's failure counter — call on a successful token verification. */
  clearAuthFailures(ip: string): void;
}

/**
 * One rate limiter instance per live trust-tier hook registration (constructed once inside buildServer,
 * scoped to that closure) — a fresh `buildServer()` call, as every daemon test performs, starts with
 * clean in-memory counters; a real daemon carries ONE instance for its whole process lifetime.
 */
export function createRemoteRateLimiter(db: Db, policy: RemoteRateLimitPolicy): RemoteRateLimiter {
  const ipWindow = new SlidingWindowCounter();
  const tokenWindow = new SlidingWindowCounter();
  return {
    allowRequest(ip, token, nowMs) {
      if (!ipWindow.allow(`ip:${ip}`, policy.perIpPerMin, nowMs)) return false;
      if (token && !tokenWindow.allow(`token:${token}`, policy.perTokenPerMin, nowMs)) return false;
      return true;
    },
    isIpLockedOut(ip, nowMs) {
      return isLockedOut(db.getGatewayAuthAttempts(ip), nowMs);
    },
    recordAuthFailure(ip, nowMs) {
      db.recordGatewayAuthFailure(ip, nowMs, policy.authFailLockout);
    },
    clearAuthFailures(ip) {
      db.clearGatewayAuthAttempts(ip);
    },
  };
}
