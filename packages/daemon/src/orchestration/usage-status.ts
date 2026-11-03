import fs from "node:fs";
import { execSync, execFile } from "node:child_process";
import type { UsageLimitsStatus, UsageWindow, UsageExtra } from "@loom/shared";
import { resolveExecutable, winCmdShimSpawnTarget } from "../pty/resolve-bin.js";
import { claudeCredentialsPath, CLAUDE_BINARY_NAME } from "../pty/claude-doctrine.js";
import { boundedFetch } from "../connections/boundedFetch.js";

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
// Card 731aa517: this request carries the host's own Claude OAuth Bearer token. Routed through the
// shared boundedFetch helper (connections/boundedFetch.ts) — manual redirect (never auto-followed,
// so the token can't be re-sent to a 3xx Location), a hard timeout, and a streamed byte cap. The
// endpoint is a fixed constant, never user-configurable, so a redirect here has no legitimate case.
const USAGE_FETCH_TIMEOUT_MS = 8_000;
const USAGE_FETCH_MAX_BYTES = 65_536;
// HarnessAdapter seam (card 2b099e48): the literal credentials-file location is claude-specific and now
// owned by pty/claude-doctrine.ts#claudeCredentialsPath (Windows-first: %USERPROFILE%\.claude\.credentials.json;
// macOS uses the Keychain — unavailable there).
const DEFAULT_CREDENTIALS_PATH = claudeCredentialsPath();
// Sane pinned fallback when `claude --version` can't be read — the UA just needs the claude-code/ prefix.
const PINNED_VERSION_FALLBACK = "2.1.162";
// @decision 9db2ad8d — the schema-changed warn (UsageStatusPoller.warnSchemaChanged) logs KEY NAMES only,
// throttled to at most once per this window, so a sustained upstream break self-confirms in the daemon
// log (once) rather than spamming it every poll tick forever.
const SCHEMA_WARN_THROTTLE_MS = 6 * 60 * 60_000; // 6h

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
  /** boundedFetch timeoutMs override (TEST ONLY — lets a hang/redirect test use a short bound instead of
   *  waiting out the real USAGE_FETCH_TIMEOUT_MS). Defaults to USAGE_FETCH_TIMEOUT_MS in production. */
  fetchTimeoutMs?: number;
  /** boundedFetch maxResponseBytes override (TEST ONLY). Defaults to USAGE_FETCH_MAX_BYTES in production. */
  fetchMaxResponseBytes?: number;
}

let cachedClaudeVersion: string | null = null;
/** The installed claude version for the User-Agent, derived once from `claude --version` (best-effort). */
function claudeVersion(): string {
  if (cachedClaudeVersion) return cachedClaudeVersion;
  let v = PINNED_VERSION_FALLBACK;
  try {
    const bin = resolveExecutable(process.env.LOOM_CLAUDE_BIN || CLAUDE_BINARY_NAME);
    const out = execSync(`"${bin}" --version`, { encoding: "utf8", timeout: 8000, windowsHide: true });
    v = out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? PINNED_VERSION_FALLBACK;
  } catch {
    v = PINNED_VERSION_FALLBACK;
  }
  cachedClaudeVersion = v;
  return v;
}

/**
 * NON-BLOCKING read of whatever version is already cached (or null if nothing has warmed it yet) — NEVER
 * triggers the synchronous `execSync` probe above. Consumed by the session-naming version gate
 * (pty/session-name.ts's `meetsMinVersion`) from the createPty spawn chokepoint, which — per CLAUDE.md's
 * load-bearing "no blocking work on the spawn hot path" invariant (the same class of bug the async
 * markitdown/venv provisioning split avoids) — must NEVER risk an up-to-8s `execSync` stall on a session
 * spawn. See {@link prewarmClaudeVersionAsync} for what actually populates this cache off that hot path.
 */
export function getCachedClaudeVersion(): string | null {
  return cachedClaudeVersion;
}

