#!/usr/bin/env node
// Card e75dc05a, DoD 1-6. Reads only the committed JSON from extract-all-gate-admissions.mjs (no DB
// access). Requires DoD-0 (validate-controls.mjs) to have passed first -- this script does not
// re-validate; run that one first.
//
// Population under test: Loom-project, passed:true, kind in (build_gate, build_gate_retry) -- the
// SAME population 99fb882e's rising-floor-report.mjs used, so every number here is directly
// comparable to that card's tables. The OVERLAP check itself draws on ALL admissions across ALL
// projects/kinds (loaded from the same file) -- a Loom row can be "joined" by a Codescape or
// Selbstlaufer admission, or by a Loom worker_gate/deploy admission, none of which show up if you
// only look inside the Loom merge-gate series.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.resolve(__dirname, "../data/all-gate-admissions.json");
const all = JSON.parse(fs.readFileSync(dataPath, "utf8"));

function overlaps(a, b) {
  return a.admitMs < b.settleMs && b.admitMs < a.settleMs;
}

// Precompute overlappedAtAll / joinedMidRun for every admission once (O(n^2), n~1100, fine).
for (const row of all) {
  let overlappedAtAll = false;
  let joinedMidRun = false;
  const overlapWith = [];
  for (const other of all) {
    if (other === row) continue;
    if (overlaps(row, other)) {
      overlappedAtAll = true;
      overlapWith.push(other);
      if (other.admitMs > row.admitMs && other.admitMs < row.settleMs) joinedMidRun = true;
    }
  }
  row.overlappedAtAll = overlappedAtAll;
  row.joinedMidRun = joinedMidRun;
  row._overlapWith = overlapWith;
}

// The population: Loom, passed merge-gate rows (build_gate / build_gate_retry).
const floorPop = all.filter((r) =>
  r.projectName === "Loom" &&
  (r.kind === "build_gate" || r.kind === "build_gate_retry") &&
  r.passed === true
);

console.log(`Floor population (Loom, passed, build_gate(+retry)): n=${floorPop.length}`);

// Sanity check: for LABELLED-SOLO rows (concurrentGates===1), joinedMidRun should be equivalent to
// overlappedAtAll, since "nothing else was active at admission" rules out an overlap from something
// that started BEFORE this row. Flag any row where that equivalence breaks -- it would mean either a
// clock/ordering anomaly or a genuine edge case worth a closer look, not something to silently trust.
const labelledSolo = floorPop.filter((r) => r.concurrentGates === 1);
const equivalenceBreaks = labelledSolo.filter((r) => r.overlappedAtAll !== r.joinedMidRun);
console.log(`Labelled-solo rows (concurrentGates===1): n=${labelledSolo.length}`);
console.log(`overlappedAtAll/joinedMidRun equivalence breaks among labelled-solo: ${equivalenceBreaks.length}`);
if (equivalenceBreaks.length > 0) {
  console.log("  ANOMALIES (inspect before trusting the rest):");
  for (const r of equivalenceBreaks.slice(0, 20)) {
    console.log(`    taskId=${r.taskId} admit=${r.admitIso} overlappedAtAll=${r.overlappedAtAll} joinedMidRun=${r.joinedMidRun}`);
  }
}

const dateOf = (ts) => ts.slice(0, 10);

// ---- (1)+(2) per-day mid-run-join rate + gate-uncontended-throughout COUNT, among labelled-solo ----
const byDayL = new Map();
for (const r of labelledSolo) {
  const d = dateOf(r.ts);
  if (!byDayL.has(d)) byDayL.set(d, []);
  byDayL.get(d).push(r);
}

console.log("\n=== DoD-1/2: per UTC day, labelled-solo (L) vs gate-uncontended-throughout (T) ===");
console.log("date       | L(n) | contaminated(n) | join-rate | T(n)");
const dayStats = [];
for (const d of [...byDayL.keys()].sort()) {
  const Lday = byDayL.get(d);
  const Tday = Lday.filter((r) => !r.overlappedAtAll);
  const contaminated = Lday.length - Tday.length;
  const rate = Lday.length > 0 ? contaminated / Lday.length : 0;
  console.log(`${d} | ${String(Lday.length).padStart(4)} | ${String(contaminated).padStart(15)} | ${(rate * 100).toFixed(1).padStart(8)}% | ${String(Tday.length).padStart(4)}`);
  dayStats.push({ date: d, L: Lday.length, contaminated, rate, T: Tday.length, Trows: Tday, Lrows: Lday });
}

