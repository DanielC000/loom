// Card f8b176f7: bounds the growth of test-daemon.mjs's gate-timing NDJSON
// (`<LOOM_HOME>/gate-timing/daemon-per-file-timing.ndjson`) WITHOUT destroying the cross-run comparability
// that artifact exists for (card a591a654's own consumer, and `src/orchestration/gate-timing-band.ts`'s
// `computeGateTimingBand`, which this module deliberately never imports or touches — see its own doc for
// why: it reads ONLY the last `LOOM_GATE_TIMING_READ_CAP_BYTES` (16MB by default) of the canonical file, so
// this module's whole design is shaped around staying compatible with that read window, not around that
// module's code).
//
// THE CORE IDEA: `kind:"file"` and `kind:"host-sample"` rows are the overwhelming majority of every run's
// bytes (~86% of rows per gate-timing-band.ts's own measurement) but are USELESS to cross-run trend
// analysis — only `kind:"run-summary"` rows (one per run, a few hundred bytes) feed `computeGateTimingBand`
// at all. So instead of deleting old history (which would starve that consumer exactly the way card
// f8b176f7's own kickoff measured: `n:8, nExact:3` — already sample-starved before this module existed),
// this module COMPACTS old runs down to their `run-summary` row alone and drops their `file`/`host-sample`/
// `run-start` rows. A `run-summary` row survives forever (subject to the hard ceiling below); only the
// bulk detail expires. This is the third candidate the card names and pre-blesses none of: "compact old
// runs to their run-summary rows and drop the per-file detail" — chosen over straightforward segment
// rotation (rename-on-overflow, e.g. this repo's OWN `scripts/lib/rotating-log.mjs`) because that consumer
// reads ONLY the canonical path — a rotated-away segment is invisible to it forever, which would make
// cross-run comparability WORSE on every rotation, not better. Compaction never moves the canonical file
// out of that path, so a `run-summary` row this module preserves stays visible to that reader for as long
// as it survives the ceiling below.
//
// RETENTION POLICY, and why it's enough for both known consumers:
//  - The most recent `keepFullRuns` runs (by write order — this file is append-only, so first-appearance
//    order of each run's key IS chronological order) keep EVERY row untouched — full `file`/`host-sample`/
//    `run-start` detail survives, so a591a654-style analysis (`docs/investigations/a591a654-gate-timing-
//    attribution/scripts/compute-sum-wall-slack.mjs`, which needs `kind:"file"` rows joined to their
//    `kind:"run-summary"` row by `runUid` to compute SUM-of-lanes vs WALL-clock slack) still has full-detail
//    runs to investigate — that script is used to diagnose RECENT gate behavior, never multi-year-old runs.
//  - Every OLDER run keeps ONLY its `run-summary` row (dropped entirely if it never wrote one — an old
//    SIGKILLed run has no `run-summary` and contributes nothing useful to trend analysis anyway; its
//    `neverCompletedFiles`-style forensic value is a RECENT-incident tool, already covered by the full-
//    detail window above).
//  - `maxCompactedSummaries` is a hard ceiling on how many of those old, compacted `run-summary` rows
//    survive (oldest dropped first) — this is what makes DoD-1's "cannot grow without bound" literally
//    true, not just "grows much more slowly". At the DEFAULT_MAX_COMPACTED_SUMMARIES below and a generous
//    ~10 gate runs/day, the ceiling doesn't engage for years (see that constant's own doc for the
//    arithmetic) — generous enough to never realistically bind, but a REAL bound either way.
//
// WHY THIS IS ENOUGH FOR `computeGateTimingBand` SPECIFICALLY (the arithmetic the card's kickoff asked for):
// that reader widens `testCount` outward only until the CLEAN exact-or-widened population reaches
// `MIN_BAND_N=8` (see its own doc). Under the OLD unbounded-detail file, a 16MB tail held roughly
// 16MB / ~200KB-per-run ≈ 80 runs total (mixed kinds) before falling out of the read window — of which
// exactly 1 row per run is ever a `run-summary` row, so at most ~80 `run-summary` rows were ever visible to
// that reader, split across however many distinct `poolSize` values existed. Under this module's policy, a
// STEADY-STATE file compacts to roughly `keepFullRuns` full-detail runs (~keepFullRuns * 200KB) PLUS up to
// `maxCompactedSummaries` old `run-summary`-only rows (~500 bytes each) — with the defaults below that's
// ~4MB of full detail plus up to ~10MB of compacted history, comfortably inside the SAME 16MB tail window,
// meaning up to ~20,000 `run-summary` rows (not ~80) become visible to `computeGateTimingBand` once the file
// has accumulated that much history — several orders of magnitude past `MIN_BAND_N=8` for any `poolSize`
// stratum that has run even a handful of times, closing the exact sample-starvation (`nExact:3`) the card's
// kickoff measured.
import fs from "node:fs";
import path from "node:path";

