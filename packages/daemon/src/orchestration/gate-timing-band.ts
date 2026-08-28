import { open, stat } from "node:fs/promises";
import path from "node:path";
import { LOOM_HOME } from "../paths.js";

/**
 * Card 19c0ef1e — surfaces `test-daemon.mjs`'s `appendGateTimingRow` NDJSON (`GATE_TIMING_NDJSON` there,
 * mirrored here as `GATE_TIMING_NDJSON_PATH`) into a stratified, filtered "how does this run compare"
 * band a manager can read straight off `gate_status(opId)`. The artifact accumulated 571 `run-summary`
 * rows before this card and nothing ever read it back — see the card body for the full "shipping a
 * detector is not someone reading it" framing this closes.
 *
 * READS ONLY. Never writes to the NDJSON — the writer (`appendGateTimingRow`) stays exactly as-is,
 * best-effort/never-throws (see its own doc for why an observability feature must never be able to fail
 * a gate); this module must never be given a reason to touch it.
 */
export const GATE_TIMING_NDJSON_PATH = path.join(LOOM_HOME, "gate-timing", "daemon-per-file-timing.ndjson");

/** How many trailing bytes of the (unboundedly growing — 115MB and climbing ~200KB/run as of card
 *  19c0ef1e) NDJSON to read per call, so a request-path read can never become a full-file parse (the
 *  freeze the card's own DoD names as the risk). Manager-measured on the live 115MB file: a 16MB tail
 *  read (~44,700 lines) costs ~43ms of synchronous event-loop time end to end — acceptable on a tool-call
 *  path, not a knob worth exposing. Override via `LOOM_GATE_TIMING_READ_CAP_BYTES` — a test seam only; no
 *  production knob is exposed, matching the writer's own no-new-config posture. */
const DEFAULT_READ_CAP_BYTES = 16 * 1024 * 1024;

function readCapBytes(): number {
  const raw = process.env.LOOM_GATE_TIMING_READ_CAP_BYTES;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_READ_CAP_BYTES;
}

/**
 * Manager correction to this card's own original filing: an EXACT `poolSize`+`testCount` match is nearly
 * always statistically empty in practice. Measured live against the real 115MB file: the most recent real
 * run's own exact stratum had `n=2`; across the whole file, 127 distinct strata exist and 98 of them
 * (77%) have a clean `n < 5`. `testCount` increments on every single test file added or removed, so a
 * real full-suite stratum is a handful of runs at best and collapses to 0–2 for WEEKS after any test
 * lands — the band is emptiest exactly when someone has just changed the suite and most wants to know
 * whether it got slower.
 *
 * Below this many CLEAN exact-stratum samples, widen the `testCount` match outward to the NEAREST
 * neighbouring `testCount` values (never `poolSize` — see `selectStratum`'s own doc for why `poolSize`
 * stays exact) until the clean population reaches this floor or the read window's population is
 * exhausted. Named, not a bare literal, so the threshold and its rationale travel together; the actual
 * widening produced is always echoed on the returned band's `testFileCountSpan`, never left implicit.
 */
const MIN_BAND_N = 8;

/** The one row `kind` this module ever looks at — `file`/`host-sample`/`run-start` rows (~86% of the
 *  file's rows; see the card's own row-count table) are skipped by a cheap substring check BEFORE
 *  JSON.parse, so the per-call cost stays close to "split the tail into lines", not "JSON.parse the
 *  tail".
 *
 *  Card 1ec2e353: `testCount` here is deliberately kept BYTE-IDENTICAL to the on-disk NDJSON key
 *  `test-daemon.mjs` has always written (`SELECTED.length` — a FILE count, one per hermetic test file,
 *  never per individual test/assertion). Renaming it would require every future reader to understand
 *  BOTH an old and a new key to stay compatible with existing history AND with the committed
 *  `docs/investigations/6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson` snapshot, which
 *  `f8b176f7` DoD-4 requires to stay schema-identical with live rows. The mislabel is real but lives at
 *  the SURFACED layer, not here — see `GateTimingBand.testFileCount` below, which this module renames on
 *  the way out precisely so a reader of the returned band never has to know this on-disk name exists. */
