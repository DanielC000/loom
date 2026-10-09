/**
 * Pure, directly-testable logic for the automatic "which test files directly import a dist module this
 * ungated landing touched" advisory (design card 71a77fb2, Option B) — the daemon-process glue (cutting
 * the isolated worktree, building it, admitting the gate run, pushing the nudge) lives in
 * `sessions/service.ts` instead.
 *
 * @decision cee17efe — this module never calls `recordMergeGateOutcome`/`applyGatePass`/`applyGateFail`/
 * `applyGateNext`/`putMergeGateState`.
 */

const SRC_PREFIX = "packages/daemon/src/";
const DIST_PREFIX = "packages/daemon/dist/";

/**
 * Maps one changed `packages/daemon/src/**\/*.ts` repo-relative path to its compiled
 * `packages/daemon/dist/**\/*.js` counterpart — `null` for anything outside that tree, a declaration
 * file (`.d.ts`, which emits no runtime `.js` a test could import), or any non-`.ts` path.
 */
export function srcTsPathToDistPath(repoRelPath: string): string | null {
  if (!repoRelPath.startsWith(SRC_PREFIX) || !repoRelPath.endsWith(".ts") || repoRelPath.endsWith(".d.ts")) return null;
  const withoutExt = repoRelPath.slice(SRC_PREFIX.length, -".ts".length);
  if (withoutExt.length === 0) return null;
  return `${DIST_PREFIX}${withoutExt}.js`;
}

/** The deduped set of touched `dist/**\/*.js` modules for a landed commit's changed `.ts` paths — the
 *  input to the direct-importer scan. Paths outside `packages/daemon/src/**` are silently dropped (this
 *  signal only exists for the daemon package; the 4 historical incidents were all daemon-src landings). */
export function touchedDistPathsFor(changedTsRepoPaths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of changedTsRepoPaths) {
    const d = srcTsPathToDistPath(p);
    if (d) out.add(d);
  }
  return [...out];
}

/**
 * SECOND LEAD ruling (2026-10-09, superseding the first oversize-SKIP design): a large matched set is
 * never skipped — it is CAPPED, running the top `cap`-many candidates instead of none. `cap` is 60% of
 * the LIVE test corpus (computed at run time from the isolated worktree's own
 * `packages/daemon/test/**\/*.mjs` count, never a hardcoded file count — a fixed count, 200, was this
 * module's own first proposal, and would have disarmed the detector on every one of 71a77fb2's
 * historical incidents, each touching `service.ts`/`host.ts` alone — 564/486 of the then-1611-file
 * corpus). A corpus-relative percentage scales with the corpus as it grows. Measured against the real
 * incident set (card cee17efe follow-up, 2026-10-09): at 60% of a 1627-file corpus (cap 976), the ONE
 * historical commit whose own run-set individually exceeded the ORIGINAL 50% skip threshold (fe1cdf10,
 * 820/1627 = 50.4%) now runs in FULL (820 < 976) — the capped-run design was adopted specifically
 * because the 50%-skip design would have dropped fe1cdf10 to zero coverage.
 */
export const DIST_IMPORTER_CAP_FRACTION = 0.6;
export function computeDistImporterCap(corpusSize: number): number {
  if (corpusSize <= 0) return 0;
  return Math.max(1, Math.floor(corpusSize * DIST_IMPORTER_CAP_FRACTION)); // never 0 while there's a corpus to cap
}

/**
 * Ranks `candidates` by HOW MANY of the touched dist modules each imports, descending (a file importing
 * 2 touched modules is more coupled to the landing than one importing 1, and runs first under a cap),
 * breaking ties alphabetically by path for a deterministic order. LEAD ruling: explicitly NOT by mtime —
 * the check runs in a FRESH worktree, where every file shares the SAME checkout-time mtime, so an
 * mtime-based order would silently degenerate to alphabetical; ranking by the scan's own already-computed
 * touched-module count is free (no extra git/fs call) and actually reflects relevance to the landing.
 * Returns the top `cap`-many paths (or all of them, if `candidates.length <= cap`) plus `matchedSize`
 * (the total eligible count BEFORE capping), so the caller can report "ran N of M" precisely.
 */
export function rankAndCapRunSet(
  candidates: readonly { path: string; touchedCount: number }[], cap: number,
): { runSet: string[]; matchedSize: number } {
  const sorted = [...candidates].sort((a, b) => b.touchedCount - a.touchedCount || a.path.localeCompare(b.path));
  return { runSet: sorted.slice(0, cap).map((c) => c.path), matchedSize: sorted.length };
}

/**
 * LEAD ruling (B), coalescing half: at most ONE direct-importer check runs at a time per (project,repo).
 * A landing that arrives while one is already running is folded into a single follow-up run at the
 * NEWEST landed sha, covering the UNION of every touched dist module across the folded-in landings — so
 * a burst of ungated landings costs at most one extra LOW-tier gate slot, never one per landing.
 *
 * A plain object (not a class) so a caller can hold it in a `Map` keyed by `${projectId}:${repoKey}` and
 * mutate it in place — mirrors every other small state-machine shape in this directory
 * (`gate-intent.ts`'s `GateIntentRow`, etc.).
 */
export interface DistImporterCheckQueueState {
  running: boolean;
  pendingShas: string[];
  pendingTouchedDistPaths: Set<string>;
}
export function newDistImporterCheckQueueState(): DistImporterCheckQueueState {
  return { running: false, pendingShas: [], pendingTouchedDistPaths: new Set() };
}

