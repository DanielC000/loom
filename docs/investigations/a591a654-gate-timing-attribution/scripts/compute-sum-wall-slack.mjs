#!/usr/bin/env node
// READ-ONLY analysis for card a591a654 ("SAME suite runs ~40-50% slower inside the merge gate").
// Computes, per run: WALL (run-summary durationMs), SUM (sum of all per-file durationMs),
// SUM/poolSize (the "ideal" wall time if scheduling were perfect), and slack = WALL - SUM/poolSize.
// Also computes, for the four in-gate runs, the per-file duration RATIO against the standalone
// baseline run (run 8, 627 files) to check whether the slowdown is broad-based or a few outliers.
//
// Usage: node compute-sum-wall-slack.mjs [--standalone <path>] [--ingate <path>]
// Defaults point at the two ndjson files committed alongside this script (data/).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../data");

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const standalonePath = argVal(
  "--standalone",
  path.resolve(__dirname, "../../6c1aadf7-daemon-suite-timing/data/per-file-timing.ndjson")
);
const ingatePath = argVal("--ingate", path.join(dataDir, "in-gate-per-file-timing.ndjson"));

function loadNdjson(p) {
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function summarize(rows, label) {
  const summaries = rows.filter((r) => r.kind === "run-summary");
  const filesByRun = new Map();
  for (const r of rows) {
    if (r.kind !== "file") continue;
    const key = r.runUid ?? r.runIndex;
    if (!filesByRun.has(key)) filesByRun.set(key, []);
    filesByRun.get(key).push(r);
  }
  const out = [];
  for (const s of summaries) {
    const key = s.runUid ?? s.runIndex;
    const files = filesByRun.get(key) ?? [];
    const wallS = s.durationMs / 1000;
    const sumS = files.reduce((a, f) => a + f.durationMs, 0) / 1000;
    const sumOverPool = sumS / s.poolSize;
    const slack = wallS - sumOverPool;
    out.push({
      source: label,
      runUid: s.runUid ?? null,
      runIndex: s.runIndex,
      poolSize: s.poolSize,
      nFiles: files.length,
      testCount: s.testCount,
      wallS: +wallS.toFixed(1),
      sumS: +sumS.toFixed(1),
      sumOverPoolS: +sumOverPool.toFixed(1),
      slackS: +slack.toFixed(1),
      files,
    });
  }
  return out;
}

const standaloneRuns = summarize(loadNdjson(standalonePath), "standalone");
const ingateRuns = summarize(loadNdjson(ingatePath), "in-gate");

console.log("=== SUM / WALL / slack, standalone runs (docs/investigations/6c1aadf7-daemon-suite-timing) ===");
console.log("runIndex | pool | nFiles | testCount | WALL(s) | SUM(s) | SUM/pool(s) | slack(s)");
for (const r of standaloneRuns) {
  console.log(`${r.runIndex} | ${r.poolSize} | ${r.nFiles} | ${r.testCount} | ${r.wallS} | ${r.sumS} | ${r.sumOverPoolS} | ${r.slackS}`);
}

console.log("\n=== SUM / WALL / slack, in-gate runs (card a591a654 banked data) ===");
console.log("runUid | pool | nFiles | testCount | WALL(s) | SUM(s) | SUM/pool(s) | slack(s) | SUM vs standalone-run8");
const baseline = standaloneRuns.find((r) => r.runIndex === 8);
for (const r of ingateRuns) {
  const pct = (((r.sumS - baseline.sumS) / baseline.sumS) * 100).toFixed(1);
  console.log(`${r.runUid} | ${r.poolSize} | ${r.nFiles} | ${r.testCount} | ${r.wallS} | ${r.sumS} | ${r.sumOverPoolS} | ${r.slackS} | +${pct}%`);
}

console.log("\n=== Per-file duration ratio vs standalone baseline (run 8, 627 files), by in-gate run ===");
const baseFileMs = new Map(baseline.files.map((f) => [f.name, f.durationMs]));
for (const r of ingateRuns) {
  const ratios = [];
  for (const f of r.files) {
    const b = baseFileMs.get(f.name);
    if (b && b > 0) ratios.push(f.durationMs / b);
  }
  ratios.sort((a, b) => a - b);
  const n = ratios.length;
  const median = ratios[Math.floor(n / 2)];
  const mean = ratios.reduce((a, b) => a + b, 0) / n;
  const p10 = ratios[Math.floor(n * 0.1)];
  const p90 = ratios[Math.floor(n * 0.9)];
  const fracSlower = ratios.filter((x) => x > 1.05).length / n;
  const fracFaster = ratios.filter((x) => x < 0.95).length / n;
  console.log(
    `${r.runUid}: matched=${n} median=${median.toFixed(2)}x mean=${mean.toFixed(2)}x p10=${p10.toFixed(2)}x p90=${p90.toFixed(2)}x frac(>1.05x)=${fracSlower.toFixed(2)} frac(<0.95x)=${fracFaster.toFixed(2)}`
  );
}
