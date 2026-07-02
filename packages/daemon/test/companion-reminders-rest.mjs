import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the human-only REST surface for the companion's RECURRING reminders (Companion Memory
// & Reminders Design, Surface 2 s5a): GET (list) + DELETE over the SAME `companion_reminders` rows the s3
// watcher (companion/reminders.ts) fires and the s4 MCP tool authors — the sibling of
// companion-memory-rest.mjs's MEMORY surface, same trust posture (REST-only review + prune, no
// author/write path here). Fully hermetic: a temp LOOM_HOME + a REAL Db + the REAL buildServer
// (app.inject) with pty/sessions/etc. stubbed out (these routes never touch a live pty). NO network, NO
// real claude, NO daemon. Proves:
//   1. GET (list) returns each row as {id, cron, prompt, label, enabled, createdAt, nextFireAt}.
//   2. The routes resolve "the companion" by sessionId: 404 on an unknown session, 400 on a session that
//      isn't role:"assistant" (a worker/manager session is refused, not silently served).
//   3. DELETE removes the row (and it drops out of the watcher's own listEnabledCompanionReminders query —
//      no controller rearm needed, since the watcher re-reads that query fresh every tick).
//   4. An unknown/other-session reminder id 404s on DELETE (per-session isolation — never delete another
//      session's reminder).
// Run: 1) build (turbo builds shared first), 2) node test/companion-reminders-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-reminders-rest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);
const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

const now = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Reminders REST", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });

const companionAgentId = randomUUID();
db.insertAgent({ id: companionAgentId, projectId: projId, name: "Companion", startupPrompt: "MY_PERSONA", position: 0, profileId: null, endpoint: false, ioSchema: null });
const companionSessId = randomUUID();
db.insertSession({
  id: companionSessId, projectId: projId, agentId: companionAgentId, engineSessionId: "eng-companion", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});

// A second companion session, to prove per-session isolation of the reminders.
const otherAgentId = randomUUID();
db.insertAgent({ id: otherAgentId, projectId: projId, name: "Companion 2", startupPrompt: "OTHER_PERSONA", position: 1, profileId: null, endpoint: false, ioSchema: null });
const otherSessId = randomUUID();
db.insertSession({
  id: otherSessId, projectId: projId, agentId: otherAgentId, engineSessionId: "eng-companion-2", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});

// A non-assistant (worker) session, to prove the routes refuse a companion-shaped request on the wrong role.
const workerAgentId = randomUUID();
db.insertAgent({ id: workerAgentId, projectId: projId, name: "Worker", startupPrompt: "WORKER_PROMPT", position: 2, profileId: null, endpoint: false, ioSchema: null });
const workerSessId = randomUUID();
db.insertSession({
  id: workerSessId, projectId: projId, agentId: workerAgentId, engineSessionId: "eng-worker", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
});

const UNKNOWN_SESSION = randomUUID();

// Seed reminders directly through the db (mirrors what the s4 MCP tool authors — this REST surface never
// creates), one on each companion session so cross-session isolation is provable.
const reminderId = randomUUID();
db.insertCompanionReminder({
  id: reminderId, sessionId: companionSessId, cron: "0 9 * * *", prompt: "morning check-in",
  label: "Morning", route: null, enabled: true, createdAt: now,
});
const disabledReminderId = randomUUID();
db.insertCompanionReminder({
  id: disabledReminderId, sessionId: companionSessId, cron: "0 18 * * *", prompt: "evening check-in",
  label: null, route: null, enabled: false, createdAt: now,
});
const otherReminderId = randomUUID();
db.insertCompanionReminder({
  id: otherReminderId, sessionId: otherSessId, cron: "0 9 * * *", prompt: "belongs to the other companion",
  label: null, route: null, enabled: true, createdAt: now,
});
// A row with a corrupt cron (should never happen — create-time validation is s4's concern), to prove the
// server's nextFireAt try/catch degrades to null instead of 500ing the whole list.
const corruptCronReminderId = randomUUID();
db.insertCompanionReminder({
  id: corruptCronReminderId, sessionId: companionSessId, cron: "not-a-cron", prompt: "broken cron",
  label: null, route: null, enabled: true, createdAt: now,
});

