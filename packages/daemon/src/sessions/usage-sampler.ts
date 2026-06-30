import { randomUUID } from "node:crypto";
import type { Session } from "@loom/shared";
import type { Db } from "../db.js";
import { readRunUsage, type RunUsageStats } from "./context.js";
import { computeRunCostUsd } from "./pricing.js";

/** app_meta one-time marker for the boot backfill (same fire-exactly-once pattern as the first-run /
 *  archived_at / held backfills). Daemon-GLOBAL (app_meta is not project-scoped); set once per LOOM_HOME. */
const BACKFILL_MARKER_KEY = "usage_backfill_done";

/** app_meta one-time marker for the corrective reset that ships the restart-double-count fix. The boot that
 *  first deploys this code wipes the (inflated) samples + clears BACKFILL_MARKER_KEY so the corrected
 *  backfill repopulates clean; every later boot is a no-op. Bump the suffix if a future correction needs to
 *  re-run. See `correctiveResetOnce`. */
const RESET_MARKER_KEY = "usage_samples_reset_v1";

/** A session's last-seen CUMULATIVE token snapshot, tagged with the engine transcript it came from. The tag
 *  guards the FORK/RECYCLE case — those rotate to a fresh engine id → a brand-new transcript whose cumulative
 *  starts at 0 — so a mid-run rotation is detected as a fresh segment. (A plain `--resume` does NOT rotate:
 *  it reuses the same engine id + the SAME transcript file, which still holds the full pre-restart cumulative
 *  — so restart-safety rides on the DB-aware first-sight baseline, not on this tag. See the class doc.) */
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
 * delta is `current_cumulative − lastSeen[sessionId]`, with two correctness wrinkles:
 *
 *  • **Mid-run rotation (FORK/RECYCLE):** `readRunUsage` is monotonic WITHIN one transcript, but a fork or
 *    recycle rotates to a new engine id → a new transcript whose cumulative restarts at 0. When the engine
 *    id changed (or any cumulative dropped) we treat it as a fresh segment and the delta IS the new
 *    cumulative (never subtract → never emit a negative).
 *
 *  • **Restart double-count (the load-bearing one):** `lastSeen` is IN-MEMORY and wiped on every daemon
 *    restart, and a plain `--resume` REUSES the same engine id + the SAME transcript file — which still
 *    holds the full pre-restart cumulative. So a naive first-sight delta (`prev === undefined` → emit the
 *    whole cumulative) would re-count, on every restart, everything a still-live session already recorded.
 *    The fix: first-sight is DB-AWARE — delta = `current_cumulative − the session's already-persisted SUM`
 *    (`db.usagePersistedTotalsBySession`, snapshotted once per process). A session resumed across the
 *    restart counts only the UNCOUNTED remainder (incl. the gap-window usage between its last sample and
 *    the restart — exact, unlike a seed-only "emit nothing" prime); a genuinely new session (no prior rows)
 *    still counts its full cumulative-so-far. This makes priming automatic on EVERY boot (the first tick
 *    self-corrects) — independent of the one-time backfill marker. `correctiveResetOnce` is the one-shot
 *    that scrubs the historical inflation this fix corrects.
 */
export class UsageSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Per-session last-seen cumulative usage (in-memory; re-derivable from the transcript). */
  private lastSeen = new Map<string, LastSeen>();
  /** Lazily-snapshotted per-session already-persisted token totals — the restart-safe baseline for a
   *  first-sight delta. Loaded once on first need (essentially boot, before any new row this process), so it
   *  reflects pure pre-boot persisted state; a session's own baseline can't change before its first sight. */
  private persistedBaseline: Map<string, { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }> | null = null;
  constructor(private deps: UsageSamplerDeps) {}

  /** The already-persisted token total for ONE session (zeros when it has no prior rows) — the first-sight
   *  baseline. Snapshots the whole table once (single GROUP BY) and caches it; see `persistedBaseline`. */
  private baselineFor(sessionId: string): { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number } {
    if (!this.persistedBaseline) this.persistedBaseline = this.deps.db.usagePersistedTotalsBySession();
    return this.persistedBaseline.get(sessionId)
      ?? { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }

  /**
   * Compute the DELTA of `cum` (a session's current cumulative transcript usage) against its last-seen
   * snapshot, advance `lastSeen`, and append a sample row UNLESS the delta is all-zero (no change → no
   * row). Reset-aware: a changed transcript (engine id) or any dropped cumulative ⇒ the whole new
   * cumulative is the delta. Returns true iff a row was written.
   */
  private recordDelta(session: Session, cum: RunUsageStats, eng: string, ts: string): boolean {
    const prev = this.lastSeen.get(session.id);
    // Three cases, each subtracting a different baseline so a row is always the genuinely-uncounted slice:
    //  • FIRST SIGHT (no in-memory prev — fresh process / post-restart): subtract the session's ALREADY-
    //    PERSISTED sum. A plain --resume reuses the same transcript (full pre-restart cumulative intact), so
    //    this counts only the remainder; a brand-new session (baseline 0) counts its full cumulative-so-far.
    //  • MID-RUN ROTATION (prev exists but engine id changed → fork/recycle's new transcript, or a defensive
    //    cumulative drop): the new transcript starts at 0 and is wholly uncounted → delta IS its cumulative.
    //  • STEADY STATE: incremental vs the in-memory snapshot.
    // Every branch clamps at 0 so we never emit a negative.
    const base = !prev
      ? this.baselineFor(session.id)
      : (prev.engineSessionId !== eng || cum.inputTokens < prev.inputTokens)
        ? { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
        : prev;
    const delta = {
      inputTokens: Math.max(0, cum.inputTokens - base.inputTokens),
      outputTokens: Math.max(0, cum.outputTokens - base.outputTokens),
      cacheCreationTokens: Math.max(0, cum.cacheCreationTokens - base.cacheCreationTokens),
      cacheReadTokens: Math.max(0, cum.cacheReadTokens - base.cacheReadTokens),
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
   * One-shot CORRECTIVE RESET (idempotent via the `usage_samples_reset_v1` app_meta marker) — the boot that
   * first deploys the restart-double-count fix. Every prior daemon restart re-emitted each still-live
   * session's whole cumulative (first-sight before the DB-aware fix), so the historical
   * `session_usage_samples` is inflated (≈ N× for a session that survived N restarts). Because that table is
   * pure DERIVED data — re-seedable from the on-disk transcripts via the backfill — the clean fix is to
   * scrub it and rebuild: clear the samples + clear the `usage_backfill_done` marker so the (now-corrected)
   * `backfillOnce` re-runs and repopulates from scratch, then ticks accrue exactly from there. MUST run
   * BEFORE `backfillOnce` at boot. Runs exactly once (marker checked FIRST, stamped LAST → a throw simply
   * retries next boot; a second boot is a no-op). Touches ONLY the derived table + the two markers. Returns
   * the number of inflated rows cleared.
   */
  correctiveResetOnce(now: Date = new Date()): number {
    const db = this.deps.db;
    if (db.getMeta(RESET_MARKER_KEY) !== undefined) return 0; // already corrected (one-shot)
    const cleared = db.clearUsageSamples();          // scrub the inflated derived data
    db.deleteMeta(BACKFILL_MARKER_KEY);              // let backfillOnce re-seed clean from transcripts
    this.lastSeen.clear();                           // drop any stale in-memory snapshots
    this.persistedBaseline = null;                   // force a fresh baseline snapshot after the rebuild
    db.setMeta(RESET_MARKER_KEY, now.toISOString()); // stamp LAST — the one-shot guarantee
    return cleared;
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
