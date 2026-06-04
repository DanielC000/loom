import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { UsageLimitsStatus, UsageWindow, UsageExtra } from "@loom/shared";
import { resolveExecutable } from "../pty/resolve-bin.js";

/**
 * ACCOUNT-WIDE Claude plan-usage poller — the source of Mission Control's plan-usage strip.
 *
 * Reads the OAuth access token from the Claude credentials file and polls the *undocumented*
 * endpoint Claude Code itself uses — `GET https://api.anthropic.com/api/oauth/usage` — for the
 * 5-hour + 7-day rate-limit windows (utilization% + reset), per-model weekly, and extra-usage.
 * The result is parsed into a typed {@link UsageLimitsStatus}, CACHED, and served to every client
 * from one shared cache (NEVER per request — the bucket is rate-limited).
 *
 * Two load-bearing details (validated against the live endpoint):
 *   - `User-Agent: claude-code/<version>` is REQUIRED. Without it the call lands in an aggressively
 *     rate-limited bucket → persistent 429s. <version> is derived once from `claude --version`
 *     (cached), falling back to a pinned string if that probe fails.
 *   - This endpoint is community-discovered and can change/break without notice, so EVERY failure
 *     mode (missing/expired token, network error, non-200, schema drift) degrades to
 *     `available:false` + a short reason. The poll loop NEVER throws and NEVER dies — same defensive
 *     posture as usage-awareness.ts / rate-limit-watcher.ts. macOS keeps the token in the Keychain,
 *     not this JSON file → unavailable there (known limitation; Loom is Windows-first).
 */

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
// Windows-first: %USERPROFILE%\.claude\.credentials.json. (macOS uses the Keychain — unavailable.)
const DEFAULT_CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
// Sane pinned fallback when `claude --version` can't be read — the UA just needs the claude-code/ prefix.
const PINNED_VERSION_FALLBACK = "2.1.162";

export interface UsageStatusDeps {
  /** Poll cadence; defaults to 60s. NEVER poll per-request. */
  intervalMs?: number;
  /** Credentials file location (injectable for tests). */
  credentialsPath?: string;
  /** Endpoint URL (injectable for tests). */
  endpoint?: string;
  /** fetch implementation (injectable for tests); defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** User-Agent version override (tests); production derives it from `claude --version` (cached). */
  userAgentVersion?: string;
}

let cachedClaudeVersion: string | null = null;
/** The installed claude version for the User-Agent, derived once from `claude --version` (best-effort). */
function claudeVersion(): string {
  if (cachedClaudeVersion) return cachedClaudeVersion;
  let v = PINNED_VERSION_FALLBACK;
  try {
    const bin = resolveExecutable(process.env.LOOM_CLAUDE_BIN || "claude");
    const out = execSync(`"${bin}" --version`, { encoding: "utf8", timeout: 8000, windowsHide: true });
    v = out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? PINNED_VERSION_FALLBACK;
  } catch {
    v = PINNED_VERSION_FALLBACK;
  }
  cachedClaudeVersion = v;
  return v;
}

/** The graceful-degrade state. fetchedAt = when we last *tried* (null if never). */
function unavailable(reason: string, fetchedAt: string | null = null): UsageLimitsStatus {
  return { available: false, reason, fetchedAt };
}

/**
 * Read the OAuth access token from the credentials JSON. Returns the token, or a reason it's
 * unusable (file missing, unreadable/malformed, no token, or expired). Never throws.
 */
export function readOAuthToken(
  credentialsPath: string,
  now: number = Date.now(),
): { token: string } | { error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(credentialsPath, "utf8");
  } catch {
    return { error: "no Claude credentials file (sign in with `claude`)" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "credentials file is not valid JSON" };
  }
  const oauth = (parsed as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } } | null)?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (typeof token !== "string" || token.length === 0) return { error: "no OAuth access token in credentials" };
  if (typeof oauth?.expiresAt === "number" && oauth.expiresAt <= now) {
    return { error: "Claude token expired — re-login with `claude`" };
  }
  return { token };
}

