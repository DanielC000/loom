/**
 * Loom Companion — a small RECONNECT wrapper for a long-poll adapter (polling resilience).
 *
 * A channel's receive loop (e.g. grammY's `bot.start()`) resolves ONLY when it stops — a network drop
 * makes it reject or return early. `runWithReconnect` re-runs the loop after a backoff until an EXPLICIT
 * stop, so a dropped poll RECOVERS instead of silently dying. Pure + fully injectable (sleep / isStopped)
 * so it is unit-testable with no real timers and no network.
 */

export interface ReconnectRunner {
  /** One receive session; resolves when the loop ends cleanly, rejects when it drops. */
  run: () => Promise<void>;
  /** True once stop() has been requested — the loop must NOT reconnect after this. */
  isStopped: () => boolean;
  /** Backoff (ms) before the Nth reconnect (attempt is 1-based). */
  delayMs: (attempt: number) => number;
  /** Sleep — injectable (real setTimeout in prod; immediate in tests). */
  sleep: (ms: number) => Promise<void>;
  /**
   * A run that STAYED UP at least this long (ms) is treated as a healthy connection, so the backoff
   * counter RESETS — a link that ran for hours before dropping reconnects fast instead of waiting the
   * accumulated 30s cap. Only a rapid re-drop escalates the backoff. Default 60s.
   */
  resetAfterMs?: number;
  /** Monotonic clock — injectable (performance.now() in prod; a fake in tests). */
  now?: () => number;
  /** Called when a run ends unexpectedly (drop or throw), before the backoff. */
  onError?: (err: unknown, attempt: number) => void;
  /** Called just before each reconnect attempt. */
  onReconnect?: (attempt: number) => void;
}

/**
 * Run `run()` and, on any drop that is NOT an explicit stop, wait a backoff and run it again. A clean
 * resolve is ALSO treated as a drop (the poll loop only returns when it ends), so it reconnects too. A run
 * that lasted ≥ `resetAfterMs` resets the backoff (a healthy connection that later dropped). Exits only
 * when `isStopped()` becomes true.
 */
export async function runWithReconnect(r: ReconnectRunner): Promise<void> {
  const now = r.now ?? (() => performance.now());
  const resetAfterMs = r.resetAfterMs ?? 60_000;
  let attempt = 0;
  while (!r.isStopped()) {
    const startedAt = now();
    try {
      await r.run();
    } catch (err) {
      if (r.isStopped()) break;
      r.onError?.(err, attempt + 1);
    }
    if (r.isStopped()) break;
    // A connection that stayed up beyond the threshold is healthy — reset so this drop backs off from 1.
    if (now() - startedAt >= resetAfterMs) attempt = 0;
    attempt += 1;
    r.onReconnect?.(attempt);
    await r.sleep(r.delayMs(attempt));
  }
}

/** Exponential backoff (ms) capped at `capMs`, starting at `baseMs` — 1s → 2s → 4s → … ≤ 30s by default. */
export function cappedBackoff(baseMs = 1000, capMs = 30_000): (attempt: number) => number {
  return (attempt) => Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}
