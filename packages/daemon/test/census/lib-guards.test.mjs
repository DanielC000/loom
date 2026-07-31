// loom:gate-exempt: card fa52f555 — a real hermetic test, deliberately run manually / out of band; see
// the "Not run by the real gate" note below for why it lives in the excluded census/ dir.
// Card f106f28e — hermetic unit tests for the runIndex-dedup / overlap-flagging / executed-evidence
// guards added to lib.mjs. Never touches test/*.mjs, src/**, or shared/**  — census-scoped, as directed.
//
// Positive/negative controls are run against the REAL raw/baseline.ndjson corpus (READ-ONLY here — never
// mutated, never renumbered) wherever possible, not a synthetic fixture: that file already contains the
// exact production duplicate (two rows at runIndex:4) and the exact production overlap
// (runIndex:4-second-row <-> runIndex:5, "chained forward into a differently-labelled row") this fix
// exists to catch, so testing against it is a stronger control than a synthetic corpus that could never
// have produced the failure in the first place (`positive-control-your-searches-empty-is-not-evidence`).
// A small hand-crafted pair supplements it for the literal DoD #4 shape ("two hand-crafted rows whose
// windows overlap").
//
// Not run by the real gate (scripts/test-daemon.mjs never descends into test/census/ — EXCLUDED_DIR_NAMES
// — and discoverHermetic() only scans the top-level test/ dir). Run directly:
//   node test/census/lib-guards.test.mjs
import path from "node:path";
import {
  readNdjson, assertRunIndexAvailable, nextRunIndex, computeOverlappingRunIndices, summarizeExecuted,
} from "./lib.mjs";

const REAL_BASELINE = path.join(import.meta.dirname, "raw", "baseline.ndjson");

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

console.log("=== assertRunIndexAvailable ===");
{
  const rows = readNdjson(REAL_BASELINE);
  check("real corpus sanity: baseline.ndjson has exactly 7 rows (never mutated by this test)", rows.length === 7);

  // RED case: runIndex 4 really IS duplicated in production (two rows) — this is the actual incident the
  // fix exists to prevent, not a synthetic stand-in for it. Proves the guard can refuse.
  let threw = null;
  try { assertRunIndexAvailable(rows, 4, "2-baseline"); } catch (err) { threw = err; }
  check("assertRunIndexAvailable REFUSES runIndex:4 — the real, already-duplicated production index", threw !== null);
  check("the refusal message names the colliding index", !!threw && threw.message.includes("4"));

  // Negative control: a genuinely free index must NOT be refused — proves the guard can also pass, not
  // just always throw.
  let notThrown = true;
  try { assertRunIndexAvailable(rows, 99, "2-baseline"); } catch { notThrown = false; }
  check("assertRunIndexAvailable does NOT refuse a genuinely free index (negative control)", notThrown);

  // Phase-scoped, not file-scoped: the same numeric index in a different phase never collides.
  let differentPhaseOk = true;
  try { assertRunIndexAvailable(rows, 4, "0"); } catch { differentPhaseOk = false; }
  check("assertRunIndexAvailable is phase-scoped: runIndex:4 under a DIFFERENT phase does not collide", differentPhaseOk);
}

console.log("\n=== nextRunIndex ===");
{
  const rows = readNdjson(REAL_BASELINE);
  check(
    "nextRunIndex derives 7 from the real file (max recorded runIndex is 6, across rows 1,2,3,4,4,5,6)",
    nextRunIndex(rows, "2-baseline") === 7,
  );
  check("nextRunIndex is 1 when no rows exist yet for the phase", nextRunIndex([], "2-baseline") === 1);
  check(
    "nextRunIndex ignores rows recorded under a different phase",
    nextRunIndex([{ phase: "0", runIndex: 999 }], "2-baseline") === 1,
  );
}

