import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// GATE-TIMING BAND test (card 19c0ef1e — "surface the gate-timing NDJSON nobody queries").
// `test-daemon.mjs` has written `<LOOM_HOME>/gate-timing/daemon-per-file-timing.ndjson` (`kind:"run-summary"`
// rows carrying `poolSize`/`testCount`/`executedCount`/`failedCount`/`durationMs`) since card 17069e7e, but
// nothing ever read it back — this proves `computeGateTimingBand` (src/orchestration/gate-timing-band.ts)
// actually does: stratifies by EXACT poolSize (never widened), excludes every row sharing the run under
// comparison's opId from its own baseline (even when more than one row shares that opId — the single-file
// merge-retry case), filters to complete+zero-failure runs before computing min/median/max (the card's own
// CORRECTION — an unfiltered median is silently skewed slow), widens the testCount match to the nearest
// neighbours when the exact match alone is too thin (the MANAGER's correction — an exact-only match is
// statistically empty for most real strata), and bounds its read of an unboundedly-growing file to a tail
// byte cap.
//
// RED-PROVEN per /worker doctrine: every assertion below names a SPECIFIC expected value computed by hand
// from the fixture — a broken filter/widen/self-pick produces a DIFFERENT number, not just "undefined vs
// defined", so a regression is falsifiable.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-timing-band.mjs
import fs from "node:fs";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

const { computeGateTimingBand } = await import("../dist/orchestration/gate-timing-band.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function ndjsonRow(obj) {
  return JSON.stringify(obj) + "\n";
}

// Interspersed "file"/"host-sample"/"run-start" rows — the ~86% of the real file's rows this module must
// skip WITHOUT JSON.parse-ing them (the substring pre-check). If they were mistakenly counted as
// run-summary rows, every assertion below would be wrong.
function noiseRows(n) {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += ndjsonRow({ kind: "file", name: `noise-${i}`, durationMs: 1234, ok: true });
    out += ndjsonRow({ kind: "host-sample", cpuBusyPct: 12.3, freeMemMB: 4096 });
  }
  return out;
}

const dir = mkdtempManaged("loom-gtb-");
const ndjsonPath = `${dir}/daemon-per-file-timing.ndjson`;

// ── (1) exact-stratum path (>= MIN_BAND_N=8 clean exact samples — no widening needed) ──────────────────────
{
  const SELF_OP = "op-self-0001";
  let text = "";
  text += noiseRows(3);
  // Same stratum (poolSize:3, testCount:700), 8 CLEAN historical runs (>= MIN_BAND_N) so the exact match
  // alone is already sufficient — this fixture's whole point is proving NO widening happens here.
  const cleanSecs = [700, 710, 720, 730, 740, 750, 760, 770];
  cleanSecs.forEach((s, i) => {
    text += ndjsonRow({ kind: "run-summary", opId: `op-clean-${i}`, poolSize: 3, testCount: 700, executedCount: 700, failedCount: 0, durationMs: s * 1000 });
  });
  // Same stratum, INCOMPLETE (executedCount !== testCount) — must count in nUnfiltered, NOT in n/median.
  text += ndjsonRow({ kind: "run-summary", opId: "op-incomplete", poolSize: 3, testCount: 700, executedCount: 690, failedCount: 0, durationMs: 100_000 });
  // Same stratum, FAILING (failedCount > 0) — must count in nUnfiltered, NOT in n/median.
  text += ndjsonRow({ kind: "run-summary", opId: "op-failed", poolSize: 3, testCount: 700, executedCount: 700, failedCount: 2, durationMs: 2_000_000 });
  // DIFFERENT poolSize (2, same testCount) — must NEVER appear in either n or nUnfiltered (poolSize is
  // never widened, unlike testCount).
  text += ndjsonRow({ kind: "run-summary", opId: "op-other-pool", poolSize: 2, testCount: 700, executedCount: 700, failedCount: 0, durationMs: 500_000 });
  text += noiseRows(2);
  // THE RUN UNDER COMPARISON — clean itself, but must be EXCLUDED from its own baseline (n/nUnfiltered).
  text += ndjsonRow({ kind: "run-summary", opId: SELF_OP, poolSize: 3, testCount: 700, executedCount: 700, failedCount: 0, durationMs: 842_600 });
  fs.writeFileSync(ndjsonPath, text);

  const band = await computeGateTimingBand(SELF_OP, ndjsonPath);
  check("(1) band is found", band !== undefined);
  check("(1) poolSize/testFileCount echo the SELF run's own stratum", band.poolSize === 3 && band.testFileCount === 700);
  check("(1) testFileCountSpan is degenerate [700,700] — the exact match alone already had >= MIN_BAND_N", band.testFileCountSpan[0] === 700 && band.testFileCountSpan[1] === 700);
  check("(1) nUnfiltered counts all 10 same-poolSize+testCount rows (8 clean + 1 incomplete + 1 failed)", band.nUnfiltered === 10);
  check("(1) n counts ONLY the 8 clean (complete + zero-failure) runs — no widening needed", band.n === 8);
  check("(1) nExact equals n (no widening happened)", band.nExact === band.n);
  check("(1) minSec is the smallest CLEAN duration (700s) — NOT the incomplete run's 100s", band.minSec === 700);
  check("(1) medianSec is the average of the 4th/5th of 8 sorted clean values (730s,740s) = 735s", band.medianSec === 735);
  check("(1) maxSec is the largest CLEAN duration (770s) — NOT the failing run's 2000s", band.maxSec === 770);
  check("(1) instrument names its producer (run-summary.durationMs)", typeof band.instrument === "string" && band.instrument.includes("durationMs"));
  check("(1) filter names what was excluded and says no widening was needed", typeof band.filter === "string" && band.filter.includes("failedCount") && band.filter.includes("no widening needed"));
  check("(1) readWindowTruncated is false (file fits well under the default read cap)", band.readWindowTruncated === false);
}

