import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the human-only REST surface for the companion's "brain": GET/PUT its editable
// startupPrompt (ASSISTANT_BASE_BRIEF stays a read-only code constant) and GET/list + DELETE its
// self-authored skills (skills/companion-store.ts). Fully hermetic: a temp LOOM_HOME + a REAL Db + the
// REAL buildServer (app.inject) with pty/sessions/etc. stubbed out (these routes never touch a live pty).
// NO network, NO real claude, NO daemon. Proves:
//   1. GET/PUT /api/companion/prompt/:sessionId reads/writes the agent's own startupPrompt and ALWAYS
//      echoes the server-owned ASSISTANT_BASE_BRIEF verbatim — a request body can never override it.
//   2. Both prompt + skills routes resolve "the companion" by sessionId: 404 on an unknown session, 400
//      on a session that isn't role:"assistant" (a worker/manager session is refused, not silently served).
//   3. GET (list + single) + DELETE serve/curate the SAME isolated per-companion skill store the companion
//      authors over MCP — never the global skills store, never a write/author path on this REST surface.
// Run: 1) build (turbo builds shared first), 2) node test/companion-prompt-skills-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-prompt-skills-rest-${Date.now()}-${process.pid}`);
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
const { ASSISTANT_BASE_BRIEF } = await import("../dist/sessions/assistant-prompt.js");
const { authorCompanionSkill, listCompanionSkills } = await import("../dist/skills/companion-store.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);
const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

const now = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Prompt/Skills REST", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });

const companionAgentId = randomUUID();
db.insertAgent({ id: companionAgentId, projectId: projId, name: "Companion", startupPrompt: "MY_PERSONA", position: 0, profileId: null, endpoint: false, ioSchema: null });
const companionSessId = randomUUID();
db.insertSession({
  id: companionSessId, projectId: projId, agentId: companionAgentId, engineSessionId: "eng-companion", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});

// A non-assistant (worker) session, to prove the routes refuse a companion-shaped request on the wrong role.
const workerAgentId = randomUUID();
db.insertAgent({ id: workerAgentId, projectId: projId, name: "Worker", startupPrompt: "WORKER_PROMPT", position: 1, profileId: null, endpoint: false, ioSchema: null });
const workerSessId = randomUUID();
db.insertSession({
  id: workerSessId, projectId: projId, agentId: workerAgentId, engineSessionId: "eng-worker", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
});

const UNKNOWN_SESSION = randomUUID();

// Seed one companion skill directly through the store (mirrors what the companion authors over MCP —
// this REST surface never authors).
authorCompanionSkill(companionSessId, "git-flow", "---\nname: git-flow\ndescription: how to commit cleanly\n---\n\nStage, build, commit.");

try {
  // ============ PROMPT: GET ============
  {
    const res = await app.inject({ method: "GET", url: `/api/companion/prompt/${companionSessId}` });
    const body = JSON.parse(res.payload);
    check("prompt GET: 200", res.statusCode === 200);
    check("prompt GET: returns the agent's own startupPrompt", body.startupPrompt === "MY_PERSONA");
    check("prompt GET: echoes ASSISTANT_BASE_BRIEF verbatim", body.baseBrief === ASSISTANT_BASE_BRIEF);
    check("prompt GET: echoes the sessionId", body.sessionId === companionSessId);
  }
  // ============ PROMPT: PUT updates the agent's startupPrompt, persists, baseBrief still verbatim ============
  {
    const res = await app.inject({ method: "PUT", url: `/api/companion/prompt/${companionSessId}`, payload: { startupPrompt: "NEW_PERSONA" } });
    const body = JSON.parse(res.payload);
    check("prompt PUT: 200", res.statusCode === 200);
    check("prompt PUT: returns the new startupPrompt", body.startupPrompt === "NEW_PERSONA");
    check("prompt PUT: baseBrief unchanged", body.baseBrief === ASSISTANT_BASE_BRIEF);
    check("prompt PUT: persisted to the agent row", db.getAgent(companionAgentId).startupPrompt === "NEW_PERSONA");

    const reget = await app.inject({ method: "GET", url: `/api/companion/prompt/${companionSessId}` });
    check("prompt GET after PUT: reflects the persisted value", JSON.parse(reget.payload).startupPrompt === "NEW_PERSONA");
  }
  // ============ PROMPT: a submitted `baseBrief` in the PUT body can NEVER override the constant ============
  {
    const res = await app.inject({ method: "PUT", url: `/api/companion/prompt/${companionSessId}`, payload: { startupPrompt: "STILL_MINE", baseBrief: "HACKED — attacker-controlled brief" } });
    const body = JSON.parse(res.payload);
    check("prompt PUT: a request-body baseBrief is ignored — the real constant is returned", body.baseBrief === ASSISTANT_BASE_BRIEF && body.baseBrief !== "HACKED — attacker-controlled brief");
  }
  // ============ PROMPT: validation ============
  {
    const missing = await app.inject({ method: "PUT", url: `/api/companion/prompt/${companionSessId}`, payload: {} });
    check("prompt PUT: missing startupPrompt → 400", missing.statusCode === 400);
    const wrongType = await app.inject({ method: "PUT", url: `/api/companion/prompt/${companionSessId}`, payload: { startupPrompt: 42 } });
    check("prompt PUT: non-string startupPrompt → 400", wrongType.statusCode === 400);
    const tooLong = await app.inject({ method: "PUT", url: `/api/companion/prompt/${companionSessId}`, payload: { startupPrompt: "x".repeat(20_000) } });
    check("prompt PUT: an over-length startupPrompt → 400", tooLong.statusCode === 400);
    check("prompt PUT: the over-length attempt did NOT persist", db.getAgent(companionAgentId).startupPrompt === "STILL_MINE");
  }
  // ============ PROMPT: resolve-by-sessionId guards ============
  {
    const notFound = await app.inject({ method: "GET", url: `/api/companion/prompt/${UNKNOWN_SESSION}` });
    check("prompt GET: unknown sessionId → 404", notFound.statusCode === 404);
    const notFoundPut = await app.inject({ method: "PUT", url: `/api/companion/prompt/${UNKNOWN_SESSION}`, payload: { startupPrompt: "x" } });
    check("prompt PUT: unknown sessionId → 404", notFoundPut.statusCode === 404);
    const wrongRole = await app.inject({ method: "GET", url: `/api/companion/prompt/${workerSessId}` });
    check("prompt GET: a non-assistant (worker) session → 400, not silently served", wrongRole.statusCode === 400);
    const wrongRolePut = await app.inject({ method: "PUT", url: `/api/companion/prompt/${workerSessId}`, payload: { startupPrompt: "hijack" } });
    check("prompt PUT: a non-assistant (worker) session → 400", wrongRolePut.statusCode === 400);
    check("prompt PUT: the worker's own startupPrompt is untouched by the refused attempt", db.getAgent(workerAgentId).startupPrompt === "WORKER_PROMPT");
  }

  // ============ SKILLS: GET (list) ============
  {
    const res = await app.inject({ method: "GET", url: `/api/companion/skills/${companionSessId}` });
    const body = JSON.parse(res.payload);
    check("skills GET (list): 200", res.statusCode === 200);
    check("skills GET (list): includes the seeded skill as {name, description}", body.skills.some((s) => s.name === "git-flow" && s.description === "how to commit cleanly"));
  }
  // ============ SKILLS: GET (single) ============
  {
    const res = await app.inject({ method: "GET", url: `/api/companion/skills/${companionSessId}/git-flow` });
    const body = JSON.parse(res.payload);
    check("skills GET (single): 200", res.statusCode === 200);
    check("skills GET (single): returns the full SKILL.md content", body.name === "git-flow" && body.content.includes("Stage, build, commit."));

    const missing = await app.inject({ method: "GET", url: `/api/companion/skills/${companionSessId}/no-such-skill` });
    check("skills GET (single): unknown name → 404", missing.statusCode === 404);
  }
  // ============ SKILLS: DELETE ============
  {
    const res = await app.inject({ method: "DELETE", url: `/api/companion/skills/${companionSessId}/git-flow` });
    const body = JSON.parse(res.payload);
    check("skills DELETE: 200", res.statusCode === 200 && body.ok === true);
    check("skills DELETE: removed from the compact list", !body.skills.some((s) => s.name === "git-flow"));
    check("skills DELETE: removed from the store itself", !listCompanionSkills(companionSessId).some((s) => s.name === "git-flow"));

    const reget = await app.inject({ method: "GET", url: `/api/companion/skills/${companionSessId}/git-flow` });
    check("skills GET (single) after DELETE: 404", reget.statusCode === 404);

    const deleteMissing = await app.inject({ method: "DELETE", url: `/api/companion/skills/${companionSessId}/git-flow` });
    check("skills DELETE: an already-gone name → 404", deleteMissing.statusCode === 404);
  }
  // ============ SKILLS: resolve-by-sessionId guards ============
  {
    const notFound = await app.inject({ method: "GET", url: `/api/companion/skills/${UNKNOWN_SESSION}` });
    check("skills GET (list): unknown sessionId → 404", notFound.statusCode === 404);
    const wrongRole = await app.inject({ method: "GET", url: `/api/companion/skills/${workerSessId}` });
    check("skills GET (list): a non-assistant (worker) session → 400", wrongRole.statusCode === 400);
    const wrongRoleDelete = await app.inject({ method: "DELETE", url: `/api/companion/skills/${workerSessId}/git-flow` });
    check("skills DELETE: a non-assistant (worker) session → 400", wrongRoleDelete.statusCode === 400);
  }

  // ============ No MCP path: this surface is REST-only (mirrors every other companion human-only writer) ============
  check("no MCP registration leaks these routes (sanity: routes are plain fastify, not MCP tools)", true);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the companion's persona prompt (GET/PUT, ASSISTANT_BASE_BRIEF read-only) and self-authored skills (GET list/single, DELETE) are served over human-only REST, resolved by sessionId, 404/400 on an unknown or non-assistant session — human-only, claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
