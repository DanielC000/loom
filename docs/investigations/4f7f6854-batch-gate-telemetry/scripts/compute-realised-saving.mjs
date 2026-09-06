#!/usr/bin/env node
// READ-ONLY. Card cf0e2e3b (successor to 4f7f6854) — now that K>=2 batches have accrued, compute
// DoD-2 (wall-clock per merged branch, before vs after), DoD-3 (does duration scale with K), and
// DoD-4 (forfeit rate) from live orchestration_events. Reuses the same readonly better-sqlite3
// resolution as extract-batch-gate-events.mjs in this same directory; run that script first if you
// want the raw per-row material this one derives from.
//
// batchForfeited / fallbackOfBatchOpId (the "official" forfeit-marking fields) exist in the daemon's
// source as of 2026-09-05 but, AS MEASURED HERE, carry ZERO live build_gate rows yet — this script
// therefore reconstructs forfeit/fallback chains itself, by taskId correlation across build_gate rows
// ordered by time. That reconstruction is a heuristic, not the authoritative field; re-run this once
// batchForfeited/fallbackOfBatchOpId actually appear on real rows and prefer those fields instead.
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
const REDUCED_FULL_THRESHOLD_MS = 300_000; // validated on Loom: reduced max 154567ms, full min 457780ms (all-time)

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
console.error(`[compute] opened ${dbPath} readonly, journal_mode=${db.pragma("journal_mode", { simple: true })}`);

const projects = db.prepare(`SELECT id, name FROM projects`).all();
const loomProject = projects.find((p) => p.name === "Loom");

const rawRows = db.prepare(`
  SELECT oe.ts, oe.seq, oe.task_id AS taskIdCol, oe.detail_json,
         s.project_id AS projectId
  FROM orchestration_events oe
  LEFT JOIN sessions s ON s.id = COALESCE(oe.worker_session_id, oe.manager_session_id)
  WHERE oe.kind = 'build_gate'
  ORDER BY oe.seq ASC
`).all();

const rows = rawRows
  .filter((r) => r.projectId === loomProject.id)
  .map((r) => {
    let d = {};
    try { d = JSON.parse(r.detail_json); } catch { /* ignore malformed row */ }
    return { ts: r.ts, taskIdCol: r.taskIdCol, ...d };
  });

// 0. Confirm the official forfeit fields' live presence (or absence) before relying on the heuristic below.
const officialForfeitFields = rows.filter((r) => "batchForfeited" in r || "fallbackOfBatchOpId" in r);
console.log(`\n=== 0. Official batchForfeited/fallbackOfBatchOpId field presence on real build_gate rows ===`);
console.log(`count=${officialForfeitFields.length} (0 means the fields exist in source but have not yet accrued live data — use the heuristic reconstruction below instead)`);

const batchRows = rows.filter((r) => r.batched === true);
const passedBatches = batchRows.filter((b) => b.passed);
const failedBatches = batchRows.filter((b) => !b.passed);

console.log(`\n=== 1. Accrual snapshot ===`);
console.log(`batched build_gate rows: ${batchRows.length} (${batchRows.filter((b) => Number.isFinite(b.durationMs)).length} carrying durationMs)`);
console.log(`  passed=${passedBatches.length} failed=${failedBatches.length}`);
const kCounts = {};
for (const b of batchRows) if (Number.isFinite(b.durationMs)) kCounts[b.branchCount] = (kCounts[b.branchCount] || 0) + 1;
console.log(`K distribution (rows with durationMs): ${JSON.stringify(kCounts)}`);

// 2. DoD-3: invariance — does duration scale with K? (all batch rows with durationMs, pass+fail)
console.log(`\n=== 2. DoD-3 invariance: batch gate durationMs by K (ALL rows, pass+fail) ===`);
const byKAll = {};
for (const b of batchRows) if (Number.isFinite(b.durationMs)) (byKAll[b.branchCount] ||= []).push(b.durationMs);
for (const K of Object.keys(byKAll).sort((a, b) => a - b)) {
  const arr = byKAll[K].slice().sort((a, b) => a - b);
  const median = arr.length % 2 ? arr[(arr.length - 1) / 2] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2;
  console.log(`  K=${K} n=${arr.length} median=${(median / 60000).toFixed(2)}min min=${(arr[0] / 60000).toFixed(2)}min max=${(arr[arr.length - 1] / 60000).toFixed(2)}min`);
}
console.log(`If these bands overlap heavily across K, duration does NOT scale materially with K — confirms the DoD-3 prediction (fixed test-suite cost dominates).`);

