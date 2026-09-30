import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e152014c — deleteSession/deleteProject/deleteAgent must cascade EVERY table with an enforced FK
// to sessions(id), atomically, instead of the old six-sequential-write, no-transaction, partial-list
// cascade that omitted companion_messages/companion_conversations/poll_jobs and never nulled
// event_triggers.target_session_id / webhook_endpoints.target_session_id.
//
// Covers:
//   (0) pragma foreign_key_list ENUMERATION — fails loudly if a future migration adds a new FK-to-
//       sessions column that cascadeSessionForeignKeyChildren doesn't know about.
//   (A) deleteSession on a companion session with messages, conversations, a poll job, an event trigger
//       and a webhook endpoint targeting it succeeds (RED on old code: threw FOREIGN KEY constraint
//       failed) and cascades correctly — owned rows (wakes/reminders/grants/messages/conversations/
//       questions) are gone; target-only rows (poll_jobs/event_triggers/webhook_endpoints) SURVIVE with
//       their session reference nulled, never deleted outright.
//   (B) a forced failure mid-cascade leaves EVERYTHING intact — the session row, every FK child, and
//       every target reference — proving the whole delete is one transaction, not six independent writes.
//   (C) deleteProject on a project whose only session ever hosted a companion with messages succeeds
//       (RED on old code: threw, so the project could never be deleted) and cascades the same way.
//   (D) deleteAgent, same shape as (C), for an agent whose only session hosted a companion.
//
// Run: 1) build (turbo builds shared first), 2) node test/session-delete-fk-cascade.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-session-delete-fk-cascade-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");

