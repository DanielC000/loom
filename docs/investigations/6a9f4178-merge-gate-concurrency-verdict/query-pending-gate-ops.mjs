// Card 6a9f4178 investigation — READ-ONLY query against the live daemon DB (`<LOOM_HOME>/loom.db`),
// opened with better-sqlite3's `readonly:true` (never writes, never held open past this one run).
// Not a hermetic test — a scratch investigation tool, kept here as part of the committed corpus so a
// future reader can re-run the SAME queries against a later DB snapshot rather than re-deriving them.
//
// Run from anywhere: `node docs/investigations/6a9f4178-merge-gate-concurrency-verdict/query-pending-gate-ops.mjs`
// ESM bare-specifier resolution walks up from THIS FILE's own location, not cwd — since this script
// lives outside packages/daemon, `better-sqlite3` is resolved explicitly via createRequire anchored at
// packages/daemon/package.json (documented footgun: CLAUDE.md "Isolated-daemon testing on Windows").
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonPkgDir = path.join(__dirname, "..", "..", "..", "packages", "daemon");
const require = createRequire(path.join(daemonPkgDir, "package.json"));
const Database = require("better-sqlite3");

const LOOM_HOME = process.env.LOOM_HOME || path.join(os.homedir(), ".loom");
const DB_PATH = path.join(LOOM_HOME, "loom.db");
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── DoD-1: does "AttachConsole failed" appear in PASSING merge-gate runs' tails too? ──────────────────
const rows = db.prepare(
  `SELECT op_id, kind, branch, task_id, started_at, verdict, verdict_payload_json
   FROM pending_gate_ops
   WHERE verdict_payload_json IS NOT NULL
   ORDER BY started_at ASC`
).all();

console.log(`Total settled rows with a verdict payload: ${rows.length}`);
let withOutputTail = 0;
const attachConsoleRows = [];
for (const r of rows) {
  let payload;
  try { payload = JSON.parse(r.verdict_payload_json); } catch { continue; }
  if (typeof payload.outputTail === "string") {
    withOutputTail++;
    if (payload.outputTail.includes("AttachConsole")) {
      attachConsoleRows.push({
        op_id: r.op_id, kind: r.kind, branch: r.branch, task_id: r.task_id,
        started_at: r.started_at, verdict: r.verdict,
        occurrences: (payload.outputTail.match(/AttachConsole failed/g) || []).length,
      });
    }
  }
}
console.log(`Rows with an outputTail string: ${withOutputTail}`);
console.log(`Rows whose tail contains "AttachConsole": ${attachConsoleRows.length}`);
console.log(JSON.stringify(attachConsoleRows, null, 2));

// ── Full attempt history for task 239d6b9e / branch 1d90ff5b7ecf (the three merge attempts) ───────────
console.log("\n--- attempt history for task 239d6b9e / branch 1d90ff5b7ecf ---");
const attempts = db.prepare(
  `SELECT op_id, kind, branch, task_id, started_at, verdict, verdict_payload_json
   FROM pending_gate_ops WHERE task_id = ? OR branch LIKE ? ORDER BY started_at ASC`
).all("239d6b9e-ebe8-40a4-b8fa-889aab810ec7", "%1d90ff5b7ecf%");
for (const r of attempts) {
  const p = JSON.parse(r.verdict_payload_json || "{}");
  console.log(`${r.op_id} kind=${r.kind} verdict=${r.verdict} started=${r.started_at} totalDurationMs=${p.totalDurationMs} gateCap=${p.gateCap} concurrentGates=${p.concurrentGates} concurrentGatesMax=${p.concurrentGatesMax}`);
  if (p.gateDetail) console.log(`  failedStep=${JSON.stringify(p.gateDetail.failedStep)} failingTest=${JSON.stringify(p.gateDetail.failingTest)} exitCode=${p.gateDetail.exitCode} timedOut=${p.gateDetail.timedOut}`);
}

db.close();