interface RunSummaryRow {
  kind: "run-summary";
  opId?: string;
  runUid?: string;
  poolSize?: number;
  testCount?: number;
  executedCount?: number;
  failedCount?: number;
  durationMs?: number;
}

export interface GateTimingBand {
  poolSize: number;
  /** This op's OWN test-FILE count (the exact value its own run-summary row's on-disk `testCount` field
   *  carries — see `RunSummaryRow`'s own doc for why that on-disk key stays unrenamed) — the CENTER of
   *  the band, not necessarily the only value contributing to it. Named `testFileCount`, not `testCount`
   *  (card 1ec2e353): the unit — one per hermetic test FILE, never per individual test/assertion — is
   *  now stated at the field itself rather than only in this paragraph. See `testFileCountSpan` for what
   *  actually went into `n`/`minSec`/`medianSec`/`maxSec`. */
  testFileCount: number;
  /** The inclusive `[min, max]` test-file counts actually included in the population `n`/`minSec`/
   *  `medianSec`/`maxSec` are computed over. Equal to `[testFileCount, testFileCount]` when the exact
   *  stratum alone already had `n >= MIN_BAND_N` clean samples (no widening happened); a real range means
   *  the match was widened — see `MIN_BAND_N`'s own doc for why and when. Always present so a reader can
   *  never mistake a widened band for an exact one. */
  testFileCountSpan: [number, number];
  /** Count of runs across `testFileCountSpan` (same `poolSize`, excluding this op's own row(s)) that were
   *  BOTH complete (`executedCount === testCount` on the underlying row) AND zero-failure
   *  (`failedCount === 0`) — the population `minSec`/`medianSec`/`maxSec` are computed over. Card
   *  19c0ef1e's own correction: an unfiltered median is silently skewed slow by failing runs, so a
   *  healthy run can misread as "faster than typical" against a contaminated baseline. */
  n: number;
  /** Same population as `n` (same `testFileCountSpan`, same self-exclusion), WITHOUT the completeness/
   *  zero-failure filter — reported alongside `n` so a reader can see how much the filter excluded. */
  nUnfiltered: number;
  /** The clean (complete + zero-failure) count restricted to the EXACT test-file-count match ONLY,
   *  regardless of whether the band below was widened — so widening never hides how thin the exact match
   *  actually was. `nExact <= n` always; `nExact === n` exactly when `testFileCountSpan` is
   *  `[testFileCount, testFileCount]`. */
  nExact: number;
  minSec?: number;
  medianSec?: number;
  maxSec?: number;
  /** Names the producer of the durations this band is built from — deliberately NOT the gate's own
   *  `totalDurationMs` (includes queue wait) or a sum of per-file lane durations (exceeds wall clock). A
   *  number returned without naming its producer recreates the exact defect card 19c0ef1e exists to fix. */
  instrument: string;
  filter: string;
  /** How many bytes of the NDJSON's TAIL this band was computed from, and whether that was less than the
   *  whole file (older history outside the window was never considered). Not a retention policy — a
   *  read-bound acknowledgment (retention itself is out of this card's scope). */
  readWindowBytes: number;
  readWindowTruncated: boolean;
}

/** Caller guarantees `sortedAscending.length > 0` — the non-null assertions below are safe on that
 *  precondition, not a bypass of it. */
