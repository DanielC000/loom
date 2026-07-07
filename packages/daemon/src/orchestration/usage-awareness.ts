import fs from "node:fs";
import path from "node:path";
import { LOOM_HOME } from "../paths.js";

/**
 * GLOBAL Claude usage awareness (phase-2 §19c, ported from the predecessor's shared/usageAwareness.ts).
 *
 * A tiny persisted record of the last rate-limit hit (+ its reset, when known). It makes the
 * WHOLE queue limit-aware, not just the one session that hit the cap: the Scheduler consults
 * isLikelyNearClaudeUsageLimit() before booting a manager, and worker_spawn before spawning a
 * worker — so neither fires into a known-limited account. Persisted under LOOM_HOME so awareness
 * survives a daemon restart.
 */

interface ClaudeUsageState {
  lastRateLimitAt?: string; // ISO
  lastResetsAt?: string;    // ISO (only when a reset time was known)
}

const STATE_PATH = path.join(LOOM_HOME, "tmp", "claude-usage.json");

export function readClaudeUsageState(): ClaudeUsageState {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as ClaudeUsageState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Record a rate-limit hit now (atomic write). resetsAtSeconds is stored as lastResetsAt when known. */
export function recordClaudeRateLimit(resetsAtSeconds?: number): void {
  const next: ClaudeUsageState = {
    ...readClaudeUsageState(),
    lastRateLimitAt: new Date().toISOString(),
    ...(typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)
      ? { lastResetsAt: new Date(resetsAtSeconds * 1000).toISOString() }
      : {}),
  };
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_PATH);
  } catch {
    // best-effort only — awareness is an optimization, never a correctness gate
  }
}

/**
 * Clear the global rate-limit record (§19c-b). Called on a successful resume so the queue stops
 * skipping spawns the moment recovery happens, rather than waiting out the 6h recency heuristic.
 */
export function clearClaudeRateLimit(): void {
  for (const f of [STATE_PATH, `${STATE_PATH}.tmp`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ }
  }
}

/** The expected reset instant if known AND still in the future, else undefined. */
export function getClaudeExpectedResetAt(now: Date = new Date()): Date | undefined {
  const state = readClaudeUsageState();
  if (!state.lastResetsAt) return undefined;
  const d = new Date(state.lastResetsAt);
  if (Number.isNaN(d.getTime()) || d.getTime() <= now.getTime()) return undefined;
  return d;
}

/** Module-const recency window (ms) — the 6h heuristic. Kept as the fallback / test seam. */
const RECENCY_WINDOW_MS = 6 * 60 * 60_000;

/**
 * Are we likely near the Claude usage limit right now? A KNOWN reset is authoritative — still in the
 * future ⇒ still limited (however far out; e.g. a weekly cap's reset can be well past `recencyWindowMs`),
 * already passed ⇒ clear. Only when NO reset is known do we fall back to the recency heuristic: a hit
 * within `recencyWindowMs` (default 6h, slightly wider than the 5h cap window to stay conservative about
 * firing into a still-capped account). A known reset must never be capped back down to the recency
 * window — that would relax awareness before the binding window actually clears (card 2110726d).
 *
 * `recencyWindowMs` is an OPTIONAL daemon-global tunable (the resolved `platform.rateLimit.recencyWindowMs`);
 * the daemon caller does the SQLite read + resolve and passes it in. Absent → the module const (6h) =
 * today's behavior. This module stays PURE (no db import) — the caller threads the number.
 */
export function isLikelyNearClaudeUsageLimit(now: Date = new Date(), recencyWindowMs: number = RECENCY_WINDOW_MS): boolean {
  const state = readClaudeUsageState();
  if (!state.lastRateLimitAt) return false;

  if (state.lastResetsAt) {
    const resetAt = new Date(state.lastResetsAt);
    if (!Number.isNaN(resetAt.getTime())) return now.getTime() <= resetAt.getTime();
  }

  const hitAt = new Date(state.lastRateLimitAt);
  if (Number.isNaN(hitAt.getTime())) return false;
  return now.getTime() - hitAt.getTime() < recencyWindowMs;
}

/**
 * The instant the current usage limit is expected to clear — the RETRY-AFTER deadline. Derived from the
 * SAME boundary `isLikelyNearClaudeUsageLimit` uses to decide "still limited", surfaced as a Date so a
 * spawn-blocked manager can compute when to retry instead of guessing: a KNOWN future reset wins;
 * otherwise the recency-window end (`lastRateLimitAt + recencyWindowMs`). Returns undefined exactly when
 * `isLikelyNearClaudeUsageLimit` would return false (not currently limited / reset already passed).
 */
export function getClaudeUsageLimitRetryAfter(now: Date = new Date(), recencyWindowMs: number = RECENCY_WINDOW_MS): Date | undefined {
  const state = readClaudeUsageState();
  if (!state.lastRateLimitAt) return undefined;

  if (state.lastResetsAt) {
    const resetAt = new Date(state.lastResetsAt);
    if (!Number.isNaN(resetAt.getTime())) {
      if (now.getTime() > resetAt.getTime()) return undefined; // reset passed → not limited
      return resetAt;                                          // known future reset = the retry-after
    }
  }

  const hitAt = new Date(state.lastRateLimitAt);
  if (Number.isNaN(hitAt.getTime())) return undefined;
  const recencyEnd = new Date(hitAt.getTime() + recencyWindowMs);
  return recencyEnd.getTime() > now.getTime() ? recencyEnd : undefined;
}

/**
 * Structured refusal for a usage-limit-blocked `worker_spawn` (PL Auditor finding #7). Carries the
 * retry-after deadline (ISO) so the MCP surface returns `{ error, retryAfter }` instead of the old bare
 * `throw new Error("usage limit active")` string — a spawn-blocked manager can schedule a wake to that
 * deadline rather than guess, and the daemon registers it for the clear-usage-hold auto-wake cascade.
 * `retryAfter` is absent only in the degenerate race where the limit cleared between the check and the throw.
 */
export class UsageLimitError extends Error {
  readonly retryAfter?: string; // ISO deadline
  constructor(retryAfter?: string) {
    super(retryAfter ? `usage limit active — retry after ${retryAfter}` : "usage limit active");
    this.name = "UsageLimitError";
    this.retryAfter = retryAfter;
  }
}
