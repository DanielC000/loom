import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { SCRATCH_ROOT_DIR } from "../paths.js";
import { withTimeout } from "../git/bounded.js";
import { killableRemoveDir, type RemoveDirResult } from "../git/worktrees.js";
import { listAllTranscriptIds } from "../pty/claude-transcript.js";
import { engineTranscriptExists } from "./transcript.js";

/**
 * Card 9775559c — boot GC for `SCRATCH_ROOT_DIR` (`~/.loom/tmp/scratch/<sessionId>`), which nothing has
 * ever deleted (see card 2c8589c9's design report + LEAD RULING for the full evidence trail). This is the
 * BUILD half of that design; every constant/predicate/safety-constraint below traces back to a specific
 * ruling there — see the inline citations rather than re-arguing them here.
 *
 * ╔═ THE TWO PREDICATES THIS DELIBERATELY DOES NOT USE — both were measured destroying live data ═══════╗
 * ║ `archived_at` is NOT terminal: archiving is automatic on pty exit and `resume()` clears it, and a     ║
 * ║ measured snapshot found 1,173 of 1,185 dirs exited+archived — keying on it would reap essentially     ║
 * ║ everything, including every still-resumable session. And the cached `resumability` column is          ║
 * ║ documented in-repo as STICKY/unreliable (`orchestration/crash-orphaned-workers.ts`'s own doc: a        ║
 * ║ TOCTOU miss can "permanently stamp a perfectly-healthy worker `dead`"), and was measured LYING for 13  ║
 * ║ real dirs whose engine transcript was present on disk. Neither column is trustworthy without a live    ║
 * ║ re-check, so — exactly like `deriveCrashOrphanedWorkers` and `resume()` — this sweep re-verifies       ║
 * ║ transcript existence AT SWEEP TIME: via {@link listAllTranscriptIds} for a claude row, or the           ║
 * ║ harness-aware per-session {@link engineTranscriptExists} for a codex row (card cb8b7eff) — never       ║
 * ║ trusting either cached column.                                                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝
 */

/** A Loom session id is a `crypto.randomUUID()` v4 UUID — this is what makes a scratch-root entry name
 *  safely reapable-by-shape: only a v4-UUID-shaped DIRECT CHILD of the scratch root is ever a candidate.
 *  Everything else under the root (the 2 no-DB-row test-fixture dirs, the 9 agent-written loose root
 *  files, any future non-uuid entry) is untouched BY CONSTRUCTION, never by an exclusion list that could
 *  drift — see the scope doc on {@link sweepUnresumableScratchDirs} for why that's a decision, not a gap. */
const V4_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Grace period past which a transcript-gone dir is reapable (card 9775559c's design report: "N=7 is
 *  cheap insurance for a reconfigured/hand-deleted transcript, NOT the load-bearing part" — the load-
 *  bearing gate is transcript ABSENCE itself, which empirically already means Claude Code's own ~30-day
 *  retention already pruned it; this just guards the rarer case of a transcript missing for some other
 *  reason shortly after last activity, where reaping immediately would be needlessly aggressive). */
