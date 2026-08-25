// One-off patch: runs 1-7 of this card's corpus were emitted before the maxInterEventGapMs pre-failure/
// whole-run split existed (manager-directed fix). This reconciles them in place rather than discarding
// them (docs/investigations/42d9d64c-kickoff-real-spawn-stall/README.md documents which rows are native
// v2 vs reconciled v1).
//
// For a PASSING row the split is trivial: no failure occurred, so pre-failure == whole-run by
// construction — the old single number is copied to both new fields unchanged, no information lost.
//
// For the one FAILING row (run 1), the per-chunk arrival timestamps needed to recompute an exact
// chunk-gap figure were never persisted to disk under the v1 instrument (only the joined text was
// written to the .log file) — so it is NOT reconstructed as a chunk-gap. Instead, the retained log text
// itself carries the test's OWN authoritative measurement of the pre-failure gap: the STALL error's own
// "no new output (heartbeat included) for Xms" figure, which is a MORE DIRECT measurement of the same
// underlying quantity than this driver's own coarse console-line-arrival proxy would have given anyway.
// That figure is extracted from run-01-fail.log and used verbatim, sourced explicitly as such (not
// fabricated, not a re-derived chunk gap).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "..");
const NDJSON_PATH = path.join(DIR, "runs.ndjson");
const RUNS_DIR = path.join(DIR, "runs");

const lines = fs.readFileSync(NDJSON_PATH, "utf8").trim().split("\n").map((l) => JSON.parse(l));

for (const row of lines) {
  if (row.maxInterEventGapMs === undefined) continue; // already v2
  const legacyValue = row.maxInterEventGapMs;
  delete row.maxInterEventGapMs;
  row.maxInterEventGapWholeRunMs = legacyValue;
  row.gapInstrumentVersion = 1;

  if (row.outcome === "pass") {
    row.maxInterEventGapPreFailureMs = legacyValue;
    row.maxInterEventGapPreFailureSource = "trivial-no-failure";
  } else {
    // Extract the STALL error's own "no new output ... for Xms" figure directly from the retained log.
    const logPath = path.join(RUNS_DIR, `run-${String(row.run).padStart(2, "0")}-fail.log`);
    const text = fs.readFileSync(logPath, "utf8");
    const m = text.match(/no new output \(heartbeat included\) for (\d+)ms \(budget \d+ms\)/);
    if (m) {
      row.maxInterEventGapPreFailureMs = Number(m[1]);
      row.maxInterEventGapPreFailureSource = "extracted-from-stall-message-text (test's own authoritative no-new-output measurement, not a re-derived chunk gap — v1 instrument did not persist per-chunk arrival timestamps)";
    } else {
      row.maxInterEventGapPreFailureMs = null;
      row.maxInterEventGapPreFailureSource = "not-recoverable — v1 instrument did not persist per-chunk timestamps and no STALL message was found in the retained log to extract from";
    }
  }
}

fs.writeFileSync(NDJSON_PATH, lines.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
console.log(`Patched ${lines.length} rows in ${NDJSON_PATH}`);
for (const row of lines) {
  console.log(`  run ${row.run}: outcome=${row.outcome} gapInstrumentVersion=${row.gapInstrumentVersion ?? 2} preFailure=${row.maxInterEventGapPreFailureMs} wholeRun=${row.maxInterEventGapWholeRunMs}`);
}
