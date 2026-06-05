/**
 * Usage-limit DETECTION + park-time math (phase-2 §19c, ported from Jinn's shared/rateLimit.ts).
 *
 * Primary signal: the `StopFailure` hook with `error === "rate_limit"` — Jinn's interactive
 * engine (`rateLimitFromStopFailure`) keys off exactly this, and it's the SAME StopFailure Loom
 * already relays to clear `busy` (spike S1). NOT output-scraping. `billing_error` and other named
 * errors are explicitly NOT rate limits (they must not park). RATE_LIMIT_ERROR_RE is a BACKSTOP
 * for a future claude that stops sending the exact field — matched against the error text only.
 *
 * This module is pure (no fs / no clock beyond the injected `now`) so it unit-tests deterministically.
 * The park-time numbers are DAEMON-GLOBAL tunables: each math fn takes an OPTIONAL `RateLimitConfig`
 * (the resolved `platform.rateLimit`), falling back to the module consts below when absent. The daemon
 * caller (index.ts) does the SQLite read + resolve and passes it in — this module never imports `db`
 * (stays pure; a type-only import is erased at compile). Omitting the arg = byte-identical to before.
 */
import type { RateLimitConfig } from "@loom/shared";

/** Backstop pattern (Jinn's), matched against StopFailure error text if `error` isn't exactly "rate_limit". */
export const RATE_LIMIT_ERROR_RE =
  /rate.?limit|too many requests|429|overloaded|usage.*limit|exceeded.*limit|out of extra usage/i;

/**
 * Park window when the StopFailure carries NO reset time — the common case (Jinn left
 * `error_details` unparsed and used a default backoff). 5h = the Claude Max rolling usage-cap
 * window, so "don't resume / don't fire into the account" until roughly the cap could clear.
 * (Awareness's recency heuristic in usage-awareness.ts uses 6h independently — see its note.)
 */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 60_000;

/** Resume a beat AFTER the reset boundary, not a few ms before it (Jinn's computeNextRetryDelayMs buffer). */
const RESET_BUFFER_MS = 10_000;

/** Give-up grace past a KNOWN reset (Jinn's computeRateLimitDeadlineMs default for reset-known). */
const DEADLINE_AFTER_RESET_MS = 30 * 60_000;
/** Give-up horizon when NO reset is known (Jinn's reset-absent deadline). */
const DEADLINE_NO_RESET_MS = 6 * 60 * 60_000;

/** The subset of a relayed hook payload this detector reads. */
export interface UsageLimitHook {
  hook_event_name?: string;
  error?: string;
  /** Unconfirmed format (Jinn left it unparsed); we best-effort read a reset from it — see below. */
  error_details?: unknown;
  /** A future claude MAY carry the reset as a top-level unix-seconds field; honored if present. */
  resetsAt?: number;
}

export interface UsageLimitDetection {
  limited: boolean;
  /** Unix SECONDS, when the payload carries a reset time (usually absent). */
  resetsAtSeconds?: number;
}

/** Best-effort reset extraction. Real interactive format is unconfirmed, so absent is the norm. */
function extractResetsAtSeconds(hook: UsageLimitHook): number | undefined {
  if (typeof hook.resetsAt === "number" && Number.isFinite(hook.resetsAt)) return hook.resetsAt;
  const d = hook.error_details;
  if (typeof d === "number" && Number.isFinite(d)) return d;
  if (d && typeof d === "object" && typeof (d as { resetsAt?: unknown }).resetsAt === "number") {
    return (d as { resetsAt: number }).resetsAt;
  }
  return undefined;
}

/**
 * Is this hook a usage-limit signal? Only a `StopFailure` can be (a clean `Stop` never parks).
 * Primary: `error === "rate_limit"`. Backstop: the RE on the error text — but `billing_error` is
 * excluded so a billing failure never false-positives as a rate limit.
 */
export function detectUsageLimit(hook: UsageLimitHook | undefined): UsageLimitDetection {
  if (!hook || hook.hook_event_name !== "StopFailure") return { limited: false };
  const resetsAtSeconds = extractResetsAtSeconds(hook);
  if (hook.error === "rate_limit") return { limited: true, resetsAtSeconds };
  if (typeof hook.error === "string" && hook.error !== "billing_error" && RATE_LIMIT_ERROR_RE.test(hook.error)) {
    return { limited: true, resetsAtSeconds };
  }
  return { limited: false };
}

/**
 * The ISO instant a parked session may resume: reset+buffer if known, else now + default backoff.
 * `cfg` (resolved `platform.rateLimit`) overrides the resetBuffer/defaultBackoff numbers when supplied;
 * absent → the module consts (today's behavior). `??` so an explicit 0 in the config survives.
 */
export function rateLimitedUntil(
  resetsAtSeconds: number | undefined, now: Date = new Date(),
  cfg?: Pick<RateLimitConfig, "resetBufferMs" | "defaultBackoffMs">,
): string {
  const resetBufferMs = cfg?.resetBufferMs ?? RESET_BUFFER_MS;
  const defaultBackoffMs = cfg?.defaultBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
  if (typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)) {
    return new Date(resetsAtSeconds * 1000 + resetBufferMs).toISOString();
  }
  return new Date(now.getTime() + defaultBackoffMs).toISOString();
}

/**
 * The ISO give-up deadline for a recovery episode (§19c-b): reset+30min when known, else now+6h —
 * Jinn's `computeRateLimitDeadlineMs`. Computed ONCE at the first cap and kept across re-caps, so a
 * never-clearing cap is eventually abandoned rather than retried forever.
 */
export function rateLimitDeadline(
  resetsAtSeconds: number | undefined, now: Date = new Date(),
  cfg?: Pick<RateLimitConfig, "deadlineAfterResetMs" | "deadlineNoResetMs">,
): string {
  const deadlineAfterResetMs = cfg?.deadlineAfterResetMs ?? DEADLINE_AFTER_RESET_MS;
  const deadlineNoResetMs = cfg?.deadlineNoResetMs ?? DEADLINE_NO_RESET_MS;
  if (typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)) {
    return new Date(resetsAtSeconds * 1000 + deadlineAfterResetMs).toISOString();
  }
  return new Date(now.getTime() + deadlineNoResetMs).toISOString();
}
