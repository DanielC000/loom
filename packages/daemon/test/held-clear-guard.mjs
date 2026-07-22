import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Held-clear tamper resistance (card 9b0373c0, Platform-Audit finding bb23d15a, PINNED P1).
//
// The bug: `held` — the owner's SOLE brake in Loom's autonomy model — was freely CLEARABLE by ANY agent
// session (workers included) via tasks_update({held:false})/project_task_update({held:false}), with no
// set-vs-clear asymmetry, no provenance, and no audit event. A wayward or prompt-injected manager could
// un-brake a human-parked card and immediately worker_spawn it.
//
// The fix: a `held_by` ('human'|'agent'|NULL) provenance column, stamped SERVER-SIDE only (never a
// client-suppliable field on any agent tool's zod schema). Agents may SET held:true freely; CLEARING is
// refused at the ONE agent-facing choke point (`updateProjectTask`, mcp/tasks.ts — shared by the
// in-project `tasks_update` AND the Platform Lead's cross-project `project_task_update`, which gets NO
// exemption — owner decision) whenever the card is currently `heldBy:"human"`. The human-only REST route
// (POST /api/tasks/:id) is always authoritative. A `task_held_cleared` orchestration event fires on every
// real clear, agent or human.
//
// Part A — SCHEMA/MIGRATION RIGOR (owner-required, per a hard Loom lesson: a migration must be exercised
// against a REAL pre-migration snapshot, not just a fresh DB, which is blind to "does an existing held=1
// row backfill correctly" and to any SCHEMA statement referencing a migration-added column too early).
// Synthesizes a REAL pre-`held_by` `tasks` table directly with better-sqlite3 (mirroring db-legacy-boot.mjs's
// method), with a genuine held=1 row already in it, then constructs a real `Db` against it and proves:
//   (1) the constructor does NOT throw against the legacy shape.
//   (2) `held_by` exists on `tasks` post-construct.
//   (3) the PRE-EXISTING held=1 row backfills to held_by='human' (not left NULL/agent-clearable).
//   (4) a held=0 row is left held_by=NULL (the backfill only touches held=1 rows).
//   (5) idempotent: closing and re-opening a SECOND `Db` against the SAME file does not throw and does
//       not re-touch the already-backfilled value.
//
// Part B — enforcement (updateProjectTask, the shared agent choke point), against a fresh DB:
//   (6) an agent sets held:true → heldBy stamps "agent".
//   (7) an agent clears its OWN agent-set hold → succeeds; held_by resets to NULL; a task_held_cleared
//       event is appended (clearedBy:"agent").
//   (8) a human-set hold (heldBy:"human", simulating the REST stamp) is REFUSED when an agent tries to
//       clear it — {error}, nothing written, held stays true, held_by stays "human".
//   (9) that refusal is a WHOLE-PATCH reject — an accompanying priority change in the SAME patch is also
//       dropped, not partially applied.
//  (10) no silent downgrade: an agent re-setting held:true on an already-human-held card does NOT
//       reclassify its provenance to "agent" (closes the "refresh-then-clear" gap) — and the card is
//       STILL refused on a subsequent clear attempt.
//
// Part C — the human-only REST route (POST /api/tasks/:id, via a real fastify app.inject, mirroring
// task-delete.mjs's pattern) is always authoritative regardless of held_by:
//  (11) held:true via REST stamps heldBy="human".
//  (12) held:false via REST on a human-held card SUCCEEDS (the agent guard never applies here) and a
//       task_held_cleared event is appended (clearedBy:"human", managerSessionId:"").
//  (13) a REST-created human hold is STILL refused via the agent path (cross-check the two paths agree).
//
// Run: 1) build (turbo builds shared first), 2) node test/held-clear-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-held-clear-guard-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { createProjectTask, updateProjectTask } = await import("../dist/mcp/tasks.js");
const { buildServer } = await import("../dist/gateway/server.js");

// ════════════════════════════ Part A — schema/migration rigor ════════════════════════════
const legacyFile = path.join(tmpHome, "legacy-tasks.db");
const legacyProjId = randomUUID();
const heldCardId = randomUUID();
const unheldCardId = randomUUID();
const now = new Date().toISOString();

{
  const raw = new Database(legacyFile);
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
    -- The true pre-9b0373c0 shape: no held_by column at all.
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      column_key TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'p2',
      held INTEGER NOT NULL DEFAULT 0,
      deferred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  raw.prepare("INSERT INTO projects (id, name, repo_path, vault_path, config_json, created_at, archived_at) VALUES (?, ?, ?, ?, '{}', ?, NULL)")
    .run(legacyProjId, "Legacy Project", legacyProjId, legacyProjId, now);
  raw.prepare(
    "INSERT INTO tasks (id, project_id, title, body, column_key, position, priority, held, deferred, created_at, updated_at) " +
      "VALUES (?, ?, 'a pre-existing held card', '', 'backlog', 1, 'p2', 1, 0, ?, ?)",
  ).run(heldCardId, legacyProjId, now, now);
  raw.prepare(
    "INSERT INTO tasks (id, project_id, title, body, column_key, position, priority, held, deferred, created_at, updated_at) " +
      "VALUES (?, ?, 'an ordinary unheld card', '', 'backlog', 2, 'p2', 0, 0, ?, ?)",
  ).run(unheldCardId, legacyProjId, now, now);
  raw.close();
}