const SCRATCH_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Bounded concurrency for the removal fan-out (design ruling: "Bound the concurrency (4-8)" — copying
 *  `sweepAllRunSnapshots`'s unbounded `Promise.all` verbatim would spawn one OS removal process PER
 *  candidate dir; at the measured corpus scale (604 reapable dirs) that's 604 concurrent `rmdir /s /q`
 *  processes on the owner's Windows host, a real host-starvation shape). */
export const SCRATCH_GC_CONCURRENCY = 6;

/** Per-removal timeout — mirrors `runs/snapshot.ts`'s `RUN_SNAPSHOT_TIMEOUT_MS` (same class of local,
 *  no-network directory removal). */
const SCRATCH_GC_REMOVE_TIMEOUT_MS = 15_000;

/**
 * Total-bytes ceiling for `SCRATCH_ROOT_DIR` — a WARN-only signal, never an eviction trigger (design
 * ruling, option (b): a cap that evicts would have to evict still-resumable dirs, trading correctness for
 * a bound — rejected). 1 GiB is a deliberately generous but genuinely bounded ceiling for a local dev-tool
 * scratch cache (comparable in spirit to `gate-spill.ts`'s own `GATE_SPILL_MAX_TOTAL_BYTES` reasoning,
 * scaled up because this root also holds Playwright PNG/video captures, an order of magnitude larger per
 * file than a gate-output log) — the number to defend or shrink going forward, not a computed constant.
 * Read by {@link measureScratchRootUsage}; surfaced on `served_status` (see `served-status.ts`) per the
 * design's BINDING condition that a ceiling must land where a named actor already reads, never a boot log
 * line nobody opens.
 */
export const SCRATCH_ROOT_WARN_BYTES = 1 * 1024 * 1024 * 1024;

/** Injectable seam mirroring `runs/snapshot.ts`'s `RunSnapshotRemoveDeps` — lets a test simulate a wedged
 *  (never-settling) removal, freeze "now", or substitute the live-transcript-id set without touching the
 *  real `~/.claude/projects`. Real callers (the boot hook) never pass any of these. */
export interface ScratchGcDeps {
  removeDir?: (target: string, timeoutMs: number) => Promise<RemoveDirResult>;
  timeoutMs?: number;
  nowMs?: number;
  /** The live engine-transcript-id set for CLAUDE rows only — defaults to a real, single-pass
   *  `listAllTranscriptIds()` scan of `~/.claude/projects`. A test injects a fixed `Set` instead of
   *  pointing at a real fixture tree. Never consulted for a `harness:"codex"` row — see
   *  {@link codexTranscriptExists}. */
  transcriptIds?: Set<string>;
  /** Per-session resumability check for a `harness:"codex"` row — defaults to the harness-aware
   *  `engineTranscriptExists(cwd, id, "codex")` (`sessions/transcript.ts`), which dispatches to codex's
   *  own rollout-file scan (`pty/codex-transcript.ts`) — the SAME check `resume()`'s own ghost-resume
   *  guard already trusts (`sessions/service.ts`). A codex conversation id is a codex rollout id and can
   *  NEVER appear in {@link transcriptIds} (that set scans ONLY `~/.claude/projects`), so a codex row
   *  needs this separate per-session check rather than folding into the claude bulk set (card cb8b7eff).
   *  A test injects a fixed function instead of touching a real `~/.codex/sessions` tree. */
  codexTranscriptExists?: (cwd: string, engineSessionId: string) => boolean;
}

export interface ScratchGcResult {
  /** v4-uuid-shaped direct children of the scratch root that were considered at all. */
  scanned: number;
  /** Dir names actually removed. */
  reaped: string[];
  /** Dir names whose removal was attempted but genuinely wedged (killed, left for the next boot sweep). */
  wedged: string[];
}

async function withBoundedConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const item = items[next++]!;
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
}

/**
 * Boot-only, fire-and-forget sweep of `SCRATCH_ROOT_DIR` — remove a session's scratch dir iff it can no
 * longer be resumed AND is past a grace period, re-verified live rather than trusted from a cached column
 * (see this file's header doc). Never called synchronously on any hot path (the predicate needs a DB read
 * PLUS a directory scan — far too heavy for `createPty`'s synchronous spawn path); wired in alongside
 * `reconcileRunsOnBoot`'s own `sweepAllRunSnapshots` call (`sessions/service.ts`), same fire-and-forget
 * shape. Best-effort and NEVER throws for an individual entry — a wedged removal is simply left on disk
 * for the next boot's sweep (`killableRemoveDir` + `withTimeout`, fail-SAFE — never a retrying `fs.rm`;
 * see `git/worktrees.ts`'s own doc on why a retry loop over a hung removal leaked the whole daemon once
 * already, card 26c661cd/bd9fc808).
 *
 * THE APPROVED PREDICATE (card 9775559c) — reap a scratch dir iff, ALL of:
 *   1. its name is a v4-UUID (a direct child of the root that isn't is untouched by construction — this
 *      DELIBERATELY excludes the 2 no-DB-row test-fixture dirs some daemon tests still leak into the real
 *      scratch root, and the 9 agent-written loose root files; neither is reachable by a session-id-keyed
 *      sweep, and a test fixture could be mid-write during a boot sweep on a host also running tests);
 *   2. a `sessions` row exists for that name (`db.getSession`, unfiltered by `archived_at` — deliberately;
 *      see the header doc on why that column is not a signal this sweep uses at all);
 *   3. that row's `processState` is NOT `live`/`starting` (a session mid-turn is never a candidate,
 *      regardless of anything else);
 *   4. that row's `engineSessionId` is set (nothing to check transcript existence against otherwise —
 *      absent-id rows are skipped rather than treated as automatically reapable);
 *   5. that id is not resumable per its OWN harness's liveness source (`resume()` is then structurally
 *      impossible) — a plain/`"claude"` row checks membership in the bulk claude-only
 *      `listAllTranscriptIds()` set; a `"codex"` row instead calls {@link ScratchGcDeps.codexTranscriptExists}
 *      (default: the harness-aware `engineTranscriptExists(cwd, id, "codex")`), since a codex conversation
 *      id is a codex rollout id and can never appear in the claude-only set (card cb8b7eff — the claude
 *      set's own scan is scoped to `~/.claude/projects`, see `pty/claude-transcript.ts`);
 *   6. `lastActivity` is older than {@link SCRATCH_GC_GRACE_MS}.
 */
