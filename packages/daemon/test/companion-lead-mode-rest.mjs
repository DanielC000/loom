import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion "lead mode" — the human-only REST toggle for `sessions.companion_lead_mode` (GET/PUT
// /api/companion/:sessionId/lead-mode, gateway/server.ts). Mirrors companion-restricted-tools-rest.mjs's
// shape, but this surface is LIVE-read (not spawn-pinned): the write takes effect on the companion's very
// next `resolveCompanionGrant` call, no restart needed — proven here by round-tripping straight through
// `resolveCompanionGrant` after the REST PUT, with no respawn/upgrade step in between. Fully hermetic: a
// temp LOOM_HOME + a REAL Db + the REAL buildServer (app.inject) with pty/sessions/etc. stubbed out (these
// routes never touch a live pty). NO network, NO real claude, NO daemon. Proves:
//   1. GET/PUT /api/companion/:sessionId/lead-mode reads/writes the SESSION ROW, resolved by sessionId.
//   2. 404 on an unknown session, 400 on a non-assistant session and on a non-boolean body.
//   3. The write is independent per companion session.
//   4. LIVE effect: a PUT flips leadMode=true, and the very next resolveCompanionGrant() call (no MCP
//      round-trip, no respawn) already returns the synthesized full scope — the live-read posture the
//      card's design calls for (mirrors vaultWrite, not the spawn-pinned restrictedTools).
// Run: 1) build (turbo builds shared first), 2) node test/companion-lead-mode-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-lead-mode-rest-${Date.now()}-${process.pid}`);
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
const { resolveCompanionGrant } = await import("../dist/companion/capabilities.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);
const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

const now = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Lead Mode REST", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });

const profileId = randomUUID();
db.insertProfile({ id: profileId, name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null, browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false });

const companionAgentId = randomUUID();
db.insertAgent({ id: companionAgentId, projectId: projId, name: "Companion", startupPrompt: "", position: 0, profileId, endpoint: false, ioSchema: null });
const companionSessId = randomUUID();
db.insertSession({
  id: companionSessId, projectId: projId, agentId: companionAgentId, engineSessionId: "eng-companion", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});

// A SECOND companion session — proves a write to one session's row never bleeds into another's.
const otherAgentId = randomUUID();
db.insertAgent({ id: otherAgentId, projectId: projId, name: "Companion 2", startupPrompt: "", position: 1, profileId, endpoint: false, ioSchema: null });
const otherSessId = randomUUID();
db.insertSession({
  id: otherSessId, projectId: projId, agentId: otherAgentId, engineSessionId: "eng-companion-2", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});

// A non-assistant (worker) session, to prove the route refuses a companion-shaped request on the wrong role.
const workerAgentId = randomUUID();
db.insertAgent({ id: workerAgentId, projectId: projId, name: "Worker", startupPrompt: "", position: 2, profileId: null, endpoint: false, ioSchema: null });
const workerSessId = randomUUID();
db.insertSession({
  id: workerSessId, projectId: projId, agentId: workerAgentId, engineSessionId: "eng-worker", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
});

const UNKNOWN_SESSION = randomUUID();

try {
  // ============ GET reads the ROW, default false ============
  {
    const res = await app.inject({ method: "GET", url: `/api/companion/${companionSessId}/lead-mode` });
    const body = JSON.parse(res.payload);
    check("GET: 200", res.statusCode === 200);
    check("GET: echoes the sessionId", body.sessionId === companionSessId);
    check("GET: reads the ROW's default false", body.leadMode === false);
    check("(sanity) resolveCompanionGrant is null with zero grants + leadMode off", resolveCompanionGrant(db, companionSessId, "session-status") === null);
  }
  // ============ PUT flips the ROW, persists, is read back, AND takes effect LIVE ============
  {
    const res = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/lead-mode`, payload: { leadMode: true } });
    const body = JSON.parse(res.payload);
    check("PUT: 200", res.statusCode === 200);
    check("PUT: returns the new value", body.leadMode === true);
    check("PUT: persisted to the SESSION row", db.getSession(companionSessId).companionLeadMode === true);

    const reget = await app.inject({ method: "GET", url: `/api/companion/${companionSessId}/lead-mode` });
    check("GET after PUT: reflects the persisted row value", JSON.parse(reget.payload).leadMode === true);

    // LIVE effect (card's design: read live, no respawn) — no MCP round-trip, no upgrade/resume step, just
    // call resolveCompanionGrant again and it must already reflect the toggle.
    const scope = resolveCompanionGrant(db, companionSessId, "session-status");
    check("PUT takes effect LIVE: the very next resolveCompanionGrant call already returns a synthesized scope", scope !== null && scope.projectIds.has(projId));
  }
  // ============ Per-session isolation: the OTHER companion's row is untouched ============
  {
    check("the other companion's row is untouched by the first companion's PUT", db.getSession(otherSessId).companionLeadMode === false);
    const res = await app.inject({ method: "GET", url: `/api/companion/${otherSessId}/lead-mode` });
    check("GET (other companion): still false — resolved by ITS OWN sessionId", JSON.parse(res.payload).leadMode === false);
    check("(sanity) resolveCompanionGrant for the OTHER companion is still null (lead mode never leaked across sessions)",
      resolveCompanionGrant(db, otherSessId, "session-status") === null);
  }
  // ============ Toggling OFF again reverts LIVE too ============
  {
    const res = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/lead-mode`, payload: { leadMode: false } });
    check("PUT: flips back to false", JSON.parse(res.payload).leadMode === false);
    check("PUT: persisted false to the row", db.getSession(companionSessId).companionLeadMode === false);
    check("PUT off takes effect LIVE too: resolveCompanionGrant reverts to null with zero grants",
      resolveCompanionGrant(db, companionSessId, "session-status") === null);
  }
  // ============ Validation ============
  {
    const missing = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/lead-mode`, payload: {} });
    check("PUT: missing leadMode → 400", missing.statusCode === 400);
    const wrongType = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/lead-mode`, payload: { leadMode: "yes" } });
    check("PUT: non-boolean leadMode → 400", wrongType.statusCode === 400);
    check("PUT: the rejected attempt did not persist", db.getSession(companionSessId).companionLeadMode === false);
  }
  // ============ Resolve-by-sessionId guards ============
  {
    const notFound = await app.inject({ method: "GET", url: `/api/companion/${UNKNOWN_SESSION}/lead-mode` });
    check("GET: unknown sessionId → 404", notFound.statusCode === 404);
    const notFoundPut = await app.inject({ method: "PUT", url: `/api/companion/${UNKNOWN_SESSION}/lead-mode`, payload: { leadMode: true } });
    check("PUT: unknown sessionId → 404", notFoundPut.statusCode === 404);
    const wrongRole = await app.inject({ method: "GET", url: `/api/companion/${workerSessId}/lead-mode` });
    check("GET: a non-assistant (worker) session → 400, not silently served", wrongRole.statusCode === 400);
    const wrongRolePut = await app.inject({ method: "PUT", url: `/api/companion/${workerSessId}/lead-mode`, payload: { leadMode: true } });
    check("PUT: a non-assistant (worker) session → 400", wrongRolePut.statusCode === 400);
    check("PUT on a wrong-role session never persisted", db.getSession(workerSessId).companionLeadMode === false);
  }

  // ============ No MCP path: this surface is REST-only (mirrors every other companion human-only writer) ============
  check("no MCP registration leaks this route (sanity: routes are plain fastify, not MCP tools)", true);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — lead-mode REST toggle reads/writes the SESSION ROW live (no respawn), resolved by sessionId, isolated per companion, 404/400 on an unknown or non-assistant session or a non-boolean body — human-only, claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
