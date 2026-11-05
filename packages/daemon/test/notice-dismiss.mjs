import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f549a0ae — a `type:"notice"` stays in the inbox after it is opened until a human dismisses it.
// Boot-tests the `dismissed_at` migration against a SYNTHETIC pre-migration `questions` shape (never the real
// DB), then drives the real route against that upgraded DB. Proves:
//   (1) the constructor does not throw on a questions table that predates `dismissed_at`; column added.
//   (2) BACKFILL: every pre-existing notice with read_at set gets dismissed_at = read_at; an UNREAD notice and
//       a READ non-notice (decision) stay null.
//   (3) the backfill runs ONCE: a notice opened after the upgrade is NOT swept into dismissed_at by a later boot.
//   (4) no index on the migrated DB references dismissed_at (positive-controlled against escalated_at).
//   (5) default inbox view: unread notice + read-but-undismissed notice present; backfilled-dismissed absent;
//       History (includeConsumed) still has all of them.
//   (6) POST /api/questions/dismiss-notices: stamps a notice, 400s on a malformed body, and SKIPS a non-notice
//       id (a pending decision is untouched — state and dismissedAt both unchanged).
//   (7) attachment-GC candidacy for a notice keys on dismissed_at, not read_at.
// Run: 1) build the daemon, 2) node test/notice-dismiss.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-notice-dismiss-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const dbFile = path.join(tmpHome, "pre-dismissed.db");
const projId = randomUUID();
const agentId = randomUUID();
const mgrId = randomUUID();
const t0 = "2026-01-01T00:00:00.000Z";
const READ_AT = "2026-02-02T00:00:00.000Z";
const ids = { noticeRead: "n-read", noticeUnread: "n-unread", decisionRead: "d-read", decisionPending: "d-pending" };

{
  const raw = new Database(dbFile);
  raw.pragma("journal_mode = WAL");
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, vault_path TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
      startup_prompt TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      agent_id TEXT NOT NULL REFERENCES agents(id), engine_session_id TEXT, title TEXT, cwd TEXT NOT NULL,
      process_state TEXT NOT NULL DEFAULT 'none', resumability TEXT NOT NULL DEFAULT 'unknown',
      busy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_activity TEXT NOT NULL,
      last_error TEXT, role TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', column_key TEXT NOT NULL, position REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    -- The pre-f549a0ae shape: every questions column that exists today EXCEPT dismissed_at.
    CREATE TABLE questions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      filed_by_session_id TEXT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      type TEXT NOT NULL DEFAULT 'decision',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      options_json TEXT, recommendation TEXT, task_id TEXT,
      permission_action TEXT, permission_scope TEXT, permission_expires_at TEXT,
      decided_scope TEXT, decided_expires_at TEXT,
      credential_env_var TEXT, secret_blob TEXT,
      provision_target TEXT, provision_connection_id TEXT, provision_binding_state TEXT,
      fulfillment_target TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      chosen_option TEXT, note TEXT,
      created_at TEXT NOT NULL, answered_at TEXT, consumed_at TEXT,
      last_surfaced_state TEXT, last_surfaced_at TEXT,
      cancelled_reason TEXT, cancelled_by TEXT, cancelled_at TEXT,
      escalated_at TEXT, acknowledged_until TEXT, read_at TEXT, attachments_json TEXT
    );
    CREATE INDEX idx_questions_session ON questions(session_id, state);
    CREATE INDEX idx_questions_state_answered ON questions(state, answered_at);
    CREATE INDEX idx_questions_task ON questions(task_id);
    CREATE INDEX idx_questions_pending_unescalated ON questions(created_at) WHERE state = 'pending' AND escalated_at IS NULL;
  `);
  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at) VALUES (?, 'Legacy', ?, ?, '{}', ?, NULL)")
    .run(projId, projId, projId, t0);
  raw.prepare("INSERT INTO agents (id, project_id, name, startup_prompt, position) VALUES (?, ?, 'Manager', '', 0)").run(agentId, projId);
  raw.prepare(
    "INSERT INTO sessions (id, project_id, agent_id, engine_session_id, title, cwd, process_state, resumability, busy, created_at, last_activity, last_error, role) " +
      "VALUES (?, ?, ?, ?, NULL, ?, 'live', 'resumable', 0, ?, ?, NULL, 'manager')",
  ).run(mgrId, projId, agentId, `eng-${mgrId}`, projId, t0, t0);
  const ins = raw.prepare(
    `INSERT INTO questions (id, session_id, filed_by_session_id, project_id, type, title, state, created_at, answered_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run(ids.noticeRead, mgrId, mgrId, projId, "notice", "opened notice", "notice", t0, t0, READ_AT);
  ins.run(ids.noticeUnread, mgrId, mgrId, projId, "notice", "unopened notice", "notice", t0, t0, null);
  ins.run(ids.decisionRead, mgrId, mgrId, projId, "decision", "opened decision", "pending", t0, null, READ_AT);
  ins.run(ids.decisionPending, mgrId, mgrId, projId, "decision", "unopened decision", "pending", t0, null, null);
  const cols = new Set(raw.prepare("PRAGMA table_info(questions)").all().map((c) => c.name));
  check("(setup) the synthesized pre-migration table has NO dismissed_at column", !cols.has("dismissed_at"));
  raw.close();
}

