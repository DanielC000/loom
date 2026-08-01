#!/usr/bin/env node
// READ-ONLY extraction of EVERY GateSemaphore admission recorded in orchestration_events, across
// ALL projects and ALL gate kinds (build_gate, build_gate_retry, worker_gate, deploy) — for card
// e75dc05a's retrospective mid-run-join reconstruction.
//
// Why all four kinds, all projects: the GateSemaphore is a SINGLE daemon-global instance
// (service.ts:1202, shared by every gateType — "merge"/"worker"/"deploy" — and every project's
// maxConcurrentGates cap draws from the same pool). A run "joining mid-run" can be ANY of these four
// kinds from ANY project — the card's own positive control is exactly a Loom merge gate joined by a
// Codescape merge gate. Restricting to one project or one kind would make the reconstruction blind to
// the exact contamination this card exists to measure.
//
// Opens loom.db with { readonly: true, fileMustExist: true } — never writes. Safe against the live
// WAL-mode DB (the pattern verified safe by card 99fb882e).
//
// Usage:
//   node extract-all-gate-admissions.mjs [--db <path-to-loom.db>] [--out <path.json>]
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
const outPath = argVal("--out", null);

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
console.error(`[extract-all-gate-admissions] opened ${dbPath} readonly, journal_mode=${db.pragma("journal_mode", { simple: true })}`);

const rows = db.prepare(`
  SELECT oe.id, oe.ts, oe.seq, oe.kind, oe.task_id, oe.worker_session_id, oe.manager_session_id, oe.detail_json,
         s.project_id AS projectId, p.name AS projectName
  FROM orchestration_events oe
  LEFT JOIN sessions s ON s.id = COALESCE(oe.worker_session_id, oe.manager_session_id)
  LEFT JOIN projects p ON p.id = s.project_id
  WHERE oe.kind IN ('build_gate','build_gate_retry','worker_gate','deploy')
  ORDER BY oe.seq ASC
`).all();

console.error(`[extract-all-gate-admissions] ${rows.length} raw rows across all kinds/projects`);

function parsed(r) {
  let d = {};
  try { d = JSON.parse(r.detail_json); } catch { /* malformed row, keep raw fields only */ }
  return {
    id: r.id, ts: r.ts, seq: r.seq, kind: r.kind, taskId: r.task_id,
    projectId: r.projectId, projectName: r.projectName, ...d,
  };
}
const all = rows.map(parsed);

// Reused rows (a worker-gate self-check result REUSED by a merge confirm, `reused:true`) never
// themselves called gateSemaphore.runExclusive — gateStartedAt in that code path is left at its
// pre-admission initializer (service.ts:9602), so `durationMs` on a reused row measures wall time
// inside confirmWorkerMerge's own gate section, NOT a real semaphore admission. Including it as an
// interval would fabricate a phantom admission. Excluded here, same as 99fb882e's own
// rising-floor-report.mjs (`!r.reused`).
const admissions = all.filter((r) => typeof r.durationMs === "number" && !r.reused);

console.error(`[extract-all-gate-admissions] ${admissions.length} real admissions (durationMs present, reused excluded) out of ${all.length}`);
console.error(`[extract-all-gate-admissions] by kind: ${JSON.stringify(
  admissions.reduce((acc, r) => { acc[r.kind] = (acc[r.kind] ?? 0) + 1; return acc; }, {})
)}`);
console.error(`[extract-all-gate-admissions] by project: ${JSON.stringify(
  admissions.reduce((acc, r) => { const k = r.projectName ?? r.projectId ?? "(unknown)"; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {})
)}`);

// Derive the interval every admission actually held the semaphore for.
// settleMs: the event is appended right after the run settles (evt() call sites all fire
// immediately after `await runExclusive(...)` resolves or throws) -> ts IS the settle instant,
// to within the few ms of synchronous work between resolution and the db write.
// admitMs = settleMs - durationMs, because durationMs is DEFINED as `Date.now() - gateStartedAt`
// where gateStartedAt is captured as the FIRST thing inside the runExclusive callback (i.e. at
// admission, strictly after any queue wait) -- see service.ts:9602/9623 (build_gate),
// :9670/9674 (retry), :10492/10514 (worker_gate), :2599/2606 (deploy). This is an EXACT
// back-calculation, not an inference -- the two fields were always going to reproduce this
// relationship because durationMs IS settleMs-admitMs by construction. What IS inferred is that
// `ts` equals the settle instant exactly; the true settle instant precedes `ts` by whatever
// synchronous work happens between `runExclusive` resolving and `db.appendEvent`'s own
// `new Date().toISOString()` call -- sub-millisecond to low-single-digit-ms in every code path
// read (no I/O between them), so the induced error on interval boundaries is negligible relative
// to run durations measured in hundreds of seconds.
for (const r of admissions) {
  const settleMs = Date.parse(r.ts);
  r.settleMs = settleMs;
  r.admitMs = settleMs - r.durationMs;
  r.admitIso = new Date(r.admitMs).toISOString();
}

admissions.sort((a, b) => a.admitMs - b.admitMs);

if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(admissions, null, 2));
  console.error(`[extract-all-gate-admissions] wrote ${admissions.length} rows to ${outPath}`);
} else {
  console.log(JSON.stringify(admissions, null, 2));
}

db.close();