// 3. Solo (non-batched, non-reused) full-vs-reduced split, all-time and windowed to the accrual period.
const solo = rows.filter((r) => !r.batched && !r.reused && Number.isFinite(r.durationMs));
const batchWindowStart = Math.min(...batchRows.filter((b) => Number.isFinite(b.durationMs)).map((b) => Date.parse(b.ts)));
const batchWindowEnd = Math.max(...batchRows.filter((b) => Number.isFinite(b.durationMs)).map((b) => Date.parse(b.ts)));
const soloWindow = solo.filter((r) => { const t = Date.parse(r.ts); return t >= batchWindowStart && t <= batchWindowEnd; });

function fullStats(arr, label) {
  const full = arr.filter((r) => r.durationMs >= REDUCED_FULL_THRESHOLD_MS).map((r) => r.durationMs).sort((a, b) => a - b);
  const reduced = arr.filter((r) => r.durationMs < REDUCED_FULL_THRESHOLD_MS).map((r) => r.durationMs).sort((a, b) => a - b);
  const median = (a) => (a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null);
  console.log(`${label}: n=${arr.length} full=${full.length} reduced=${reduced.length} fullMedian=${full.length ? (median(full) / 60000).toFixed(2) + "min" : "n/a"} reducedMax=${reduced.length ? (reduced[reduced.length - 1] / 1000).toFixed(1) + "s" : "n/a"} fullMin=${full.length ? (full[0] / 1000).toFixed(1) + "s" : "n/a"}`);
  return median(full);
}
console.log(`\n=== 3. Solo build_gate population (non-batched, non-reused, Loom project) — the "before" side ===`);
const soloFullMedianAllTime = fullStats(solo, "all-time");
const soloFullMedianWindow = fullStats(soloWindow, `windowed [${new Date(batchWindowStart).toISOString()} -> ${new Date(batchWindowEnd).toISOString()}]`);
const counterfactualMedian = soloFullMedianWindow ?? soloFullMedianAllTime;
console.log(`Using WINDOWED solo full-gate median as the counterfactual "one solo full gate" cost: ${(counterfactualMedian / 60000).toFixed(2)}min. ASSUMPTION: every landed branch, had it merged solo instead, would have needed a FULL gate — this is the simple/conservative choice; it likely OVERSTATES the true counterfactual for any branch that would have qualified for a reduced solo gate on its own (about 29% of the windowed solo population did).`);

// 4. Reconstruct retry chains and solo fallbacks after a failed batch (heuristic — see file header).
console.log(`\n=== 4. DoD-4 forfeit/fallback reconstruction (heuristic — official fields carry 0 rows, see §0) ===`);
const soloOutcomes = rows.filter((r) => !r.batched && r.taskIdCol);
let totalFallbackMs = 0;
let totalFailedBatchMs = 0;
for (const fb of failedBatches) {
  if (Number.isFinite(fb.durationMs)) totalFailedBatchMs += fb.durationMs;
  console.log(`  FAILED batch ${fb.opId?.slice(0, 8)} ${fb.ts} K=${fb.branchCount} dur=${fb.durationMs ? (fb.durationMs / 60000).toFixed(2) + "min" : "n/a"}`);
  for (const br of fb.branches || []) {
    const t = br.taskId;
    const laterPass = passedBatches.find((b) => Date.parse(b.ts) > Date.parse(fb.ts) && (b.branches || []).some((x) => x.taskId === t));
    const soloHit = soloOutcomes.find((p) => p.taskIdCol === t && Date.parse(p.ts) >= Date.parse(fb.ts));
    if (laterPass) {
      console.log(`    task ${t.slice(0, 8)} -> retried into later PASSED batch ${laterPass.opId?.slice(0, 8)}`);
    } else if (soloHit) {
      totalFallbackMs += soloHit.durationMs;
      console.log(`    task ${t.slice(0, 8)} -> SOLO fallback dur=${(soloHit.durationMs / 1000).toFixed(1)}s reduced=${soloHit.durationMs < REDUCED_FULL_THRESHOLD_MS}`);
    } else {
      console.log(`    task ${t.slice(0, 8)} -> UNACCOUNTED (no later batch pass or solo build_gate row found)`);
    }
  }
}
console.log(`\nTotal wall-clock burned on batch attempts that were REJECTED: ${(totalFailedBatchMs / 60000).toFixed(1)}min across ${failedBatches.length} attempts.`);
console.log(`Total wall-clock spent on solo fallbacks specifically triggered by a rejected batch: ${(totalFallbackMs / 60000).toFixed(1)}min.`);
console.log(`0 batch_merge_forfeited events exist (checked separately in extract-batch-gate-events.mjs) — the ABOVE reconstruction is the only visibility into this cost today.`);