/**
 * Best-effort, ASYNC warm of the cached claude version (mirrors the async discipline of the python venv/
 * markitdown provisioning — never `execSync`/`spawnSync` off a path that must stay non-blocking). Called
 * ONCE at daemon boot (index.ts), independent of the usage poller/OAuth credentials — the version probe
 * needs neither — so `getCachedClaudeVersion()` is warm by the time any real session spawn reaches
 * createPty in the overwhelmingly common case (a `claude --version` child process resolves in well under
 * a second). A cold read before this resolves just means that ONE spawn's session-naming gate sees
 * `null` (⇒ `meetsMinVersion` returns false ⇒ `-n` omitted for that spawn only) — never a hang, never a
 * thrown error. No-op if already cached (idempotent; safe to call more than once). Failures never throw —
 * the cache simply stays unset and the next opportunistic caller (this function, or the usage poller's
 * own lazy `claudeVersion()`) can retry — but a failure IS surfaced via `console.warn` rather than
 * swallowed silently (see the `catch`/`execFile` callback below).
 */
export function prewarmClaudeVersionAsync(): void {
  if (cachedClaudeVersion) return;
  const bin = resolveExecutable(process.env.LOOM_CLAUDE_BIN || CLAUDE_BINARY_NAME);
  try {
    // Card 12c6f580: an npm-global claude install resolves to a `.cmd` shim on Windows, and plain
    // `execFile` (unlike `execSync`/node-pty's Windows agent, both of which already go through a
    // shell/equivalent) refuses to run a `.cmd` directly (CVE-2024-27980 EINVAL) — previously swallowed
    // silently by this function's own best-effort `if (err) return`. Reuse winCmdShimSpawnTarget (card
    // 7b2670d8) to parse the shim and spawn node + its real entry script directly — never cmd.exe/
    // shell:true (decision 8ddd12c6: every spawned child would become cmd.exe itself, orphaning the real
    // process on kill(), plus reopening the escaping gap the CVE mitigation exists to close).
    const target = winCmdShimSpawnTarget(bin, ["--version"]);
    execFile(target.command, target.args, { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) {
        console.warn(`[usage-status] claude version prewarm failed (continuing): ${err.message}`);
        return;
      }
      const v = stdout.match(/(\d+\.\d+\.\d+)/)?.[1];
      if (v) cachedClaudeVersion = v;
    });
  } catch (err) {
    console.warn(`[usage-status] claude version prewarm failed (continuing): ${(err as Error)?.message ?? String(err)}`);
  }
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
 * Parse the windows + extra-usage out of a flat source object — `five_hour`/`seven_day` are required
 * (their absence/shape-drift → `available:false`); the per-model + extra fields are optional (null when
 * absent). Shared by both wire shapes {@link parseUsagePayload} accepts: the legacy top-level object, and
 * CLI 2.1.317's `rate_limits` sub-object (where `extra_usage` also lives, per that schema).
 */
function parseWindowsFrom(src: Record<string, unknown>, fetchedAt: string): UsageLimitsStatus {
  const fiveHour = parseWindow(src.five_hour);
  const sevenDay = parseWindow(src.seven_day);
  if (!fiveHour || !sevenDay) return unavailable("usage endpoint schema changed", fetchedAt);
  return {
    available: true,
    fetchedAt,
    fiveHour,
    sevenDay,
    sevenDayOpus: parseWindow(src.seven_day_opus),
    sevenDaySonnet: parseWindow(src.seven_day_sonnet),
    extraUsage: parseExtra(src.extra_usage),
  };
}

/**
 * Parse the raw endpoint payload — SHAPE-TOLERANT across two wire shapes (legacy top-level, CLI 2.1.317's
 * nested `rate_limits`). `rate_limits_available:false`/`rate_limits:null` is honoured FIRST, with its own
 * reason distinct from "schema changed".
 * @decision 9db2ad8d — never read a legitimately-unavailable account (`rate_limits_available:false`) as
 * "schema changed"; that reason is reserved for a genuinely unrecognized shape.
 */
export function parseUsagePayload(raw: unknown, fetchedAt: string): UsageLimitsStatus {
  if (!raw || typeof raw !== "object") return unavailable("unexpected response shape", fetchedAt);
  const o = raw as Record<string, unknown>;
  if (o.rate_limits_available === false || o.rate_limits === null) {
    return unavailable("plan rate limits not available for this account", fetchedAt);
  }
  const nested = o.rate_limits;
  if (nested && typeof nested === "object") return parseWindowsFrom(nested as Record<string, unknown>, fetchedAt);
  return parseWindowsFrom(o, fetchedAt);
}