// ── (2) self row not found in the file at all → undefined, never a fabricated empty band ──────────────────
{
  const band = await computeGateTimingBand("op-does-not-exist", ndjsonPath);
  check("(2) an opId with no matching run-summary row returns undefined", band === undefined);
}

// ── (3) file does not exist at all → undefined ──────────────────────────────────────────────────────────
{
  const band = await computeGateTimingBand("anything", `${dir}/does-not-exist.ndjson`);
  check("(3) a missing NDJSON file returns undefined", band === undefined);
}

// ── (4) self is the ONLY row in its poolSize at all → n:0, nUnfiltered:0, nExact:0, degenerate span ────────
{
  const SELF_OP = "op-self-lonely";
  const text = ndjsonRow({ kind: "run-summary", opId: SELF_OP, poolSize: 7, testCount: 42, executedCount: 42, failedCount: 0, durationMs: 100_000 });
  const lonelyPath = `${dir}/lonely.ndjson`;
  fs.writeFileSync(lonelyPath, text);
  const band = await computeGateTimingBand(SELF_OP, lonelyPath);
  check("(4) band still found (self row exists)", band !== undefined);
  check("(4) n is 0 — no other runs at this poolSize to widen into", band.n === 0);
  check("(4) nUnfiltered is 0 too", band.nUnfiltered === 0);
  check("(4) nExact is 0", band.nExact === 0);
  check("(4) testFileCountSpan stays degenerate [42,42] — nothing existed to widen into", band.testFileCountSpan[0] === 42 && band.testFileCountSpan[1] === 42);
  check("(4) minSec/medianSec/maxSec are OMITTED, never fabricated as 0/null", band.minSec === undefined && band.medianSec === undefined && band.maxSec === undefined);
}

