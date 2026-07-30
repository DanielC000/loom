// Phase 2 (per manager directive #5's renumbering) — baseline census: N=20 full-suite runs at the real
// gate profile (LOOM_TEST_CONCURRENCY=2, unmodified composition C0). Invoked in SMALL BATCHES (--start/
// --count) rather than one long-lived process, so a recycled successor can resume from the NDJSON alone
// without needing to reconnect to a background task. Run from packages/daemon:
//   node test/census/phase2-baseline.mjs --start 1 --count 5
import path from "node:path";
import fs from "node:fs";
import { discoverHermetic, runCensusBatch, appendNdjson, hostSnapshot } from "./lib.mjs";

const OUT = path.join(import.meta.dirname, "raw", "baseline.ndjson");

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? def : Number(process.argv[i + 1]);
}
const start = argVal("--start", 1);
const count = argVal("--count", 5);

const { names } = await discoverHermetic();
console.log(`Baseline census: ${names.length} hermetic tests, LOOM_TEST_CONCURRENCY=2, runs ${start}..${start + count - 1}`);

for (let i = 0; i < count; i++) {
  const runIndex = start + i;
  const hostBefore = hostSnapshot();
  const { results, durationMs, poolSize } = await runCensusBatch({ names, poolSize: 2, basePort: 4500 });
  const hostAfter = hostSnapshot();
  const failed = results.filter((r) => !r.ok);
  const record = {
    ts: new Date().toISOString(),
    phase: "2-baseline",
    runIndex,
    composition: "C0",
    poolSize,
    durationMs,
    testCount: names.length,
    failed: failed.map((f) => ({ name: f.name, status: f.status, stdout: f.stdout, stderr: f.stderr })),
    failedCount: failed.length,
    hostBefore,
    hostAfter,
    // Known concurrent fleet activity at authoring time — not derived from gate_queue/activeCount
    // (that only sees admitted lanes, not real host load); a plain factual note, not a "quiet host" claim.
    knownConcurrentActivity: "one other worker on this project doing light log-mining (grep/awk), negligible CPU",
  };
  appendNdjson(OUT, record);
  console.log(`[baseline] run ${runIndex}/20: ${failed.length === 0 ? "CLEAN" : `${failed.length} FAILED: ${failed.map((f) => f.name).join(", ")}`} (${durationMs}ms, pool=${poolSize})`);
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