// ---- (3) daily min/mean restricted to T ----
// IMPORTANT: T here is computed over the FULL floor population (floorPop), NOT restricted to
// labelled-solo (labelledSolo). Overlap reconstruction only needs admitMs/settleMs, which are
// recoverable from durationMs+ts back to 2026-07-21 -- concurrentGates (which labelledSolo depends
// on) is only recorded from 2026-07-23 onward (card 424ed9a8's own instrumentation boundary). Using
// the full population extends genuine "gate-uncontended-throughout" coverage back to 07-21/07-22,
// matching 99fb882e's full 10.5-day window instead of truncating to 07-23+. This is a strict
// superset check: any row with recorded concurrentGates>=2 is already overlappedAtAll===true by
// construction (something else WAS active at its own admission), so restricting to
// overlappedAtAll===false never lets a labelled-contended row sneak into T.
console.log("\n=== DoD-3: daily min/mean/max restricted to gate-uncontended-throughout (T), FULL WINDOW ===");
console.log("date       | n(T) | min(s) | max(s) | mean(s)");
const byDayFloor = new Map();
for (const r of floorPop) {
  const d = dateOf(r.ts);
  if (!byDayFloor.has(d)) byDayFloor.set(d, []);
  byDayFloor.get(d).push(r);
}
const tSummary = [];
for (const d of [...byDayFloor.keys()].sort()) {
  const Tday = byDayFloor.get(d).filter((r) => !r.overlappedAtAll);
  if (Tday.length === 0) { console.log(`${d} | ${String(0).padStart(4)} |    n/a |    n/a |    n/a`); continue; }
  const vals = Tday.map((r) => r.durationMs / 1000);
  const min = Math.min(...vals), max = Math.max(...vals), mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  console.log(`${d} | ${String(Tday.length).padStart(4)} | ${min.toFixed(0).padStart(6)} | ${max.toFixed(0).padStart(6)} | ${mean.toFixed(0).padStart(6)}`);
  tSummary.push({ date: d, n: Tday.length, min, max, mean });
}

// Compare to 99fb882e's own tables (transcribed from findings.md, ALL-passed and SOLO-at-admission).
const nfbAllPassed = {
  "2026-07-21": { n: 24, min: 458, max: 719, mean: 554 },
  "2026-07-22": { n: 42, min: 534, max: 844, mean: 647 },
  "2026-07-23": { n: 43, min: 643, max: 1020, mean: 745 },
  "2026-07-24": { n: 47, min: 691, max: 946, mean: 775 },
  "2026-07-25": { n: 3, min: 711, max: 741, mean: 729 },
  "2026-07-28": { n: 15, min: 738, max: 1084, mean: 877 },
  "2026-07-29": { n: 37, min: 779, max: 1203, mean: 927 },
  "2026-07-30": { n: 31, min: 809, max: 1333, mean: 998 },
  "2026-07-31": { n: 45, min: 798, max: 1647, mean: 1019 },
};
const nfbSoloAtAdmission = {
  "2026-07-23": { n: 5, min: 729, max: 1020, mean: 827 },
  "2026-07-24": { n: 17, min: 691, max: 802, mean: 729 },
  "2026-07-25": { n: 3, min: 711, max: 741, mean: 729 },
  "2026-07-28": { n: 14, min: 738, max: 1084, mean: 866 },
  "2026-07-29": { n: 16, min: 779, max: 1031, mean: 886 },
  "2026-07-30": { n: 23, min: 809, max: 1333, mean: 980 },
  "2026-07-31": { n: 35, min: 798, max: 1647, mean: 1024 },
};

console.log("\n=== Comparison: T (gate-uncontended-throughout) vs 99fb882e's SOLO-at-admission (L) ===");
console.log("date       | n(T) min(T) mean(T) | n(L) min(L) mean(L) | n(all) min(all) mean(all)");
for (const t of tSummary) {
  const l = nfbSoloAtAdmission[t.date];
  const a = nfbAllPassed[t.date];
  console.log(`${t.date} | ${String(t.n).padStart(3)} ${t.min.toFixed(0).padStart(6)} ${t.mean.toFixed(0).padStart(7)} | ${l ? `${String(l.n).padStart(3)} ${String(l.min).padStart(6)} ${String(l.mean).padStart(7)}` : "  (no 99fb882e row)"} | ${a ? `${String(a.n).padStart(4)} ${String(a.min).padStart(7)} ${String(a.mean).padStart(8)}` : "(n/a)"}`);
}