try {
  // ============ REMINDERS: GET (list) ============
  {
    const res = await app.inject({ method: "GET", url: `/api/companion/reminders/${companionSessId}` });
    const body = JSON.parse(res.payload);
    check("reminders GET: 200", res.statusCode === 200);
    check("reminders GET: includes the seeded enabled reminder as {id,cron,prompt,label,enabled,createdAt,nextFireAt}",
      body.reminders.some((r) => r.id === reminderId && r.cron === "0 9 * * *" && r.prompt === "morning check-in" && r.label === "Morning" && r.enabled === true && r.createdAt === now && typeof r.nextFireAt === "string"));
    check("reminders GET: includes the seeded disabled reminder (list is ANY enabled state, not just the watcher's work set)",
      body.reminders.some((r) => r.id === disabledReminderId && r.enabled === false));
    check("reminders GET: does NOT include the other companion's reminder (isolation)",
      !body.reminders.some((r) => r.id === otherReminderId));
    check("reminders GET: a row with a corrupt cron degrades nextFireAt to null instead of 500ing the list",
      res.statusCode === 200 && body.reminders.some((r) => r.id === corruptCronReminderId && r.nextFireAt === null));
  }
  // ============ REMINDERS: DELETE ============
  {
    const res = await app.inject({ method: "DELETE", url: `/api/companion/reminders/${companionSessId}/${reminderId}` });
    const body = JSON.parse(res.payload);
    check("reminders DELETE: 200", res.statusCode === 200 && body.ok === true);
    check("reminders DELETE: removed from the returned list", !body.reminders.some((r) => r.id === reminderId));
    check("reminders DELETE: removed from the db itself", db.getCompanionReminder(reminderId) === undefined);
    check("reminders DELETE: also gone from the watcher's own enabled-reminders query (no controller rearm needed)",
      !db.listEnabledCompanionReminders(companionSessId).some((r) => r.id === reminderId));

    const deleteMissing = await app.inject({ method: "DELETE", url: `/api/companion/reminders/${companionSessId}/${reminderId}` });
    check("reminders DELETE: an already-gone id → 404", deleteMissing.statusCode === 404);

    check("reminders DELETE: the other companion's reminder is untouched (isolation)",
      db.getCompanionReminder(otherReminderId) !== undefined);

    const crossSessionDelete = await app.inject({ method: "DELETE", url: `/api/companion/reminders/${companionSessId}/${otherReminderId}` });
    check("reminders DELETE: another companion's reminder id → 404 (isolation, never cross-session delete)", crossSessionDelete.statusCode === 404);
    check("reminders DELETE: the other companion's reminder really wasn't deleted", db.getCompanionReminder(otherReminderId) !== undefined);
  }
  // ============ REMINDERS: resolve-by-sessionId guards ============
  {
    const notFound = await app.inject({ method: "GET", url: `/api/companion/reminders/${UNKNOWN_SESSION}` });
    check("reminders GET: unknown sessionId → 404", notFound.statusCode === 404);
    const notFoundDelete = await app.inject({ method: "DELETE", url: `/api/companion/reminders/${UNKNOWN_SESSION}/${otherReminderId}` });
    check("reminders DELETE: unknown sessionId → 404", notFoundDelete.statusCode === 404);

    const wrongRole = await app.inject({ method: "GET", url: `/api/companion/reminders/${workerSessId}` });
    check("reminders GET: a non-assistant (worker) session → 400, not silently served", wrongRole.statusCode === 400);
    const wrongRoleDelete = await app.inject({ method: "DELETE", url: `/api/companion/reminders/${workerSessId}/${otherReminderId}` });
    check("reminders DELETE: a non-assistant (worker) session → 400", wrongRoleDelete.statusCode === 400);
  }

} finally {
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the companion's recurring reminders are served over human-only REST (GET list, DELETE), resolved by sessionId, 404/400 on an unknown or non-assistant session, per-session isolated, delete needs no controller rearm — human-only, claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