function median(sortedAscending: number[]): number {
  const mid = Math.floor(sortedAscending.length / 2);
  return sortedAscending.length % 2 !== 0
    ? sortedAscending[mid]!
    : (sortedAscending[mid - 1]! + sortedAscending[mid]!) / 2;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function isClean(r: RunSummaryRow): boolean {
  return r.executedCount === r.testCount && r.failedCount === 0 && typeof r.durationMs === "number";
}

async function readTailRunSummaryRows(filePath: string, capBytes: number): Promise<{ rows: RunSummaryRow[]; truncated: boolean; readBytes: number }> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    // No NDJSON yet (fresh LOOM_HOME, or this project's gate command never shells out to
    // test-daemon.mjs) — honest empty, not an error.
    return { rows: [], truncated: false, readBytes: 0 };
  }
  const start = Math.max(0, size - capBytes);
  const length = size - start;
  if (length <= 0) return { rows: [], truncated: false, readBytes: 0 };
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    // Manager finding: a SHORT read would leave the tail of `buf` zero-filled, and `toString`-ing that
    // padding as if it were file content risks a silently-corrupted last line. Confirmed no short read on
    // the measured host (bytesRead === length), but slice to the ACTUAL bytes read regardless — this is a
    // real (if currently unobserved) correctness gap, not a theoretical one worth leaving open.
    const { bytesRead } = await handle.read(buf, 0, length, start);
    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    // Reading from a mid-file byte offset almost always lands inside a line — drop that partial first
    // line rather than risk a JSON.parse that happens to succeed on truncated garbage. Also correctly
    // covers the split-multi-byte-UTF-8-character-at-the-window-boundary case (Buffer#toString replaces
    // an incomplete trailing/leading sequence with U+FFFD, which then simply fails the discarded line's
    // JSON.parse if it lands mid-line, or is discarded outright as this partial first line).
    if (start > 0) lines.shift();
    const rows: RunSummaryRow[] = [];
    for (const line of lines) {
      if (!line || !line.includes("\"kind\":\"run-summary\"")) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.kind === "run-summary") rows.push(parsed);
      } catch {
        // A partial/corrupted line — e.g. the file's very last line if a run was SIGKILLed mid-write.
        // appendGateTimingRow's own doc already treats this as an expected shape; skip it the same way.
      }
    }
    return { rows, truncated: start > 0, readBytes: bytesRead };
  } finally {
    await handle.close();
  }
}

/**
 * Picks WHICH row describes "this op's own run" when more than one `run-summary` row shares `opId`.
 *
 * This is a real case, not a theoretical one: `sessions/service.ts`'s single-file merge retry
 * (`identifyRetriableTestFile`) re-invokes `test-daemon.mjs` with `--only=<file>` under the SAME
 * `LOOM_GATE_OP_ID` as the first (failed, full-suite) attempt — and that first attempt, having failed
 * with a "genuine" (clean non-zero exit, never a kill/timeout) classification, DID reach its own
 * `run-summary` write. So a retried-and-then-passed merge can leave TWO `run-summary` rows under one
 * `opId`: one full-suite (`testCount` in the hundreds, `failedCount>=1`), one single-file
 * (`testCount===1`). The TRANSIENT-KILL retry (OOM/SIGKILL/timeout) does NOT create this problem — a
 * killed attempt never reaches its own post-run write at all (that's the entire point of the write-ahead
 * "run-start" row design), so only the retry's own row ever exists for that opId there.
 *
 * DELIBERATE CHOICE: the row with the LARGEST `testCount` wins (ties broken toward the LAST/most-recent
 * one in file order). A single-file retry's `testCount===1` row is never what a caller wants this op's
 * stratum to describe — it would put the band at a near-meaningless "single test file" population instead
 * of the full-suite one every other gate run actually populates. The largest-`testCount` row is, by
 * construction, always the full/real gate invocation for this op, regardless of retry shape.
 */
function pickSelfRow(rows: RunSummaryRow[], opId: string): RunSummaryRow | undefined {
  let best: RunSummaryRow | undefined;
  for (const r of rows) {
    if (r.opId !== opId) continue;
    if (!best || (r.testCount ?? -1) >= (best.testCount ?? -1)) best = r;
  }
  return best;
}

interface Stratum {
  population: RunSummaryRow[];
  testCountSpan: [number, number];
  widened: boolean;
}

/**
 * Builds the population this op's band is computed over. `poolSize` is matched EXACTLY and never widened
 * — pool size dominates run duration more than population size does (the card's own measurement: pool 3
 * at 700-749 files ran FASTER than pool 2 at 600-649), so pooling across `poolSize` would be a genuine
 * category error, not a convenience. `testCount` starts exact and widens outward to the nearest
 * neighbouring values (by absolute distance, ties toward the smaller value) only if the exact match alone
 * has fewer than `MIN_BAND_N` clean samples — see that constant's own doc for the measured reason this is
 * necessary at all.
 */