let legacyDb;
try {
  let ctorError = null;
  try {
    legacyDb = new Db(legacyFile);
  } catch (err) {
    ctorError = err;
  }
  check("(1) constructing Db against a legacy pre-held_by tasks table does not throw", ctorError === null);
  if (ctorError) console.log(`    threw: ${ctorError?.stack || ctorError}`);

  if (!ctorError) {
    const rawCheck = new Database(legacyFile, { readonly: true });
    try {
      const cols = new Set(rawCheck.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name));
      check("(2) tasks gained the held_by column", cols.has("held_by"));
    } finally {
      rawCheck.close();
    }

    const heldCard = legacyDb.getTask(heldCardId);
    check("(3) the pre-existing held=1 row backfilled to held_by='human'", heldCard.held === true && heldCard.heldBy === "human");

    const unheldCard = legacyDb.getTask(unheldCardId);
    check("(4) a held=0 row is left held_by=NULL (backfill only touches held=1 rows)", unheldCard.held === false && (unheldCard.heldBy === null || unheldCard.heldBy === undefined));

    legacyDb.close();
    // (5) idempotent re-run: a SECOND Db against the same (now-migrated) file must not throw and must
    // not re-touch the already-backfilled value.
    let secondCtorError = null;
    let db2;
    try {
      db2 = new Db(legacyFile);
    } catch (err) {
      secondCtorError = err;
    }
    check("(5) re-opening a Db against the already-migrated file does not throw", secondCtorError === null);
    if (db2) {
      check("(5) the backfilled value is unchanged on re-open", db2.getTask(heldCardId).heldBy === "human");
      db2.close();
    }
  }
} finally {
  // legacyDb/db2 already closed above in the success path; best-effort in case of an early throw.
}

// ════════════════════════════ Part B — agent-path enforcement (fresh DB) ════════════════════════════
const file = path.join(tmpHome, "held-clear-guard.db");
const db = new Db(file);
const AGENT_SESSION_A = "agentSessA";
const AGENT_SESSION_B = "agentSessB";

try {
  db.insertProject({ id: "projH", name: "Held", repoPath: "C:/h", vaultPath: "C:/h", config: {}, createdAt: now, archivedAt: null, reserved: false });

  // ── (6)+(7): agent sets its own hold, then clears it ──
  const card1 = createProjectTask(db, "projH", { title: "fix(x): agent-managed card" });
  const set1 = await updateProjectTask(db, "projH", card1.id, { held: true }, { sessionId: AGENT_SESSION_A });
  check("(6) agent held:true — no error", !set1.error);
  check("(6) agent held:true — heldBy stamps 'agent'", set1.heldBy === "agent");
  check("(6) agent held:true — persisted", db.getTask(card1.id).held === true && db.getTask(card1.id).heldBy === "agent");

  const clear1 = await updateProjectTask(db, "projH", card1.id, { held: false }, { sessionId: AGENT_SESSION_A });
  check("(7) agent clearing its OWN agent-set hold succeeds — no error", !clear1.error);
  check("(7) agent-set-then-agent-clear — persisted held=false, heldBy=null", db.getTask(card1.id).held === false && (db.getTask(card1.id).heldBy === null || db.getTask(card1.id).heldBy === undefined));

  const eventsA = db.listEvents(AGENT_SESSION_A);
  const clearEvent = eventsA.find((e) => e.kind === "task_held_cleared");
  check("(7) a task_held_cleared event was appended for the agent clear", !!clearEvent && clearEvent.detail?.clearedBy === "agent" && clearEvent.taskId === card1.id);

  // ── (8): a human-set hold cannot be cleared by an agent ──
  const card2 = createProjectTask(db, "projH", { title: "fix(x): human-parked card" });
  db.updateTask(card2.id, { held: true, heldBy: "human" }); // stand-in for the REST stamp (Part C proves the real route)
  check("(8) setup: card2 is human-held", db.getTask(card2.id).held === true && db.getTask(card2.id).heldBy === "human");

  const refusedClear = await updateProjectTask(db, "projH", card2.id, { held: false }, { sessionId: AGENT_SESSION_B });
  check("(8) agent clearing a HUMAN-set hold is REFUSED — returns an error", typeof refusedClear.error === "string");
  check("(8) the refusal did NOT write — held stays true, heldBy stays 'human'", db.getTask(card2.id).held === true && db.getTask(card2.id).heldBy === "human");

  const eventsBAfterRefusal = db.listEvents(AGENT_SESSION_B);
  check("(8) no task_held_cleared event was emitted for the refused attempt", !eventsBAfterRefusal.some((e) => e.kind === "task_held_cleared"));

  // ── (9): the refusal is a WHOLE-PATCH reject — an accompanying field change is also dropped ──
  const priorityBefore = db.getTask(card2.id).priority;
  const refusedWithPriority = await updateProjectTask(db, "projH", card2.id, { held: false, priority: "p0" }, { sessionId: AGENT_SESSION_B });
  check("(9) a held:false + priority patch on a human-held card is ALSO refused", typeof refusedWithPriority.error === "string");
  check("(9) the accompanying priority change was NOT partially applied", db.getTask(card2.id).priority === priorityBefore);

  // ── (10): no silent downgrade — re-setting held:true on a human-held card keeps heldBy='human' ──
  const reset = await updateProjectTask(db, "projH", card2.id, { held: true }, { sessionId: AGENT_SESSION_B });
  check("(10) agent re-setting held:true on an already-human-held card — no error", !reset.error);
  check("(10) provenance is NOT downgraded to 'agent'", db.getTask(card2.id).heldBy === "human");

  const stillRefused = await updateProjectTask(db, "projH", card2.id, { held: false }, { sessionId: AGENT_SESSION_B });
  check("(10) the card is STILL refused on a subsequent clear (the downgrade gap stays closed)", typeof stillRefused.error === "string");
  check("(10) still human-held in the DB", db.getTask(card2.id).held === true && db.getTask(card2.id).heldBy === "human");
} finally {
  // db stays open — Part C reuses it below.
}

