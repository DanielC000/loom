// Manager-directed fix on 42d9d64c: maxInterEventGapPreFailureMs must be ONE instrument (this driver's
// own chunk-arrival parser) across every row, never mixed with the harness's OWN stall detector ("no new
// output (heartbeat included) for Nms") — those are different measurements of a related but distinct
// quantity (parser-recognized line arrivals vs ANY output byte, heartbeats included), and a number lifted
// from an assertion string carries different precision/semantics than one computed from timestamps.
//
// Running the manager's own decisive check (comparing both numbers for one real run) surfaced a SECOND,
// more serious bug: run-loop.mjs's `findFailureMarkerTMs` bounds "pre-failure" at the chunk containing
// "💥 UNCAUGHT" — but that text is only ever printed by the file's OUTERMOST catch block, which (ordinary
// JS try/finally semantics) only runs AFTER the file's own `finally` safety-net sweep has ALREADY
// completed (confirmed directly in run-08-fail.txt: the true failure moment is the
// "[measured [large 40000]] SessionStart→FIXTURE_RECEIVED: 19922ms" line at :424, but the ~25000ms
// stranding-sweep wait for real-late-ready at :442-443 prints BEFORE "💥 UNCAUGHT" at :445). So
// maxInterEventGapPreFailureMs, as actually computed by the running loop, is NOT pre-failure at all for
// an uncaught-throw failure — it includes the entire stranding-cleanup sweep, which is exactly the
// contamination the pre/whole-run split was built to exclude. This affects every "stall"/"backstop"/
// "fixture-ready-timeout" fail row emitted by the CURRENT run-loop.mjs (the bug is in the live boundary
// computation, not recoverable after the fact — per-chunk arrival timestamps are never persisted to
// disk, only the joined text, so there is no way to recompute a corrected chunk-based gap post-hoc for
// ANY row, v1 or v2). Per the standing instruction not to restart the loop again, this script does NOT
// attempt to patch the live computation — it nulls the known-contaminated field on every affected row and
// documents why, so the corpus never reports a number that looks like a measurement but silently
// isn't one.
//
// This script adds a SEPARATE `stallAssertionMs` field (the harness's own detector value, extracted from
// the retained log text, present only on rows whose failureKind is "stall") to every row that has one —
// this figure is immune to the boundary bug above since it is read straight from the harness's own
// self-report, not derived from chunk-arrival timestamps — and nulls maxInterEventGapPreFailureMs on
// every row whose value would otherwise be contaminated (either by the v1 text-extraction shortcut, or by
// the boundary bug described above), so the parser-gap column is never a silent mix of "real parser
// measurement" and "something else that happens to be a number."
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "..");
const NDJSON_PATH = path.join(DIR, "runs.ndjson");
const RUNS_DIR = path.join(DIR, "runs");

const lines = fs.readFileSync(NDJSON_PATH, "utf8").trim().split("\n").map((l) => JSON.parse(l));

for (const row of lines) {
  const logPath = path.join(RUNS_DIR, `run-${String(row.run).padStart(2, "0")}-${row.outcome}.txt`);
  if (!fs.existsSync(logPath)) { console.log(`  run ${row.run}: log not found at ${logPath}, skipping`); continue; }
  const text = fs.readFileSync(logPath, "utf8");
  const m = text.match(/no new output \(heartbeat included\) for (\d+)ms \(budget \d+ms\)/);
  row.stallAssertionMs = m ? Number(m[1]) : null;

  if (row.maxInterEventGapPreFailureSource && row.maxInterEventGapPreFailureSource.startsWith("extracted-from-stall-message-text")) {
    // v1's hand-patch (run 1): the value living in maxInterEventGapPreFailureMs is actually the SAME
    // number now correctly homed in stallAssertionMs. Not computable for this row from this driver's own
    // parser: v1 discarded per-chunk arrival timestamps entirely.
    row.maxInterEventGapPreFailureMs = null;
    row.maxInterEventGapPreFailureSource = "not-computable — v1 instrument discarded per-chunk arrival timestamps; see stallAssertionMs for the harness's own (differently-instrumented) stall-detector figure for this same failure";
  } else if (["stall", "backstop", "fixture-ready-timeout"].includes(row.failureKind)) {
    // Every uncaught-throw failure emitted by the CURRENT run-loop.mjs (v2) shares the boundary bug
    // described at file top: its "failure marker" is "💥 UNCAUGHT", which prints only after the file's
    // own finally-block stranding sweep has already completed, so the reported value silently includes
    // that cleanup-phase wait rather than excluding it. Confirmed directly on run 8 (see file-top note).
    row.maxInterEventGapPreFailureMs = null;
    row.maxInterEventGapPreFailureSource = "contaminated-by-boundary-bug — run-loop.mjs's failure marker (\"💥 UNCAUGHT\") prints after the finally-block stranding sweep already ran, so the live-computed value included that sweep's ~25000ms-per-stranded-session wait rather than excluding it; not recoverable post-hoc (no persisted per-chunk timestamps); see stallAssertionMs for the harness's own stall-detector figure instead";
  }
}

fs.writeFileSync(NDJSON_PATH, lines.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
console.log(`Updated ${lines.length} rows in ${NDJSON_PATH}`);
for (const row of lines) {
  console.log(`  run ${row.run}: outcome=${row.outcome} failureKind=${row.failureKind} preFailure(parser)=${row.maxInterEventGapPreFailureMs} stallAssertionMs(harness)=${row.stallAssertionMs}`);
}