function selectStratum(candidates: RunSummaryRow[], testCount: number, minCleanN: number): Stratum {
  const distinctTestCounts = [...new Set(candidates.map((r) => r.testCount as number))]
    .sort((a, b) => Math.abs(a - testCount) - Math.abs(b - testCount) || a - b);

  const population: RunSummaryRow[] = [];
  let minTc = testCount;
  let maxTc = testCount;
  let cleanCount = 0;
  for (const tc of distinctTestCounts) {
    population.push(...candidates.filter((r) => r.testCount === tc));
    minTc = Math.min(minTc, tc);
    maxTc = Math.max(maxTc, tc);
    cleanCount = population.filter(isClean).length;
    if (cleanCount >= minCleanN) break;
  }
  return { population, testCountSpan: [minTc, maxTc], widened: minTc !== testCount || maxTc !== testCount };
}

/**
 * The band for `opId`'s own gate/merge run, stratified against every OTHER `run-summary` row with the
 * same `poolSize` found within the read window (see `selectStratum` for the test-file-count-widening
 * rule — its own params/locals keep the on-disk `testCount` name; only the returned `GateTimingBand`
 * renames it to `testFileCount`, see that interface's own doc).
 * Returns `undefined` (never a fabricated empty band) when the NDJSON doesn't exist, the read window
 * doesn't contain a `run-summary` row for this `opId` (a non-Loom gate command, a run older than the read
 * window, or a run whose gate command never shells out to `test-daemon.mjs` at all), or that row is
 * missing `poolSize`/`testCount`.
 */
export async function computeGateTimingBand(opId: string, filePath: string = GATE_TIMING_NDJSON_PATH): Promise<GateTimingBand | undefined> {
  const { rows, truncated, readBytes } = await readTailRunSummaryRows(filePath, readCapBytes());
  if (rows.length === 0) return undefined;
  const self = pickSelfRow(rows, opId);
  if (!self || typeof self.poolSize !== "number" || typeof self.testCount !== "number") return undefined;

  // Every row sharing this op's opId is excluded from its own baseline — not just the one `pickSelfRow`
  // selected (see that function's own doc: a retried op can leave more than one row under one opId, and
  // NONE of them belong in the historical population).
  const candidates = rows.filter((r) => r.opId !== opId && r.poolSize === self.poolSize && typeof r.testCount === "number");

  const exactPopulation = candidates.filter((r) => r.testCount === self.testCount);
  const nExact = exactPopulation.filter(isClean).length;

  const { population, testCountSpan, widened } = selectStratum(candidates, self.testCount, MIN_BAND_N);
  const nUnfiltered = population.length;
  const clean = population.filter(isClean);
  const durationsSec = clean.map((r) => (r.durationMs as number) / 1000).sort((a, b) => a - b);

  return {
    poolSize: self.poolSize,
    testFileCount: self.testCount,
    testFileCountSpan: testCountSpan,
    n: durationsSec.length,
    nUnfiltered,
    nExact,
    ...(durationsSec.length > 0
      ? { minSec: round1(durationsSec[0]!), medianSec: round1(median(durationsSec)), maxSec: round1(durationsSec[durationsSec.length - 1]!) }
      : {}),
    instrument: "run-summary.durationMs (runEndTs−runStartTs, the test-step wall clock — excludes gate queue wait, and is not a sum of per-file lane durations)",
    filter: widened
      ? `same poolSize (exact), testFileCount widened to span [${testCountSpan[0]}, ${testCountSpan[1]}] because the exact testFileCount=${self.testCount} match alone had only nExact=${nExact} clean samples (< ${MIN_BAND_N}); excluding this run itself, restricted to executedCount===testCount and failedCount===0 runs`
      : `same poolSize+testFileCount stratum (exact — the match already had >= ${MIN_BAND_N} clean samples, no widening needed), excluding this run itself; restricted to executedCount===testCount and failedCount===0 runs`,
    readWindowBytes: readBytes,
    readWindowTruncated: truncated,
  };
}
