import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import { lastSweepMetaKey, sweepProjectMemoryDuplicates } from "../sessions/project-memory-dedup-report.js";

export interface MemoryDedupWatcherDeps {
  db: Db;
  /** Tick cadence override in ms (tests use a short interval). Production default: 1h — the per-project
   *  cadence itself is hours-granular (`memory.duplicateReportIntervalHours`), so a coarse outer tick is
   *  enough; it only decides how promptly a newly-due project is noticed, not the report cadence itself. */
  intervalMs?: number;
}

const DEFAULT_TICK_MS = 60 * 60_000;

/**
 * Periodic likely-duplicate-notes report ticker (card 446d97f0, following b1f34988's write-time
 * advisory) — structural twin of `DbBackupWatcher`/`ResumeDocWatcher`: a daemon-internal `setInterval`
 * tick, no scheduling lib, best-effort, never throws. Deliberately NOT the Scheduler (Pillar B): booting
 * an agent session there would violate this feature's own zero-metered-tokens requirement.
 *
 * @decision 446d97f0
 *
 * Per-project single-flight: a project already mid-sweep is skipped on a later tick (`inFlight`), never
 * queued or stacked. `stop()` honors the existing watcher teardown shape (index.ts's graceful-shutdown
 * line) — it stops scheduling new ticks AND flips `stopped`, which `sweepProjectMemoryDuplicates`'s own
 * chunked loop checks before every item, so an in-flight sweep bails within one query's latency rather
 * than running to completion after the daemon has asked every other watcher to stop.
 */
export class MemoryDedupWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Set<string>();
  private stopped = false;
  constructor(private deps: MemoryDedupWatcherDeps) {}

  /** One tick: sweep every project whose resolved cadence is due. Exposed so a test can drive it
   *  directly without waiting on the real interval. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.stopped) return;
    const { db } = this.deps;
    const nowMs = now.getTime();
    for (const project of db.listProjects()) {
      if (this.inFlight.has(project.id)) continue;
      const cfg = resolveConfig(project.config).memory;
      if (cfg.duplicateReportIntervalHours <= 0) continue; // disabled for this project
      const lastIso = db.getMeta(lastSweepMetaKey(project.id));
      const lastMs = lastIso ? Date.parse(lastIso) : 0;
      if (nowMs - lastMs < cfg.duplicateReportIntervalHours * 3_600_000) continue; // not due yet
      this.inFlight.add(project.id);
      void this.runOne(project.id, now).finally(() => this.inFlight.delete(project.id));
    }
  }

  private async runOne(projectId: string, now: Date): Promise<void> {
    try {
      await sweepProjectMemoryDuplicates(this.deps.db, projectId, () => this.stopped, now);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[memory-dedup-watcher] sweep failed for project ${projectId} (continuing): ${(err as Error).message}`);
    }
  }

  start(): void {
    this.timer = setInterval(() => { void this.tick().catch(() => { /* never let a bad tick kill the loop */ }); }, this.deps.intervalMs ?? DEFAULT_TICK_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
