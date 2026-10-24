import fs from "node:fs";
import type { Db } from "../db.js";
import { PROJECTS_WORK_ROOT, UUID_SHAPE_RE } from "../paths.js";

/**
 * @decision 3b65028c — VISIBILITY ONLY: never add an automatic re-delete/removal sweep to this module;
 * that is its own worktree-deletion-class card + Code Review, not an extension of this one.
 */
export interface OrphanedProjectWorkDirEntry {
  dirName: string;
}

export interface OrphanedProjectWorkDirsResult {
  /** The TRUE total count of orphaned dirs found — can exceed `entries.length` (see `listMax` below). */
  count: number;
  /** Bounded list of orphan dir names — see {@link ORPHANED_PROJECT_WORK_DIRS_LIST_MAX}. Never carries
   *  byte sizes (visibility-only; a human who wants to size one up to decide whether to clean it up by
   *  hand can `du`/`Get-ChildItem` the path themselves — this module exists to name it, not measure it). */
  entries: OrphanedProjectWorkDirEntry[];
  /** True when the scan itself hit its own entry bound — `count`/`entries` may then be a partial result,
   *  never silently presented as complete. */
  truncated: boolean;
  computedAt: string | null;
}

const INITIAL_RESULT: OrphanedProjectWorkDirsResult = { count: 0, entries: [], truncated: false, computedAt: null };

let cached: OrphanedProjectWorkDirsResult = INITIAL_RESULT;
let refreshInFlight: Promise<OrphanedProjectWorkDirsResult> | null = null;

/** Defensive cap on `PROJECTS_WORK_ROOT`'s own top-level entries visited — mirrors
 *  `STALE_ASIDE_SCAN_MAX_ENTRIES` (git/worktrees.ts). Never expected to be hit in practice: this is one
 *  level of `readdirSync` (directory NAMES only, no descent into a candidate's own content). */
export const ORPHANED_PROJECT_WORK_DIRS_SCAN_MAX_ENTRIES = 20_000;

/** How many orphan dir names to keep in the reported list — `count` above is always the true total,
 *  independent of this cap. */
export const ORPHANED_PROJECT_WORK_DIRS_LIST_MAX = 20;

/** Same floor shape as `project-work-dir-usage.ts`'s `MIN_REFRESH_INTERVAL_MS`, for the same reason:
 *  `served_status` is read ad hoc, not on one fixed interval, and this is a WARN-grade visibility figure
 *  that never needs to be fresher than a few minutes. */
const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Synchronous, in-memory read of the last-computed figure — never touches disk or the DB. This is what
 *  `served-status.ts` calls on its own read path. */
export function getCachedOrphanedProjectWorkDirs(): OrphanedProjectWorkDirsResult {
  return cached;
}

/** TEST SEAM ONLY — reset the module-level cache between independently-scoped test scenarios. */
export function __resetOrphanedProjectWorkDirsCacheForTest(): void {
  cached = INITIAL_RESULT;
  refreshInFlight = null;
}

/** TEST SEAM ONLY — directly set the cache to an arbitrary value, mirroring
 *  `__setProjectsWorkRootUsageCacheForTest` — lets a test prove `buildServedStatus` genuinely propagates
 *  whatever the cache holds, and that the read path never performs its own scan. */
export function __setOrphanedProjectWorkDirsCacheForTest(value: OrphanedProjectWorkDirsResult): void {
  cached = value;
}

/**
 * Pure scan core (no DB, no cache) — a single-level `readdirSync` of `root`, reporting every
 * UUID-shaped directory entry whose name is NOT in `knownIds` as orphaned. Never throws: a
 * missing/unreadable `root` reports an honest empty result, not a failure.
 *
 * @decision 3b65028c (round 2) — never drop the UUID-shape filter: `LOOM_PROJECT_WORK_ROOT` is a
 * human-settable override that may point at an existing populated directory, and a non-UUID-shaped entry
 * there is bystander content, never an orphaned project work dir.
 */
