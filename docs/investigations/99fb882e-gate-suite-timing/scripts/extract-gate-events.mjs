#!/usr/bin/env node
// READ-ONLY extraction of gate-run history from loom.db, for card 99fb882e's suite-timing analysis.
// Opens the DB with { readonly: true, fileMustExist: true } and NEVER writes. Safe to run against the
// live production DB (better-sqlite3 readonly connections coexist with a live WAL-mode writer).
//
// Usage:
//   node extract-gate-events.mjs [--db <path-to-loom.db>] [--project <projectId>] [--out <path.json>]
//
// Defaults: --db ~/.loom/loom.db, --project none (all projects), --out prints a summary to stdout only.
//
// Resolves better-sqlite3 via packages/daemon's own node_modules regardless of where this script is
// invoked from or copied to (ESM bare-specifier resolution walks up from the script's own location, not
// cwd — see this repo's CLAUDE.md "Isolated-daemon testing on Windows" footgun list).
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonPkg = path.resolve(__dirname, "../../../../packages/daemon/package.json");
const require = createRequire(pathToFileURL(daemonPkg).href);
const Database = require("better-sqlite3");

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const dbPath = argVal("--db", path.join(os.homedir(), ".loom", "loom.db"));
const projectFilter = argVal("--project", null);
const outPath = argVal("--out", null);

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
console.error(`[extract-gate-events] opened ${dbPath} readonly, journal_mode=${db.pragma("journal_mode", { simple: true })}`);

const rows = db.prepare(`
  SELECT oe.id, oe.ts, oe.seq, oe.kind, oe.task_id, oe.worker_session_id, oe.manager_session_id, oe.detail_json,
         s.project_id AS projectId
  FROM orchestration_events oe
  LEFT JOIN sessions s ON s.id = COALESCE(oe.worker_session_id, oe.manager_session_id)
  WHERE oe.kind IN ('build_gate','build_gate_retry')
  ORDER BY oe.seq ASC
`).all();

const filtered = projectFilter ? rows.filter((r) => r.projectId === projectFilter) : rows;

function parsed(r) {
  let d = {};
  try { d = JSON.parse(r.detail_json); } catch { /* malformed row, keep raw fields only */ }
  return { ts: r.ts, seq: r.seq, kind: r.kind, taskId: r.task_id, projectId: r.projectId, ...d };
}
const series = filtered.map(parsed);

console.error(`[extract-gate-events] ${rows.length} build_gate(+retry) rows total, ${filtered.length} after project filter`);
console.error(`[extract-gate-events] passed=${series.filter((r) => r.passed === true).length} failed=${series.filter((r) => r.passed === false).length}`);
console.error(`[extract-gate-events] rows missing durationMs=${series.filter((r) => typeof r.durationMs !== "number").length}`);

if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(series, null, 2));
  console.error(`[extract-gate-events] wrote ${series.length} rows to ${outPath}`);
} else {
  console.log(JSON.stringify(series, null, 2));
}

db.close();
