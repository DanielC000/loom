/**
 * Usage-limit DETECTION + park-time math (phase-2 §19c, ported from the predecessor's shared/rateLimit.ts).
 *
 * Primary signal: the `StopFailure` hook with `error === "rate_limit"` — the predecessor's interactive
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
import type { RateLimitConfig, UsageLimitsStatus } from "@loom/shared";

/** Backstop pattern (the predecessor's), matched against StopFailure error text if `error` isn't exactly "rate_limit". */
export const RATE_LIMIT_ERROR_RE =
  /rate.?limit|too many requests|429|overloaded|usage.*limit|exceeded.*limit|out of extra usage/i;

/**
 * Weekly/account usage-cap TEXT sentinel — see {@link isWeeklyUsageLimitSentinel}. Unlike the
 * session-scoped 5h cap (a `StopFailure` — see {@link detectUsageLimit}), the interactive CLI answers a
 * weekly/account cap as an ordinary reply + a clean `Stop`, so this heuristic is the only signal.
 * @decision b16320bc — biased toward precision over recall: both `WEEKLY_LIMIT_HIT_RE` and
 *  `WEEKLY_LIMIT_RESET_CLOCK_RE` (below) must match — a false positive silently freezes a healthy
 *  session, worse than a missed real cap (a visible, transcript-diagnosable stall).
 */
const WEEKLY_LIMIT_HIT_RE = /\bhit your (?:weekly|account) (?:usage )?limit\b/i;
// A clock time REQUIRES an `HH:MM` pair and/or an am/pm suffix — a bare `\d{1,2}` alone (e.g. "resets 5
// items", "resets 5×") must NOT qualify. The `:MM` branch optionally still allows a trailing am/pm
// ("11:30pm"); the no-colon branch REQUIRES am/pm ("5pm") — so at least one real time marker is mandatory.
const WEEKLY_LIMIT_RESET_CLOCK_RE = /\bresets?\s+(?:at\s+)?\d{1,2}(?:(?::\d{2})\s*(?:am|pm)?|\s*(?:am|pm))\b/i;
export function isWeeklyUsageLimitSentinel(text: string): boolean {
  return WEEKLY_LIMIT_HIT_RE.test(text) && WEEKLY_LIMIT_RESET_CLOCK_RE.test(text);
}

/**
 * Park window when the StopFailure carries NO reset time — the common case (the predecessor left
 * `error_details` unparsed and used a default backoff). 5h = the Claude Max rolling usage-cap
 * window, so "don't resume / don't fire into the account" until roughly the cap could clear.
 * (Awareness's recency heuristic in usage-awareness.ts uses 6h independently — see its note.)
 */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 60_000;

/** Resume a beat AFTER the reset boundary, not a few ms before it (the predecessor's computeNextRetryDelayMs buffer). */
const RESET_BUFFER_MS = 10_000;

/** Give-up grace past a KNOWN reset (the predecessor's computeRateLimitDeadlineMs default for reset-known). */
const DEADLINE_AFTER_RESET_MS = 30 * 60_000;
/** Give-up horizon when NO reset is known (the predecessor's reset-absent deadline). */
const DEADLINE_NO_RESET_MS = 6 * 60 * 60_000;

/**
 * A plan-usage window (UsageWindow.utilization, 0–100 scale) counts as EXHAUSTED at/above this —
 * the threshold `resumeResetFromUsageStatus` uses to pick a real reset over the flat default backoff.
 */
const DEFAULT_EXHAUSTED_THRESHOLD_PCT = 95;

/**
 * Card dfef375f round 2 item 9: a weekly/account-scale window (sevenDay/sevenDayOpus/sevenDaySonnet) is
 * NOT exhausted-enough to override a HOOK-reported reset unless it is TRULY exhausted (100%) — the
 * ordinary "near" threshold above is for the five-hour window, and for the status-only path (no hook
 * reset to compare against). A near-exhausted (e.g. 95-99%) weekly window isn't necessarily what's
 * actually blocking THIS StopFailure, and trusting it as a later-wins override over a present hook
 * reset can park far longer than the real cap requires. See {@link resolveResumeReset}'s own doc.
 */
export const FULLY_EXHAUSTED_THRESHOLD_PCT = 100;

