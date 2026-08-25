// Card 42d9d64c, DoD-3 re-instrumented per manager direction: the chunk-arrival proxy is retired (see
// README) — instead, this extracts the harness's OWN per-sub-fixture "SessionStart→FIXTURE_RECEIVED"
// measurement from every retained run-NN-*.txt. That line is inside a `finally` block in
// kickoff-real-spawn.mjs (verifyRealDelivery), so it prints on BOTH a normal completion and a throw —
// fit for both arms, unlike stallAssertionMs (failing-arm-only) or the retired chunk proxy (neither arm,
// as it turns out — see README's "three instrument verdicts").
//
// Output: docs/investigations/42d9d64c-kickoff-real-spawn-stall/measured-timings.ndjson, one row per
// sub-fixture per run: {run, outcome, fixture, sessionStartToReceivedMs, stallBudgetMs, order}
// `order` is this sub-fixture's position within its OWN run (1-based, in the order it printed) — lets you
// ask "were the fixtures BEFORE the failure point also slow" without re-deriving allSessionIds ordering.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "..");
const RUNS_DIR = path.join(DIR, "runs");
const NDJSON_PATH = path.join(DIR, "runs.ndjson");
const OUT_PATH = path.join(DIR, "measured-timings.ndjson");

const runs = fs.readFileSync(NDJSON_PATH, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const rows = [];
for (const run of runs) {
  const logPath = path.join(RUNS_DIR, `run-${String(run.run).padStart(2, "0")}-${run.outcome}.txt`);
  if (!fs.existsSync(logPath)) { console.log(`run ${run.run}: log not found, skipping`); continue; }
  const text = fs.readFileSync(logPath, "utf8");
  const re = /\[measured (\[[^\]]+\])\] SessionStart.FIXTURE_RECEIVED: (\d+)ms \(stall budget (\d+)ms/g;
  let m;
  let order = 0;
  while ((m = re.exec(text)) !== null) {
    order++;
    rows.push({
      run: run.run,
      outcome: run.outcome,
      fixture: m[1],
      sessionStartToReceivedMs: Number(m[2]),
      stallBudgetMs: Number(m[3]),
      order,
    });
  }
}

fs.writeFileSync(OUT_PATH, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
console.log(`Extracted ${rows.length} sub-fixture measurements from ${runs.length} runs -> ${OUT_PATH}`);

// Quick summary: per-outcome distribution.
const pass = rows.filter((r) => r.outcome === "pass").map((r) => r.sessionStartToReceivedMs);
const fail = rows.filter((r) => r.outcome === "fail").map((r) => r.sessionStartToReceivedMs);
const stats = (arr) => arr.length ? { n: arr.length, min: Math.min(...arr), max: Math.max(...arr), mean: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) } : { n: 0 };
console.log("pass sub-fixtures:", JSON.stringify(stats(pass)));
console.log("fail-run sub-fixtures (includes the failing one's own last measured value where present):", JSON.stringify(stats(fail)));
