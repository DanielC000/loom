import fs from "node:fs";
import { removeWorktree, type BoundedGitDeps } from "./worktrees.js";

/**
 * Board card bd9fc808 — the ROOT-CAUSE follow-up to 460d3178 (which only backgrounded boot's own GC
 * pass so a dangling worktree couldn't wedge the port bind). THIS module reduces the danglers at the
 * source: on Windows, {@link removeWorktree}'s filesystem backstop can swallow-and-leave-on-disk when a
 * just-exited worker's directory handle lags release (an OS indexer/Defender scan of the fresh ~270MB
 * node_modules, or a detached watcher) — see removeWorktree's docstring. Previously that dir sat
 * untouched until the NEXT daemon boot's Pass B. Instead, `finalizeMerge` and Pass B now `enqueue` a
 * swallowed removal HERE, and this retries it in the background, in-session, every {@link sweepOnce}
 * tick — so it's cleaned within minutes of the merge once the OS releases the handle, not left to
 * accumulate across the project's history.
 *
 * Reuses {@link removeWorktree} VERBATIM for every retry — this is a SCHEDULING wrapper, not new
 * deletion logic, so all of removeWorktree's P0 SAFE-TO-DISCARD guards (documented on that function and
 * its callers) stay exactly as load-bearing as before. This module never decides WHAT is safe to
 * delete, only WHEN to retry a removal that removeWorktree's caller already decided was safe.
 *
 * OFF the hot path, best-effort, and never throws past `enqueue`/`sweepOnce` — a stuck entry is retried
 * up to {@link WorktreeGcDeps.maxAttempts} times or {@link WorktreeGcDeps.maxAgeMs} of wall-clock,
 * whichever comes first, then given up on (left for the next boot's Pass B, unchanged from before this
 * module existed — never worse than the old behavior, only better on the common path). Retries run
 * SERIALLY within one sweep (never concurrently) to respect the libuv threadpool caveat documented on
 * removeWorktree: a stuck `fs.rm` occupies one threadpool slot until its handle releases, so firing many
 * at once could exhaust the pool; one at a time bounds that to a single slot.
 */
export interface WorktreeGcDeps extends BoundedGitDeps {
  /** Cadence between retry sweeps, in ms. Default 30s. Tests pass a tiny value to avoid a real wait. */
  intervalMs?: number;
  /** Give up on an entry after this many retry attempts. Default 20 (~10min at the default cadence). */
  maxAttempts?: number;
  /** Give up on an entry after this much wall-clock time since it was first enqueued. Default 10 minutes. */
  maxAgeMs?: number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_MAX_AGE_MS = 10 * 60_000;

interface QueuedRemoval {
  repoPath: string;
  worktreePath: string;
  attempts: number;
  firstEnqueuedAt: number;
}

/**
 * The in-session background retry queue for a worktree removal `removeWorktree` swallowed (left on
 * disk). One instance is shared for the daemon's whole lifetime (owned by SessionService); `enqueue` is
 * idempotent per `worktreePath` so a repeated swallow (e.g. Pass B re-attempting a dir this same
 * instance already queued) doesn't create a duplicate retry. The sweep timer is SELF-ARMING: it starts
 * on the first `enqueue` and stops itself once the queue drains, so an idle daemon (the common case —
 * most removals succeed on the first try) never pays for a standing timer.
 */
export class WorktreeGc {
  private queue = new Map<string, QueuedRemoval>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(private deps: WorktreeGcDeps = {}) {}

  /** Number of removals currently queued for retry — exposed for logging/tests, not load-bearing. */
  get pending(): number {
    return this.queue.size;
  }

  /** Queue `worktreePath` for background retry. No-op if it's already queued. Arms the sweep timer. */
  enqueue(repoPath: string, worktreePath: string): void {
    if (this.queue.has(worktreePath)) return;
    this.queue.set(worktreePath, { repoPath, worktreePath, attempts: 0, firstEnqueuedAt: Date.now() });
    this.armTimer();
  }

  private armTimer(): void {
    if (this.timer) return;
    const timer = setInterval(() => {
      void this.sweepOnce();
    }, this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    timer.unref?.(); // never keep the process alive on this timer alone
    this.timer = timer;
  }

  /**
   * One retry pass over every queued entry, SERIALLY (see the threadpool caveat above). Exposed so a
   * test can drive retries deterministically instead of waiting on a real timer. Never throws: a
   * per-entry failure is swallowed (it just stays queued for the next sweep, or is given up on past its
   * bound) so one bad entry can't stall the rest of the queue or crash the timer callback.
   */
  async sweepOnce(): Promise<void> {
    if (this.sweeping) return; // a prior sweep is still in flight (e.g. a slow removal) — don't overlap
    this.sweeping = true;
    try {
      const maxAttempts = this.deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      const maxAgeMs = this.deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
      for (const [key, entry] of [...this.queue]) {
        if (!fs.existsSync(entry.worktreePath)) {
          // Removed some other way (or already gone) since it was queued — nothing left to retry.
          this.queue.delete(key);
          continue;
        }
        if (entry.attempts >= maxAttempts || Date.now() - entry.firstEnqueuedAt > maxAgeMs) {
          // eslint-disable-next-line no-console
          console.warn(`[worktree-gc] giving up on ${entry.worktreePath} after ${entry.attempts} attempt(s) — left on disk for the next boot's reconcile (unchanged from pre-existing behavior)`);
          this.queue.delete(key);
          continue;
        }
        entry.attempts++;
        try {
          const removed = await removeWorktree(entry.repoPath, entry.worktreePath, this.deps);
          if (removed) {
            // eslint-disable-next-line no-console
            console.log(`[worktree-gc] removed stuck worktree ${entry.worktreePath} on in-session retry ${entry.attempts}`);
            this.queue.delete(key);
          }
        } catch {
          // removeWorktree is itself best-effort and should never throw; stay defensive anyway — the
          // entry simply stays queued for the next sweep.
        }
      }
    } finally {
      this.sweeping = false;
      if (this.queue.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }
  }

  /** Stop the sweep timer (daemon shutdown / tests). Queued entries are dropped, not retried further. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
