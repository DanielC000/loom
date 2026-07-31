// Phase 2 (per manager directive #5's renumbering) — baseline census: N=20 full-suite runs at the real
// gate profile (LOOM_TEST_CONCURRENCY=2, unmodified composition C0). Invoked in SMALL BATCHES (--start/
// --count) rather than one long-lived process, so a recycled successor can resume from the NDJSON alone
// without needing to reconnect to a background task. Run from packages/daemon:
//   node test/census/phase2-baseline.mjs --start 1 --count 5
import path from "node:path";
import fs from "node:fs";
import {
  discoverHermetic, runCensusBatch, appendNdjson, hostSnapshot,
  readNdjson, assertRunIndexAvailable, nextRunIndex, computeOverlappingRunIndices, summarizeExecuted,
} from "./lib.mjs";

const OUT = path.join(import.meta.dirname, "raw", "baseline.ndjson");
const PHASE = "2-baseline";

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? def : Number(process.argv[i + 1]);
}
const explicitStart = argVal("--start", null);
const count = argVal("--count", 5);

const { names } = await discoverHermetic();
// Card f106f28e DoD #2: omitting --start derives the next free index FROM THE FILE (max existing + 1),
// so two concurrent invocations that both omit it don't independently mint the same label. An explicit
// --start is still honored as a deliberate override — assertRunIndexAvailable below gates it too, so an
// override that collides is refused, not silently accepted.
const start = explicitStart ?? nextRunIndex(readNdjson(OUT), PHASE);
console.log(`Baseline census: ${names.length} hermetic tests, LOOM_TEST_CONCURRENCY=2, runs ${start}..${start + count - 1}` + (explicitStart === null ? " (--start derived from file)" : " (--start explicit override)"));

for (let i = 0; i < count; i++) {
  const runIndex = start + i;

  // Read back fresh EVERY iteration — a prior iteration in this same loop just appended a row, and a
  // separate concurrent invocation could have appended one too. Card f106f28e: this read-back was
  // previously entirely absent (`runIndex` was pure argv arithmetic), which is exactly how
  // raw/baseline.ndjson ended up with two rows at runIndex:4. Checked BEFORE the expensive
  // runCensusBatch call, so a doomed re-run is refused in seconds, not after a ~15-20 minute suite run.
  const existingRows = readNdjson(OUT);
  try {
    assertRunIndexAvailable(existingRows, runIndex, PHASE);
  } catch (err) {
    console.error(`❌ [baseline] ${err.message}`);
    process.exit(1);
  }

  const hostBefore = hostSnapshot();
  const { results, durationMs, poolSize } = await runCensusBatch({ names, poolSize: 2, basePort: 4500 });
  const hostAfter = hostSnapshot();
  const failed = results.filter((r) => !r.ok);
  const { executedCount, executedNames } = summarizeExecuted(results);
  const record = {
    ts: new Date().toISOString(),
    phase: PHASE,
    runIndex,
    composition: "C0",
    poolSize,
    durationMs,
    testCount: names.length,
    // Card f106f28e DoD #3: the EXECUTED evidence, not just the verdict — see summarizeExecuted's doc
    // comment in lib.mjs for why testCount/failed alone can't answer "did this test actually run".
    executedCount,
    executedNames,
    failed: failed.map((f) => ({ name: f.name, status: f.status, stdout: f.stdout, stderr: f.stderr })),
    failedCount: failed.length,
    hostBefore,
    hostAfter,
    // Known concurrent fleet activity at authoring time — not derived from gate_queue/activeCount
    // (that only sees admitted lanes, not real host load); a plain factual note, not a "quiet host" claim.
    knownConcurrentActivity: "one other worker on this project doing light log-mining (grep/awk), negligible CPU",
  };
  // Card f106f28e DoD #4/#5: flag wall-clock overlap at append time, computed from timestamps — never
  // refuses the append (an overlapping run is still real data), just names it so a reader doesn't have to
  // re-derive it by hand the way the f106f28e audit did.
  record.overlapsRows = computeOverlappingRunIndices(existingRows, record, PHASE);
  if (record.overlapsRows.length) {
    console.warn(`⚠ [baseline] run ${runIndex} wall-clock OVERLAPS existing row(s) ${record.overlapsRows.join(", ")} — contamination risk, see overlapsRows in the persisted record.`);
  }
  appendNdjson(OUT, record);
  console.log(`[baseline] run ${runIndex}: ${failed.length === 0 ? "CLEAN" : `${failed.length} FAILED: ${failed.map((f) => f.name).join(", ")}`} (${durationMs}ms, pool=${poolSize}, executed=${executedCount}/${names.length})`);
}

// Running tally across ALL runs recorded so far (not just this invocation's batch) — read back from the
// NDJSON file itself, so a resumed/recycled successor gets the true cumulative state, not just this batch.
const all = fs.readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.phase === "2-baseline");
const totalRuns = all.length;
const totalFailedRuns = all.filter((r) => r.failedCount > 0).length;
const perTestFailCounts = {};
for (const r of all) for (const f of r.failed) perTestFailCounts[f.name] = (perTestFailCounts[f.name] ?? 0) + 1;
console.log(`\n=== Cumulative baseline tally: ${totalRuns} runs recorded, ${totalFailedRuns} run(s) had ≥1 failure ===`);
if (Object.keys(perTestFailCounts).length) {
  console.log("Per-test failure counts so far:", JSON.stringify(perTestFailCounts));
} else {
  console.log("No failures recorded in any run so far.");
}
