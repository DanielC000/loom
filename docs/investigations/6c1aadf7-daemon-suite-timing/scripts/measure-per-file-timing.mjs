// Card 6c1aadf7 — per-file timing across ≥3 runs of the real hermetic daemon suite.
// Reuses the census harness's own `runCensusBatch` (packages/daemon/test/census/lib.mjs) instead of
// duplicating its spawn/port/timeout logic — that harness already records per-file startTs/endTs/
// durationMs and mirrors the real gate's pool-of-lanes/fixed-port scheme exactly.
//
// Deliberately does NOT touch run_gate or the daemon-mediated gate path (the card forbids measuring via
// run_gate — it shares the resource under study). This spawns the suite directly, at the SAME
// LOOM_GATE_TEST_CONCURRENCY=2 default the merge gate itself uses, so the wall-clock shape is
// representative without being gate-mediated.
//
// This pass is NOT gate-admitted — invisible to gate_queue and every contention control this project
// has. Every row (per-file AND per-run) carries explicit UTC start/end timestamps so a reader can, after
// the fact, cross-reference against orchestration_events/gate_queue for anything else that landed inside
// the same window and attribute inflation instead of guessing at it (the exact hole `e75dc05a` found in
// admission-time-only snapshots — see that investigation's findings.md).
//
// Two row kinds, discriminated by `kind` (never inferred from field presence — same reasoning as the
// project's own "add a discriminating field" convention): `kind:"run-summary"` (one per run, the batch
// window + host snapshot) and `kind:"file"` (one per test file per run, with its own exact window).
//
// Usage (from packages/daemon):
//   node ../../docs/investigations/6c1aadf7-daemon-suite-timing/scripts/measure-per-file-timing.mjs --runs 3
import path from "node:path";
import { pathToFileURL } from "node:url";

const DAEMON_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "..", "packages", "daemon");
const { discoverHermetic, runCensusBatch, appendNdjson, hostSnapshot, summarizeExecuted } =
  await import(pathToFileURL(path.join(DAEMON_DIR, "test", "census", "lib.mjs")).href);

const OUT = path.join(import.meta.dirname, "..", "data", "per-file-timing.ndjson");

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? def : Number(process.argv[i + 1]);
}
const runs = argVal("--runs", 3);
const poolSize = argVal("--pool", 2); // matches DEFAULT_CONCURRENCY in scripts/test-daemon.mjs
const limit = argVal("--limit", null); // debug/pilot only — restricts to the first N discovered names
// Lets a later invocation continue labelling runs (e.g. 4, 5) instead of restarting at 1 and colliding
// with an earlier invocation's rows in the same NDJSON file — needed because contamination (see the
// investigation's findings.md) can force extra runs beyond the original --runs count, appended later.
const startIndex = argVal("--start-index", 1);

let { names } = await discoverHermetic();
if (limit) names = names.slice(0, limit);
console.log(`Measuring ${names.length} hermetic tests × ${runs} run(s), pool=${poolSize}`);

for (let runIndex = startIndex; runIndex <= startIndex + runs - 1; runIndex++) {
  const hostBefore = hostSnapshot();
  const runStartTs = new Date().toISOString();
  console.log(`[run ${runIndex}] START ${runStartTs}`);
  const { results, durationMs } = await runCensusBatch({ names, poolSize, basePort: 4600 });
  const runEndTs = new Date().toISOString();
  const hostAfter = hostSnapshot();
  const { executedCount } = summarizeExecuted(results);
  const failed = results.filter((r) => !r.ok);

  appendNdjson(OUT, {
    kind: "run-summary",
    runIndex,
    runStartTs,
    runEndTs,
    durationMs,
    poolSize,
    testCount: names.length,
    executedCount,
    failedCount: failed.length,
    failedNames: failed.map((f) => f.name),
    hostBefore,
    hostAfter,
  });

  for (const r of results) {
    appendNdjson(OUT, {
      kind: "file",
      runIndex,
      name: r.name,
      // r.startTs/r.endTs are epoch-ms (runOneTimed in census/lib.mjs) — stamp both epoch (for cheap
      // arithmetic) and ISO (for cheap human/cross-reference reading) rather than forcing every reader to
      // reconvert.
      startTs: r.startTs ?? null,
      startTsIso: r.startTs != null ? new Date(r.startTs).toISOString() : null,
      endTs: r.endTs ?? null,
      endTsIso: r.endTs != null ? new Date(r.endTs).toISOString() : null,
      durationMs: r.durationMs ?? null,
      ok: r.ok,
      status: r.status ?? null,
      skipped: !!r.skipped,
      lane: r.lane ?? null,
    });
  }
  console.log(
    `[run ${runIndex}] END ${runEndTs} total=${durationMs}ms executed=${executedCount}/${names.length} ` +
      `failed=${failed.length}${failed.length ? " (" + failed.map((f) => f.name).join(", ") + ")" : ""} ` +
      `hostFreeMemMB=${hostBefore.freeMemMB}->${hostAfter.freeMemMB}`,
  );
}

console.log(`\nWrote per-file + per-run rows to ${OUT}`);
