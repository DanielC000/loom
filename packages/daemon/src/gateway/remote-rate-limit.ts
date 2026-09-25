/**
 * Access-story Phase C (card 6bc02f50) — the remote-interface rate limiter, all in memory (a daemon restart resets
 * it), consulted ONLY from the trust-tier onRequest hook (gateway/server.ts) — after its loopback-peer early-return,
 * so the loopback fast path never touches this module at all. Two kinds of control, both sliding-window:
 *   1. Request caps: per VALID token, and per ip (or one shared bucket on the trusted-proxy class) for requests that
 *      did not verify.
 *   2. A failed-auth THROTTLE (card 179b6227 — replaced the old db-backed per-ip hard lockout): only the FAILURE
 *      path is limited, and it answers 429, never a lock; a VALID token is never gated by an ip's failure count.
 * The direct and trusted-proxy listeners share ONE verify-first sequence (server.ts `verifyThenThrottle`,
 * `@decision 179b6227`); see docs/decisions/4cbbc343-trust-class-follows-the-listener-proxy-mode.md.
 */
export interface RemoteRateLimitPolicy {
  perIpPerMin: number;
  perTokenPerMin: number;
  authFailLockout: { maxAttempts: number; windowMs: number; lockoutMs: number };
}

/**
 * In-memory per-key sliding-window counter (60s window unless constructed otherwise). Not persisted — see module doc.
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
  constructor(private readonly windowMs: number = 60_000) {}
  /** true = allowed (and recorded this hit); false = the key is already at `limit` hits within this counter's window. */
  allow(key: string, limit: number, nowMs: number): boolean {
    const windowStart = nowMs - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    const allowed = kept.length < limit;
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
    const windowStart = nowMs - this.windowMs;
    for (const [key, hits] of this.hits) {
      const kept = hits.filter((t) => t > windowStart);
      if (kept.length === 0) this.hits.delete(key); else this.hits.set(key, kept);
    }
  }
}

export interface RemoteRateLimiter {
  /** Per-ip sliding-window cap (`perIpPerMin`) for the PUBLIC Tier-2 webhook ingress, the only caller — there is no
   *  token there (Tier 2 never reads Authorization), so the old per-token branch is gone. Tier 1 goes through
   *  allowIpPreAuth / allowToken instead. */
  allowRequest(ip: string, nowMs: number): boolean;
  /** Card 179b6227 — per-ip request cap for a request whose token did NOT verify (absent/invalid): `perIpPerMin`.
   *  A VALID token never touches an ip bucket (verify-first), so a guesser sharing the owner's ip (NAT/CGNAT/office)
   *  cannot exhaust the owner's request budget. */
  allowIpPreAuth(ip: string, nowMs: number): boolean;
  /** Throttle (429) — NEVER a hard lock — a PRESENTED-but-invalid credential per ip: `authFailLockout.maxAttempts`
   *  failures per `authFailLockout.windowMs`, in memory (a restart resets it; tokens are 256-bit so nothing is
   *  gained by persisting). Call ONLY for a non-empty token that failed verification — an absent token is ordinary
   *  first contact. A success deliberately does NOT reset it: on a shared ip that would let the owner's success wipe
   *  a guesser's count. A refused (throttled) call does not extend the window. */
  allowIpFailedAuth(ip: string, nowMs: number): boolean;
  /** Per VALID token request cap (`perTokenPerMin`), shared by the direct and trusted-proxy listeners; call only
   *  AFTER the token verified (verify-first, `@decision 179b6227`). */
  allowToken(token: string, nowMs: number): boolean;
  /** A generous shared cap over every UNAUTHENTICATED (absent/invalid token) proxy-class request (`perIpPerMin`). */
  allowProxyPreAuth(nowMs: number): boolean;
  /** Throttle (429) — never lock — presented-but-invalid tokens on the proxy class: `PROXY_FAILED_AUTH_PER_MIN` a minute. */
  allowProxyFailedAuth(nowMs: number): boolean;
}

/** Failed token verifications per minute the trusted-proxy class tolerates before the FAILURE path answers 429. A
 *  browser holding a wrong token fires several parallel requests, so this is deliberately not tiny; a valid token is
 *  never subject to it (verify-first). */
export const PROXY_FAILED_AUTH_PER_MIN = 30;

/**
 * One rate limiter instance per live trust-tier hook registration (constructed once inside buildServer,
 * scoped to that closure) — a fresh `buildServer()` call, as every daemon test performs, starts with
 * clean in-memory counters; a real daemon carries ONE instance for its whole process lifetime.
 * `authFailLockout.lockoutMs` is accepted for config compatibility but no longer used (no hard lock exists).
 */
export function createRemoteRateLimiter(policy: RemoteRateLimitPolicy): RemoteRateLimiter {
  const ipWindow = new SlidingWindowCounter();
  const tokenWindow = new SlidingWindowCounter();
  const proxyPreAuthWindow = new SlidingWindowCounter();
  const proxyFailWindow = new SlidingWindowCounter();
  const ipFailWindow = new SlidingWindowCounter(policy.authFailLockout.windowMs);
  return {
    allowToken(token, nowMs) { return tokenWindow.allow(`token:${token}`, policy.perTokenPerMin, nowMs); },
    allowProxyPreAuth(nowMs) { return proxyPreAuthWindow.allow("proxy", policy.perIpPerMin, nowMs); },
    allowProxyFailedAuth(nowMs) { return proxyFailWindow.allow("proxy", PROXY_FAILED_AUTH_PER_MIN, nowMs); },
    allowRequest(ip, nowMs) { return ipWindow.allow(`ip:${ip}`, policy.perIpPerMin, nowMs); },
    allowIpPreAuth(ip, nowMs) { return ipWindow.allow(`ip:${ip}`, policy.perIpPerMin, nowMs); },
    allowIpFailedAuth(ip, nowMs) { return ipFailWindow.allow(`ip:${ip}`, policy.authFailLockout.maxAttempts, nowMs); },
  };
}
