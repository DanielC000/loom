import fs from "node:fs";
import type { Db } from "../db.js";
import { PROJECT_WORK_DIR_WARN_BYTES, measureDirBytesBoundedAsync, projectWorkDir } from "../paths.js";

/**
 * The fleet-wide `PROJECTS_WORK_ROOT` usage figure `served_status` reports — read via
 * {@link getCachedProjectsWorkRootUsage} (a plain synchronous in-memory read, however stale) and
 * refreshed here in the background, scoped to real known project ids only, never arbitrary directory
 * entries.
 *
 * @decision 5eace211 — never make `served_status` walk the filesystem on its own read path, and never
 * widen the refresh's scope beyond real, currently-known project ids: a human-set `LOOM_PROJECT_WORK_ROOT`
 * could point at an existing populated directory with nothing to do with Loom.
 */
export interface ProjectsWorkRootUsage {
  bytes: number;
  truncated: boolean;
  overCeiling: boolean;
  computedAt: string | null;
}

const INITIAL_USAGE: ProjectsWorkRootUsage = { bytes: 0, truncated: false, overCeiling: false, computedAt: null };

let cached: ProjectsWorkRootUsage = INITIAL_USAGE;
let refreshInFlight: Promise<ProjectsWorkRootUsage> | null = null;

/** Per-project walk bound — generous enough for a real monorepo build+cache population, bounded so a
 *  pathological directory can never block the refresh indefinitely. */
const PER_PROJECT_MAX_ENTRIES = 200_000;
const PER_PROJECT_MAX_MS = 5_000;

/** Card 5eace211 Code Review MINOR 3 — the floor below which {@link kickProjectsWorkRootUsageRefresh}
 *  skips firing a new background walk: `served_status` is read on every poll (not just human-triggered),
 *  so without a floor every single read re-kicks a fresh recursive walk the instant the prior one settles
 *  — real work for a figure that is, by design, only ever WARN-grade and never needs to be fresher than a
 *  few minutes. Does NOT apply to {@link refreshProjectsWorkRootUsage} itself — a caller that explicitly
 *  awaits that function (a test wanting a guaranteed-fresh figure) always gets a real walk. */
const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Synchronous, in-memory read of the last-computed figure — never touches disk. */
export function getCachedProjectsWorkRootUsage(): ProjectsWorkRootUsage {
  return cached;
}

/** TEST SEAM ONLY — reset the module-level cache between independently-scoped test scenarios. */
export function __resetProjectsWorkRootUsageCacheForTest(): void {
  cached = INITIAL_USAGE;
  refreshInFlight = null;
}

/**
 * TEST SEAM ONLY — directly set the cache to an arbitrary value (e.g. an artificially stale
 * `computedAt`, to test {@link kickProjectsWorkRootUsageRefresh}'s {@link MIN_REFRESH_INTERVAL_MS} floor
 * without waiting 5 real minutes). Card 2c9f0854 (round 3, item 4a) — since an OVERRIDE call to
 * {@link refreshProjectsWorkRootUsage} deliberately never writes to the shared cache (see that
 * function's own doc below), this is the only way a test can put a specific value into
 * `getCachedProjectsWorkRootUsage()`'s read surface without a real walk.
 */
export function __setProjectsWorkRootUsageCacheForTest(value: ProjectsWorkRootUsage): void {
  cached = value;
}

/**
 * Recompute the cache, scoped to real known project ids only (see this module's own doc). Dedupes: a
 * refresh already in flight is returned to a concurrent caller instead of starting a second one. Never
 * throws — a per-project measurement failure just contributes 0 for that project (best-effort, same
 * posture as `measureDirBytesBoundedAsync` itself).
 *
 * `bounds`/`warnBytes` (card 5eace211 Code Review MINOR 5) are OPTIONAL overrides of the per-project walk
 * cap and the per-project over-ceiling threshold — omitted, they default to the real production values
 * above. A direct caller (a test) can pass a tiny `{maxEntries:1}` or a near-zero `warnBytes` to exercise
 * `truncated:true`/`overCeiling:true` cheaply, without writing a pathological amount of real data; a real
 * production caller (the kick below) never passes either, so its behavior is byte-identical to before.
 *
 * @decision 2c9f0854 — do not let an override call join the shared in-flight dedupe or write to
 * `cached` — only the exact-default-bounds (production) call may touch either.
 */
export async function refreshProjectsWorkRootUsage(
  db: Db,
  bounds?: { maxEntries: number; maxMs: number },
  warnBytes?: number,
): Promise<ProjectsWorkRootUsage> {
  const isDefaultCall = bounds === undefined && warnBytes === undefined;
  const effectiveBounds = bounds ?? { maxEntries: PER_PROJECT_MAX_ENTRIES, maxMs: PER_PROJECT_MAX_MS };
  const effectiveWarnBytes = warnBytes ?? PROJECT_WORK_DIR_WARN_BYTES;

  if (isDefaultCall && refreshInFlight) return refreshInFlight;
  const run = (async (): Promise<ProjectsWorkRootUsage> => {
    let knownIds: string[];
    try {
      knownIds = [...db.listAllProjects(), ...db.listArchivedProjects()].map((p) => p.id);
    } catch {
      knownIds = [];
    }
    let total = 0;
    let anyTruncated = false;
    let anyOverCeiling = false;
    for (const id of knownIds) {
      const dir = projectWorkDir(id);
      let exists = false;
      try { exists = fs.existsSync(dir); } catch { /* treat as absent */ }
      if (!exists) continue;
      const { bytes, truncated } = await measureDirBytesBoundedAsync(dir, effectiveBounds);
      total += bytes;
      if (truncated) anyTruncated = true;
      if (bytes > effectiveWarnBytes) anyOverCeiling = true;
    }
    const result: ProjectsWorkRootUsage = { bytes: total, truncated: anyTruncated, overCeiling: anyOverCeiling, computedAt: new Date().toISOString() };
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
 * Fire-and-forget kick (never awaited by the caller, never throws) — used both at boot and
 * opportunistically on every `served_status` read, so the cache self-warms without ever blocking the
 * read that triggered it. Card 5eace211 Code Review MINOR 3 — throttled to {@link MIN_REFRESH_INTERVAL_MS}:
 * `served_status` is polled, not just human-triggered, so without this floor every read re-kicks a fresh
 * recursive walk the instant the prior one settles. Skips ONLY on a fresh-enough cached `computedAt`; a
 * refresh already genuinely in flight is still deduped inside `refreshProjectsWorkRootUsage` itself, same
 * as before.
 */
export function kickProjectsWorkRootUsageRefresh(db: Db): void {
  if (cached.computedAt && Date.now() - new Date(cached.computedAt).getTime() < MIN_REFRESH_INTERVAL_MS) return;
  refreshProjectsWorkRootUsage(db).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[project-work-dir-usage] background refresh failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}