// ── (5) bounded read: a small LOOM_GATE_TIMING_READ_CAP_BYTES excludes an OLD row outside the tail ─────────
{
  const SELF_OP = "op-self-truncation";
  const oldRow = ndjsonRow({ kind: "run-summary", opId: "op-old", poolSize: 5, testCount: 500, executedCount: 500, failedCount: 0, durationMs: 999_000 });
  // Pad well past any small cap so the old row genuinely falls outside a tight tail window.
  const padding = noiseRows(4000); // ~4000 * ~90 bytes/row-pair ≈ hundreds of KB
  const recentRow = ndjsonRow({ kind: "run-summary", opId: "op-recent", poolSize: 5, testCount: 500, executedCount: 500, failedCount: 0, durationMs: 600_000 });
  const selfRow = ndjsonRow({ kind: "run-summary", opId: SELF_OP, poolSize: 5, testCount: 500, executedCount: 500, failedCount: 0, durationMs: 610_000 });
  const text = oldRow + padding + recentRow + selfRow;
  const truncPath = `${dir}/trunc.ndjson`;
  fs.writeFileSync(truncPath, text);
  const totalBytes = Buffer.byteLength(text, "utf8");

  const savedCap = process.env.LOOM_GATE_TIMING_READ_CAP_BYTES;
  try {
    // Small cap: only the tail (recent + self) should be visible — op-old excluded. Note: poolSize:5 has
    // no OTHER testCount in this fixture at all, so there is nothing to widen into either way — this case
    // isolates the READ-BOUND behavior from the widening behavior on purpose.
    process.env.LOOM_GATE_TIMING_READ_CAP_BYTES = "2048";
    const smallCapBand = await computeGateTimingBand(SELF_OP, truncPath);
    check("(5 small cap) band found", smallCapBand !== undefined);
    check("(5 small cap) readWindowTruncated is true", smallCapBand?.readWindowTruncated === true);
    check("(5 small cap) readWindowBytes is at most the configured cap", smallCapBand !== undefined && smallCapBand.readWindowBytes <= 2048);
    check("(5 small cap) the OLD row (999s) is excluded — n is 1 (only op-recent), not 2", smallCapBand?.n === 1);
    check("(5 small cap) medianSec reflects ONLY the recent row (600s), not the old one", smallCapBand?.medianSec === 600);

    // Large cap: the whole file fits — op-old is now included, changing n and the median.
    process.env.LOOM_GATE_TIMING_READ_CAP_BYTES = String(totalBytes + 1024);
    const bigCapBand = await computeGateTimingBand(SELF_OP, truncPath);
    check("(5 big cap) readWindowTruncated is false (whole file read)", bigCapBand?.readWindowTruncated === false);
    check("(5 big cap) the OLD row is now included — n is 2 (op-old + op-recent)", bigCapBand?.n === 2);
    check("(5 big cap) medianSec is the average of 600s and 999s (799.5s)", bigCapBand?.medianSec === 799.5);
  } finally {
    if (savedCap === undefined) delete process.env.LOOM_GATE_TIMING_READ_CAP_BYTES;
    else process.env.LOOM_GATE_TIMING_READ_CAP_BYTES = savedCap;
  }
}