/** The subset of a relayed hook payload this detector reads. */
export interface UsageLimitHook {
  hook_event_name?: string;
  error?: string;
  /** Unconfirmed format (the predecessor left it unparsed); we best-effort read a reset from it — see below. */
  error_details?: unknown;
  /** A future claude MAY carry the reset as a top-level unix-seconds field; honored if present. */
  resetsAt?: number;
}

export interface UsageLimitDetection {
  limited: boolean;
  /** Unix SECONDS, when the payload carries a reset time (usually absent). */
  resetsAtSeconds?: number;
  /** Best-effort rate-limit TYPE label (e.g. "cooldown") — see {@link extractRateLimitType}. Diagnostic
   *  only today (card dfef375f item 1); nothing branches on it yet (that's item 4, deliberately deferred
   *  until a real occurrence confirms the hook's actual field shape). */
  type?: string;
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
 * A rate-limit TYPE label is a short enum-like token (the CLI 2.1.317 binary's own strings confirm
 * "cooldown"/"blocked_five_hour"/"blocked_seven_day"/… — see docs/decisions/dfef375f-*.md) — never a
 * message. Bounded to a short `[a-z_]` token so a future `error_details` shape that turns out to carry
 * free text can never leak through this diagnostic path (card dfef375f item 1's redaction-safety bar).
 */
const RATE_LIMIT_TYPE_LABEL_RE = /^[a-z_]{1,40}$/i;

/** Best-effort rate-limit TYPE extraction — see {@link RATE_LIMIT_TYPE_LABEL_RE}. Real interactive
 *  shape is unconfirmed (same caveat as {@link extractResetsAtSeconds}), so absent is the norm. */
function extractRateLimitType(hook: UsageLimitHook): string | undefined {
  const d = hook.error_details;
  const candidate = typeof d === "string" ? d : d && typeof d === "object" ? (d as { type?: unknown }).type : undefined;
  return typeof candidate === "string" && RATE_LIMIT_TYPE_LABEL_RE.test(candidate) ? candidate : undefined;
}

/**
 * Is this hook a usage-limit signal? Only a `StopFailure` can be (a clean `Stop` never parks).
 * Primary: `error === "rate_limit"`. Backstop: the RE on the error text — but `billing_error` is
 * excluded so a billing failure never false-positives as a rate limit.
 */
export function detectUsageLimit(hook: UsageLimitHook | undefined): UsageLimitDetection {
  if (!hook || hook.hook_event_name !== "StopFailure") return { limited: false };
  const resetsAtSeconds = extractResetsAtSeconds(hook);
  const type = extractRateLimitType(hook);
  if (hook.error === "rate_limit") return { limited: true, resetsAtSeconds, type };
  if (typeof hook.error === "string" && hook.error !== "billing_error" && RATE_LIMIT_ERROR_RE.test(hook.error)) {
    return { limited: true, resetsAtSeconds, type };
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
 * the predecessor's `computeRateLimitDeadlineMs`. Computed ONCE at the first cap and kept across re-caps, so a
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

/**
 * Fallback reset derivation for a StopFailure that carries NO resetsAtSeconds (the common case — the
 * interactive hook doesn't include one). Loom already polls the account's real plan-usage windows
 * (fiveHour/sevenDay/sevenDayOpus/sevenDaySonnet); among the ones that are EXHAUSTED (utilization ≥
 * `cfg.exhaustedThresholdPct`, 0–100 scale, default 95) AND have a reset still in the future, returns
 * the LATEST such reset (unix seconds) — so a caller never resumes back into a still-capped window.
 * `undefined` when the status is unavailable, no window is exhausted, or every exhausted window's
 * reset has already passed. Pure: `status` + `now` are both passed in, never read live.
 *
 * `cfg.sevenDayExhaustedThresholdPct`, when supplied, overrides the threshold applied to the
 * weekly/account-scale windows ONLY (sevenDay/sevenDayOpus/sevenDaySonnet) — the fiveHour window always
 * uses the ordinary `exhaustedThresholdPct`. Defaults to `exhaustedThresholdPct` itself when omitted, so
 * every existing caller (status-only — no hook reset to cross-check against) stays byte-identical;
 * {@link resolveResumeReset} is the one caller that raises it (see that function's own doc, item 9).
 */
export function resumeResetFromUsageStatus(
  status: UsageLimitsStatus | undefined, now: Date = new Date(),
  cfg?: Partial<Pick<RateLimitConfig, "exhaustedThresholdPct">> & { sevenDayExhaustedThresholdPct?: number },
): number | undefined {
  if (!status || status.available !== true) return undefined;
  const threshold = cfg?.exhaustedThresholdPct ?? DEFAULT_EXHAUSTED_THRESHOLD_PCT;
  const sevenDayThreshold = cfg?.sevenDayExhaustedThresholdPct ?? threshold;
  const windows = [
    { w: status.fiveHour, threshold },
    { w: status.sevenDay, threshold: sevenDayThreshold },
    { w: status.sevenDayOpus, threshold: sevenDayThreshold },
    { w: status.sevenDaySonnet, threshold: sevenDayThreshold },
  ];
  let latestResetMs: number | undefined;
  for (const { w, threshold: t } of windows) {
    if (!w || w.utilization < t || !w.resetsAt) continue;
    const resetMs = new Date(w.resetsAt).getTime();
    if (!Number.isFinite(resetMs) || resetMs <= now.getTime()) continue;
    if (latestResetMs === undefined || resetMs > latestResetMs) latestResetMs = resetMs;
  }
  return latestResetMs === undefined ? undefined : Math.floor(latestResetMs / 1000);
}

/** Which signal {@link resolveResumeReset} actually used. */
export type ResumeResetSource = "hook" | "status" | "default";

export interface ResumeResetResolution {
  resetsAtSeconds: number | undefined;
  source: ResumeResetSource;
}

/**
 * Card dfef375f item 2: when BOTH the StopFailure hook and the polled plan-usage status carry a reset,
 * take the LATER one — a later resume is always safe (never resumes back into a window that's actually
 * still exhausted), while trusting an EARLIER hook-reported reset unconditionally is exactly the
 * premature-resume bug this card investigated (a short "cooldown" sub-limit reset reported in place of
 * the binding cap's). When only one side carries a value, use it. When neither does, `resetsAtSeconds`
 * is `undefined` and `source` is `"default"` — the safe degrade when the poller is unavailable (no
 * token, schema drift, or simply no exhausted window): the caller's own flat backoff applies, and this
 * is NEVER read as "no limit", only as "no better reset than the default backoff is known".
 *
 * Card dfef375f round 2 item 9: when a hook reset IS present, the status may only override it with a
 * weekly/account-scale (sevenDay-family) reset when that window is TRULY exhausted (100%), never merely
 * "near" (the ordinary `exhaustedThresholdPct`, default 95) — raised ONLY for this comparison; the
 * status-only path (no hook reset at all) keeps the ordinary threshold unchanged.
 */
export function resolveResumeReset(
  hookResetsAtSeconds: number | undefined,
  status: UsageLimitsStatus | undefined, now: Date = new Date(),
  cfg?: Pick<RateLimitConfig, "exhaustedThresholdPct">,
): ResumeResetResolution {
  const statusCfg = typeof hookResetsAtSeconds === "number"
    ? { ...cfg, sevenDayExhaustedThresholdPct: FULLY_EXHAUSTED_THRESHOLD_PCT }
    : cfg;
  const statusResetsAtSeconds = resumeResetFromUsageStatus(status, now, statusCfg);
  if (typeof hookResetsAtSeconds === "number" && typeof statusResetsAtSeconds === "number") {
    return hookResetsAtSeconds >= statusResetsAtSeconds
      ? { resetsAtSeconds: hookResetsAtSeconds, source: "hook" }
      : { resetsAtSeconds: statusResetsAtSeconds, source: "status" };
  }
  if (typeof hookResetsAtSeconds === "number") return { resetsAtSeconds: hookResetsAtSeconds, source: "hook" };
  if (typeof statusResetsAtSeconds === "number") return { resetsAtSeconds: statusResetsAtSeconds, source: "status" };
  return { resetsAtSeconds: undefined, source: "default" };
}

/**
 * Loop-breaker tunables — the re-cap/backoff/bail defaults {@link stepLoopBreaker} falls back to when no
 * `RateLimitConfig` override is supplied.
 *
 * @decision dfef375f — do not anchor the re-cap streak to a cap-to-cap window (round 1's superseded
 *  design); it let the real incident's own first few caps through for free. Count CONSECUTIVE "quick"
 *  re-caps against the session's own last RESUME instead.
 */
export const LOOP_BREAKER_MAX_RECAPS = 3;
export const LOOP_BREAKER_QUICK_GAP_MS = 3 * 60_000; // 3min
export const LOOP_BREAKER_BACKOFF_BASE_MS = 30 * 60_000; // 30min
export const LOOP_BREAKER_BACKOFF_CEILING_MS = 4 * 60 * 60_000; // 4h

/** Persisted loop-breaker counters (one row's worth) — see {@link stepLoopBreaker}. */
export interface LoopBreakerState {
  /** ISO timestamp of the MOST RECENT cap counted into `recapCount` — diagnostic bookkeeping only; the
   *  trip/bail decision itself reads `lastResumedAt` (a separate, externally-recorded timestamp — see
   *  {@link stepLoopBreaker}'s own doc), never this field. */
  lastCapAt: string | null;
  recapCount: number;
}

export interface LoopBreakerResult {
  /** The state to persist for the NEXT call. */
  state: LoopBreakerState;
  /** True once this cap counts as a "quick" re-cap (arrived within `quickGapMs` of the session's last
   *  resume) — the caller must override `until` with `backoffMs` instead of trusting whatever reset any
   *  source reported (never set together with `bail`). */
  tripped: boolean;
  /** True once `recapCount` of CONSECUTIVE quick re-caps has been reached — the caller must bail the
   *  episode (stop trying automatically) instead of parking again. `backoffMs` is absent when `bail` is true. */
  bail: boolean;
  backoffMs?: number;
}

/**
 * Advance the loop-breaker's CONSECUTIVE-quick-re-cap streak by one cap and decide whether to override
 * the normal park math. Pure: `now` is injected, nothing is read live. A cap counts toward the streak
 * ONLY when it arrives within `quickGapMs` of `lastResumedAt` (the session's own last recorded resume,
 * supplied by the caller — see `Db.getRateLimitLoopBreakerState`/`recordRateLimitResume`); any other cap
 * (including the episode's first, which has no prior resume to compare against) resets the streak to 0
 * and is never tripped. Once the streak reaches `maxRecaps`, the episode bails immediately — there is no
 * escalation ladder to climb first; the 1st/2nd (etc., up to `maxRecaps - 1`) consecutive quick re-caps
 * each trip an escalating backoff (`backoffBaseMs * 2^(streak-1)`, capped at `backoffCeilingMs`) so the
 * session doesn't just keep resuming on the stale hook-reported reset while the streak builds.
 *
 * @decision dfef375f — do not anchor the streak on the gap since the PREVIOUS CAP again; a Code Review
 *  simulation proved that design still took 6 caps to end the real incident, no improvement at all.
 */
export function stepLoopBreaker(
  prev: LoopBreakerState | null | undefined,
  lastResumedAt: string | null | undefined,
  now: Date = new Date(),
  cfg?: Pick<RateLimitConfig, "loopBreakerMaxRecaps" | "loopBreakerQuickGapMs" | "loopBreakerBackoffBaseMs" | "loopBreakerBackoffCeilingMs">,
): LoopBreakerResult {
  const maxRecaps = cfg?.loopBreakerMaxRecaps ?? LOOP_BREAKER_MAX_RECAPS;
  const quickGapMs = cfg?.loopBreakerQuickGapMs ?? LOOP_BREAKER_QUICK_GAP_MS;
  const backoffBaseMs = cfg?.loopBreakerBackoffBaseMs ?? LOOP_BREAKER_BACKOFF_BASE_MS;
  const backoffCeilingMs = cfg?.loopBreakerBackoffCeilingMs ?? LOOP_BREAKER_BACKOFF_CEILING_MS;
  const lastResumedAtMs = lastResumedAt ? new Date(lastResumedAt).getTime() : undefined;
  const isQuick = typeof lastResumedAtMs === "number" && Number.isFinite(lastResumedAtMs)
    && now.getTime() - lastResumedAtMs <= quickGapMs;
  const recapCount = isQuick ? (prev?.recapCount ?? 0) + 1 : 0;
  const state: LoopBreakerState = { lastCapAt: now.toISOString(), recapCount };
  if (recapCount === 0) return { state, tripped: false, bail: false };
  if (recapCount >= maxRecaps) return { state, tripped: true, bail: true };
  const backoffMs = Math.min(backoffBaseMs * 2 ** (recapCount - 1), backoffCeilingMs);
  return { state, tripped: true, bail: false, backoffMs };
}

/** What {@link decideRateLimitPark} decided for one StopFailure cap — everything `onRateLimited` needs,
 *  composed in one pure call instead of three separately-ordered ones (card dfef375f round 2 item 6). */
export interface RateLimitParkDecision {
  /** True once the episode must be abandoned — the caller must bail (never park again). */
  bail: boolean;
  /** Present iff `!bail`. */
  until?: string;
  /** Present iff `!bail`. */
  deadline?: string;
  /** Present iff the loop breaker tripped on this cap (and `!bail`) — purely for logging. */
  backoffMs?: number;
  /** The loop-breaker state to persist for the NEXT call (`Db.setRateLimitLoopBreakerState`). */
  breakerState: LoopBreakerState;
  /** The resolved reset, for logging — `undefined` when no source carried one (source is `"default"`). */
  resolvedResetsAtSeconds: number | undefined;
  resumeResetSource: ResumeResetSource;
  /** Bounded enum-shaped rate-limit TYPE label, or "none" — see {@link extractRateLimitType}. */
  typeLabel: string;
  /** The resetsAtSeconds GLOBAL usage-awareness should arm on THIS cap — present on every cap, bail
   *  included (item 4), and only when it would not SHORTEN an existing hold below the recency floor. */
  globalResetsAtSeconds: number | undefined;
}

/**
 * Card dfef375f round 2 item 6: the pure core of `onRateLimited` — composes `resolveResumeReset` (item
 * 2/9), `stepLoopBreaker` (item 3), the tripped-backoff-never-shortens-a-known-reset clamp (item 3), and
 * the GLOBAL-awareness-on-every-cap derivation (item 4) into ONE decision. The caller still owns every
 * DB write (this function reads nothing live) and the bail/park branch itself.
 */
export function decideRateLimitPark(
  hook: { resetsAtSeconds: number | undefined; type: string | undefined },
  status: UsageLimitsStatus | undefined,
  prevBreakerState: LoopBreakerState | null | undefined,
  lastResumedAt: string | null | undefined,
  now: Date = new Date(),
  cfg?: RateLimitConfig,
): RateLimitParkDecision {
  const resolved = resolveResumeReset(hook.resetsAtSeconds, status, now, cfg);
  const breaker = stepLoopBreaker(prevBreakerState, lastResumedAt, now, cfg);
  const typeLabel = hook.type ?? "none";

  // Item 4: GLOBAL awareness is derived on EVERY cap, bail included — a bailed episode must not leave
  // the Scheduler/worker_spawn gate blind to a still-capped account. Never SHORTENS an existing hold
  // below the recency floor (mirrors the pre-existing per-session logic, just no longer skipped on bail).
  const recencyFloorSeconds = now.getTime() / 1000 + (cfg?.recencyWindowMs ?? 0) / 1000;
  const globalResetsAtSeconds = typeof resolved.resetsAtSeconds === "number" && resolved.resetsAtSeconds >= recencyFloorSeconds
    ? resolved.resetsAtSeconds : undefined;

  if (breaker.bail) {
    return {
      bail: true, breakerState: breaker.state, resolvedResetsAtSeconds: resolved.resetsAtSeconds,
      resumeResetSource: resolved.source, typeLabel, globalResetsAtSeconds,
    };
  }

  // Item 3: a tripped backoff never SHORTENS a known reset — park until max(resolved reset, now+backoff).
  let until: string;
  if (breaker.tripped) {
    const backoffUntilMs = now.getTime() + (breaker.backoffMs ?? 0);
    if (typeof resolved.resetsAtSeconds === "number") {
      const resetUntilMs = new Date(rateLimitedUntil(resolved.resetsAtSeconds, now, cfg)).getTime();
      until = new Date(Math.max(resetUntilMs, backoffUntilMs)).toISOString();
    } else {
      until = new Date(backoffUntilMs).toISOString();
    }
  } else {
    until = rateLimitedUntil(resolved.resetsAtSeconds, now, cfg);
  }
  const deadline = rateLimitDeadline(resolved.resetsAtSeconds, now, cfg);
  return {
    bail: false, until, deadline, backoffMs: breaker.backoffMs, breakerState: breaker.state,
    resolvedResetsAtSeconds: resolved.resetsAtSeconds, resumeResetSource: resolved.source, typeLabel,
    globalResetsAtSeconds,
  };
}