/** A raw window `{ utilization, resets_at }` → typed {@link UsageWindow}, or null if not a valid window. */
function parseWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const u = (raw as { utilization?: unknown }).utilization;
  if (typeof u !== "number" || !Number.isFinite(u)) return null;
  const r = (raw as { resets_at?: unknown }).resets_at;
  return { utilization: u, resetsAt: typeof r === "string" ? r : null };
}

function parseExtra(raw: unknown): UsageExtra | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { is_enabled?: unknown; monthly_limit?: unknown; used_credits?: unknown; utilization?: unknown };
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    isEnabled: o.is_enabled === true,
    monthlyLimit: num(o.monthly_limit),
    usedCredits: num(o.used_credits),
    utilization: num(o.utilization),
  };
}

/**
 * Parse the raw endpoint payload into a typed status. `five_hour` and `seven_day` are required (their
 * absence/shape-drift → `available:false`); the per-model + extra fields are optional (null when absent).
 */
export function parseUsagePayload(raw: unknown, fetchedAt: string): UsageLimitsStatus {
  if (!raw || typeof raw !== "object") return unavailable("unexpected response shape", fetchedAt);
  const o = raw as Record<string, unknown>;
  const fiveHour = parseWindow(o.five_hour);
  const sevenDay = parseWindow(o.seven_day);
  if (!fiveHour || !sevenDay) return unavailable("usage endpoint schema changed", fetchedAt);
  return {
    available: true,
    fetchedAt,
    fiveHour,
    sevenDay,
    sevenDayOpus: parseWindow(o.seven_day_opus),
    sevenDaySonnet: parseWindow(o.seven_day_sonnet),
    extraUsage: parseExtra(o.extra_usage),
  };
}

export class UsageStatusPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cache: UsageLimitsStatus = unavailable("not polled yet");
  private readonly intervalMs: number;
  private readonly credentialsPath: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly versionOverride?: string;

  constructor(deps: UsageStatusDeps = {}) {
    this.intervalMs = deps.intervalMs ?? 60_000;
    this.credentialsPath = deps.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
    this.endpoint = deps.endpoint ?? USAGE_ENDPOINT;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.versionOverride = deps.userAgentVersion;
  }

  /** The cached status — served to every client (god-eye read-only). */
  getStatus(): UsageLimitsStatus {
    return this.cache;
  }

  /** One fetch+parse cycle. NEVER throws — every failure becomes an `available:false` cache entry. */
  async pollOnce(): Promise<void> {
    const fetchedAt = new Date().toISOString();
    try {
      const cred = readOAuthToken(this.credentialsPath);
      if ("error" in cred) {
        this.cache = unavailable(cred.error, fetchedAt);
        return;
      }
      const version = this.versionOverride ?? claudeVersion();
      const res = await this.fetchImpl(this.endpoint, {
        headers: {
          Authorization: `Bearer ${cred.token}`,
          "anthropic-beta": OAUTH_BETA,
          "Content-Type": "application/json",
          // LOAD-BEARING: without claude-code/<version> the request is hard rate-limited (429s).
          "User-Agent": `claude-code/${version}`,
        },
      });
      if (!res.ok) {
        const hint = res.status === 401 ? "token rejected (401) — re-login with `claude`" : `usage endpoint returned ${res.status}`;
        this.cache = unavailable(hint, fetchedAt);
        return;
      }
      const json = (await res.json()) as unknown;
      this.cache = parseUsagePayload(json, fetchedAt);
    } catch (err) {
      this.cache = unavailable(`usage fetch failed: ${(err as Error).message}`, fetchedAt);
    }
  }

  /**
   * Begin polling. Skips entirely (no timer) when there's no credentials file — nothing to poll, and
   * we don't churn a 60s loop against a missing file. The daemon restarts on deploy/login anyway.
   */
  start(): void {
    if (!fs.existsSync(this.credentialsPath)) {
      this.cache = unavailable("no Claude credentials file (sign in with `claude`)");
      return;
    }
    void this.pollOnce(); // prime the cache immediately
    this.timer = setInterval(() => {
      // pollOnce never throws, but guard the scheduling layer too — a bad tick must not kill the loop.
      void this.pollOnce().catch(() => { /* never let a bad poll kill the loop */ });
    }, this.intervalMs);
    // Don't keep the process alive just for usage polling.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