// ── (6) WIDENING — exact match too thin (< MIN_BAND_N), widens outward to the nearest testCounts ───────────
{
  const SELF_OP = "op-self-widen";
  let text = "";
  // Exact stratum (poolSize:4, testCount:500): only 2 clean rows — below MIN_BAND_N=8, must trigger widening.
  text += ndjsonRow({ kind: "run-summary", opId: "op-500-a", poolSize: 4, testCount: 500, executedCount: 500, failedCount: 0, durationMs: 500_000 });
  text += ndjsonRow({ kind: "run-summary", opId: "op-500-b", poolSize: 4, testCount: 500, executedCount: 500, failedCount: 0, durationMs: 510_000 });
  // distance-1 neighbour BELOW (499): 3 clean rows. Sort order for equidistant neighbours favors the
  // smaller value (499 before 501) — this stratum is visited SECOND.
  text += ndjsonRow({ kind: "run-summary", opId: "op-499-a", poolSize: 4, testCount: 499, executedCount: 499, failedCount: 0, durationMs: 480_000 });
  text += ndjsonRow({ kind: "run-summary", opId: "op-499-b", poolSize: 4, testCount: 499, executedCount: 499, failedCount: 0, durationMs: 490_000 });
  text += ndjsonRow({ kind: "run-summary", opId: "op-499-c", poolSize: 4, testCount: 499, executedCount: 499, failedCount: 0, durationMs: 495_000 });
  // distance-1 neighbour ABOVE (501): 4 clean rows + 1 FAILING row (must count in nUnfiltered, not n).
  // 2 (exact) + 3 (499) = 5 clean so far, still < 8 — this bucket must ALSO be pulled in.
  text += ndjsonRow({ kind: "run-summary", opId: "op-501-a", poolSize: 4, testCount: 501, executedCount: 501, failedCount: 0, durationMs: 520_000 });
  text += ndjsonRow({ kind: "run-summary", opId: "op-501-b", poolSize: 4, testCount: 501, executedCount: 501, failedCount: 0, durationMs: 525_000 });
  text += ndjsonRow({ kind: "run-summary", opId: "op-501-c", poolSize: 4, testCount: 501, executedCount: 501, failedCount: 0, durationMs: 530_000 });
  text += ndjsonRow({ kind: "run-summary", opId: "op-501-d", poolSize: 4, testCount: 501, executedCount: 501, failedCount: 0, durationMs: 535_000 });
  text += ndjsonRow({ kind: "run-summary", opId: "op-501-failed", poolSize: 4, testCount: 501, executedCount: 501, failedCount: 1, durationMs: 999_000 });
  // A FAR neighbour (distance 50) that must NEVER be needed — reaching it would prove the "stop as soon as
  // MIN_BAND_N is reached" early-exit is broken.
  text += ndjsonRow({ kind: "run-summary", opId: "op-far", poolSize: 4, testCount: 550, executedCount: 550, failedCount: 0, durationMs: 1_000_000 });
  text += ndjsonRow({ kind: "run-summary", opId: SELF_OP, poolSize: 4, testCount: 500, executedCount: 500, failedCount: 0, durationMs: 505_000 });
  const widenPath = `${dir}/widen.ndjson`;
  fs.writeFileSync(widenPath, text);

  const band = await computeGateTimingBand(SELF_OP, widenPath);
  check("(6) band found", band !== undefined);
  check("(6) poolSize/testFileCount echo the SELF run's own EXACT values", band.poolSize === 4 && band.testFileCount === 500);
  check("(6) nExact is 2 — the exact testFileCount=500 match alone, regardless of the widening below", band.nExact === 2);
  check("(6) testFileCountSpan widened to [499,501] — never reaching the far testCount=550 bucket", band.testFileCountSpan[0] === 499 && band.testFileCountSpan[1] === 501);
  check("(6) n is 9 — 2 (exact) + 3 (499) + 4 (501), stopping the instant MIN_BAND_N=8 is reached", band.n === 9);
  check("(6) nUnfiltered is 10 — the same widened population PLUS the one failing row at testCount=501", band.nUnfiltered === 10);
  check("(6) minSec is the smallest of the 9 clean durations (480s)", band.minSec === 480);
  check("(6) medianSec is the middle (5th of 9 sorted) clean duration (510s)", band.medianSec === 510);
  check("(6) maxSec is the largest of the 9 clean durations (535s) — NOT the failing row's 999s or the far row's 1000s", band.maxSec === 535);
  check("(6) filter names the widened span and why", typeof band.filter === "string" && band.filter.includes("widened") && band.filter.includes("[499, 501]") && band.filter.includes("nExact=2"));
}