let db;
let app;
try {
  const { Db } = await import("../dist/db.js");
  let ctorError = null;
  try { db = new Db(dbFile); } catch (err) { ctorError = err; }
  check("(1) constructing Db against a pre-dismissed_at DB does not throw", ctorError === null);
  if (ctorError) { console.log(`    threw: ${ctorError?.stack || ctorError}`); throw ctorError; }

  const peek = (sql) => { const r = new Database(dbFile, { readonly: true }); try { return r.prepare(sql).all(); } finally { r.close(); } };
  check("(1) column 'dismissed_at' was added", peek("PRAGMA table_info(questions)").some((c) => c.name === "dismissed_at"));

  // (2) backfill
  check("(2) an already-OPENED notice is backfilled: dismissedAt === its readAt", db.getQuestion(ids.noticeRead)?.dismissedAt === READ_AT);
  check("(2) an UNOPENED notice stays dismissedAt:null", db.getQuestion(ids.noticeUnread)?.dismissedAt === null);
  check("(2) an opened NON-notice (decision) is NOT backfilled", db.getQuestion(ids.decisionRead)?.dismissedAt === null);
  check("(2) the unopened decision stays null", db.getQuestion(ids.decisionPending)?.dismissedAt === null);

  // (3) runs once: open the unread notice AFTER the upgrade, reboot, and it must not be swept in.
  db.markQuestionsRead([ids.noticeUnread], "2026-03-03T00:00:00.000Z");
  db.close();
  db = new Db(dbFile);
  check("(3) a notice opened AFTER the upgrade is not dismissed by a later boot (backfill ran once)", db.getQuestion(ids.noticeUnread)?.dismissedAt === null);
  check("(3) the backfilled stamp is unchanged by the second boot", db.getQuestion(ids.noticeRead)?.dismissedAt === READ_AT);

  // (4) index check, positive-controlled
  const idx = peek("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'questions'").map((r) => r.sql ?? "");
  check("(4) POSITIVE CONTROL: the same scan finds escalated_at's index", idx.some((s) => s.includes("escalated_at")));
  check("(4) no index references dismissed_at", !idx.some((s) => s.includes("dismissed_at")));

  // (5) views
  const def = db.listOpenQuestions(false).map((q) => q.id);
  check("(5) default view keeps the opened-but-undismissed notice (opening never dismisses)", def.includes(ids.noticeUnread));
  check("(5) default view hides the backfilled-dismissed notice", !def.includes(ids.noticeRead));
  const hist = db.listOpenQuestions(true).map((q) => q.id);
  check("(5) History still lists both notices", hist.includes(ids.noticeRead) && hist.includes(ids.noticeUnread));

  // (6) the route
  const { buildServer } = await import("../dist/gateway/server.js");
  const stub = {};
  app = await buildServer({ db, pty: { enqueueStdin: () => ({ delivered: false, reason: "n/a" }) }, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const r1 = await app.inject({ method: "POST", url: "/api/questions/dismiss-notices", payload: { ids: [ids.noticeUnread, ids.decisionPending, "nope"] } });
  check("(6) POST dismiss-notices → 200 reporting ONLY the notice", r1.statusCode === 200 && JSON.stringify(r1.json().updated) === JSON.stringify([ids.noticeUnread]));
  check("(6) the notice is now dismissed and gone from the default view", typeof db.getQuestion(ids.noticeUnread)?.dismissedAt === "string" && !db.listOpenQuestions(false).some((q) => q.id === ids.noticeUnread));
  const dec = db.getQuestion(ids.decisionPending);
  check("(6) a pending DECISION id is skipped: still pending, dismissedAt null", dec?.state === "pending" && dec?.dismissedAt === null);
  const r2 = await app.inject({ method: "POST", url: "/api/questions/dismiss-notices", payload: { ids: [ids.noticeUnread] } });
  check("(6) re-dismissing is a 200 no-op", r2.statusCode === 200 && r2.json().updated.length === 0);
  check("(6) missing ids → 400", (await app.inject({ method: "POST", url: "/api/questions/dismiss-notices", payload: {} })).statusCode === 400);
  check("(6) non-string element → 400", (await app.inject({ method: "POST", url: "/api/questions/dismiss-notices", payload: { ids: [1] } })).statusCode === 400);

  // (7) GC candidacy keys on dismissed_at. Give both notices an attachments_json so they are candidates-shaped.
  const w = new Database(dbFile);
  try { w.prepare("UPDATE questions SET attachments_json = '[]' WHERE id IN (?, ?)").run(ids.noticeRead, ids.noticeUnread); } finally { w.close(); }
  db.close();
  db = new Db(dbFile);
  const cand = db.listAttachmentGcCandidateIds("2099-01-01T00:00:00.000Z");
  check("(7) a dismissed notice IS a GC candidate", cand.includes(ids.noticeRead) && cand.includes(ids.noticeUnread));
  const w2 = new Database(dbFile);
  try { w2.prepare("UPDATE questions SET dismissed_at = NULL WHERE id = ?").run(ids.noticeRead); } finally { w2.close(); }
  check("(7) an OPENED-but-undismissed notice (read_at set, dismissed_at null) is NOT a GC candidate", !db.listAttachmentGcCandidateIds("2099-01-01T00:00:00.000Z").includes(ids.noticeRead));
} finally {
  try { await app?.close(); } catch { /* ignore */ }
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — dismissed_at migrates onto a pre-existing DB, backfills opened notices exactly once, the dismiss route is notice-only, and GC keys on dismissed_at."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
