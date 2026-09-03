#!/usr/bin/env node
// READ-ONLY. Card 4f7f6854 — batch-gate telemetry: does the realised saving match the modelled ~26-28%?
// Extracts every build_gate / build_gate_retry / batch_merge_forfeited orchestration_events row for the
// Loom project, classifies batched vs solo vs reused, and reports the raw material DoD-2/3/4 need.
// Mirrors the readonly pattern from
// docs/investigations/a591a654-gate-timing-attribution/scripts/extract-gate-events.mjs
// (readonly:true, fileMustExist:true — safe against the live WAL-mode DB, never writes).
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

const projects = db.prepare(`SELECT id, name FROM projects`).all();
const loomProject = projects.find((p) => p.name === "Loom");
console.error(`[extract] resolved Loom project: ${JSON.stringify(loomProject)}`);

const rows = db.prepare(`
  SELECT oe.id, oe.ts, oe.seq, oe.kind, oe.task_id, oe.worker_session_id, oe.manager_session_id, oe.detail_json,
         s.project_id AS projectId
  FROM orchestration_events oe
  LEFT JOIN sessions s ON s.id = COALESCE(oe.worker_session_id, oe.manager_session_id)
  WHERE oe.kind IN ('build_gate','build_gate_retry','batch_merge_forfeited','build_gate_single_file_retry')
  ORDER BY oe.seq ASC
`).all();

function parsed(r) {
  let d = {};
  try { d = JSON.parse(r.detail_json); } catch { /* ignore malformed row */ }
  return { id: r.id, ts: r.ts, seq: r.seq, kind: r.kind, taskId: r.task_id, projectId: r.projectId, ...d };
}
const series = rows.map(parsed);
console.error(`[extract] ${rows.length} rows total across ALL projects`);

const loomSeries = loomProject ? series.filter((r) => r.projectId === loomProject.id) : series;
console.error(`[extract] ${loomSeries.length} rows scoped to Loom project`);

// DoD-1 material: every batch_gate row this daemon has EVER emitted, any project (batches are rare
// enough that all-project context matters more than per-project noise here).
const batchedAllProjects = series.filter((r) => r.kind === "build_gate" && r.batched === true);
const forfeitsAllProjects = series.filter((r) => r.kind === "batch_merge_forfeited");
console.log("\n=== ALL-PROJECT batch build_gate rows (kind=build_gate, batched:true) — this is DoD-1's/DoD-3's raw material ===");
for (const r of batchedAllProjects) console.log(JSON.stringify(r));
console.log(`count=${batchedAllProjects.length}`);
console.log("\n=== ALL-PROJECT batch_merge_forfeited rows — DoD-4's raw material ===");
for (const r of forfeitsAllProjects) console.log(JSON.stringify(r));
console.log(`count=${forfeitsAllProjects.length}`);

// Loom-scoped solo build_gate population (DoD-2's "before" side + the reuse positive control).
const solo = loomSeries.filter((r) => r.kind === "build_gate" && !r.batched);
const reusedRows = solo.filter((r) => r.reused === true);
console.log(`\n=== Loom-project solo build_gate rows: total=${solo.length}, reused:true=${reusedRows.length} ===`);
for (const r of reusedRows) console.log(JSON.stringify({ ts: r.ts, taskId: r.taskId, reusedOpId: r.reusedOpId, gateSpawned: r.gateSpawned, durationMs: r.durationMs }));

console.log(`\nreuse rate (Loom project, full history, solo build_gate rows only) = ${reusedRows.length}/${solo.length} = ${((reusedRows.length / solo.length) * 100).toFixed(2)}%`);