// ── (7) SELF-ROW SELECTION — two run-summary rows share the SAME opId (the single-file merge-retry shape:
// a failed full-suite attempt followed by a passing single-file retry under the SAME LOOM_GATE_OP_ID) ──────
{
  const SELF_OP = "op-multi-row";
  let text = "";
  // 8 clean historical rows at (poolSize:3, testCount:750) — enough that the exact match needs no widening,
  // isolating this test to ONLY the self-row-selection question.
  [700, 710, 720, 730, 740, 750, 760, 770].forEach((s, i) => {
    text += ndjsonRow({ kind: "run-summary", opId: `op-hist-${i}`, poolSize: 3, testCount: 750, executedCount: 750, failedCount: 0, durationMs: s * 1000 });
  });
  // DELIBERATELY WRITTEN OUT OF chronological order — the single-file RETRY (testCount:1) appears in the
  // file BEFORE the failed full-suite attempt (testCount:750) it actually followed in real life. This is
  // the discriminating fixture: a "first match in file order" selection would pick testCount:1 here, while
  // the correct "largest testCount wins" selection picks 750 regardless of position. Real gate runs always
  // write the full attempt first and the retry second — this fixture proves the selection doesn't
  // secretly depend on that ordering rather than actually deciding by testCount.
  text += ndjsonRow({ kind: "run-summary", opId: SELF_OP, poolSize: 3, testCount: 1, executedCount: 1, failedCount: 0, durationMs: 5_000 });
  text += ndjsonRow({ kind: "run-summary", opId: SELF_OP, poolSize: 3, testCount: 750, executedCount: 750, failedCount: 1, durationMs: 900_000 });
  const multiPath = `${dir}/multi-row.ndjson`;
  fs.writeFileSync(multiPath, text);

  const band = await computeGateTimingBand(SELF_OP, multiPath);
  check("(7) band found", band !== undefined);
  check("(7) picks the LARGER-testCount row (750, the real full-suite run) as self — NOT the single-file retry's testCount:1", band.testFileCount === 750);
  check("(7) testFileCountSpan is [750,750] — the exact match (8 clean historical) needed no widening", band.testFileCountSpan[0] === 750 && band.testFileCountSpan[1] === 750);
  check("(7) nUnfiltered is 8 — BOTH of this op's own rows (the failed 750 AND the retry's testCount:1) are excluded from its own baseline", band.nUnfiltered === 8);
  check("(7) n is 8 — all 8 historical rows are clean", band.n === 8);
}