export async function sweepUnresumableScratchDirs(db: Db, deps: ScratchGcDeps = {}): Promise<ScratchGcResult> {
  const result: ScratchGcResult = { scanned: 0, reaped: [], wedged: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(SCRATCH_ROOT_DIR, { withFileTypes: true });
  } catch {
    return result; // scratch root absent — nothing to sweep
  }

  const nowMs = deps.nowMs ?? Date.now();
  const liveTranscriptIds = deps.transcriptIds ?? listAllTranscriptIds();
  const codexTranscriptExists = deps.codexTranscriptExists ?? ((cwd, id) => engineTranscriptExists(cwd, id, "codex"));
  const timeoutMs = deps.timeoutMs ?? SCRATCH_GC_REMOVE_TIMEOUT_MS;
  const removeDir = deps.removeDir ?? ((p, ms) => killableRemoveDir(p, ms));

  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !V4_UUID_RE.test(entry.name)) continue; // scope: non-uuid entries + loose root files untouched
    result.scanned++;

    const row = db.getSession(entry.name);
    if (!row) continue; // no-DB-row dir (predicate 2) — carve-out, see header doc
    if (row.processState === "live" || row.processState === "starting") continue; // predicate 3
    if (!row.engineSessionId) continue; // predicate 4
    const stillResumable = row.harness === "codex"
      ? codexTranscriptExists(row.cwd, row.engineSessionId)
      : liveTranscriptIds.has(row.engineSessionId);
    if (stillResumable) continue; // predicate 5 — still resumable, never reap
    const lastActivityMs = Date.parse(row.lastActivity);
    if (Number.isNaN(lastActivityMs) || nowMs - lastActivityMs < SCRATCH_GC_GRACE_MS) continue; // predicate 6

    candidates.push(entry.name);
  }

  await withBoundedConcurrency(candidates, SCRATCH_GC_CONCURRENCY, async (name) => {
    const target = path.join(SCRATCH_ROOT_DIR, name);
    const outcome = await withTimeout(removeDir(target, timeoutMs), timeoutMs, "removeDir scratch gc")
      .catch((): RemoveDirResult => ({ removed: false, killed: true })); // injected/broken seam that never settles ⇒ fail SAFE as WEDGED
    if (outcome.removed) {
      result.reaped.push(name);
    } else {
      result.wedged.push(name);
      // eslint-disable-next-line no-console
      console.warn(`[scratch-gc] boot sweep could not remove ${target} (${outcome.killed ? "genuinely wedged" : "clean failure"}; left for the next boot sweep)`);
    }
  });

  return result;
}

/** Total on-disk bytes currently under `SCRATCH_ROOT_DIR` — the WHOLE root (every entry, not just
 *  v4-uuid-shaped reap candidates), since this feeds a footprint WARNING, not the reap scope. A full
 *  recursive walk, deliberately synchronous: called on-demand from `served_status`/`GET /api/deploy-
 *  status` only (never a hot path, never polled on an interval — see `served-status.ts`'s own doc on why
 *  its sibling fields are all "fresh, uncached reads" too), so paying a real disk walk per call is the
 *  same trade every other field on that surface already makes. Best-effort: an unreadable file/dir simply
 *  contributes 0 rather than aborting the whole measurement. */
export function measureScratchRootBytes(root: string = SCRATCH_ROOT_DIR): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += measureScratchRootBytes(full);
    } else if (entry.isFile()) {
      try { total += fs.statSync(full).size; } catch { /* best-effort */ }
    }
  }
  return total;
}