export class UsageStatusPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cache: UsageLimitsStatus = unavailable("not polled yet");
  private readonly intervalMs: number;
  private readonly credentialsPath: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly versionOverride?: string;
  private readonly fetchTimeoutMs: number;
  private readonly fetchMaxResponseBytes: number;
  private lastSchemaWarnAt: number | null = null;

  constructor(deps: UsageStatusDeps = {}) {
    this.intervalMs = deps.intervalMs ?? 60_000;
    this.credentialsPath = deps.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
    this.endpoint = deps.endpoint ?? USAGE_ENDPOINT;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.versionOverride = deps.userAgentVersion;
    this.fetchTimeoutMs = deps.fetchTimeoutMs ?? USAGE_FETCH_TIMEOUT_MS;
    this.fetchMaxResponseBytes = deps.fetchMaxResponseBytes ?? USAGE_FETCH_MAX_BYTES;
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
      const result = await boundedFetch(this.endpoint, {
        headers: {
          Authorization: `Bearer ${cred.token}`,
          "anthropic-beta": OAUTH_BETA,
          "Content-Type": "application/json",
          // LOAD-BEARING: without claude-code/<version> the request is hard rate-limited (429s).
          "User-Agent": `claude-code/${version}`,
        },
        timeoutMs: this.fetchTimeoutMs,
        maxResponseBytes: this.fetchMaxResponseBytes,
        fetchImpl: this.fetchImpl,
      });
      if (!result.ok) {
        const hint = result.kind === "redirect"
          ? `usage endpoint refused a redirect (HTTP ${result.status})`
          : `usage fetch failed: ${result.error}`;
        this.cache = unavailable(hint, fetchedAt);
        return;
      }
      if (result.status < 200 || result.status >= 300) {
        const hint = result.status === 401 ? "token rejected (401) — re-login with `claude`" : `usage endpoint returned ${result.status}`;
        this.cache = unavailable(hint, fetchedAt);
        return;
      }
      const json = JSON.parse(result.text) as unknown;
      this.cache = parseUsagePayload(json, fetchedAt);
      if (!this.cache.available && this.cache.reason === "usage endpoint schema changed") {
        this.warnSchemaChanged(json);
      }
    } catch (err) {
      this.cache = unavailable(`usage fetch failed: ${(err as Error).message}`, fetchedAt);
    }
  }

  /**
   * Throttled, content-free diagnostic: logs the response's top-level key names (and, if present, the
   * nested `rate_limits` object's own key names) — never values — so a real upstream shape change
   * self-confirms in the daemon log after this ships, with no manual authenticated call needed.
   *
   * @decision 9db2ad8d — never log response VALUES here, key names only (the response is the user's own
   * account data); why this exists instead of patching the parser against one captured body is recorded
   * out-of-band.
   */
  private warnSchemaChanged(raw: unknown): void {
    const now = Date.now();
    if (this.lastSchemaWarnAt !== null && now - this.lastSchemaWarnAt < SCHEMA_WARN_THROTTLE_MS) return;
    this.lastSchemaWarnAt = now;
    const topKeys = raw && typeof raw === "object" ? Object.keys(raw as object) : [];
    const nested = raw && typeof raw === "object" ? (raw as Record<string, unknown>).rate_limits : undefined;
    const nestedKeys = nested && typeof nested === "object" ? Object.keys(nested as object) : null;
    console.warn(
      `[usage-status] usage endpoint schema changed — top-level keys: [${topKeys.join(", ")}]` +
      (nestedKeys ? `, rate_limits keys: [${nestedKeys.join(", ")}]` : ""),
    );
  }

  /**
   * Begin polling (idempotent — a second call while already running is a no-op, never two pollers).
   *
   * The loop runs even when there's NO credentials file yet: `pollOnce` reads the token first and, when
   * credentials are absent, degrades to `available:false` WITHOUT touching the network — so churning a
   * missing file costs one `readFileSync` per tick (no rate-limited bucket hit). That cheap tick is what
   * lets a POST-BOOT login recover the usage strip with no daemon restart: when the user signs in with
   * `claude` (which writes the credentials file out-of-band), the next tick polls for real and the strip
   * refreshes. (Previously `start` skipped the timer entirely when credentials were absent at boot, so a
   * later login left the strip permanently stale until a restart.)
   */
  start(): void {
    if (this.timer) return; // already running — never start a second poller
    void this.pollOnce(); // prime immediately (no creds → available:false, no network call)
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