/** Trigger compaction once the live file exceeds this many bytes. Deliberately set to HALF of
 *  `gate-timing-band.ts`'s own 16MB `DEFAULT_READ_CAP_BYTES` (duplicated here as a plain number, not
 *  imported — this script is plain JS run standalone before any build, same reasoning `test-daemon.mjs`
 *  already gives for duplicating `LOOM_HOME` instead of importing `paths.ts`) so the steady-state file size
 *  after compaction stays comfortably under that reader's tail-read window, with headroom for the current
 *  run's own writes between compaction passes. */
export const DEFAULT_COMPACT_TRIGGER_BYTES = 8 * 1024 * 1024;

/** How many of the most-recent runs (by write order) keep their full `file`/`host-sample`/`run-start`
 *  detail, untouched. At ~200KB/run (current measured rate — see this file's header comment) this is
 *  ~4MB of full detail, leaving the rest of the 16MB reader window for compacted history. */
export const DEFAULT_KEEP_FULL_RUNS = 20;

/** Hard ceiling on how many OLD (already-compacted, `run-summary`-only) rows survive — the oldest are
 *  dropped first once this is exceeded. This is what makes growth genuinely BOUNDED (DoD-1), not merely
 *  slow: without it, `run-summary` rows alone would still accumulate forever, just ~650x slower than the
 *  pre-compaction rate. At ~500 bytes/row and even 10 gate runs/day (this project's CLAUDE.md notes ~10/day
 *  as the estimate the original card scaled its own numbers from), 20,000 rows is >5 years of history
 *  before this ceiling ever drops anything — generous enough to never realistically bind, but a real,
 *  provable bound either way. */
export const DEFAULT_MAX_COMPACTED_SUMMARIES = 20000;

/** Resolves the run-grouping key for a row: `runUid` when present (every row since card 05056168), else a
 *  `runIndex`-derived fallback for any pre-runUid legacy row, else `null` for a row with neither (kept only
 *  if it happens to be a `run-summary` row itself — see the caller). */
function runKeyOf(row) {
  if (row && typeof row.runUid === "string") return row.runUid;
  if (row && row.runIndex != null) return `idx:${row.runIndex}`;
  return null;
}

/**
 * Best-effort, synchronous NDJSON compaction. NEVER throws — same posture as `appendGateTimingRow` in
 * `test-daemon.mjs` (an observability feature that can fail a gate is strictly worse than no observability
 * feature at all) — every failure mode (permission denied, disk full, a concurrent writer, a missing dir,
 * a corrupt line) is caught here and reported back as a plain result object, never propagated.
 *
 * CONCURRENCY (this project's gate can run up to `maxConcurrentGates` — currently 2 — gate processes at
 * once, any of which may be appending to `filePath` while this runs): this function only ever WRITES the
 * canonical file via one atomic `fs.renameSync` of a freshly-and-fully-written temp file over it — it never
 * partially rewrites `filePath` in place. So at any observable instant `filePath` is either wholly the OLD
 * content or wholly the NEW (compacted) content — a concurrent `appendFileSync(filePath, …)` (which opens,
 * writes, and closes by PATH on every call — see `appendGateTimingRow`) either lands in the old content
 * before the swap or the new content after it; EITHER WAY the result is well-formed NDJSON, never a
 * truncated/corrupted line. The only race outcome possible is a LOST row: an append whose `open()` happened
 * just before this function's `renameSync` keeps writing to the now-unlinked old inode, which is never
 * reachable via `filePath` again once its handle closes. This function never duplicates a row (each
 * survivor line is copied at most once) and never throws on that race — a failed `renameSync` (e.g. a
 * transient Windows lock) is caught like any other fs error below and simply skipped for this run; the next
 * run's compaction attempt (or gate-timing append) proceeds normally against whatever the file currently
 * holds. Two concurrent compactions racing each other (both gates crossing the threshold at once) resolve
 * the same way: last `renameSync` wins, the loser's already-computed compacted content is simply never
 * referenced again — no error, no corruption, at worst one run's compaction pass wasted.
 *
 * @param {string} filePath the canonical NDJSON path (matches `GATE_TIMING_NDJSON` in test-daemon.mjs)
 * @param {object} [opts]
 * @param {number} [opts.triggerBytes] compact only when the file is at least this large
 * @param {number} [opts.keepFullRuns] most-recent N runs keep full per-row detail
 * @param {number} [opts.maxCompactedSummaries] hard ceiling on retained old `run-summary` rows
 * @param {string} [opts.tmpPath] override the temp file path (test seam — lets a test force the write step
 *   to fail deterministically by pre-creating a directory at this exact path, the same "force a genuinely
 *   unwritable target" technique `test-daemon.mjs`'s own tests already use for `appendGateTimingRow`)
 * @returns {{compacted: boolean, reason?: string, beforeBytes?: number, beforeRows?: number, afterRows?: number, droppedOldSummaries?: number, error?: string}}
 */
