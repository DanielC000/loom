import type { Db } from "../db.js";
import { SCRATCH_ROOT_DIR } from "../paths.js";
import {
  classifyScratchDirResumability,
  measureScratchRootDirSizes,
  type ScratchDirResumability,
  type ScratchGcDeps,
} from "./scratch-gc.js";
import { listAllTranscriptIds } from "../pty/claude-transcript.js";
import { engineTranscriptExists } from "./transcript.js";

/**
 * Card 0e701396 — the top-N-largest-scratch-dirs reporter for `served_status`'s `scratchLargestDirs`.
 * Mirrors `project-work-dir-usage.ts`'s own shape exactly (card 5eace211's precedent for this project):
 * a plain synchronous in-memory cache read on `served_status`'s hot read path, refreshed by a throttled,
 * fire-and-forget BACKGROUND walk — never a fresh synchronous walk on the read itself.
 *
 * WARN-only, visibility-only, by design (owner directive on card 0e701396's investigation phase: never
 * auto-delete a resumable session's data without a human action) — this module never removes anything;
 * it only names the largest offenders so a human can act, the same binding condition cards 2c8589c9/
 * 9775559c/1a686bad already established for this scratch root's other served_status signals.
 */
export interface ScratchLargestDirEntry {
  id: string;
  bytes: number;
  /** Whole days since the row's own `lastActivity` — 0 when there is no row to derive it from
   *  (`resumability:"no-row"`). Compare against `SCRATCH_GC_GRACE_MS` (scratch-gc.ts) yourself; this
   *  reporter deliberately does not fold the grace period in (see `classifyScratchDirResumability`'s doc). */
  ageDays: number;
  resumability: ScratchDirResumability;
}

export interface ScratchLargestDirsCache {
  entries: ScratchLargestDirEntry[];
  computedAt: string | null;
}

const INITIAL_CACHE: ScratchLargestDirsCache = { entries: [], computedAt: null };

let cached: ScratchLargestDirsCache = INITIAL_CACHE;
let refreshInFlight: Promise<ScratchLargestDirsCache> | null = null;

/** How many of the largest dirs to report — the manager's own decision on card 0e701396 (N=5). */
export const SCRATCH_LARGEST_DIRS_N = 5;

/** Same floor shape as `project-work-dir-usage.ts`'s `MIN_REFRESH_INTERVAL_MS` and for the same reason:
 *  `served_status` is read ad hoc by any agent/human at will, not on one fixed interval, but without a
 *  floor a busy fleet re-kicking this on every read would re-walk the whole scratch root (plus, for any
 *  claude-harness candidate among the top N, a `~/.claude/projects` scan) far more often than this
 *  WARN-grade figure needs to be fresh. */
const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Synchronous, in-memory read of the last-computed top-N — never touches disk or the DB. This is what
 *  `served-status.ts` calls on its own read path. */
export function getCachedScratchLargestDirs(): ScratchLargestDirEntry[] {
  return cached.entries;
}

/** TEST SEAM ONLY — reset the module-level cache between independently-scoped test scenarios. */
export function __resetScratchLargestDirsCacheForTest(): void {
  cached = INITIAL_CACHE;
  refreshInFlight = null;
}

/** TEST SEAM ONLY — directly set the cache to an arbitrary value, mirroring
 *  `__setProjectsWorkRootUsageCacheForTest`. Used both to prove `buildServedStatus` genuinely propagates
 *  whatever the cache holds, and (card 0e701396 DoD) to prove the READ path never performs its own walk:
 *  a fabricated value that contradicts real on-disk state can only come back unchanged if nothing on the
 *  read path recomputed it. */
export function __setScratchLargestDirsCacheForTest(value: ScratchLargestDirsCache): void {
  cached = value;
}

/**
 * Recompute the cache: bucket per-top-level-dir bytes (`measureScratchRootDirSizes`), keep the largest
 * `n`, then classify ONLY those `n` via the shared, pure `classifyScratchDirResumability` (card 0e701396)
 * — the same predicates 2-5 `sweepUnresumableScratchDirs` itself uses, so this reporter and the real GC
 * can never answer "is this dir resumable" two different ways. Dedupes: a refresh already in flight is
 * returned to a concurrent caller instead of starting a second one. Never throws — degrades to the
 * previous cache on failure (best-effort, same posture as `refreshProjectsWorkRootUsage`).
 */
export async function refreshScratchLargestDirs(
  db: Db,
  n: number = SCRATCH_LARGEST_DIRS_N,
  deps: Pick<ScratchGcDeps, "transcriptIds" | "codexTranscriptExists"> = {},
): Promise<ScratchLargestDirsCache> {
  if (refreshInFlight) return refreshInFlight;
  const run = (async (): Promise<ScratchLargestDirsCache> => {
    const sizes = measureScratchRootDirSizes(SCRATCH_ROOT_DIR);
    sizes.sort((a, b) => b.bytes - a.bytes);
    const top = sizes.slice(0, n);

    // ONE pass over `~/.claude/projects`, shared across every claude-harness candidate in the top N —
    // same discipline `sweepUnresumableScratchDirs` itself uses, never per-candidate. `deps` mirrors
    // `ScratchGcDeps` — a test injects a fixed set/function instead of touching the real
    // `~/.claude/projects`/`~/.codex/sessions` trees; the real boot-side kick never passes either.
    const liveTranscriptIds = deps.transcriptIds ?? listAllTranscriptIds();
    const codexTranscriptExists = deps.codexTranscriptExists ?? ((cwd, id) => engineTranscriptExists(cwd, id, "codex"));
    const nowMs = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;

    const entries: ScratchLargestDirEntry[] = top.map(({ name, bytes }) => {
      const classification = classifyScratchDirResumability(db, name, { transcriptIds: liveTranscriptIds, codexTranscriptExists });
      const ageDays = classification.row
        ? Math.max(0, Math.floor((nowMs - Date.parse(classification.row.lastActivity)) / DAY_MS))
        : 0;
      return { id: name, bytes, ageDays, resumability: classification.status };
    });

    const result: ScratchLargestDirsCache = { entries, computedAt: new Date().toISOString() };
    cached = result;
    return result;
  })();
  refreshInFlight = run;
  try {
    return await run;
  } finally {
    refreshInFlight = null;
  }
}

/**
 * Fire-and-forget kick (never awaited, never throws) — called opportunistically on every `served_status`
 * read, same shape as `kickProjectsWorkRootUsageRefresh`. Throttled to {@link MIN_REFRESH_INTERVAL_MS}; a
 * refresh already genuinely in flight is still deduped inside `refreshScratchLargestDirs` itself.
 */
export function kickScratchLargestDirsRefresh(db: Db): void {
  if (cached.computedAt && Date.now() - new Date(cached.computedAt).getTime() < MIN_REFRESH_INTERVAL_MS) return;
  refreshScratchLargestDirs(db).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[scratch-largest-dirs] background refresh failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}