export function findOrphanedProjectWorkDirs(
  root: string,
  knownIds: ReadonlySet<string>,
  bounds: { maxEntries: number; listMax: number } = {
    maxEntries: ORPHANED_PROJECT_WORK_DIRS_SCAN_MAX_ENTRIES,
    listMax: ORPHANED_PROJECT_WORK_DIRS_LIST_MAX,
  },
): { count: number; entries: OrphanedProjectWorkDirEntry[]; truncated: boolean } {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { count: 0, entries: [], truncated: false }; // root missing/unreadable — nothing to report
  }
  let count = 0;
  let truncated = false;
  const entries: OrphanedProjectWorkDirEntry[] = [];
  let visited = 0;
  for (const d of dirents) {
    if (visited >= bounds.maxEntries) {
      truncated = true;
      break;
    }
    visited++;
    if (!d.isDirectory()) continue;
    if (!UUID_SHAPE_RE.test(d.name)) continue; // not a Loom-assigned project id shape — bystander content, never an orphan
    if (knownIds.has(d.name)) continue; // matches a real project row (active OR archived) — never an orphan
    count++;
    if (entries.length < bounds.listMax) entries.push({ dirName: d.name });
  }
  return { count, entries, truncated };
}

/**
 * Recompute the cache. Dedupes: a refresh already in flight is returned to a concurrent caller instead of
 * starting a second one. Never throws.
 *
 * @decision 3b65028c (round 2) — a db read failure must never degrade to an empty known-id set and run
 * the scan anyway (every real project dir would read "orphaned"); skip the scan, warn, keep the cache.
 *
 * `bounds` (optional) mirrors `refreshProjectsWorkRootUsage`'s own override — an OVERRIDE call never joins
 * the shared in-flight dedupe or writes to the module-level `cached`, same isolation discipline as that
 * sibling module (decision 2c9f0854), so a test can force `truncated:true` cheaply without poisoning what
 * `getCachedOrphanedProjectWorkDirs()`/`buildServedStatus` report.
 */
export async function refreshOrphanedProjectWorkDirs(
  db: Db,
  bounds?: { maxEntries: number; listMax: number },
): Promise<OrphanedProjectWorkDirsResult> {
  const isDefaultCall = bounds === undefined;
  if (isDefaultCall && refreshInFlight) return refreshInFlight;
  const run = (async (): Promise<OrphanedProjectWorkDirsResult> => {
    let knownIds: Set<string>;
    try {
      knownIds = new Set([...db.listAllProjects(), ...db.listArchivedProjects()].map((p) => p.id));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[orphaned-project-work-dirs] db read failed — skipping this refresh, keeping previous cache: ${e instanceof Error ? e.message : String(e)}`);
      return cached;
    }
    const scan = findOrphanedProjectWorkDirs(PROJECTS_WORK_ROOT, knownIds, bounds);
    const result: OrphanedProjectWorkDirsResult = { ...scan, computedAt: new Date().toISOString() };
    if (isDefaultCall) cached = result;
    return result;
  })();
  if (!isDefaultCall) return run;
  refreshInFlight = run;
  try {
    return await run;
  } finally {
    refreshInFlight = null;
  }
}

/**
 * Fire-and-forget kick (never awaited, never throws) — called opportunistically on every `served_status`
 * read, same shape as `kickProjectsWorkRootUsageRefresh`/`kickScratchLargestDirsRefresh`. Throttled to
 * {@link MIN_REFRESH_INTERVAL_MS}; a refresh already genuinely in flight is still deduped inside
 * `refreshOrphanedProjectWorkDirs` itself.
 */
export function kickOrphanedProjectWorkDirsRefresh(db: Db): void {
  if (cached.computedAt && Date.now() - new Date(cached.computedAt).getTime() < MIN_REFRESH_INTERVAL_MS) return;
  refreshOrphanedProjectWorkDirs(db).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[orphaned-project-work-dirs] background refresh failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}
