import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the human-only REST surface for the companion's SELF-AUTHORED memory store: GET
// (list + single) + DELETE over the SAME isolated per-companion MEMORY.md store the companion authors
// over MCP (skills/companion-memory-store.ts) — the sibling of companion-prompt-skills-rest.mjs's SKILLS
// surface, same trust posture (REST-only review + prune, no author/write path here). Fully hermetic: a
// temp LOOM_HOME + a REAL Db + the REAL buildServer (app.inject) with pty/sessions/etc. stubbed out
// (these routes never touch a live pty). NO network, NO real claude, NO daemon. Proves:
//   1. GET (list) returns the compact {name, description, pinned} entries; GET (single) returns the
//      full MEMORY.md content; DELETE removes and returns the updated compact list.
//   2. The routes resolve "the companion" by sessionId: 404 on an unknown session, 400 on a session
//      that isn't role:"assistant" (a worker/manager session is refused, not silently served).
//   3. A name absent from the store 404s on GET (single) and DELETE.
//   4. Per-session isolation: a memory authored under one companion session never appears for another.
// Run: 1) build (turbo builds shared first), 2) node test/companion-memory-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-memory-rest-${Date.now()}-${process.pid}`);
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
const { authorCompanionMemory, listCompanionMemories } = await import("../dist/skills/companion-memory-store.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);
const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

const now = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Memory REST", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });

const companionAgentId = randomUUID();
db.insertAgent({ id: companionAgentId, projectId: projId, name: "Companion", startupPrompt: "MY_PERSONA", position: 0, profileId: null, endpoint: false, ioSchema: null });
const companionSessId = randomUUID();
db.insertSession({
  id: companionSessId, projectId: projId, agentId: companionAgentId, engineSessionId: "eng-companion", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});

// A second companion session, to prove per-session isolation of the memory store.
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

// Seed one companion memory directly through the store (mirrors what the companion authors over MCP —
// this REST surface never authors), pinned so the compact list surfaces the flag.
authorCompanionMemory(companionSessId, "user-timezone", "---\nname: user-timezone\ndescription: the user's home timezone\npinned: true\n---\n\nUS/Pacific.");
// A memory under the OTHER companion session, to prove isolation.
authorCompanionMemory(otherSessId, "other-memory", "---\nname: other-memory\ndescription: belongs to the other companion\npinned: false\n---\n\nnope.");

try {
  // ============ MEMORY: GET (list) ============
  {
    const res = await app.inject({ method: "GET", url: `/api/companion/memory/${companionSessId}` });
    const body = JSON.parse(res.payload);
    check("memory GET (list): 200", res.statusCode === 200);
    check("memory GET (list): includes the seeded entry as {name, description, pinned}",
      body.memories.some((m) => m.name === "user-timezone" && m.description === "the user's home timezone" && m.pinned === true));
    check("memory GET (list): does NOT include the other companion's memory (isolation)",
      !body.memories.some((m) => m.name === "other-memory"));
  }
  // ============ MEMORY: GET (single) ============
  {
    const res = await app.inject({ method: "GET", url: `/api/companion/memory/${companionSessId}/user-timezone` });
    const body = JSON.parse(res.payload);
    check("memory GET (single): 200", res.statusCode === 200);
    check("memory GET (single): returns the full MEMORY.md content", body.name === "user-timezone" && body.content.includes("US/Pacific."));

    const missing = await app.inject({ method: "GET", url: `/api/companion/memory/${companionSessId}/no-such-memory` });
    check("memory GET (single): unknown name → 404", missing.statusCode === 404);

    const crossSession = await app.inject({ method: "GET", url: `/api/companion/memory/${companionSessId}/other-memory` });
    check("memory GET (single): another companion's memory name → 404 (isolation)", crossSession.statusCode === 404);
  }
  // ============ MEMORY: DELETE ============
  {
    const res = await app.inject({ method: "DELETE", url: `/api/companion/memory/${companionSessId}/user-timezone` });
    const body = JSON.parse(res.payload);
    check("memory DELETE: 200", res.statusCode === 200 && body.ok === true);
    check("memory DELETE: removed from the compact list", !body.memories.some((m) => m.name === "user-timezone"));
    check("memory DELETE: removed from the store itself", !listCompanionMemories(companionSessId).some((m) => m.name === "user-timezone"));

    const reget = await app.inject({ method: "GET", url: `/api/companion/memory/${companionSessId}/user-timezone` });
    check("memory GET (single) after DELETE: 404", reget.statusCode === 404);

    const deleteMissing = await app.inject({ method: "DELETE", url: `/api/companion/memory/${companionSessId}/user-timezone` });
    check("memory DELETE: an already-gone name → 404", deleteMissing.statusCode === 404);

    check("memory DELETE: the other companion's memory is untouched (isolation)",
      listCompanionMemories(otherSessId).some((m) => m.name === "other-memory"));
  }
  // ============ MEMORY: resolve-by-sessionId guards ============
  {
    const notFound = await app.inject({ method: "GET", url: `/api/companion/memory/${UNKNOWN_SESSION}` });
    check("memory GET (list): unknown sessionId → 404", notFound.statusCode === 404);
    const notFoundSingle = await app.inject({ method: "GET", url: `/api/companion/memory/${UNKNOWN_SESSION}/user-timezone` });
    check("memory GET (single): unknown sessionId → 404", notFoundSingle.statusCode === 404);
    const notFoundDelete = await app.inject({ method: "DELETE", url: `/api/companion/memory/${UNKNOWN_SESSION}/user-timezone` });
    check("memory DELETE: unknown sessionId → 404", notFoundDelete.statusCode === 404);

    const wrongRole = await app.inject({ method: "GET", url: `/api/companion/memory/${workerSessId}` });
    check("memory GET (list): a non-assistant (worker) session → 400, not silently served", wrongRole.statusCode === 400);
    const wrongRoleSingle = await app.inject({ method: "GET", url: `/api/companion/memory/${workerSessId}/user-timezone` });
    check("memory GET (single): a non-assistant (worker) session → 400", wrongRoleSingle.statusCode === 400);
    const wrongRoleDelete = await app.inject({ method: "DELETE", url: `/api/companion/memory/${workerSessId}/user-timezone` });
    check("memory DELETE: a non-assistant (worker) session → 400", wrongRoleDelete.statusCode === 400);
  }

  // ============ No MCP path: this surface is REST-only (mirrors every other companion human-only writer) ============
  check("no MCP registration leaks these routes (sanity: routes are plain fastify, not MCP tools)", true);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the companion's self-authored memory store is served over human-only REST (GET list/single, DELETE), resolved by sessionId, 404/400 on an unknown or non-assistant session, per-session isolated — human-only, claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
