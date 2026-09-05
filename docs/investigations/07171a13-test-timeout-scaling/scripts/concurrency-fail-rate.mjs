#!/usr/bin/env node
// READ-ONLY analysis for card 07171a13 ("decide whether the per-file test timeout should scale with
// observed gate concurrency"). Opens loom.db { readonly: true, fileMustExist: true } — never writes.
// Same pattern as docs/investigations/99fb882e-gate-suite-timing/scripts/extract-gate-events.mjs.
//
// Question: across the WHOLE Loom-project build_gate(+retry) history, does the FAIL RATE of a
// full-scale (non-reduced) gate rise with concurrentGates (admission-instant) / concurrentGatesMax
// (whole-run max)? The card's own table is n=3 (df051231/cd7bd162/d9a2256c); this reruns the same
// question against every recorded row instead.
//
// Usage: node concurrency-fail-rate.mjs [--db <path-to-loom.db>] [--project <projectId>]
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonPkg = path.resolve(__dirname, "../../../../packages/daemon/package.json");
const require = createRequire(pathToFileURL(daemonPkg).href);
const Database = require("better-sqlite3");

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const dbPath = argVal("--db", path.join(os.homedir(), ".loom", "loom.db"));
const projectFilter = argVal("--project", "c36e8691-44d8-44ae-91ed-1bae3c632b33");

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
console.error(`[concurrency-fail-rate] opened ${dbPath} readonly, journal_mode=${db.pragma("journal_mode", { simple: true })}`);

const rows = db.prepare(`
  SELECT oe.ts, oe.detail_json, s.project_id AS projectId
  FROM orchestration_events oe
  LEFT JOIN sessions s ON s.id = COALESCE(oe.worker_session_id, oe.manager_session_id)
  WHERE oe.kind IN ('build_gate','build_gate_retry')
`).all();

function parsed(r) {
  let d = {};
  try { d = JSON.parse(r.detail_json); } catch { /* malformed row, keep raw fields only */ }
  return { ts: r.ts, ...d };
}

const filtered = (projectFilter ? rows.filter((r) => r.projectId === projectFilter) : rows).map(parsed);
console.error(`[concurrency-fail-rate] ${rows.length} build_gate(+retry) rows total; ${filtered.length} after project filter`);

// Exclude reused (gateSpawned:false) rows — durationMs:0, no real test execution happened.
const withDuration = filtered.filter((r) => typeof r.durationMs === "number" && r.durationMs > 0 && !r.reused);
console.error(`[concurrency-fail-rate] ${withDuration.length} rows carry a real durationMs (reused rows excluded)`);

// FULL-SCALE proxy: durationMs > 500_000 (500s). Validated below (should exclude ~all emitCompareReduced
// rows, since those measured 27-130s standalone in this same dataset — see docs/investigations/
// 07171a13-test-timeout-scaling/findings.md for the validation run).
const FULL_SCALE_MS = 500_000;
const fullScale = withDuration.filter((r) => r.durationMs > FULL_SCALE_MS);
const reducedInFullScale = fullScale.filter((r) => r.emitCompareReduced === true).length;
console.error(`[concurrency-fail-rate] full-scale (>${FULL_SCALE_MS}ms) rows: ${fullScale.length} of ${withDuration.length}`);
console.error(`[concurrency-fail-rate] of those, emitCompareReduced===true: ${reducedInFullScale} (proxy validation — should be 0)`);

function rateTable(pop, label, keyName) {
  const buckets = {};
  for (const d of pop) {
    const k = d[keyName];
    if (typeof k !== "number") continue;
    buckets[k] = buckets[k] || { pass: 0, fail: 0 };
    if (d.passed === true) buckets[k].pass++; else buckets[k].fail++;
  }
  console.log(`\n=== ${label}: fail rate by ${keyName} ===`);
  for (const k of Object.keys(buckets).sort()) {
    const { pass, fail } = buckets[k];
    const total = pass + fail;
    console.log(`  ${keyName}=${k}: n=${total}  fail=${fail}  failRate=${(100 * fail / total).toFixed(1)}%`);
  }
}
rateTable(fullScale, "FULL-SCALE ONLY", "concurrentGates");
rateTable(fullScale, "FULL-SCALE ONLY", "concurrentGatesMax");

const cgWithTs = fullScale.filter((d) => typeof d.concurrentGates === "number").map((d) => d.ts).sort();
const cgMaxWithTs = fullScale.filter((d) => typeof d.concurrentGatesMax === "number").map((d) => d.ts).sort();
console.log(`\n[concurrency-fail-rate] concurrentGates population date range: ${cgWithTs[0]} .. ${cgWithTs[cgWithTs.length - 1]}`);
console.log(`[concurrency-fail-rate] concurrentGatesMax population date range: ${cgMaxWithTs[0]} .. ${cgMaxWithTs[cgMaxWithTs.length - 1]}`);

// The card's own 3 specimens, printed in full for direct comparison against this larger corpus.
console.log(`\n=== the card's own 3 specimens (df051231 / cd7bd162 / d9a2256c), full detail ===`);
for (const r of filtered) {
  if (["df051231", "cd7bd162", "d9a2256c"].some((prefix) => (r.opId || "").startsWith(prefix))) {
    console.log(JSON.stringify(r));
  }
}

db.close();
