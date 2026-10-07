import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Migration boot-test for Schedule.createdBy (card acd3c688) — mirrors
// task-manual-deferral-migration.mjs's discipline: a FRESH LOOM_HOME is structurally blind to a "schema
// references a migration-added column" bug, because a brand-new schedules table gets every
// SCHEDULE_ADDED_COLUMNS entry applied by migrateSchedules() regardless of whether the ALTER actually
// exercised anything. This test synthesizes a REAL pre-acd3c688 `schedules` table directly on disk with
// better-sqlite3 (the exact column set the base SCHEMA + SCHEDULE_ADDED_COLUMNS produced before this
// card added created_by — mirrors db.ts's own CREATE TABLE schedules + pre-change SCHEDULE_ADDED_COLUMNS).
//
// Proves:
//   (1) the constructor does NOT throw on this legacy (pre-acd3c688) schedules table.
//   (2) created_by was added to the existing table.
//   (3) a pre-existing legacy schedule row backfills createdBy to null — never an invented "human"/"agent"
//       — while every other field survives untouched.
//   (4) scheduleCreatedByIsHuman treats a legacy (null) row the SAME as "agent" (fail-closed), never as
//       "human".
//   (5) a fresh insertSchedule round-trips createdBy "human"/"agent" through both getSchedule() and
//       listSchedules().
//   (6) NEGATIVE: no BASE SCHEMA index/constraint references created_by (the inverse-bug check).
//
// Run: 1) build (turbo builds shared first), 2) node test/schedule-created-by-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-schedule-created-by-migration-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy-pre-created-by.db");
const projId = randomUUID();
const agentId = randomUUID();
const legacyScheduleId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";

// ===== Synthesize the LEGACY (pre-acd3c688) `schedules` table (+ its projects/agents dependencies) =====
{
  const raw = new Database(dbFile);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, vault_path TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT, reserved INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
      startup_prompt TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
      profile_id TEXT, endpoint INTEGER NOT NULL DEFAULT 0, io_schema TEXT
    );
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      name TEXT,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      cron TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_fire_at TEXT NOT NULL,
      last_fired_at TEXT,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'manager',
      prompt TEXT,
      last_deferred_at TEXT,
      last_deferred_reason TEXT
      -- NO created_by — the real pre-acd3c688 shape.
    );
  `);
  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at, reserved) VALUES (?, ?, ?, ?, '{}', ?, NULL, 0)")
    .run(projId, "Legacy Project", projId, projId, t0);
  raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position, profile_id, endpoint, io_schema) VALUES (?, ?, 'Legacy Manager Agent', '', 0, NULL, 0, NULL)")
    .run(agentId, projId);
  // A real pre-existing schedule row, written before this card ever existed.
  raw.prepare(
    "INSERT INTO schedules (id, name, agent_id, cron, enabled, next_fire_at, last_fired_at, created_at, kind, prompt, last_deferred_at, last_deferred_reason) VALUES (?, 'Nightly sweep', ?, '0 2 * * *', 1, ?, NULL, ?, 'manager', NULL, NULL, NULL)",
  ).run(legacyScheduleId, agentId, t0, t0);
  raw.close();

  const cols0 = new Set(new Database(dbFile, { readonly: true }).prepare("PRAGMA table_info(schedules)").all().map((c) => c.name));
  check("(setup) the synthesized pre-migration schedules table has NO created_by yet", !cols0.has("created_by"));
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this legacy (pre-acd3c688) DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a legacy pre-acd3c688 schedules table does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    // ===== (2) created_by was added to the existing table =====
    const raw2 = new Database(dbFile, { readonly: true });
    let cols;
    try {
      cols = raw2.prepare("PRAGMA table_info(schedules)").all().map((c) => c.name);
    } finally {
      raw2.close();
    }
    check("(2) created_by column added", cols.includes("created_by"));

    // ===== (3) the pre-existing legacy row backfills createdBy to null; everything else untouched =====
    const legacy = db.getSchedule(legacyScheduleId);
    check("(3) the legacy schedule is still readable post-migration", legacy?.name === "Nightly sweep");
    check("(3) createdBy backfills to null — NEVER an invented 'human'/'agent'", legacy?.createdBy === null);
    check("(3) unrelated fields survive untouched (agentId)", legacy?.agentId === agentId);
    check("(3) unrelated fields survive untouched (cron)", legacy?.cron === "0 2 * * *");
    check("(3) unrelated fields survive untouched (kind)", legacy?.kind === "manager");
    check("(3) unrelated fields survive untouched (enabled)", legacy?.enabled === true);

    // ===== (4) scheduleCreatedByIsHuman treats the legacy (null) row as "agent", never "human" =====
    const { scheduleCreatedByIsHuman } = await import("../dist/orchestration/scheduler.js");
    check("(4) a legacy (null createdBy) row is NOT treated as human-authorized", scheduleCreatedByIsHuman(legacy) === false);
    check("(4) positive control: an explicit createdBy:'human' row IS treated as human-authorized", scheduleCreatedByIsHuman({ createdBy: "human" }) === true);
    check("(4) positive control: an explicit createdBy:'agent' row is NOT treated as human-authorized", scheduleCreatedByIsHuman({ createdBy: "agent" }) === false);

    // ===== (5) a fresh insertSchedule round-trips createdBy through getSchedule()/listSchedules() =====
    const humanId = randomUUID();
    const agentCreatedId = randomUUID();
    const next = new Date(Date.now() + 86400000).toISOString();
    db.insertSchedule({ id: humanId, name: "Human-made", agentId, cron: "0 3 * * *", enabled: true, nextFireAt: next, lastFiredAt: null, createdAt: t0, kind: "manager", prompt: null, createdBy: "human" });
    db.insertSchedule({ id: agentCreatedId, name: "Agent-made", agentId, cron: "0 4 * * *", enabled: true, nextFireAt: next, lastFiredAt: null, createdAt: t0, kind: "manager", prompt: null, createdBy: "agent" });
    check("(5) getSchedule() round-trips createdBy:'human'", db.getSchedule(humanId)?.createdBy === "human");
    check("(5) getSchedule() round-trips createdBy:'agent'", db.getSchedule(agentCreatedId)?.createdBy === "agent");
    const all = db.listSchedules();
    check("(5) listSchedules() ALSO surfaces createdBy:'human'", all.find((s) => s.id === humanId)?.createdBy === "human");
    check("(5) listSchedules() ALSO surfaces createdBy:'agent'", all.find((s) => s.id === agentCreatedId)?.createdBy === "agent");

    // ===== (6) NEGATIVE — no BASE SCHEMA index/constraint references created_by =====
    const dbSrc = fs.readFileSync(new URL("../dist/db.js", import.meta.url), "utf8");
    const schemaMatch = dbSrc.match(/const SCHEMA = `([\s\S]*?)`;/);
    check("(6) setup: located the compiled SCHEMA template literal", !!schemaMatch);
    if (schemaMatch) {
      check("(6) base SCHEMA never references created_by", !/\bcreated_by\b/.test(schemaMatch[1]));
    }
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-acd3c688 legacy schedules table, migrateSchedules() ADD COLUMNs created_by, a pre-existing legacy row backfills createdBy to null — never an invented value — while every other field survives untouched, scheduleCreatedByIsHuman treats a legacy (null) row the same as 'agent' (fail-closed), a fresh insertSchedule round-trips createdBy through both getSchedule() and listSchedules(), and the base SCHEMA never references created_by (the inverse-bug check)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
