import { randomUUID } from "node:crypto";
import type { Session } from "@loom/shared";
import type { Db } from "../db.js";
import { readRunUsage, type RunUsageStats } from "./context.js";
import { computeRunCostUsd } from "./pricing.js";

/** app_meta one-time marker for the boot backfill (same fire-exactly-once pattern as the first-run /
 *  archived_at / held backfills). Daemon-GLOBAL (app_meta is not project-scoped); set once per LOOM_HOME. */
const BACKFILL_MARKER_KEY = "usage_backfill_done";

/** A session's last-seen CUMULATIVE token snapshot, tagged with the transcript (engine id) it came from
 *  so a resume (new engine id → new transcript, cumulative restarts at 0) is detected as a fresh segment. */
interface LastSeen {
  engineSessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface UsageSamplerDeps {
  db: Db;
  /** Sampler cadence (ms) — config `usageSampleIntervalMs` (default 5m). Injectable so a test drives tick() directly. */
  intervalMs: number;
  /** Retention (days) — config `usageSampleRetentionDays` (default 90); old samples pruned each tick. */
  retentionDays: number;
}

/**
 * Session usage telemetry COLLECTION engine (epic c9924bcd, card B) — the daemon-side background sampler
 * that fills `session_usage_samples` (card A's table). 100% daemon-side and **token-free** (load-bearing
 * owner constraint): it NEVER invokes an agent or makes a model call — it only reads the transcript JSONL
 * files the engine already writes to disk (`readRunUsage`) and prices them with the same per-model rate
 * table Agent Runs use (`computeRunCostUsd`). Pure Node + SQLite.
 *
 * Lifecycle mirrors the IDLE WATCHER (`orchestration/idle-watcher.ts`): constructed at boot, `start()`ed
 * with a config-driven interval, `stop()`ed on graceful shutdown.
 *
 * Each stored row is a per-interval DELTA (additive), so the read-side aggregation is a plain SUM. The
 * delta is `current_cumulative − lastSeen[sessionId]`, with RESET handling (the load-bearing wrinkle):
 * `readRunUsage` is monotonic WITHIN one transcript, but a RESUMED session gets a new engine id → a new
 * transcript → cumulative restarts at 0. When the transcript changed (or any cumulative dropped) we treat
 * it as a fresh segment and the delta IS the new cumulative (never subtract → never emit a negative).
 * `lastSeen` is in-memory + re-seedable; `start()` does not need it primed because the backfill seeds it
 * for any session it backfills, and a post-restart resumed session starts a fresh (~0) transcript anyway.
 */
export class UsageSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Per-session last-seen cumulative usage (in-memory; re-derivable from the transcript). */
  private lastSeen = new Map<string, LastSeen>();
  constructor(private deps: UsageSamplerDeps) {}

  /**
   * Compute the DELTA of `cum` (a session's current cumulative transcript usage) against its last-seen
   * snapshot, advance `lastSeen`, and append a sample row UNLESS the delta is all-zero (no change → no
   * row). Reset-aware: a changed transcript (engine id) or any dropped cumulative ⇒ the whole new
   * cumulative is the delta. Returns true iff a row was written.
   */
  private recordDelta(session: Session, cum: RunUsageStats, eng: string, ts: string): boolean {
    const prev = this.lastSeen.get(session.id);
    // Fresh segment when: first sight of this session, the transcript changed (resume → new engine id),
    // or the cumulative dropped (defensive; can't happen within one monotonic transcript). The whole new
    // cumulative is then the delta — NOT a subtraction, so we never emit a negative.
    const fresh = !prev || prev.engineSessionId !== eng || cum.inputTokens < prev.inputTokens;
    const delta = fresh
      ? {
          inputTokens: cum.inputTokens,
          outputTokens: cum.outputTokens,
          cacheCreationTokens: cum.cacheCreationTokens,
          cacheReadTokens: cum.cacheReadTokens,
        }
      : {
          inputTokens: Math.max(0, cum.inputTokens - prev.inputTokens),
          outputTokens: Math.max(0, cum.outputTokens - prev.outputTokens),
          cacheCreationTokens: Math.max(0, cum.cacheCreationTokens - prev.cacheCreationTokens),
          cacheReadTokens: Math.max(0, cum.cacheReadTokens - prev.cacheReadTokens),
        };
    // Always advance last-seen to the new cumulative (so the NEXT tick's delta is incremental) — even on a
    // zero-delta tick, and even on a reset (re-seed to the fresh transcript's cumulative).
    this.lastSeen.set(session.id, {
      engineSessionId: eng,
      inputTokens: cum.inputTokens,
      outputTokens: cum.outputTokens,
      cacheCreationTokens: cum.cacheCreationTokens,
      cacheReadTokens: cum.cacheReadTokens,
    });
    if (
      delta.inputTokens === 0 && delta.outputTokens === 0 &&
      delta.cacheCreationTokens === 0 && delta.cacheReadTokens === 0
    ) return false; // no change → no row
    const costUsd = computeRunCostUsd({ ...delta, model: cum.model });
    this.deps.db.insertUsageSample({
      id: randomUUID(),
      sessionId: session.id,
      projectId: session.projectId,
      agentId: session.agentId ?? null,
      model: cum.model,
      ts,
      ...delta,
      costUsd,
    });
    return true;
  }

