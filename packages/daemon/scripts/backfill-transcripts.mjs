// ─────────────────────────────────────────────────────────────────────────────────────────────
// backfill-transcripts.mjs — ONE-OFF, MANUAL transcript-snapshot backfill (NOT wired into boot).
//
// WHY: Loom does not own engine transcripts — a session keeps a readable transcript only because the
// daemon SNAPSHOTS Claude's JSONL (on exit, on shutdown, and — since the periodic-snapshot timer —
// every few minutes). Sessions that exited BEFORE that machinery existed have no snapshot; their
// engine JSONL may still survive under ~/.claude/projects. This recovers whatever survives: for every
// Loom session that has an engine id but NO stored snapshot AND whose engine JSONL still exists on
// disk, it snapshots it. Most old JSONLs are already pruned by Claude — this recovers only the rest.
//
// SAFE: READ-ONLY on ~/.claude (only reads JSONLs) and READ-ONLY on the DB (opened readonly — no
// migrations, no writes). Its ONLY writes are the snapshot copies it produces under ~/.loom/archives.
// Idempotent + safe to re-run: snapshotTranscript is mtime-guarded, so an already-current snapshot is
// a no-op. Best-effort: a per-session failure is counted and skipped, never aborts the run.
//
// RUN (from the repo root, after a build so dist/ exists):
//   pnpm --filter @loom/daemon build
//   node packages/daemon/scripts/backfill-transcripts.mjs            # apply: write missing snapshots
//   node packages/daemon/scripts/backfill-transcripts.mjs --dry-run  # scan + report only, NO writes
//
// Run it while the daemon is stopped (or accept that it sees the DB as-of now); it takes no locks the
// daemon needs, but the readonly snapshot is a point-in-time view.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolve dist modules as file:// URLs — Windows' ESM loader rejects a bare absolute path (`c:\...`).
const dist = (p) => pathToFileURL(path.join(here, "..", "dist", p)).href;

// Reuse the real snapshot helpers — never reimplement the copy/guard logic (single source of truth).
const { DB_PATH } = await import(dist("paths.js"));
const { snapshotTranscript, archivedTranscriptExists, engineTranscriptExists } =
  await import(dist("sessions/transcript.js"));

const dryRun = process.argv.includes("--dry-run");

let scanned = 0;        // sessions examined (have an engine id)
let backfilled = 0;     // snapshots newly written (or that WOULD be, in --dry-run)
let alreadyHave = 0;    // already had a snapshot — nothing to do
let jsonlGone = 0;      // no engine id OR the source JSONL is pruned — unrecoverable
let failed = 0;         // snapshotTranscript returned false / threw despite a present source

console.log(`[backfill] ${dryRun ? "DRY-RUN (no writes)" : "APPLY"} — reading DB ${DB_PATH} (readonly)`);

let db;
try {
  // READONLY: never migrates, never writes the DB — a strictly read-only view of the session registry.
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (err) {
  console.error(`[backfill] cannot open DB readonly (${DB_PATH}): ${err.message}`);
  process.exit(1);
}

// EVERY session (including archived) that has an engine id — archived rows are the whole point, but a
// still-live row missing a snapshot is harmless to backfill too (mtime-guarded). Only the columns the
// snapshot helpers need; no toSession mapping required.
let rows;
try {
  rows = db.prepare(
    `SELECT id, project_id AS projectId, cwd, engine_session_id AS engineSessionId
       FROM sessions
      WHERE engine_session_id IS NOT NULL
      ORDER BY last_activity DESC`,
  ).all();
} catch (err) {
  console.error(`[backfill] failed to read sessions: ${err.message}`);
  db.close();
  process.exit(1);
}

for (const s of rows) {
  scanned++;
  // Already snapshotted → idempotent skip (the common case on a re-run).
  if (archivedTranscriptExists(s.projectId, s.id)) { alreadyHave++; continue; }
  // No surviving engine JSONL → unrecoverable (Claude already pruned it). Read-only existence check.
  if (!engineTranscriptExists(s.cwd, s.engineSessionId)) { jsonlGone++; continue; }
  // Recoverable: a missing snapshot with a surviving source.
  if (dryRun) {
    backfilled++;
    console.log(`[backfill] would snapshot ${s.id.slice(0, 8)} (project ${s.projectId.slice(0, 8)})`);
    continue;
  }
  let ok = false;
  try { ok = snapshotTranscript(s.cwd, s.engineSessionId, s.projectId, s.id); } catch { ok = false; }
  if (ok) { backfilled++; console.log(`[backfill] snapshotted ${s.id.slice(0, 8)} (project ${s.projectId.slice(0, 8)})`); }
  else { failed++; console.warn(`[backfill] FAILED to snapshot ${s.id.slice(0, 8)} (source present but copy failed)`); }
}

db.close();

console.log(
  `\n[backfill] done — scanned ${scanned} session(s) with an engine id: ` +
  `${backfilled} ${dryRun ? "recoverable (would backfill)" : "backfilled"}, ` +
  `${alreadyHave} already had a snapshot, ${jsonlGone} unrecoverable (JSONL pruned), ${failed} failed.`,
);
process.exit(0);