/**
 * Call when a landing wants to kick a check. `{shouldRunNow:true}` means the queue was idle — the caller
 * runs it immediately (and must eventually call {@link drainFollowUp} when that run settles).
 * `{shouldRunNow:false}` means a run is already in flight — this landing's sha + touched modules are
 * folded into the pending batch and the caller does nothing further; the in-flight run's own
 * `drainFollowUp` call will pick this up.
 */
export function enqueueLanding(
  state: DistImporterCheckQueueState, sha: string, touchedDistPaths: readonly string[],
): { shouldRunNow: boolean } {
  if (!state.running) {
    state.running = true;
    return { shouldRunNow: true };
  }
  state.pendingShas.push(sha);
  for (const p of touchedDistPaths) state.pendingTouchedDistPaths.add(p);
  return { shouldRunNow: false };
}

/**
 * Call exactly once, right after a run settles (pass, fail, or error — always call this, even on a
 * thrown error, so a queue can never get stuck `running:true` forever). Returns the next batch to run
 * (newest sha + the union of every touched module folded in while the previous run was in flight), or
 * `null` when nothing arrived meanwhile — in which case the queue is now idle (`running` is set `false`
 * here; the caller does not need to touch it) and can be dropped from its owning `Map`.
 */
export function drainFollowUp(
  state: DistImporterCheckQueueState,
): { sha: string; touchedDistPaths: string[] } | null {
  if (state.pendingShas.length === 0) {
    state.running = false;
    return null;
  }
  const sha = state.pendingShas[state.pendingShas.length - 1]!;
  const touchedDistPaths = [...state.pendingTouchedDistPaths];
  state.pendingShas = [];
  state.pendingTouchedDistPaths = new Set();
  return { sha, touchedDistPaths };
}

/** Shortens a `packages/daemon/dist/<path>.js` module path to just `<path>` for a compact nudge. */
function shortDistModuleLabel(distPath: string): string {
  return distPath.startsWith(DIST_PREFIX) && distPath.endsWith(".js")
    ? distPath.slice(DIST_PREFIX.length, -".js".length)
    : distPath;
}

/** LEAD ruling (C): a red here is a CANDIDATE, not a verdict — the run happens on a loaded host, so the
 *  nudge must say so explicitly rather than reading as an authoritative failure. `matchedSize` is the
 *  TOTAL eligible count before capping; `ranSize` (`<= matchedSize`) is how many actually ran — when they
 *  differ, the nudge says "ran N of M… not run (cap X% of corpus)" instead of a bare count (SECOND LEAD
 *  ruling, 2026-10-09 — replaces the old oversize-SKIP nudge; a capped run still fires this SAME
 *  pass/fail nudge, never a separate skip-shaped one, since something always runs now).
 *
 * @decision cee17efe — `timedOut` is a third failure shape, never folded into `failingFiles ?? "(unnamed)"`. */
export function formatDistImporterResultNudge(args: {
  landedSha: string; touchedDistPaths: readonly string[]; ranSize: number; matchedSize: number;
  passed: boolean; failingFiles?: readonly string[]; timedOut?: boolean;
}): string {
  const modules = args.touchedDistPaths.map(shortDistModuleLabel).join(", ") || "(none)";
  const countClause = args.ranSize === args.matchedSize
    ? `${args.ranSize} test file(s) directly importing ${modules}`
    : `ran ${args.ranSize} of ${args.matchedSize} matched test file(s) directly importing ${modules}; ${args.matchedSize - args.ranSize} not run (cap ${Math.round(DIST_IMPORTER_CAP_FRACTION * 100)}% of corpus)`;
  const head = `[loom:dist-importer-check] after ungated landing ${args.landedSha.slice(0, 8)} (gate-interval): ${countClause}`;
  if (args.passed) return `${head} — all passed. This did not run the gate, does not block the landing, and does not affect the gate interval counter or gateOwed.`;
  if (args.timedOut) {
    return `${head} — TIMED OUT before any test file reported completion (possibly resource-starved under load — see gate_status for the full diagnosis). This is a timeout, not a confirmed test red. This did not block the landing and does not affect the gate interval counter or gateOwed.`;
  }
  const failing = (args.failingFiles ?? []).join(", ") || "(unnamed)";
  return `${head} — FAILED: ${failing}. ⚠️ Re-run each failing file directly on main before carding — this ran on a possibly-loaded host, so a red here is a candidate, not a verdict. This did not block the landing and does not affect the gate interval counter or gateOwed.`;
}

/** A diagnostic-only failure shape for the scan/build/run machinery itself (not a test FAILURE — a
 *  mechanism failure: the worktree couldn't be built, the scan child process errored, etc.). The nudge
 *  for this is deliberately distinct from a real red (see `formatDistImporterMechanismFailureNudge`
 *  below) so a manager never mistakes "the check itself broke" for "the tests failed". */
export function formatDistImporterMechanismFailureNudge(args: { landedSha: string; reason: string }): string {
  return `[loom:dist-importer-check] could not run for ungated landing ${args.landedSha.slice(0, 8)} (gate-interval) — ${args.reason}. This is a mechanism failure, not a test result; it does not block the landing and does not affect the gate interval counter or gateOwed.`;
}

/**
 * @decision cee17efe — shared by every cancel site this check can settle through (queued, mid-phase, and
 * running); see that record's own "LEAD round-3 ruling 1" section for why all three share one format.
 */
export function formatDistImporterCancelledNudge(args: { landedSha: string; reason: string }): string {
  return `[loom:dist-importer-check] the automatic check for ungated landing ${args.landedSha.slice(0, 8)} was cancelled before it produced a result (${args.reason}). This was never a gate and touches nothing — nothing further to do.`;
}
