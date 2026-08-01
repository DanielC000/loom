#!/usr/bin/env node
// Reads data/loom-build-gate-series.json (produced by extract-gate-events.mjs) and prints the
// per-day floor tables used in findings.md — full population, then re-stratified by concurrentGates
// to rule out a contention mix-shift as the explanation for a rising minimum. Also runs the 1643s
// attribution search. Pure read of the committed JSON; no DB access.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.resolve(__dirname, "../data/loom-build-gate-series.json");
const rows = JSON.parse(fs.readFileSync(dataPath, "utf8"));

const real = rows.filter((r) => !r.reused && typeof r.durationMs === "number");
const passed = real.filter((r) => r.passed === true).sort((a, b) => a.ts.localeCompare(b.ts));
const dateOf = (ts) => ts.slice(0, 10);

function printDayTable(subset, label) {
  console.log(`\n=== ${label}: n=${subset.length} ===`);
  const byDay = new Map();
  for (const r of subset) {
    const d = dateOf(r.ts);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r.durationMs / 1000);
  }
  console.log("date       | n  | min(s) | max(s) | mean(s)");
  for (const d of [...byDay.keys()].sort()) {
    const vals = byDay.get(d);
    const min = Math.min(...vals), max = Math.max(...vals), mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    console.log(`${d} | ${String(vals.length).padStart(2)} | ${min.toFixed(0).padStart(6)} | ${max.toFixed(0).padStart(6)} | ${mean.toFixed(0).padStart(6)}`);
  }
}

printDayTable(passed, "ALL passed runs, per UTC day");
printDayTable(passed.filter((r) => r.concurrentGates === 1), "SOLO-at-admission passed runs only (concurrentGates===1)");
printDayTable(passed.filter((r) => r.concurrentGates >= 2), "CONTENDED-at-admission passed runs only (concurrentGates>=2)");

console.log("\n=== 1643s search: closest match within the Loom-project series ===");
let best = null;
for (const r of real) {
  const diff = Math.abs(r.durationMs / 1000 - 1643);
  if (!best || diff < best.diff) best = { ...r, diff };
}
console.log(best);