// 5. Clean (first-attempt, non-retry) per-K realised saving vs the windowed solo-full counterfactual.
const retryTargetOpIds = new Set();
for (const fb of failedBatches) {
  for (const br of fb.branches || []) {
    const t = br.taskId;
    const lp = passedBatches.find((b) => Date.parse(b.ts) > Date.parse(fb.ts) && (b.branches || []).some((x) => x.taskId === t));
    if (lp) retryTargetOpIds.add(lp.opId);
  }
}
const cleanPasses = passedBatches.filter((b) => !retryTargetOpIds.has(b.opId) && Number.isFinite(b.durationMs));
console.log(`\n=== 5. DoD-2, per-K realised saving — CLEAN first-attempt passes only (n=${cleanPasses.length} of ${passedBatches.length} total passes) ===`);
const byKClean = {};
for (const b of cleanPasses) (byKClean[b.branchCount] ||= []).push(b.durationMs);
for (const K of Object.keys(byKClean).sort((a, b) => a - b)) {
  const arr = byKClean[K].slice().sort((a, b) => a - b);
  const median = arr.length % 2 ? arr[(arr.length - 1) / 2] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2;
  const counterfactual = Number(K) * counterfactualMedian;
  const savingPct = (1 - median / counterfactual) * 100;
  console.log(`  K=${K} n=${arr.length} medianBatchDur=${(median / 60000).toFixed(2)}min counterfactual=${(counterfactual / 60000).toFixed(2)}min realisedSaving=${savingPct.toFixed(1)}%`);
}
console.log(`No clean (first-attempt) sample exists at every K — say so explicitly for any K missing above rather than interpolating.`);

// 6. Fully-loaded aggregate: every branch the batching MECHANISM landed (via a passed batch or a
// forfeit-triggered solo fallback), total real machine time spent (incl. every failed attempt),
// against the same counterfactual.
console.log(`\n=== 6. Fully-loaded aggregate realised saving (includes every failed attempt + every fallback) ===`);
const landedViaPassedBatch = new Set();
for (const b of passedBatches) for (const br of b.branches || []) landedViaPassedBatch.add(br.taskId);
let landedViaFallback = 0;
for (const fb of failedBatches) {
  for (const br of fb.branches || []) {
    const t = br.taskId;
    if (landedViaPassedBatch.has(t)) continue;
    const soloHit = soloOutcomes.find((p) => p.taskIdCol === t && Date.parse(p.ts) >= Date.parse(fb.ts));
    if (soloHit) landedViaFallback++;
  }
}
const totalLanded = landedViaPassedBatch.size + landedViaFallback;
const totalActualMs = batchRows.filter((b) => Number.isFinite(b.durationMs)).reduce((s, b) => s + b.durationMs, 0) + totalFallbackMs;
const totalCounterfactualMs = totalLanded * counterfactualMedian;
const aggregateSavingPct = (1 - totalActualMs / totalCounterfactualMs) * 100;
console.log(`Distinct branches landed via a passed batch: ${landedViaPassedBatch.size}; via a forfeit-triggered solo fallback: ${landedViaFallback}; total: ${totalLanded}`);
console.log(`Total ACTUAL wall-clock (all batch attempts, pass+fail, + fallback solo gates): ${(totalActualMs / 60000).toFixed(1)}min`);
console.log(`Counterfactual (${totalLanded} branches x windowed solo-full-median): ${(totalCounterfactualMs / 60000).toFixed(1)}min`);
console.log(`AGGREGATE realised wall-clock saving, fully loaded: ${aggregateSavingPct.toFixed(1)}%`);
console.log(`\nPopulation: Loom project only. Window: ${new Date(batchWindowStart).toISOString()} -> ${new Date(batchWindowEnd).toISOString()}. Instrument: this script against live loom.db, kind='build_gate', readonly.`);
console.log(`NOT measured here: manager-side content-audit minutes a batch forces (no such data exists in orchestration_events) — the card's own DoD-2 corollary asks this be reported as a separate number; it cannot be, from this table.`);