console.log("\n=== computeOverlappingRunIndices — real corpus ===");
{
  const rows = readNdjson(REAL_BASELINE);
  const [line1, line2, line3, line4, line5dup, line6, line7] = rows;
  check(
    "corpus shape sanity: line4 & line5dup are the two runIndex:4 rows; line6=runIndex:5, line7=runIndex:6",
    line4.runIndex === 4 && line5dup.runIndex === 4 && line6.runIndex === 5 && line7.runIndex === 6,
  );

  // The audit's headline finding, found by hand: the SECOND runIndex:4 row's window overlaps the
  // DIFFERENTLY-LABELLED runIndex:5 row's window by ~8.3 minutes — "contamination chained forward". Must
  // be re-derivable automatically from timestamps alone, and must correctly pick out only the row that
  // actually overlaps (not the first runIndex:4 row, which ends ~1s before this window starts).
  const overlapsWithLine6 = computeOverlappingRunIndices([line1, line2, line3, line4, line5dup], line6, "2-baseline");
  check(
    "computeOverlappingRunIndices finds the real production overlap (2nd runIndex:4 row overlaps runIndex:5's window), and only that one",
    JSON.stringify(overlapsWithLine6) === JSON.stringify([4]),
  );

  // Negative control: the audit's own verified-clean cluster (runIndex 2, 3, 6) — none should overlap.
  const cleanOverlap = computeOverlappingRunIndices([line2, line3], line7, "2-baseline");
  check("computeOverlappingRunIndices reports NO overlap for the audit's verified-clean cluster (negative control)", cleanOverlap.length === 0);
}

console.log("\n=== computeOverlappingRunIndices — hand-crafted pair (DoD #4's literal shape) ===");
{
  const existing = [{
    phase: "2-baseline", runIndex: 10,
    hostBefore: { ts: "2026-08-01T00:00:00.000Z" }, hostAfter: { ts: "2026-08-01T00:10:00.000Z" },
    ts: "2026-08-01T00:10:00.000Z",
  }];
  const overlappingNew = {
    phase: "2-baseline", runIndex: 11,
    hostBefore: { ts: "2026-08-01T00:05:00.000Z" }, hostAfter: { ts: "2026-08-01T00:15:00.000Z" },
    ts: "2026-08-01T00:15:00.000Z",
  };
  const nonOverlappingNew = {
    phase: "2-baseline", runIndex: 12,
    hostBefore: { ts: "2026-08-01T00:20:00.000Z" }, hostAfter: { ts: "2026-08-01T00:30:00.000Z" },
    ts: "2026-08-01T00:30:00.000Z",
  };
  check(
    "hand-crafted: a new row whose window overlaps an existing row's is flagged",
    JSON.stringify(computeOverlappingRunIndices(existing, overlappingNew, "2-baseline")) === JSON.stringify([10]),
  );
  check(
    "hand-crafted: a new row whose window does NOT overlap is not flagged (negative control)",
    computeOverlappingRunIndices(existing, nonOverlappingNew, "2-baseline").length === 0,
  );
}

console.log("\n=== summarizeExecuted (DoD #3 — the ran-vs-never-ran evidence) ===");
{
  const cleanResults = [{ name: "a", ok: true }, { name: "b", ok: true }, { name: "c", ok: false, status: 1 }];
  const clean = summarizeExecuted(cleanResults);
  check("a clean run's executedCount matches its full result count", clean.executedCount === 3);
  check("executedNames is sorted and complete for a clean run", JSON.stringify(clean.executedNames) === JSON.stringify(["a", "b", "c"]));

  // The exact gap DoD #3 targets: a name whose file never resolved (`skipped:true`, runOneTimed's own
  // skip path) at the SAME nominal result count as the clean case above.
  const shortCircuited = [{ name: "a", ok: true }, { name: "b", ok: true, skipped: true }, { name: "c", ok: false, status: 1 }];
  const sc = summarizeExecuted(shortCircuited);
  check(
    "a short-circuited run's executedCount is LESS than its nominal length (positive control — proves this is not always 'everything ran')",
    sc.executedCount < shortCircuited.length,
  );
  check("the never-executed name is excluded from executedNames", !sc.executedNames.includes("b"));
  check(
    "at an IDENTICAL nominal length, the clean and short-circuited runs are now distinguishable by executedCount (the old testCount-only scheme could not do this)",
    cleanResults.length === shortCircuited.length && clean.executedCount !== sc.executedCount,
  );
}

console.log(`\n${failures === 0 ? "✅" : "❌"} census lib.mjs guard tests: ${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
