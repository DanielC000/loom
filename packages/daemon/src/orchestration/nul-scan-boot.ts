// Boot-time NUL-filled-file scan for crash recovery (card 5643ce01) — the scheduling + hand-off half; the
// per-worktree scan itself is `scanWorktreeForNulFilledFiles` (git/worktrees.ts).
//
// Why a module: index.ts's crash-recovery branch used to scan inline, which (a) put the whole scan on boot's
// critical path and (b) could not be tested without booting a daemon. Here the scan STARTS EARLY as a promise
// (it overlaps the rest of boot) and is AWAITED only where recovery needs it, behind one hard budget.
import { withTimeout } from "../git/bounded.js";
import { scanWorktreeForNulFilledFiles, type NulFilledScan } from "../git/worktrees.js";
import type { SessionService } from "../sessions/service.js";

/** Overall wall-clock budget for ALL candidate scans. A scan still outstanding when it expires resolves as
 *  "not scanned" and recovery proceeds — a HUNG fs read is never retried (the worktree-GC threadpool-leak
 *  lesson: retrying a hung fs op leaks libuv threadpool threads); the one stuck read is simply abandoned. */
export const NUL_SCAN_TOTAL_BUDGET_MS = 20_000;
/** Worktrees scanned concurrently (small: each scan is a git child plus up to a few hundred tiny reads).
 *  Up to this many ABANDONED hung threadpool reads can coexist (one per lane). The supervisor and the CLI set
 *  UV_THREADPOOL_SIZE=16, but a bare `pnpm daemon` keeps libuv's default of 4, so keep this below that. */
export const NUL_SCAN_PARALLELISM = 3;

export type NulScanMap = Map<string, NulFilledScan | undefined>;

export interface NulScanBootDeps {
  getWorktreePath: (workerSessionId: string) => string | null | undefined;
  /** TEST SEAM — defaults to the real per-worktree scan. */
  scan?: (worktreePath: string | null | undefined) => Promise<NulFilledScan | undefined>;
  budgetMs?: number;
  parallelism?: number;
}

/**
 * Start scanning every candidate's worktree. NEVER rejects and NEVER outlives `budgetMs` by more than a
 * timer tick: each scan is raced against the REMAINING budget, so a read that never settles costs at most the
 * budget, resolves that worker as "not scanned" (absent from the map), and lets recovery run. The returned map
 * is a snapshot — a scan that settles after the budget can never mutate it.
 *
 * Race note (a human resuming or stopping a candidate through the UI while this runs): the scan is read-only,
 * keyed by worker id, and consumed only for workers `recoverCrashOrphanedWorkers` itself then resumes, so a
 * session a human already resumed/stopped is handled by that method's existing paths and a stale result can
 * only ever add an advisory line.
 */
export function startNulFilledScan(candidates: readonly { workerSessionId: string }[], deps: NulScanBootDeps): Promise<NulScanMap> {
  const scan = deps.scan ?? ((p) => scanWorktreeForNulFilledFiles(p));
  const budgetMs = deps.budgetMs ?? NUL_SCAN_TOTAL_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const results: NulScanMap = new Map();
  const queue = [...candidates];
  // Why the snapshot can't be mutated late: a scan that outlives its budget makes `withTimeout` REJECT before
  // `results.set` runs (the late value is never awaited by anyone), and the lanes have all finished by the
  // time the map is copied with `new Map(results)` below.
  const lane = async (): Promise<void> => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return; // budget spent: leave the rest unscanned
      try {
        const r = await withTimeout(scan(deps.getWorktreePath(c.workerSessionId)), remaining, "nul-filled file scan");
        results.set(c.workerSessionId, r);
      } catch { /* timed out or failed: this worker is simply not scanned */ }
    }
  };
  const lanes = Array.from({ length: Math.max(1, Math.min(deps.parallelism ?? NUL_SCAN_PARALLELISM, queue.length)) }, () => lane());
  return Promise.all(lanes).then(
    () => {
      const flagged = [...results.values()].filter((s) => s && s.count > 0).length;
      if (flagged > 0) console.warn(`[boot] crash recovery: ${flagged} worker worktree(s) hold NUL-filled files (named in the recovery notices)`);
      if (queue.length > 0 || results.size < candidates.length) {
        console.warn(`[boot] crash recovery: NUL-file scan covered ${results.size} of ${candidates.length} worktree(s) (budget ${budgetMs}ms; the rest were not scanned)`);
      }
      return new Map(results);
    },
    () => new Map(),
  );
}

/**
 * The crash-recovery hand-off: await the (already running) scan, then run recovery WITH its result map. A
 * missing/failed scan yields recovery without the map, i.e. today's text. Exists so the hand-off — the one
 * thing a dropped `nulScanByWorkerId` would silently break — is covered by a test.
 */
export async function recoverCrashOrphanedWorkersWithNulScan(
  sessions: Pick<SessionService, "recoverCrashOrphanedWorkers">,
  candidates: Parameters<SessionService["recoverCrashOrphanedWorkers"]>[0],
  opts: NonNullable<Parameters<SessionService["recoverCrashOrphanedWorkers"]>[1]>,
  scanPromise: Promise<NulScanMap> | undefined,
): Promise<ReturnType<SessionService["recoverCrashOrphanedWorkers"]>> {
  let nulScanByWorkerId: NulScanMap | undefined;
  try { nulScanByWorkerId = await scanPromise; } catch { /* recovery never depends on the scan */ }
  return sessions.recoverCrashOrphanedWorkers(candidates, nulScanByWorkerId ? { ...opts, nulScanByWorkerId } : opts);
}
