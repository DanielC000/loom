#!/usr/bin/env node
// READ-ONLY extraction of build_gate events from loom.db for card a591a654's in-gate attribution pass.
// Reuses the exact readonly pattern from docs/investigations/99fb882e-gate-suite-timing/scripts/extract-gate-events.mjs
// (readonly:true, fileMustExist:true — safe against the live WAL-mode DB, never writes).
//
// For each of the four banked in-gate runs (card a591a654's own table), finds every OTHER project's
// build_gate/build_gate_retry event whose own [ts-durationMs, ts] window overlaps the run's window
// (a build_gate event's `ts` is logged at gate-FINISH time, so its start is ts - durationMs), and
// reports the overlap coverage fraction — the discriminator for "was another merge gate genuinely
// running concurrently, and for how much of this run's wall clock."
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

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
console.error(`[extract] opened ${dbPath} readonly, journal_mode=${db.pragma("journal_mode", { simple: true })}`);

const rows = db.prepare(`
  SELECT oe.id, oe.ts, oe.seq, oe.kind, oe.task_id, oe.worker_session_id, oe.manager_session_id, oe.detail_json,
         s.project_id AS projectId
  FROM orchestration_events oe
  LEFT JOIN sessions s ON s.id = COALESCE(oe.worker_session_id, oe.manager_session_id)
  WHERE oe.kind IN ('build_gate','build_gate_retry')
  ORDER BY oe.seq ASC
`).all();

function parsed(r) {
  let d = {};
  try { d = JSON.parse(r.detail_json); } catch { /* ignore malformed row */ }
  return { ts: r.ts, seq: r.seq, kind: r.kind, taskId: r.task_id, projectId: r.projectId, ...d };
}
const series = rows.map(parsed);
console.error(`[extract] ${rows.length} build_gate(+retry) rows total across all projects`);

// The four banked in-gate runs from card a591a654's own table (runUid -> [startMs, endMs]).
const RUNS = {
  "17069e7e": [1785610717955, 1785610717955 + 1262287],
  "63bdd2cc(REJECTED)": [1785612035741, 1785612035741 + 1339643],
  "753d9911": [1785613469275, 1785613469275 + 1088718],
  "867e64f1(contended)": [1785614606189, 1785614606189 + 1580534],
};

function toMs(ts) {
  return typeof ts === "number" ? ts : Date.parse(ts);
}

console.log("\n=== This project's own build_gate row for each of the 4 tasks (sanity-check + concurrentGates-at-admission) ===");
for (const r of series) {
  if (r.taskId && Object.keys(RUNS).some((k) => r.taskId.startsWith(k.split("(")[0]))) {
    console.log(JSON.stringify(r));
  }
}

console.log("\n=== Foreign (any-project) build_gate rows overlapping each run's window, + coverage fraction ===");
for (const [label, [s, e]] of Object.entries(RUNS)) {
  const windowMs = e - s;
  const overlapping = series.filter((r) => {
    const rEnd = toMs(r.ts); // ts = gate-finish time
    if (!Number.isFinite(rEnd) || typeof r.durationMs !== "number") return false;
    const rStart = rEnd - r.durationMs;
    return rStart < e && rEnd > s;
  });
  let coveredMs = 0;
  const foreignRows = [];
  for (const r of overlapping) {
    const rEnd = toMs(r.ts);
    const rStart = rEnd - r.durationMs;
    const overlapStart = Math.max(s, rStart);
    const overlapEnd = Math.min(e, rEnd);
    const isSelf = r.taskId && label.startsWith(r.taskId.slice(0, 8));
    if (!isSelf) {
      coveredMs += Math.max(0, overlapEnd - overlapStart);
      foreignRows.push({ taskId: r.taskId, projectId: r.projectId, window: [new Date(rStart).toISOString(), r.ts], durationMs: r.durationMs, passed: r.passed });
    }
  }
  console.log(`\n-- ${label}  window=${(windowMs / 1000).toFixed(1)}s  foreignGateCoverage=${((coveredMs / windowMs) * 100).toFixed(1)}% --`);
  for (const f of foreignRows) console.log(`   FOREIGN taskId=${f.taskId} projectId=${f.projectId} window=[${f.window[0]} .. ${f.window[1]}] durationMs=${f.durationMs} passed=${f.passed}`);
  if (foreignRows.length === 0) console.log("   (no foreign build_gate overlap found)");
}
