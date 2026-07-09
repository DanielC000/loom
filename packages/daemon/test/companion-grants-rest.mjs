import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework §1 — the human-only REST surface for
// companion_capability_grants (GET list / POST create / PUT update / DELETE), the ONLY writer of a grant
// (there is intentionally no MCP path — see companion-capability-grants.mjs's belt-and-suspenders check).
// Fully hermetic: a temp LOOM_HOME + a REAL Db + the REAL buildServer (app.inject), pty/sessions/etc.
// stubbed (these routes never touch a live pty). NO network, NO real claude, NO daemon. Covers the card's
// DoD (e) grants are human-REST-writable, plus REST-layer validation:
//   1. POST creates a grant (capability validated against the catalog, projectId validated to exist,
//      mode/config validated) and 201s it.
//   2. GET lists a session's grants.
//   3. PUT updates an EXISTING grant (e.g. flips read→act) and 404s when there's nothing to update.
//   4. DELETE removes a grant by (capability, projectId) and is idempotent.
//   5. The routes resolve "the companion" by sessionId: 404 on an unknown session, 400 on a session that
//      isn't role:"assistant" (mirrors every other companion REST resource).
//   6. Bad input (unknown capability slug, a non-existent projectId, an invalid mode) is rejected 400/404,
//      never silently coerced.
// Run: 1) build (turbo builds shared first), 2) node test/companion-grants-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-companion-grants-rest-${Date.now()}-${process.pid}`);
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
db.insertProject({ id: projId, name: "Grants REST", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
const otherProjId = randomUUID();
db.insertProject({ id: otherProjId, name: "Grants REST — other", repoPath: otherProjId, vaultPath: otherProjId, config: {}, createdAt: now, archivedAt: null });

const companionAgentId = randomUUID();
db.insertAgent({ id: companionAgentId, projectId: projId, name: "Companion", startupPrompt: "MY_PERSONA", position: 0, profileId: null, endpoint: false, ioSchema: null });
const companionSessId = randomUUID();
db.insertSession({
  id: companionSessId, projectId: projId, agentId: companionAgentId, engineSessionId: "eng-companion", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});

const workerAgentId = randomUUID();
db.insertAgent({ id: workerAgentId, projectId: projId, name: "Worker", startupPrompt: "WORKER_PROMPT", position: 1, profileId: null, endpoint: false, ioSchema: null });
const workerSessId = randomUUID();
db.insertSession({
  id: workerSessId, projectId: projId, agentId: workerAgentId, engineSessionId: "eng-worker", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
});

const UNKNOWN_SESSION = randomUUID();

try {
  // ============ POST: create ============
  let created;
  {
    const res = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-status" } });
    created = JSON.parse(res.payload);
    check("POST: 201", res.statusCode === 201);
    check("POST: created row carries {sessionId, capability, projectId:null, mode:'read', config:{}}",
      created.sessionId === companionSessId && created.capability === "session-status" && created.projectId === null && created.mode === "read" && JSON.stringify(created.config) === "{}");
    check("POST: the row round-trips through the db", db.listCompanionCapabilityGrantsForSession(companionSessId).length === 1);
  }
  // ============ POST: validation ============
  {
    const badCap = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "not-a-real-lever" } });
    check("POST: an unknown capability slug → 400", badCap.statusCode === 400);

    const badProject = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-status", projectId: "no-such-project" } });
    check("POST: a non-existent projectId → 404", badProject.statusCode === 404);

    const badMode = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-status", mode: "delete-everything" } });
    check("POST: an invalid mode → 400", badMode.statusCode === 400);

    const badConfig = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-status", config: "not-an-object" } });
    check("POST: a non-object config → 400", badConfig.statusCode === 400);

    // CR fix: the config-size bound must be a real UTF-8 BYTE bound, not a UTF-16 code-unit count. 1500
    // multibyte (3-byte-in-UTF-8) characters is ~1500 UTF-16 code units (well under the old .length-based
    // 4096 "limit") but ~4500 UTF-8 bytes (over the 4096-byte bound) — this must now be REJECTED.
    const multibyteOverBytes = await app.inject({
      method: "POST", url: `/api/companion/${companionSessId}/grants`,
      payload: { capability: "session-status", config: { note: "測".repeat(1500) } },
    });
    check("POST: a config within UTF-16 .length but OVER the real UTF-8 byte bound → 400 (byte bound, not code-unit bound)",
      multibyteOverBytes.statusCode === 400);
  }
  // ============ POST: a second, project-scoped grant for the SAME capability coexists ============
  {
    const res = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-status", projectId: otherProjId, mode: "read" } });
    check("POST: a project-scoped grant for the same capability is a SEPARATE row from the NULL 'own project' one", res.statusCode === 201);
    check("POST: the session now has 2 distinct session-status grants", db.listCompanionCapabilityGrantsForSession(companionSessId).length === 2);
  }
  // ============ GET: list ============
  {
    const res = await app.inject({ method: "GET", url: `/api/companion/${companionSessId}/grants` });
    const body = JSON.parse(res.payload);
    check("GET: 200", res.statusCode === 200);
    check("GET: lists both grants", body.grants.length === 2);
  }
  // ============ PUT: update an EXISTING grant (read → act) ============
  {
    const res = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-status", mode: "act" } });
    const body = JSON.parse(res.payload);
    check("PUT: 200 on an existing (capability, projectId) grant", res.statusCode === 200);
    check("PUT: mode flipped to 'act'", body.mode === "act");
    check("PUT: id is STABLE across the update (same row, not a new one)", body.id === created.id);
    check("PUT: the OTHER (project-scoped) grant is untouched", db.getCompanionCapabilityGrant(companionSessId, "session-status", otherProjId).mode === "read");

    const missing = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-status", projectId: otherProjId, mode: "act", config: { x: 1 }, extra: "irrelevant" } });
    check("PUT: updates config too", JSON.parse(missing.payload).config.x === 1);

    const noRow = await app.inject({ method: "PUT", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "decisions-relay" } });
    check("PUT: no existing grant for that (capability, projectId) → 404 (must POST to create)", noRow.statusCode === 404);
  }
  // ============ POST: re-POSTing an EXISTING (capability, projectId) is an upsert → 200, not 201 (CR fix) ============
  {
    const res = await app.inject({ method: "POST", url: `/api/companion/${companionSessId}/grants`, payload: { capability: "session-status", mode: "read" } });
    const body = JSON.parse(res.payload);
    check("POST: re-POSTing an EXISTING grant → 200 (update), NOT 201 (would misreport it as freshly created)", res.statusCode === 200);
    check("POST: the update actually applied (mode flipped back to 'read')", body.mode === "read");
    check("POST: id is STABLE across the upsert (same row)", body.id === created.id);
    check("POST: still exactly 2 grants for the session (no duplicate row)", db.listCompanionCapabilityGrantsForSession(companionSessId).length === 2);
  }
  // ============ DELETE ============
  {
    const res = await app.inject({ method: "DELETE", url: `/api/companion/${companionSessId}/grants?capability=session-status` });
    const body = JSON.parse(res.payload);
    check("DELETE: 200, ok:true", res.statusCode === 200 && body.ok === true);
    check("DELETE: the NULL-project grant is gone", db.getCompanionCapabilityGrant(companionSessId, "session-status", null) === undefined);
    check("DELETE: the project-scoped grant for the SAME capability survives (scoped by projectId too)",
      db.getCompanionCapabilityGrant(companionSessId, "session-status", otherProjId) !== undefined);

    const idempotent = await app.inject({ method: "DELETE", url: `/api/companion/${companionSessId}/grants?capability=session-status` });
    check("DELETE: re-deleting an already-gone grant is a safe 200 no-op (idempotent)", idempotent.statusCode === 200);

    const badCap = await app.inject({ method: "DELETE", url: `/api/companion/${companionSessId}/grants?capability=not-a-real-lever` });
    check("DELETE: an unknown capability query param → 400", badCap.statusCode === 400);
  }
  // ============ resolve-by-sessionId guards (mirrors every other companion REST resource) ============
  {
    const notFound = await app.inject({ method: "GET", url: `/api/companion/${UNKNOWN_SESSION}/grants` });
    check("GET: unknown sessionId → 404", notFound.statusCode === 404);

    const wrongRole = await app.inject({ method: "GET", url: `/api/companion/${workerSessId}/grants` });
    check("GET: a non-assistant (worker) session → 400, not silently served", wrongRole.statusCode === 400);

    const postWrongRole = await app.inject({ method: "POST", url: `/api/companion/${workerSessId}/grants`, payload: { capability: "session-status" } });
    check("POST: a non-assistant (worker) session → 400", postWrongRole.statusCode === 400);
  }
} finally {
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — companion_capability_grants is human-REST-writable (GET/POST/PUT/DELETE), validates the capability slug/projectId existence/mode/config shape, POST creates + PUT updates-only (404 when nothing exists yet) + DELETE is idempotent, distinct (capability, projectId) rows coexist independently, and every route resolves by sessionId with the same 404/400 posture as every other companion REST resource."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
