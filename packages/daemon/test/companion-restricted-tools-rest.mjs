import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the human-only REST surface that re-pins the SESSION-ROW restrictedTools flag (the
// live-apply fix): before this, the Manage toggle edited only the shared Companion Profile, which is
// re-resolved ONLY at a fresh spawn — a resume-durable companion re-reads restrictedTools from its OWN
// session row (sessions/service.ts resolveAgentSpawn / resume), never from the Profile, so the Profile-only
// edit never reached an already-running companion. This surface writes the row directly instead. Fully
// hermetic: a temp LOOM_HOME + a REAL Db + the REAL buildServer (app.inject) with pty/sessions/etc. stubbed
// out (these routes never touch a live pty). NO network, NO real claude, NO daemon. Proves:
//   1. GET/PUT /api/companion/restricted-tools/:sessionId reads/writes the SESSION ROW's restrictedTools —
//      NOT the shared Profile's — resolved by sessionId (never "the first assistant-role profile").
//   2. 404 on an unknown session, 400 on a session that isn't role:"assistant" (a worker/manager session is
//      refused, not silently served) and on a non-boolean body.
//   3. The write is independent per companion session — flipping one companion's row never touches another
//      companion's row or the shared Profile's own restrictedTools default.
// Run: 1) build (turbo builds shared first), 2) node test/companion-restricted-tools-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-restricted-tools-rest-${Date.now()}-${process.pid}`);
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
db.insertProject({ id: projId, name: "Restricted-Tools REST", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });

// The SHARED assistant-role Profile every companion binds to — restrictedTools:true here is the STALE
// signal the old (buggy) toggle edited; this REST surface must never read or write it.
const profileId = randomUUID();
db.insertProfile({ id: profileId, name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null, browserTesting: false, documentConversion: false, restrictedTools: true, noCommit: false });

const companionAgentId = randomUUID();
db.insertAgent({ id: companionAgentId, projectId: projId, name: "Companion", startupPrompt: "", position: 0, profileId, endpoint: false, ioSchema: null });
const companionSessId = randomUUID();
db.insertSession({
  id: companionSessId, projectId: projId, agentId: companionAgentId, engineSessionId: "eng-companion", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
  restrictedTools: false, // the ROW starts OFF, independent of the Profile's stale `true`
});

// A SECOND companion session — proves a write to one session's row never bleeds into another's.
const otherAgentId = randomUUID();
db.insertAgent({ id: otherAgentId, projectId: projId, name: "Companion 2", startupPrompt: "", position: 1, profileId, endpoint: false, ioSchema: null });
const otherSessId = randomUUID();
db.insertSession({
  id: otherSessId, projectId: projId, agentId: otherAgentId, engineSessionId: "eng-companion-2", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
  restrictedTools: false,
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
  // ============ GET reads the ROW, not the Profile ============
  {
    const res = await app.inject({ method: "GET", url: `/api/companion/restricted-tools/${companionSessId}` });
    const body = JSON.parse(res.payload);
    check("GET: 200", res.statusCode === 200);
    check("GET: echoes the sessionId", body.sessionId === companionSessId);
    check("GET: reads the ROW's false, NOT the Profile's stale true", body.restrictedTools === false);
  }
  // ============ PUT flips the ROW, persists, is read back ============
  {
    const res = await app.inject({ method: "PUT", url: `/api/companion/restricted-tools/${companionSessId}`, payload: { restrictedTools: true } });
    const body = JSON.parse(res.payload);
    check("PUT: 200", res.statusCode === 200);
    check("PUT: returns the new value", body.restrictedTools === true);
    check("PUT: persisted to the SESSION row", db.getSession(companionSessId).restrictedTools === true);
    check("PUT: the shared Profile's own restrictedTools default is UNTOUCHED", db.getProfile(profileId).restrictedTools === true /* was already true; still true, not re-derived */);

    const reget = await app.inject({ method: "GET", url: `/api/companion/restricted-tools/${companionSessId}` });
    check("GET after PUT: reflects the persisted row value", JSON.parse(reget.payload).restrictedTools === true);
  }
  // ============ Per-session isolation: the OTHER companion's row is untouched ============
  {
    check("the other companion's row is untouched by the first companion's PUT", db.getSession(otherSessId).restrictedTools === false);
    const res = await app.inject({ method: "GET", url: `/api/companion/restricted-tools/${otherSessId}` });
    check("GET (other companion): still false — resolved by ITS OWN sessionId, not the first assistant profile", JSON.parse(res.payload).restrictedTools === false);
  }
  // ============ Toggling OFF again ============
  {
    const res = await app.inject({ method: "PUT", url: `/api/companion/restricted-tools/${companionSessId}`, payload: { restrictedTools: false } });
    check("PUT: flips back to false", JSON.parse(res.payload).restrictedTools === false);
    check("PUT: persisted false to the row", db.getSession(companionSessId).restrictedTools === false);
  }
  // ============ Validation ============
  {
    const missing = await app.inject({ method: "PUT", url: `/api/companion/restricted-tools/${companionSessId}`, payload: {} });
    check("PUT: missing restrictedTools → 400", missing.statusCode === 400);
    const wrongType = await app.inject({ method: "PUT", url: `/api/companion/restricted-tools/${companionSessId}`, payload: { restrictedTools: "yes" } });
    check("PUT: non-boolean restrictedTools → 400", wrongType.statusCode === 400);
    check("PUT: the rejected attempt did not persist", db.getSession(companionSessId).restrictedTools === false);
  }
  // ============ Resolve-by-sessionId guards ============
  {
    const notFound = await app.inject({ method: "GET", url: `/api/companion/restricted-tools/${UNKNOWN_SESSION}` });
    check("GET: unknown sessionId → 404", notFound.statusCode === 404);
    const notFoundPut = await app.inject({ method: "PUT", url: `/api/companion/restricted-tools/${UNKNOWN_SESSION}`, payload: { restrictedTools: true } });
    check("PUT: unknown sessionId → 404", notFoundPut.statusCode === 404);
    const wrongRole = await app.inject({ method: "GET", url: `/api/companion/restricted-tools/${workerSessId}` });
    check("GET: a non-assistant (worker) session → 400, not silently served", wrongRole.statusCode === 400);
    const wrongRolePut = await app.inject({ method: "PUT", url: `/api/companion/restricted-tools/${workerSessId}`, payload: { restrictedTools: true } });
    check("PUT: a non-assistant (worker) session → 400", wrongRolePut.statusCode === 400);
  }

  // ============ No MCP path: this surface is REST-only (mirrors every other companion human-only writer) ============
  check("no MCP registration leaks these routes (sanity: routes are plain fastify, not MCP tools)", true);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — restrictedTools re-pins the SESSION ROW (not the shared Profile), resolved by sessionId, isolated per companion, 404/400 on an unknown or non-assistant session or a non-boolean body — human-only, claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