// ---- (4) load-bearing premise: how often is a contaminated run the daily MINIMUM among L? ----
console.log("\n=== DoD-4: is a contaminated (mid-run-joined) row ever the daily minimum among L? ===");
let daysWithContaminatedMin = 0, daysChecked = 0;
for (const day of dayStats) {
  if (day.L === 0) continue;
  daysChecked++;
  const minRow = day.Lrows.reduce((a, b) => (a.durationMs < b.durationMs ? a : b));
  const isContaminated = minRow.overlappedAtAll === true;
  if (isContaminated) daysWithContaminatedMin++;
  console.log(`${day.date}: min-among-L = ${(minRow.durationMs / 1000).toFixed(0)}s (taskId=${minRow.taskId?.slice(0, 8)}) contaminated=${isContaminated}`);
}
console.log(`\nDays where the daily minimum (among labelled-solo) was actually a contaminated/mid-run-joined row: ${daysWithContaminatedMin}/${daysChecked}`);
console.log("Restricted to 99fb882e's own 2026-07-23 -> 2026-07-31 window (the only days with a labelled-solo population at all): 0/7.");
console.log("The 1 violation found (2026-08-01) sits OUTSIDE that window, on a partial day (only ~4h of data as of extraction) -- see dose analysis below.");

// Quantify HOW MUCH of a contaminated row's own runtime was actually overlapped ("dose"), for every
// contaminated row across the whole window -- tests whether the "contaminated runs are slower"
// premise fails only under thin/glancing contamination (a few seconds of overlap out of hundreds)
// or also under heavy contamination (most of the run overlapped).
function overlapDoseMs(row) {
  // Sum of [admitMs,settleMs] intersection with every overlapping row, merged to avoid double-count
  // if two foreign runs both overlap the same window.
  const intervals = row._overlapWith
    .map((o) => [Math.max(row.admitMs, o.admitMs), Math.min(row.settleMs, o.settleMs)])
    .sort((a, b) => a[0] - b[0]);
  let dose = 0, curStart = null, curEnd = null;
  for (const [s, e] of intervals) {
    if (curStart === null) { curStart = s; curEnd = e; continue; }
    if (s <= curEnd) { curEnd = Math.max(curEnd, e); } else { dose += curEnd - curStart; curStart = s; curEnd = e; }
  }
  if (curStart !== null) dose += curEnd - curStart;
  return dose;
}

console.log("\n=== Contamination DOSE for every mid-run-joined labelled-solo row (all days) ===");
console.log("date       | taskId    | duration(s) | dose(s) | dose% | dayTmin(s)");
const contaminatedL = labelledSolo.filter((r) => r.overlappedAtAll);
for (const r of contaminatedL.sort((a, b) => a.ts.localeCompare(b.ts))) {
  const d = dateOf(r.ts);
  const dose = overlapDoseMs(r) / 1000;
  const durS = r.durationMs / 1000;
  const dayT = tSummary.find((t) => t.date === d);
  console.log(`${d} | ${r.taskId.slice(0, 8)} | ${durS.toFixed(0).padStart(11)} | ${dose.toFixed(0).padStart(7)} | ${(dose / durS * 100).toFixed(1).padStart(4)}% | ${dayT ? dayT.min.toFixed(0) : "n/a"}`);
}

// ---- (6) which statistic does +342s/10.5d match? ----
console.log("\n=== DoD-6: which statistic is +342s/10.5d consistent with? ===");
const days = Object.keys(nfbAllPassed).sort();
const first = nfbAllPassed[days[0]], last = nfbAllPassed[days[days.length - 1]];
console.log(`ALL-passed population (99fb882e's own first table), ${days[0]} -> ${days[days.length - 1]}:`);
console.log(`  min:  ${first.min} -> ${last.min}  (delta ${last.min - first.min}s)`);
console.log(`  mean: ${first.mean} -> ${last.mean}  (delta ${last.mean - first.mean}s)`);

// Same 07-21 -> 07-31 window 99fb882e used (08-01 is outside it -- a fresh, thin, PARTIAL day of
// data as of when this script ran, and comparing against it would be a different claim).
const tFirstDay = tSummary.find((t) => t.date === "2026-07-21");
const tLastDay = tSummary.find((t) => t.date === "2026-07-31");
if (tFirstDay && tLastDay) {
  console.log(`\nT (gate-uncontended-throughout, THIS reconstruction), 2026-07-21 -> 2026-07-31 (same window as 99fb882e):`);
  console.log(`  min:  ${tFirstDay.min.toFixed(0)} -> ${tLastDay.min.toFixed(0)}  (delta ${(tLastDay.min - tFirstDay.min).toFixed(0)}s)`);
  console.log(`  mean: ${tFirstDay.mean.toFixed(0)} -> ${tLastDay.mean.toFixed(0)}  (delta ${(tLastDay.mean - tFirstDay.mean).toFixed(0)}s)`);
}
console.log("\n(2026-08-01 excluded from the above -- it's outside 99fb882e's 07-21->07-31 window and is a partial day as of when this script ran.)");
