import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression guard for the P0 boot crash of 2026-07-06: `exec(SCHEMA)` runs BEFORE the `migrate*()`
// methods in the Db constructor, so a SCHEMA-level statement that references a column only ADDED by a
// migration (a `*_ADDED_COLUMNS` ALTER, e.g. `conversation_seq` on `companion_messages`) blows up with
// `SqliteError: no such column: ...` on any EXISTING (upgraded) DB — `CREATE TABLE IF NOT EXISTS` no-ops
// on a table that already exists in its OLD shape, so the column genuinely isn't there yet when SCHEMA's
// statement runs. Every other hermetic daemon test is blind to this whole class of bug because they ALL
// construct a Db against a FRESH file, where CREATE TABLE brings in every column at once.
//
// This test instead synthesizes a REAL pre-migration ("legacy") companion_messages table directly on disk
// with better-sqlite3 (mirroring the true pre-85f62475 shape: no `conversation_seq`, and no
// `companion_conversations` table at all — see git commit a6ff355 for the original CREATE TABLE), with
// real rows and their referenced `sessions`/`projects`/`agents` rows, then constructs a real `Db` against
// it and proves:
//   (1) the constructor does NOT throw on a legacy DB.
//   (2) `conversation_seq` exists on companion_messages post-construct, the
//       `idx_companion_messages_conversation` index exists, and every legacy row backfills to
//       conversation_seq = 1 (non-NULL).
//   (3) `companion_conversations` is backfilled — one OPEN conversation-1 per session that has messages,
//       started_at = that session's earliest message.
//
// ACCEPTANCE PROOF (see the worker report, not committed here): moving the
// `idx_companion_messages_conversation` CREATE INDEX back into `exec(SCHEMA)` (as it was pre-ddf75de)
// makes this test's constructor-throw check FAIL, proving it actually catches the regression class.
//
// Run: 1) build (turbo builds shared first), 2) node test/db-legacy-boot.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-db-legacy-boot-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "legacy.db");

const projId = randomUUID();
const agentId = randomUUID();
const sess1 = randomUUID(); // 2 messages
const sess2 = randomUUID(); // 1 message
const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-01-01T00:00:05.000Z";
const t2 = "2026-01-02T00:00:00.000Z";

// ===== Synthesize the LEGACY (pre-85f62475) DB shape directly, bypassing the Db class entirely =====
{
  const raw = new Database(dbFile);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      vault_path TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      startup_prompt TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      engine_session_id TEXT,
      title TEXT,
      cwd TEXT NOT NULL,
      process_state TEXT NOT NULL DEFAULT 'none',
      resumability TEXT NOT NULL DEFAULT 'unknown',
      busy INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      last_error TEXT,
      role TEXT
    );
    -- The true pre-85f62475 shape (git a6ff355): via_voice already landed (7d63e200), conversation_seq
    -- has NOT — the exact upgrade gap that shipped the P0 crash. NO companion_conversations table either.
    CREATE TABLE companion_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      via_voice INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_companion_messages_session ON companion_messages(session_id, channel, created_at);
  `);

  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at) VALUES (?, ?, ?, ?, '{}', ?, NULL)")
    .run(projId, "Legacy Project", projId, projId, t0);
  raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position) VALUES (?, ?, 'Companion', '', 0)")
    .run(agentId, projId);
  for (const [sessId, ts] of [[sess1, t0], [sess2, t2]]) {
    raw.prepare(
      "INSERT INTO sessions (id, project_id, agent_id, engine_session_id, title, cwd, process_state, resumability, busy, created_at, last_activity, last_error, role) " +
        "VALUES (?, ?, ?, ?, NULL, ?, 'live', 'resumable', 0, ?, ?, NULL, 'assistant')",
    ).run(sessId, projId, agentId, `eng-${sessId}`, projId, ts, ts);
  }
  const insertMsg = raw.prepare(
    "INSERT INTO companion_messages (id, session_id, channel, chat_id, author, text, created_at, via_voice) VALUES (?, ?, 'in-app', ?, ?, ?, ?, 0)",
  );
  insertMsg.run(randomUUID(), sess1, sess1, "user", "old message 1", t0);
  insertMsg.run(randomUUID(), sess1, sess1, "companion", "old message 2", t1);
  insertMsg.run(randomUUID(), sess2, sess2, "user", "a different legacy session", t2);

  raw.close();
}

let db;
try {
  // ===== (1) the constructor must NOT throw on this legacy DB =====
  let ctorError = null;
  try {
    const { Db } = await import("../dist/db.js");
    db = new Db(dbFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a legacy pre-conversation_seq DB does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    const raw2 = new Database(dbFile, { readonly: true });
    try {
      // ===== (2) conversation_seq exists, index exists, every row backfilled non-NULL =====
      const cols = new Set(raw2.prepare("PRAGMA table_info(companion_messages)").all().map((c) => c.name));
      check("(2) companion_messages gained the conversation_seq column", cols.has("conversation_seq"));

      const idx = raw2.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_companion_messages_conversation'",
      ).get();
      check("(2) idx_companion_messages_conversation was created", idx !== undefined);

      const rows = raw2.prepare("SELECT conversation_seq AS seq FROM companion_messages ORDER BY created_at").all();
      check(
        "(2) every legacy companion_messages row backfilled to a non-NULL conversation_seq (1)",
        rows.length === 3 && rows.every((r) => r.seq === 1),
      );

      // ===== (3) companion_conversations backfilled per session =====
      const conv1 = db.listCompanionConversations(sess1);
      check(
        "(3) session 1 (2 legacy messages) backfilled to exactly one OPEN conversation-1",
        conv1.length === 1 && conv1[0].seq === 1 && conv1[0].endedAt === null,
      );
      check("(3) its startedAt is session 1's EARLIEST message time", conv1[0].startedAt === t0);
      check("(3) its message count reflects both legacy rows", conv1[0].messageCount === 2);

      const conv2 = db.listCompanionConversations(sess2);
      check(
        "(3) session 2 (1 legacy message) ALSO backfilled independently",
        conv2.length === 1 && conv2[0].seq === 1 && conv2[0].startedAt === t2 && conv2[0].messageCount === 1,
      );
    } finally {
      raw2.close();
    }
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Db boots clean against a real pre-conversation_seq legacy DB (exec(SCHEMA) never references a column only a later migrate*() ALTERs in), and the conversation_seq + companion_conversations backfill both land correctly per-session."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
