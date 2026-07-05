import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the human-only REST surface for the companion's CHAT HISTORY (bug 0f01f234): GET (list,
// read-only) over the `companion_messages` rows the in-app inbound/outbound record hooks write
// (controller.ts / in-app.ts) — the sibling of companion-reminders-rest.mjs / companion-memory-rest.mjs's
// VIEW-only surfaces. Fully hermetic: a temp LOOM_HOME + a REAL Db + the REAL buildServer (app.inject) with
// pty/sessions/etc. stubbed out (this route never touches a live pty). NO network, NO real claude, NO daemon.
// Proves:
//   1. GET returns the session's in-app messages chronologically as {id,sessionId,channel,chatId,author,text,createdAt}.
//   2. Scoped to the IN-APP channel only — a row seeded on a different channel for the SAME session is excluded.
//   3. Per-session isolation — another companion's messages never leak into this one's list.
//   4. resolveCompanionAgent guards: 404 on an unknown session, 400 on a non-assistant (worker) session.
// Run: 1) build (turbo builds shared first), 2) node test/companion-messages-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-messages-rest-${Date.now()}-${process.pid}`);
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
db.insertProject({ id: projId, name: "Messages REST", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });

const companionAgentId = randomUUID();
db.insertAgent({ id: companionAgentId, projectId: projId, name: "Companion", startupPrompt: "MY_PERSONA", position: 0, profileId: null, endpoint: false, ioSchema: null });
const companionSessId = randomUUID();
db.insertSession({
  id: companionSessId, projectId: projId, agentId: companionAgentId, engineSessionId: "eng-companion", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});

// A second companion session, to prove per-session isolation.
const otherAgentId = randomUUID();
db.insertAgent({ id: otherAgentId, projectId: projId, name: "Companion 2", startupPrompt: "OTHER_PERSONA", position: 1, profileId: null, endpoint: false, ioSchema: null });
const otherSessId = randomUUID();
db.insertSession({
  id: otherSessId, projectId: projId, agentId: otherAgentId, engineSessionId: "eng-companion-2", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});

// A non-assistant (worker) session, to prove the route refuses a companion-shaped request on the wrong role.
const workerAgentId = randomUUID();
db.insertAgent({ id: workerAgentId, projectId: projId, name: "Worker", startupPrompt: "WORKER_PROMPT", position: 2, profileId: null, endpoint: false, ioSchema: null });
const workerSessId = randomUUID();
db.insertSession({
  id: workerSessId, projectId: projId, agentId: workerAgentId, engineSessionId: "eng-worker", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
});

const UNKNOWN_SESSION = randomUUID();

// Seed messages directly through the db (mirrors what the record hooks write — this REST surface never
// creates), chronological on the companion session, plus one on a DIFFERENT channel (must be excluded) and
// one belonging to the OTHER companion (must be excluded — isolation).
db.insertCompanionMessage({ id: randomUUID(), sessionId: companionSessId, channel: "in-app", chatId: companionSessId, author: "user", text: "hi there", createdAt: "2026-07-06T10:00:00.000Z" });
db.insertCompanionMessage({ id: randomUUID(), sessionId: companionSessId, channel: "in-app", chatId: companionSessId, author: "companion", text: "hello!", createdAt: "2026-07-06T10:00:01.000Z" });
db.insertCompanionMessage({ id: randomUUID(), sessionId: companionSessId, channel: "telegram", chatId: "123", author: "user", text: "a telegram row on the SAME session", createdAt: "2026-07-06T10:00:02.000Z" });
db.insertCompanionMessage({ id: randomUUID(), sessionId: otherSessId, channel: "in-app", chatId: otherSessId, author: "user", text: "belongs to the other companion", createdAt: "2026-07-06T10:00:03.000Z" });

try {
  // ============ MESSAGES: GET (list) ============
  {
    const res = await app.inject({ method: "GET", url: `/api/companion/messages/${companionSessId}` });
    const body = JSON.parse(res.payload);
    check("messages GET: 200", res.statusCode === 200);
    check("messages GET: returns exactly the two in-app rows, chronological", body.messages.length === 2 && body.messages[0].text === "hi there" && body.messages[1].text === "hello!");
    check("messages GET: shape is {id,sessionId,channel,chatId,author,text,createdAt}", typeof body.messages[0].id === "string" && body.messages[0].sessionId === companionSessId && body.messages[0].channel === "in-app" && body.messages[0].chatId === companionSessId && body.messages[0].author === "user" && typeof body.messages[0].createdAt === "string");
    check("messages GET: the telegram-channel row on the SAME session is excluded (in-app only)", !body.messages.some((m) => m.text.includes("telegram")));
    check("messages GET: the OTHER companion's message is excluded (isolation)", !body.messages.some((m) => m.text.includes("other companion")));
  }
  // ============ MESSAGES: resolve-by-sessionId guards ============
  {
    const notFound = await app.inject({ method: "GET", url: `/api/companion/messages/${UNKNOWN_SESSION}` });
    check("messages GET: unknown sessionId → 404", notFound.statusCode === 404);

    const wrongRole = await app.inject({ method: "GET", url: `/api/companion/messages/${workerSessId}` });
    check("messages GET: a non-assistant (worker) session → 400, not silently served", wrongRole.statusCode === 400);

    const empty = await app.inject({ method: "GET", url: `/api/companion/messages/${otherSessId}` });
    const emptyBody = JSON.parse(empty.payload);
    check("messages GET: a companion with no telegram history still 200s with just its in-app row", empty.statusCode === 200 && emptyBody.messages.length === 1 && emptyBody.messages[0].text === "belongs to the other companion");
  }
} finally {
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the companion's chat history is served over human-only REST (GET, in-app-only, chronological), resolved by sessionId, 404/400 on an unknown or non-assistant session, per-session and per-channel isolated — human-only, claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
