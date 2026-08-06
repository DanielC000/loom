// Read-only extraction against the live loom.db for card 8126f1a0 ("read the first real single-file
// gate retry"). Opens with { readonly: true, fileMustExist: true } — never writes, safe against the
// live WAL-mode DB. Run from anywhere; LOOM_HOME env var overrides the default ~/.loom location.
//
// better-sqlite3 is a packages/daemon dependency; ESM bare-specifier resolution walks up from THIS
// file's own location, not cwd (see this repo's CLAUDE.md "Isolated-daemon testing on Windows" note) —
// so resolve it explicitly via createRequire anchored at packages/daemon/package.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonPkgDir = path.join(here, "..", "..", "..", "..", "packages", "daemon");
const requireFromDaemon = createRequire(path.join(daemonPkgDir, "package.json"));
const Database = requireFromDaemon("better-sqlite3");

const dbPath = process.env.LOOM_HOME
  ? path.join(process.env.LOOM_HOME, "loom.db")
  : path.join(os.homedir(), ".loom", "loom.db");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const SPECIMEN_OP_ID = "5f7e5dcc-8a06-4e9e-8a57-d6ab4bc27947";
const SPECIMEN_TASK_ID = "066d317c-4932-49d1-b24d-cdb7b24f28e2";
const RETRY_FEATURE_MERGE_SHA = "701daccd3935d016417dabb6f6ae1d7203542b38";
const CARD_344CE950_ID = "344ce950-b354-4f77-bc1c-0c21421d56e1";

const out = {};

// 1) The specimen itself: the ONE row in orchestration_events carrying retriedFile, plus its full
//    ms-precision step breakdown from pending_gate_ops.verdict_payload_json.
out.specimenGateHistoryRows = db.prepare(
  `SELECT oe.id AS id, oe.ts AS ts, oe.kind AS kind, oe.detail_json AS detailJson, oe.task_id AS taskId
   FROM orchestration_events oe
   WHERE oe.kind IN ('worker_gate','build_gate','build_gate_retry','build_gate_single_file_retry','deploy')
     AND oe.detail_json LIKE '%retriedFile%'
   ORDER BY oe.seq ASC`
).all().map((r) => ({ ...r, detail: JSON.parse(r.detailJson) }));

out.specimenTaskEvents = db.prepare(
  `SELECT oe.id AS id, oe.ts AS ts, oe.kind AS kind, oe.detail_json AS detailJson,
          COALESCE(oe.worker_session_id, oe.manager_session_id) AS sessionId
   FROM orchestration_events oe
   WHERE oe.task_id = ?
   ORDER BY oe.seq ASC`
).all(SPECIMEN_TASK_ID).map((r) => ({ ...r, detail: r.detailJson ? JSON.parse(r.detailJson) : null }));

const pendingOpRow = db.prepare(`SELECT * FROM pending_gate_ops WHERE op_id = ?`).get(SPECIMEN_OP_ID);
out.specimenPendingGateOp = pendingOpRow
  ? { ...pendingOpRow, verdict_payload: pendingOpRow.verdict_payload_json ? JSON.parse(pendingOpRow.verdict_payload_json) : null }
  : null;

// 2) Card 344ce950's own creation time (bounds "what mgr #127 could have measured").
out.card344ce950 = db.prepare(`SELECT id, title, created_at, updated_at FROM tasks WHERE id = ?`).get(CARD_344CE950_ID);

// 3) The full pre-feature build_gate population (every "merge" gate run before the retry feature's
//    own merge commit landed), for the DoD-4 premise re-check.
const cutoffTs = "2026-08-05T22:48:43.000Z"; // 701daccd commit time (merge of card 344ce950)
const buildGateRows = db.prepare(
  `SELECT oe.ts AS ts, oe.detail_json AS detailJson,
          COALESCE(oe.worker_session_id, oe.manager_session_id) AS sessionId, s.branch AS branch
   FROM orchestration_events oe
   LEFT JOIN sessions s ON s.id = COALESCE(oe.worker_session_id, oe.manager_session_id)
   WHERE oe.kind = 'build_gate' AND oe.ts < ?
   ORDER BY oe.ts ASC`
).all(cutoffTs);
out.cutoffTs = cutoffTs;
out.preFeatureBuildGateRuns = buildGateRows.map((r) => ({ ts: r.ts, branch: r.branch, passed: JSON.parse(r.detailJson).passed === true }));

// 4) Case study: branch loom/d878a91ffb04's rejection + re-pass ~15min later, and every event for that
//    session in between (checks whether a worker fix landed, or this was a bare re-fire).
out.caseStudySessionEvents = db.prepare(
  `SELECT oe.ts AS ts, oe.kind AS kind, oe.detail_json AS detailJson,
          COALESCE(oe.worker_session_id, oe.manager_session_id) AS sessionId
   FROM orchestration_events oe
   WHERE (oe.worker_session_id = '6bca7bb5-6990-4343-9fc4-7f738482805c'
          OR oe.manager_session_id = '6bca7bb5-6990-4343-9fc4-7f738482805c')
     AND oe.ts BETWEEN '2026-08-05T19:55:00.000Z' AND '2026-08-05T20:20:00.000Z'
   ORDER BY oe.seq ASC`
).all().map((r) => ({ ...r, detail: r.detailJson ? JSON.parse(r.detailJson) : null }));

const outPath = path.join(here, "..", "data", "weaker-pass-evidence.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}`);