export function compactGateTimingLogIfNeeded(filePath, opts = {}) {
  const triggerBytes = opts.triggerBytes ?? DEFAULT_COMPACT_TRIGGER_BYTES;
  const keepFullRuns = opts.keepFullRuns ?? DEFAULT_KEEP_FULL_RUNS;
  const maxCompactedSummaries = opts.maxCompactedSummaries ?? DEFAULT_MAX_COMPACTED_SUMMARIES;

  try {
    let beforeBytes;
    try {
      beforeBytes = fs.statSync(filePath).size;
    } catch {
      return { compacted: false, reason: "no-file" };
    }
    if (beforeBytes < triggerBytes) return { compacted: false, reason: "below-threshold", beforeBytes };

    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);

    const parsed = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        parsed.push({ line, row });
      } catch {
        // A partial/corrupted line (e.g. the file's very last line if a prior run was SIGKILLed
        // mid-write) — appendGateTimingRow's own doc already treats this as an expected shape for
        // readers; drop it here too rather than risk carrying a broken line forward.
      }
    }
    if (parsed.length === 0) return { compacted: false, reason: "nothing-parsed", beforeBytes };

    // First-appearance order of each run's key == write order == chronological (this file is append-only
    // within a single writer; concurrent writers interleave individual lines, never reorder a single
    // writer's own sequence, so this remains a reasonable recency proxy across concurrent gates too).
    const runOrder = [];
    const seenRuns = new Set();
    for (const { row } of parsed) {
      const key = runKeyOf(row);
      if (key === null) continue;
      if (!seenRuns.has(key)) {
        seenRuns.add(key);
        runOrder.push(key);
      }
    }
    const recentRunKeys = new Set(runOrder.slice(-keepFullRuns));

    // Pass 1: keep every row of a recent run untouched; for an old run, keep ONLY its run-summary row(s).
    const survivors = [];
    for (const { line, row } of parsed) {
      const key = runKeyOf(row);
      const isRecent = key !== null && recentRunKeys.has(key);
      if (isRecent || row.kind === "run-summary") survivors.push({ line, row, isRecent });
    }

    // Pass 2: hard ceiling on OLD (non-recent) run-summary rows — drop the oldest beyond the cap. Recent
    // runs' own run-summary rows are exempt (they're part of the full-detail window, not the compacted
    // tail this ceiling governs).
    const oldSummaryPositions = [];
    for (let i = 0; i < survivors.length; i++) {
      if (!survivors[i].isRecent && survivors[i].row.kind === "run-summary") oldSummaryPositions.push(i);
    }
    let finalLines;
    let droppedOldSummaries = 0;
    if (oldSummaryPositions.length > maxCompactedSummaries) {
      droppedOldSummaries = oldSummaryPositions.length - maxCompactedSummaries;
      const dropSet = new Set(oldSummaryPositions.slice(0, droppedOldSummaries));
      finalLines = survivors.filter((_, i) => !dropSet.has(i)).map((s) => s.line);
    } else {
      finalLines = survivors.map((s) => s.line);
    }

    const tmpPath = opts.tmpPath ?? `${filePath}.compact-${process.pid}-${Date.now()}.tmp`;
    const content = finalLines.length ? finalLines.join("\n") + "\n" : "";
    try {
      // Both steps share one try/catch and one reported reason ("write-failed") — the live file at
      // `filePath` is untouched by either failing (the write targets `tmpPath`, a distinct path, and the
      // rename is the only step that ever touches `filePath`, atomically), so callers don't need to
      // distinguish "the temp write failed" from "the atomic swap failed" — either way nothing changed.
      fs.writeFileSync(tmpPath, content);
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      // Clean up the orphaned temp file best-effort (it may or may not exist depending on which step
      // failed) and report the miss; the live file is untouched either way.
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* best-effort cleanup only */ }
      return { compacted: false, reason: "write-failed", beforeBytes, error: err.message };
    }

    return {
      compacted: true,
      beforeBytes,
      beforeRows: parsed.length,
      afterRows: finalLines.length,
      droppedOldSummaries,
    };
  } catch (err) {
    return { compacted: false, reason: "error", error: err.message };
  }
}
