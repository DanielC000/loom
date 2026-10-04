/**
 * Access-story Phase C (card 6bc02f50) — the remote-interface rate limiter, all in memory (a daemon restart resets
 * it), consulted ONLY from the trust-tier onRequest hook (gateway/server.ts) — after its loopback-peer early-return,
 * so the loopback fast path never touches this module at all. Two kinds of control, both sliding-window:
 *   1. Request caps: per VALID token, and per ip (or one shared bucket on the trusted-proxy class) for requests that
 *      did not verify.
 *   2. A failed-auth THROTTLE (card 179b6227 — replaced the old db-backed per-ip hard lockout): only the FAILURE
 *      path is limited, and it answers 429, never a lock; a VALID token is never gated by an ip's failure count.
 * The direct and trusted-proxy listeners share ONE verify-first sequence (server.ts `verifyThenThrottle`,
 * `@decision 4cbbc343`); see docs/decisions/4cbbc343-trust-class-follows-the-listener-proxy-mode.md.
 */
import { isIP } from "node:net";

export interface RemoteRateLimitPolicy {
  perIpPerMin: number;
  perTokenPerMin: number;
  authFailLockout: { maxAttempts: number; windowMs: number; lockoutMs: number };
}

/** Default hard ceiling on tracked keys per counter. Keys are peer addresses (or a token), so this is a memory/CPU
 *  bound against an address spray, not a per-caller quota. */
export const DEFAULT_MAX_KEYS = 10_000;
/** At most one full-map sweep per this many ms (measured on the caller-supplied clock), whatever the key count. */
export const SWEEP_INTERVAL_MS = 1_000;

/**
 * In-memory per-key sliding-window counter (60s window unless constructed otherwise). Not persisted — see module doc.
 *
 * Bounded three ways (card cf9ebab9, from the review of 179b6227 — a multi-address spray must not turn every
 * failed-auth request into a full-map walk on the daemon's single event loop):
 *  1. Stale keys are swept once the map crosses `SWEEP_THRESHOLD` entries (card 6bc02f50: a key touched once and
 *     never again would otherwise sit in the Map forever) — but at MOST once per `sweepIntervalMs`. A sweep that
 *     removes nothing (every key still in-window) used to re-run on EVERY allow(); now the walk is amortised.
 *  2. HARD KEY CAP (`maxKeys`), enforced on every insert of a NEW key by evicting the least-recently-touched key
 *     (Map insertion order, refreshed on each touch), so memory is bounded even when nothing is stale yet.
 *  3. Eviction FAILS OPEN PER KEY, deliberately: an evicted key just starts a fresh window, i.e. a throttled
 *     address that gets evicted regains its attempts. That is the safe direction here — the alternatives are
 *     unbounded memory, or refusing NEW keys once full (fail closed), which would let a spray lock legitimate new
 *     callers out. The failure throttle is a nuisance-limiter, not brute-force protection (tokens are 256-bit,
 *     `@decision 4cbbc343`), and a valid token never consults an ip counter at all.
 * No timer: everything is driven by allow() and the caller's clock, so nothing leaks across a `buildServer()`-per-test
 * lifecycle and it is deterministic to unit-test.
 */
export class SlidingWindowCounter {
  private hits = new Map<string, number[]>();
  private static readonly SWEEP_THRESHOLD = 2000;
  private lastSweepMs = Number.NEGATIVE_INFINITY;
  private sweeps = 0;
  private readonly maxKeys: number;
  private readonly sweepIntervalMs: number;
  constructor(private readonly windowMs: number = 60_000, opts: { maxKeys?: number; sweepIntervalMs?: number } = {}) {
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  }
  /** true = allowed (and recorded this hit); false = the key is already at `limit` hits within this counter's window. */
  allow(key: string, limit: number, nowMs: number): boolean {
    const windowStart = nowMs - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    const allowed = kept.length < limit;
    if (allowed) kept.push(nowMs);
    // delete-then-set moves the key to the END of Map order, so the FIRST key is always the least recently touched.
    this.hits.delete(key);
    if (kept.length > 0) this.hits.set(key, kept);
    if (this.hits.size > SlidingWindowCounter.SWEEP_THRESHOLD && nowMs - this.lastSweepMs >= this.sweepIntervalMs) this.sweep(nowMs);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value as string;
      this.hits.delete(oldest);
    }
    return allowed;
  }
  /** Milliseconds until `key`'s oldest tracked hit ages out of the window (i.e. until a refused `allow`
   *  would next succeed) — 0 if the key has no tracked hits. Read-only: never mutates or sweeps. Lets a
   *  caller that just received a refusal compute a Retry-After without re-deriving the window logic. */
  retryAfterMs(key: string, nowMs: number): number {
    const hits = this.hits.get(key);
    if (!hits || hits.length === 0) return 0;
    // `hits` is maintained in time order (a kept/filtered prefix, with new hits pushed at the end — see
    // `allow` above), so the oldest surviving hit is always index 0; no need to re-scan for the minimum.
    const oldest = hits[0] as number;
    return Math.max(0, this.windowMs - (nowMs - oldest));
  }
  /** Number of live (non-empty) keys currently tracked — exposed for the eviction/bound tests. */
  get size(): number {
    return this.hits.size;
  }
  /** Number of full-map sweeps performed so far — exposed so the sweep-frequency bound is testable. */
  get sweepCount(): number {
    return this.sweeps;
  }
  private sweep(nowMs: number): void {
    this.lastSweepMs = nowMs;
    this.sweeps++;
    const windowStart = nowMs - this.windowMs;
    for (const [key, hits] of this.hits) {
      const kept = hits.filter((t) => t > windowStart);
      if (kept.length === 0) this.hits.delete(key); else this.hits.set(key, kept);
    }
  }
}

/**
 * The rate-limit KEY for a peer address. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) folds to its IPv4 form, and any other
 * IPv6 address folds to its /64 — one subscriber is normally handed a whole /64 (2^64 addresses), so keying on the
 * full address would give one party unlimited keys (and unlimited fresh throttle windows). Anything that is not a
 * parseable IPv6 literal (IPv4, an empty/undeterminable peer) is returned unchanged.
 */
export function rateLimitKeyForIp(ip: string): string {
  const bare = ip.split("%")[0] ?? ip; // strip a zone id
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped) return mapped[1] as string;
  if (!bare.includes(":") || isIP(bare) !== 6) return ip;
  let groups: string[];
  if (bare.includes("::")) {
    const [head = "", tail = ""] = bare.split("::");
    const h = head === "" ? [] : head.split(":");
    const t = tail === "" ? [] : tail.split(":");
    groups = [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  } else {
    groups = bare.split(":");
  }
  if (groups.length < 4) return ip;
  return groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":") + "::/64";
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
   *  AFTER the token verified (verify-first, `@decision 4cbbc343`). */
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
    allowRequest(ip, nowMs) { return ipWindow.allow(`ip:${rateLimitKeyForIp(ip)}`, policy.perIpPerMin, nowMs); },
    allowIpPreAuth(ip, nowMs) { return ipWindow.allow(`ip:${rateLimitKeyForIp(ip)}`, policy.perIpPerMin, nowMs); },
    allowIpFailedAuth(ip, nowMs) { return ipFailWindow.allow(`ip:${rateLimitKeyForIp(ip)}`, policy.authFailLockout.maxAttempts, nowMs); },
  };
}