// ════════════════════════════ Part C — the human-only REST route ════════════════════════════
process.env.LOOM_PORT = "45420";
const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

try {
  const card3 = createProjectTask(db, "projH", { title: "fix(x): REST-managed card" });

  const setResp = await app.inject({ method: "POST", url: `/api/tasks/${card3.id}`, payload: { held: true } });
  check("(11) REST held:true — 200 ok", setResp.statusCode === 200 && JSON.parse(setResp.body).ok === true);
  check("(11) REST held:true stamps heldBy='human'", db.getTask(card3.id).held === true && db.getTask(card3.id).heldBy === "human");

  const clearResp = await app.inject({ method: "POST", url: `/api/tasks/${card3.id}`, payload: { held: false } });
  check("(12) REST held:false on a human-held card SUCCEEDS (human authority)", clearResp.statusCode === 200 && JSON.parse(clearResp.body).ok === true);
  check("(12) persisted: held=false, heldBy reset to null", db.getTask(card3.id).held === false && (db.getTask(card3.id).heldBy === null || db.getTask(card3.id).heldBy === undefined));

  const restEvents = db.listEvents("");
  const restClearEvent = restEvents.find((e) => e.kind === "task_held_cleared" && e.taskId === card3.id);
  check("(12) a task_held_cleared event was appended for the REST clear (clearedBy:'human')", !!restClearEvent && restClearEvent.detail?.clearedBy === "human");

  // ── (13): cross-check — a REST-created human hold is STILL refused via the agent path ──
  const setResp2 = await app.inject({ method: "POST", url: `/api/tasks/${card3.id}`, payload: { held: true } });
  check("(13) setup: card3 human-held again via REST", setResp2.statusCode === 200 && db.getTask(card3.id).heldBy === "human");
  const crossCheck = await updateProjectTask(db, "projH", card3.id, { held: false }, { sessionId: AGENT_SESSION_A });
  check("(13) the agent path still refuses a REST-created human hold", typeof crossCheck.error === "string");
  check("(13) still held in the DB", db.getTask(card3.id).held === true && db.getTask(card3.id).heldBy === "human");

  // ── (14): Code Reviewer catch — a bare {heldBy:"agent"} POST with NO `held` key must NOT forge
  // provenance. card3 is still held:true/heldBy:"human" from (13). heldBy is stripped server-side before
  // any use on this route (gateway/server.ts), so this must be a complete no-op on provenance. ──
  const forgeAttempt = await app.inject({ method: "POST", url: `/api/tasks/${card3.id}`, payload: { heldBy: "agent" } });
  check("(14) a bare heldBy:'agent' POST (no held key) — 200 ok (a harmless no-op write)", forgeAttempt.statusCode === 200 && JSON.parse(forgeAttempt.body).ok === true);
  check("(14) provenance was NOT forged — held stays true, heldBy stays 'human'", db.getTask(card3.id).held === true && db.getTask(card3.id).heldBy === "human");
  const stillRefusedAfterForgeAttempt = await updateProjectTask(db, "projH", card3.id, { held: false }, { sessionId: AGENT_SESSION_A });
  check("(14) a subsequent agent held:false clear is STILL refused", typeof stillRefusedAfterForgeAttempt.error === "string");
  check("(14) still held in the DB after the refused clear", db.getTask(card3.id).held === true && db.getTask(card3.id).heldBy === "human");
} finally {
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — held_by provenance backfills correctly against a REAL pre-migration DB (idempotent re-run included); an agent may set held:true freely but clearing a human-set hold is refused (whole-patch, no silent downgrade) at the shared updateProjectTask choke point; an agent-set-then-agent-clear still works and audits via task_held_cleared; and the human-only REST route stays fully authoritative in both directions."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
