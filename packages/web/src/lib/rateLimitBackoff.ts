/**
 * Client-side 429 backoff for the shared fetch layer (`lib/api.ts` › `guardedFetch`). JSX-free and
 * dependency-free so `test/rate-limit-backoff.mjs` imports the SAME source the app ships.
 *
 * A remote (non-loopback) page is held to the daemon's per-ip / per-token sliding-window cap. A refused request
 * is NOT recorded in that window, so retrying costs the window nothing — but retrying IMMEDIATELY just gets
 * refused again, in a tight loop that also leaves the pane with no data and no explanation. So an idempotent
 * read that gets a 429 waits (the server's `Retry-After` when it sends one, else capped exponential backoff with
 * jitter) and retries, and the wait is published here so a banner can say so.
 *
 * @decision 4729d007 — never retry a 429 immediately, never auto-retry a non-idempotent request, and never
 * retry the coded failed-auth 429 (a bad token is not fixed by waiting).
 */

import { GATEWAY_TOKEN_REQUIRED_CODE } from "./gatewayCredential";

/** First backoff step when the server sent no usable `Retry-After`. */
export const RATE_LIMIT_BASE_MS = 1_000;
/** Ceiling of one exponential step. */
export const RATE_LIMIT_STEP_CAP_MS = 30_000;
/** Ceiling honoured for a server-sent `Retry-After` (the daemon's window is 60s). */
export const RATE_LIMIT_RETRY_AFTER_CAP_MS = 60_000;
/** Retries per request. WITHOUT a usable `Retry-After`: 1+2+4+8+16+30 = 61s of waiting — one full 60s window.
 *  The daemon always sends the header now, so the real bound is per retry min(Retry-After, 60s) × up to 1.25
 *  (jitter): ≤ 75s each, ≤ 6 × 75s = 7.5 min worst case for one request. A caller stops waiting only when an
 *  AbortSignal reaches `init.signal`: `lib/api.ts`'s `get`/`getOrNull`/`getErr` forward the signal a queryFn
 *  passes them, and a queryFn that does not forward react-query's `{signal}` still runs its sleep and request. */
export const RATE_LIMIT_MAX_RETRIES = 6;

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms, or null when absent/unusable/non-positive. */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (header == null) return null;
  const v = header.trim();
  if (v === "") return null;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const ms = Number(v) * 1000;
    return ms > 0 ? ms : null;
  }
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  const ms = at - nowMs;
  return ms > 0 ? ms : null;
}

/**
 * How long to wait before retry number `attempt` (0-based). A usable `Retry-After` is honoured (capped) and is
 * never undercut; otherwise `base * 2^attempt`, capped. `rand()` in [0,1) adds up to 25% jitter on top (never
 * below the floor) so a page whose ~20 queries were refused together does not retry them in lockstep.
 */
export function rateLimitDelayMs(
  attempt: number,
  retryAfterHeader: string | null | undefined,
  nowMs: number = Date.now(),
  rand: () => number = Math.random,
): number {
  const fromHeader = parseRetryAfterMs(retryAfterHeader, nowMs);
  const floor = fromHeader !== null
    ? Math.min(fromHeader, RATE_LIMIT_RETRY_AFTER_CAP_MS)
    : Math.min(RATE_LIMIT_STEP_CAP_MS, RATE_LIMIT_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(floor * (1 + 0.25 * rand()));
}

/** Thrown when every retry was still refused. Message keeps the `<url> -> 429` shape callers already match. */
export class RateLimitedError extends Error {
  readonly status = 429;
  constructor(url: string) {
    super(`${url} -> 429`);
    this.name = "RateLimitedError";
  }
}

/** react-query's `retry` predicate: never re-run a cancelled (aborted) read, a read whose 429 budget is spent, or
 *  anything past react-query's default of 3 retries. */
export function shouldRetryQuery(failureCount: number, err: unknown): boolean {
  return !(err instanceof RateLimitedError) && !isAbortError(err) && failureCount < 3;
}

// ---- published wait state (for the banner) ----------------------------------------------------------------

export interface RateLimitSnapshot {
  /** Requests currently sleeping between a 429 and their retry. */
  waiting: number;
  /** Epoch ms of the soonest retry among them (drives the banner's countdown). */
  nextRetryAt: number;
}
const IDLE: RateLimitSnapshot = { waiting: 0, nextRetryAt: 0 };
let snapshot: RateLimitSnapshot = IDLE;
const sleepers = new Map<number, number>(); // id -> retryAt
let nextId = 1;
const listeners = new Set<() => void>();

function publish(): void {
  if (sleepers.size === 0) snapshot = IDLE;
  else snapshot = { waiting: sleepers.size, nextRetryAt: Math.min(...sleepers.values()) };
  for (const l of listeners) l();
}
export function subscribeRateLimit(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }
/** Referentially stable between changes (required by useSyncExternalStore). */
export function rateLimitSnapshot(): RateLimitSnapshot { return snapshot; }

function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}
/** True for the error an aborted fetch / backoff sleep rejects with (a cancelled query, not a failure). */
export function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}
function defaultSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface BackoffOptions {
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  maxRetries?: number;
  now?: () => number;
  rand?: () => number;
}

const IDEMPOTENT = new Set(["GET", "HEAD"]);

/** True for the daemon's failed-auth throttle 429 (carries the gateway-token code): waiting cannot fix a bad token. */
async function isFailedAuthThrottle(r: Response): Promise<boolean> {
  try {
    const j = (await r.clone().json()) as { code?: string };
    return j?.code === GATEWAY_TOKEN_REQUIRED_CODE;
  } catch { return false; }
}

/**
 * Run `doFetch`; on a 429 to an idempotent request, wait and retry up to `maxRetries` times, publishing the wait.
 * A non-429, a non-idempotent method, or a failed-auth throttle is returned untouched. If every retry is still
 * refused, throws `RateLimitedError` — an ERROR, so a pane shows its error state rather than empty data.
 */
export async function fetchWithRateLimitBackoff(
  url: string,
  init: RequestInit | undefined,
  doFetch: () => Promise<Response>,
  opts: BackoffOptions = {},
): Promise<Response> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? RATE_LIMIT_MAX_RETRIES;
  const now = opts.now ?? Date.now;
  const method = (init?.method ?? "GET").toUpperCase();
  const signal = init?.signal;
  // An already-aborted signal starts no request at all, and none starts after an abort (a custom `sleep` that
  // ignores the signal, or an abort landing between the sleep and the retry, must not launch another fetch).
  if (signal?.aborted) throw abortError();
  let r = await doFetch();
  if (r.status !== 429 || !IDEMPOTENT.has(method)) return r;
  if (await isFailedAuthThrottle(r)) return r;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const wait = rateLimitDelayMs(attempt, r.headers.get("retry-after"), now(), opts.rand);
    const id = nextId++;
    sleepers.set(id, now() + wait);
    publish();
    try { await sleep(wait, signal); } finally { sleepers.delete(id); publish(); }
    if (signal?.aborted) throw abortError();
    r = await doFetch();
    if (r.status !== 429) return r;
    if (await isFailedAuthThrottle(r)) return r;
  }
  throw new RateLimitedError(url);
}