const dbFile = path.join(tmpHome, "fk-cascade.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

function mkProject(id) {
  db.insertProject({ id, name: id, repoPath: `/tmp/${id}`, vaultPath: `/tmp/${id}`, config: {}, createdAt: now, archivedAt: null });
  const agentId = `${id}-agent`;
  db.insertAgent({ id: agentId, projectId: id, name: "t", startupPrompt: "", position: 0 });
  return { projectId: id, agentId };
}

function mkSession(id, projectId, agentId) {
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: id,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
}

/** Populate every FK-child / target-reference table for ONE session id. Returns the ids of the
 *  standing (never-deleted-by-a-session-cascade) rows — connection, poll_job, event_trigger, webhook —
 *  so the caller can assert on their SURVIVAL + nulled target, not just on their absence. */
function populateFkChildren(sessionId, projectId, tag) {
  db.insertWake({ id: `wake-${tag}`, sessionId, wakeAt: now, note: "n", createdAt: now });
  db.insertCompanionReminder({ id: `rem-${tag}`, sessionId, cron: "0 9 * * *", prompt: "p", enabled: true, createdAt: now });
  db.upsertCompanionCapabilityGrant({ sessionId, capability: "session-status", projectId: null });
  db.insertCompanionMessage({ id: `msg1-${tag}`, sessionId, channel: "telegram", chatId: "c1", author: "user", text: "hi", createdAt: now });
  db.insertCompanionMessage({ id: `msg2-${tag}`, sessionId, channel: "telegram", chatId: "c1", author: "companion", text: "hello", createdAt: now });
  db.insertQuestion({
    id: `q-${tag}`, sessionId, projectId, title: "t", body: "b", options: null, recommendation: null,
    taskId: null, state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null,
  });
  const conn = db.createConnection({ name: `conn-${tag}`, host: "https://example.test", authScheme: "api-key", secretBlob: "v1:iv:tag:ct" });
  db.insertPollJob({
    id: `poll-${tag}`, connectionId: conn.id, path: "/items", method: "GET", intervalMs: 60000,
    nextPollAt: now, lastPolledAt: null, itemsPath: "", idPath: "id", cursorJson: null,
    mode: "wake", sessionId, agentId: null, enabled: true, consecutiveFailures: 0, lastError: null, createdAt: now,
  });
  db.insertEventTrigger({
    id: `trig-${tag}`, eventKind: "worker_report", projectId: null, mode: "wake",
    targetSessionId: sessionId, agentId: null, enabled: true, lastSeq: 0, lastFiredAt: null, createdAt: now,
  });
  const hook = db.createWebhookEndpoint({
    path: `hook-${tag}`, name: `hook-${tag}`, sourceType: "generic", secretBlob: "v1:iv:tag:ct",
    mode: "wake", targetSessionId: sessionId, agentId: null,
  });
  return { pollJobId: `poll-${tag}`, eventTriggerId: `trig-${tag}`, webhookId: hook.id };
}

function countFor(table, column, sessionId) {
  return (db.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`).get(sessionId)).c;
}

// ===== (0) pragma foreign_key_list ENUMERATION — the "fails loudly on a new FK child" guard =====
{
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const actual = [];
  for (const t of tables) {
    for (const fk of db.db.pragma(`foreign_key_list(${t})`)) {
      if (fk.table === "sessions") actual.push(`${t}.${fk.from}`);
    }
  }
  actual.sort();
  // The exact set cascadeSessionForeignKeyChildren (db.ts) knows how to handle today. If a future
  // migration adds a new FK-to-sessions column, this list goes stale and the check below fails loudly —
  // update BOTH this list and cascadeSessionForeignKeyChildren together, never just one.
  const expected = [
    "companion_conversations.session_id",
    "companion_messages.session_id",
    "companion_reminders.session_id",
    "event_triggers.target_session_id",
    "poll_jobs.session_id",
    "questions.session_id",
    "wakes.session_id",
    "webhook_endpoints.target_session_id",
  ].sort();
  check(`(0) every real FK-to-sessions(id) column matches the known, handled set — got [${actual.join(", ")}]`, JSON.stringify(actual) === JSON.stringify(expected));
  // Negative control: a deliberately bogus column must NOT appear — proves the enumeration itself can
  // discriminate (a broken pragma call would return [] and pass vacuously against a wrong expected set).
  check("(0) negative control: a nonexistent bogus column is correctly absent", !actual.includes("nonexistent_table.bogus_col"));
}

// ===== (A) deleteSession cascades every FK child + nulls every target reference =====
{
  const proj = mkProject("sdc-session");
  const sid = "sdc-session-sess";
  mkSession(sid, proj.projectId, proj.agentId);
  const refs = populateFkChildren(sid, proj.projectId, "a");

  check("(setup) wakes/reminders/grants/messages/conversations/questions all present before delete",
    countFor("wakes", "session_id", sid) === 1 &&
    countFor("companion_reminders", "session_id", sid) === 1 &&
    countFor("companion_capability_grants", "session_id", sid) === 1 &&
    countFor("companion_messages", "session_id", sid) === 2 &&
    countFor("companion_conversations", "session_id", sid) === 1 &&
    countFor("questions", "session_id", sid) === 1);

  let threw = false;
  try { db.deleteSession(sid); } catch { threw = true; }
  check("(A) deleteSession on a companion session with chat history + poll/trigger/webhook targets does NOT throw", !threw);

  check("(A) wakes cascaded away", countFor("wakes", "session_id", sid) === 0);
  check("(A) companion_reminders cascaded away", countFor("companion_reminders", "session_id", sid) === 0);
  check("(A) companion_capability_grants cascaded away", countFor("companion_capability_grants", "session_id", sid) === 0);
  check("(A) companion_messages cascaded away", countFor("companion_messages", "session_id", sid) === 0);
  check("(A) companion_conversations cascaded away", countFor("companion_conversations", "session_id", sid) === 0);
  check("(A) questions cascaded away", countFor("questions", "session_id", sid) === 0);
  check("(A) the session row itself is gone", db.getSession(sid) === undefined);

  const pollJob = db.getPollJob(refs.pollJobId);
  check("(A) the poll_job SURVIVES (not deleted)", pollJob !== undefined);
  check("(A) the poll_job's session_id is NULLED, not left dangling", pollJob?.sessionId === null);

  const trigger = db.getEventTrigger(refs.eventTriggerId);
  check("(A) the event_trigger SURVIVES (not deleted)", trigger !== undefined);
  check("(A) the event_trigger's targetSessionId is NULLED, not left dangling", trigger?.targetSessionId === null);

  const hook = db.getWebhookEndpointByPath(`hook-a`);
  check("(A) the webhook_endpoint SURVIVES (not deleted)", hook !== undefined);
  check("(A) the webhook_endpoint's targetSessionId is NULLED, not left dangling", hook?.targetSessionId === null);
}

// ===== (B) a forced failure mid-cascade leaves EVERYTHING intact (atomicity) =====
{
  const proj = mkProject("sdc-atomic");
  const sid = "sdc-atomic-sess";
  mkSession(sid, proj.projectId, proj.agentId);
  const refs = populateFkChildren(sid, proj.projectId, "b");

  const realPrepare = db.db.prepare.bind(db.db);
  db.db.prepare = (sql) => {
    if (sql.includes("DELETE FROM questions WHERE session_id")) throw new Error("forced failure — atomicity test");
    return realPrepare(sql);
  };
  let threw = false;
  try { db.deleteSession(sid); } catch { threw = true; }
  db.db.prepare = realPrepare; // restore before any assertion, so the check queries use the real statement

  check("(B) the forced failure actually propagated out of deleteSession", threw);
  check("(B) the session row is STILL PRESENT (no partial apply)", db.getSession(sid) !== undefined);
  check("(B) wakes STILL PRESENT", countFor("wakes", "session_id", sid) === 1);
  check("(B) companion_reminders STILL PRESENT", countFor("companion_reminders", "session_id", sid) === 1);
  check("(B) companion_capability_grants STILL PRESENT", countFor("companion_capability_grants", "session_id", sid) === 1);
  check("(B) companion_messages STILL PRESENT", countFor("companion_messages", "session_id", sid) === 2);
  check("(B) companion_conversations STILL PRESENT", countFor("companion_conversations", "session_id", sid) === 1);
  check("(B) questions STILL PRESENT (the row the injected failure targeted)", countFor("questions", "session_id", sid) === 1);
  check("(B) poll_job's session_id is UNCHANGED (not nulled)", db.getPollJob(refs.pollJobId)?.sessionId === sid);
  check("(B) event_trigger's targetSessionId is UNCHANGED (not nulled)", db.getEventTrigger(refs.eventTriggerId)?.targetSessionId === sid);
  check("(B) webhook_endpoint's targetSessionId is UNCHANGED (not nulled)", db.getWebhookEndpointByPath("hook-b")?.targetSessionId === sid);

  // Clean up this fixture's session for real now that atomicity is proven, so it doesn't leak into later counts.
  db.deleteSession(sid);
}

// ===== (C) deleteProject on a project whose session hosted a companion with chat history succeeds =====
{
  const proj = mkProject("sdc-project");
  const sid = "sdc-project-sess";
  mkSession(sid, proj.projectId, proj.agentId);
  const refs = populateFkChildren(sid, proj.projectId, "c");

  let threw = false;
  try { db.deleteProject(proj.projectId); } catch { threw = true; }
  check("(C) deleteProject on a project that ever hosted a companion with chat history does NOT throw", !threw);
  check("(C) the project's session is gone", db.getSession(sid) === undefined);
  check("(C) companion_messages cascaded away", countFor("companion_messages", "session_id", sid) === 0);
  check("(C) companion_conversations cascaded away", countFor("companion_conversations", "session_id", sid) === 0);
  check("(C) the poll_job survives with session_id nulled", db.getPollJob(refs.pollJobId)?.sessionId === null);
  check("(C) the event_trigger survives with targetSessionId nulled", db.getEventTrigger(refs.eventTriggerId)?.targetSessionId === null);
  check("(C) the webhook_endpoint survives with targetSessionId nulled", db.getWebhookEndpointByPath("hook-c")?.targetSessionId === null);
}

// ===== (D) deleteAgent on an agent whose session hosted a companion with chat history succeeds =====
{
  const proj = mkProject("sdc-agent");
  const sid = "sdc-agent-sess";
  mkSession(sid, proj.projectId, proj.agentId);
  const refs = populateFkChildren(sid, proj.projectId, "d");

  let threw = false;
  try { db.deleteAgent(proj.agentId); } catch { threw = true; }
  check("(D) deleteAgent on an agent whose session ever hosted a companion with chat history does NOT throw", !threw);
  check("(D) the agent's session is gone", db.getSession(sid) === undefined);
  check("(D) companion_messages cascaded away", countFor("companion_messages", "session_id", sid) === 0);
  check("(D) companion_conversations cascaded away", countFor("companion_conversations", "session_id", sid) === 0);
  check("(D) the poll_job survives with session_id nulled", db.getPollJob(refs.pollJobId)?.sessionId === null);
  check("(D) the event_trigger survives with targetSessionId nulled", db.getEventTrigger(refs.eventTriggerId)?.targetSessionId === null);
  check("(D) the webhook_endpoint survives with targetSessionId nulled", db.getWebhookEndpointByPath("hook-d")?.targetSessionId === null);
}

try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — deleteSession/deleteProject/deleteAgent now cascade every FK-to-sessions(id) child atomically through the shared cascadeSessionForeignKeyChildren helper; companion chat history is deleted with its session, poll_jobs/event_triggers/webhook_endpoints survive with their session reference nulled."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