  /** True for a session the sampler should never sample: an Agent Run (role==='run', accounted separately
   *  via aggregateRunUsage) or one with no engine transcript yet. */
  private skip(s: Session): boolean {
    return s.role === "run" || !s.engineSessionId;
  }

  /**
   * One sampler pass: for every LIVE session, read its transcript → cumulative, append the per-interval
   * DELTA (reset-aware, zero skipped), then prune samples past retention. Never throws (the start() timer
   * also guards). `now` is injectable so a test drives the tick directly with no real wait.
   */
  tick(now: Date = new Date()): void {
    const nowIso = now.toISOString();
    for (const s of this.deps.db.listLiveSessions()) {
      if (this.skip(s)) continue;
      const cum = readRunUsage(s.cwd, s.engineSessionId!);
      if (!cum) continue; // missing/unreadable transcript — skip this session
      this.recordDelta(s, cum, s.engineSessionId!, nowIso);
    }
    // Retention (each tick — cheap; a second prune at the same cutoff is a no-op): drop samples older
    // than `retentionDays` so the append-only table stays bounded.
    const cutoff = new Date(now.getTime() - this.deps.retentionDays * 86_400_000).toISOString();
    try { this.deps.db.pruneUsageSamples(cutoff); } catch { /* never let prune kill the tick */ }
  }

  /**
   * Teardown sample: on a session's exit, take ONE final delta so the tail of its billed usage isn't lost
   * (the periodic tick may have missed the last segment). Reuses the same delta/reset logic, then drops
   * the in-memory last-seen entry (an exited session never ticks again). Skips run / no-transcript
   * sessions. Best-effort — the caller wraps it; this never throws on a normal path.
   */
  onSessionExit(session: Session, now: Date = new Date()): void {
    if (this.skip(session)) { this.lastSeen.delete(session.id); return; }
    const cum = readRunUsage(session.cwd, session.engineSessionId!);
    if (cum) this.recordDelta(session, cum, session.engineSessionId!, now.toISOString());
    this.lastSeen.delete(session.id);
  }

  /**
   * One-time boot backfill (idempotent via the `usage_backfill_done` app_meta marker): so the Usage page
   * isn't empty on day one, scan transcripts STILL ON DISK for every known session and seed ONE coarse
   * historical sample per session — the whole transcript's cumulative as a single delta at the session's
   * last_activity (honest about the coarser-than-live granularity). Also seeds `lastSeen` for each
   * backfilled session so a still-LIVE one's first live tick is incremental (no double count). Marker is
   * checked FIRST and stamped LAST, so a throw simply retries next boot; a second boot is a no-op.
   */
  backfillOnce(now: Date = new Date()): number {
    const db = this.deps.db;
    if (db.getMeta(BACKFILL_MARKER_KEY) !== undefined) return 0; // already run (one-shot)
    const nowIso = now.toISOString();
    let seeded = 0;
    for (const s of db.listSessionsWithEngineId()) {
      if (this.skip(s)) continue;
      const cum = readRunUsage(s.cwd, s.engineSessionId!);
      if (!cum) continue; // transcript already pruned from disk — nothing to seed
      if (
        cum.inputTokens === 0 && cum.outputTokens === 0 &&
        cum.cacheCreationTokens === 0 && cum.cacheReadTokens === 0
      ) continue; // a zero-usage transcript contributes no sample
      const costUsd = computeRunCostUsd({ ...cum, model: cum.model });
      db.insertUsageSample({
        id: randomUUID(),
        sessionId: s.id,
        projectId: s.projectId,
        agentId: s.agentId ?? null,
        model: cum.model,
        ts: s.lastActivity || nowIso,
        inputTokens: cum.inputTokens,
        outputTokens: cum.outputTokens,
        cacheCreationTokens: cum.cacheCreationTokens,
        cacheReadTokens: cum.cacheReadTokens,
        costUsd,
      });
      this.lastSeen.set(s.id, {
        engineSessionId: s.engineSessionId!,
        inputTokens: cum.inputTokens,
        outputTokens: cum.outputTokens,
        cacheCreationTokens: cum.cacheCreationTokens,
        cacheReadTokens: cum.cacheReadTokens,
      });
      seeded++;
    }
    db.setMeta(BACKFILL_MARKER_KEY, nowIso); // stamp LAST — the one-shot guarantee
    return seeded;
  }

  start(): void {
    this.timer = setInterval(
      () => { try { this.tick(); } catch { /* never let a bad tick kill the loop */ } },
      this.deps.intervalMs,
    );
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