// ── (8) SCHEDULING SHAPE (card c8df9663) — isolatedPhaseFileCount is a SECOND exact, never-widened key
// dimension alongside poolSize. Same (poolSize, testCount) stratum holds BOTH a flat population (shape 0,
// one row's field OMITTED entirely to prove undefined normalizes the same as 0) and an isolated-phase
// population (shape 5) at wildly different durations. RED-PROVEN: pre-fix code ignored shape entirely, so
// the exact testCount=300 stratum would see 8 flat + 3 isolated = 11 clean samples (>= MIN_BAND_N), never
// widen, and report n=11/nExact=11 with a median pulled toward the isolated durations for EITHER self run
// — this fixture is exactly the confound the card's own body describes. ────────────────────────────────────
{
  const SELF_FLAT = "op-self-flat";
  const SELF_ISO = "op-self-iso";
  let text = "";
  // Group A — FLAT (shape 0), poolSize:6, testCount:300, 8 clean rows (>= MIN_BAND_N alone, no widening
  // needed for the flat self). One row OMITS isolatedPhaseFileCount entirely (pre-0f0816e2 shape); the
  // rest set it explicitly to 0 — both must normalize identically.
  const flatSecs = [300, 310, 320, 330, 340, 350, 360, 370];
  flatSecs.forEach((s, i) => {
    const row = { kind: "run-summary", opId: `op-flat-${i}`, poolSize: 6, testCount: 300, executedCount: 300, failedCount: 0, durationMs: s * 1000 };
    if (i > 0) row.isolatedPhaseFileCount = 0; // row 0 deliberately omits the field
    text += ndjsonRow(row);
  });
  // Group B — ISOLATED-PHASE (shape 5), SAME poolSize:6, SAME testCount:300, 3 clean rows at durations far
  // outside the flat group's range — must be COMPLETELY invisible to the flat self's band.
  [700, 710, 720].forEach((s, i) => {
    text += ndjsonRow({ kind: "run-summary", opId: `op-iso-300-${i}`, poolSize: 6, testCount: 300, isolatedPhaseFileCount: 5, executedCount: 300, failedCount: 0, durationMs: s * 1000 });
  });
  // Group B neighbour — ISOLATED-PHASE (shape 5), testCount:299 (distance 1), 5 clean rows. 3 (exact) + 5
  // (neighbour) = 8, reaching MIN_BAND_N — proves widening for the isolated self stays WITHIN shape 5 and
  // never reaches into the abundant flat testCount:300 population sitting right at distance 0.
  [670, 680, 690, 695, 705].forEach((s, i) => {
    text += ndjsonRow({ kind: "run-summary", opId: `op-iso-299-${i}`, poolSize: 6, testCount: 299, isolatedPhaseFileCount: 5, executedCount: 299, failedCount: 0, durationMs: s * 1000 });
  });
  // Self rows — one flat (field omitted, same as a legacy pre-card opId), one isolated-phase.
  text += ndjsonRow({ kind: "run-summary", opId: SELF_FLAT, poolSize: 6, testCount: 300, executedCount: 300, failedCount: 0, durationMs: 305_000 });
  text += ndjsonRow({ kind: "run-summary", opId: SELF_ISO, poolSize: 6, testCount: 300, isolatedPhaseFileCount: 5, executedCount: 300, failedCount: 0, durationMs: 715_000 });
  const shapePath = `${dir}/shape.ndjson`;
  fs.writeFileSync(shapePath, text);

  const flatBand = await computeGateTimingBand(SELF_FLAT, shapePath);
  check("(8 flat self) band found", flatBand !== undefined);
  check("(8 flat self) isolatedPhaseFileCount echoes 0 (self's own field was OMITTED, normalized)", flatBand?.isolatedPhaseFileCount === 0);
  check("(8 flat self) testFileCountSpan stays [300,300] — the 8 flat rows alone already meet MIN_BAND_N, no widening", flatBand?.testFileCountSpan?.[0] === 300 && flatBand?.testFileCountSpan?.[1] === 300);
  check("(8 flat self) nExact is 8 — ONLY the flat rows, never the 3 same-testCount isolated-phase rows", flatBand?.nExact === 8);
  check("(8 flat self) n is 8 (not 11 — proves the isolated-phase rows never entered the pool)", flatBand?.n === 8);
  check("(8 flat self) minSec/maxSec stay inside the flat range (300s/370s), never reaching the isolated 700s-720s durations", flatBand?.minSec === 300 && flatBand?.maxSec === 370);
  check("(8 flat self) medianSec is the flat group's own median (335s)", flatBand?.medianSec === 335);
  check("(8 flat self) filter names isolatedPhaseFileCount=0", typeof flatBand?.filter === "string" && flatBand.filter.includes("isolatedPhaseFileCount=0"));

  const isoBand = await computeGateTimingBand(SELF_ISO, shapePath);
  check("(8 iso self) band found", isoBand !== undefined);
  check("(8 iso self) isolatedPhaseFileCount echoes 5", isoBand?.isolatedPhaseFileCount === 5);
  check("(8 iso self) nExact is 3 — ONLY the isolated-phase rows at testCount=300, never the 8 same-testCount flat rows", isoBand?.nExact === 3);
  check("(8 iso self) testFileCountSpan widens to [299,300] — WITHIN shape 5 only, never touching the flat population sitting at distance 0", isoBand?.testFileCountSpan?.[0] === 299 && isoBand?.testFileCountSpan?.[1] === 300);
  check("(8 iso self) n is 8 (3 exact + 5 neighbour, not 11 — proves the flat rows never entered the pool)", isoBand?.n === 8);
  check("(8 iso self) minSec/maxSec stay inside the isolated-phase range (670s/720s), never reaching the flat 300s-370s durations", isoBand?.minSec === 670 && isoBand?.maxSec === 720);
  check("(8 iso self) medianSec is the isolated-phase population's own median (697.5s)", isoBand?.medianSec === 697.5);
  check("(8 iso self) filter names isolatedPhaseFileCount=5", typeof isoBand?.filter === "string" && isoBand.filter.includes("isolatedPhaseFileCount=5"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 19c0ef1e: computeGateTimingBand stratifies by EXACT poolSize (never widened), picks the largest-testCount row when an op's opId spans more than one run-summary row (the single-file merge-retry shape) and excludes ALL of that op's own rows from its own baseline, filters to complete+zero-failure runs before computing min/median/max, widens the testCount match to the nearest neighbours (stopping the instant MIN_BAND_N is reached) only when the exact match alone is too thin, reports the exact-only count (nExact) alongside the (possibly widened) n/nUnfiltered, names the actual testCountSpan the band was computed over, and bounds its read of the unboundedly-growing NDJSON to a tail byte cap. Card c8df9663: isolatedPhaseFileCount (scheduling shape) is a second exact, never-widened key dimension alongside poolSize — a band can never silently mix a flat run's history with an isolated-phase run's, in either direction."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
