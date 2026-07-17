import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — scope-denial coherence (Platform Auditor finding,
// session 5db71873): `board_list` on a project returned the plain "not in your granted scope" error even
// though the SAME companion session had `session-status` granted on that SAME project — a project that is
// status-granted yet board-denied is easy to mistake for full read access, since nothing distinguished
// "you have NO access to this project" from "you have a DIFFERENT capability on this project, just not
// this one." `scopeDenialMessage` (companion/capabilities.ts) is the fix: every belt-and-suspenders
// per-project scope check now names the missing capability when the project has SOME other grant, and
// falls back to the old plain message when it genuinely has none. Fully hermetic: a REAL Db on a temp
// LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory MCP transport. NO network, NO real claude,
// NO daemon.
//
// Covers the card's DoD, exercised through `board_list` (capability "board-reach") as the denied call and
// `session-status` as the OTHER granted capability, mirroring the exact evidence session:
//   (a) fully granted: board_list on a project WITH a board-reach grant works (no {error}).
//   (b) partially granted: board_list on a project granted session-status but NOT board-reach is denied
//       WITH a message naming BOTH the missing capability ("board-reach") and the capability that IS
//       granted ("session-status") — distinguishable from (c) below.
//   (c) fully ungranted: board_list on a project with NO grant at all is denied with the plain,
//       pre-existing "not in your granted scope" message — no mention of any other capability (there
//       isn't one), and textually distinct from (b)'s coherent warning.
// Run: 1) build (turbo builds shared first), 2) node test/companion-scope-denial-coherence.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-scope-denial-coherence-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-scope-denial-coherence-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const now = new Date().toISOString();
function seedProject(db, id, name) {
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role, startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role, taskId: null,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

try {
  const db = tmpDb();
  const projBoard = "proj-board-granted";   // board-reach granted here
  const projStatusOnly = "proj-status-only"; // session-status granted, board-reach NOT
  const projNone = "proj-no-grant-at-all";   // no grant at all
  seedProject(db, projBoard, "Board granted");
  seedProject(db, projStatusOnly, "Status only");
  seedProject(db, projNone, "No grant");

  const companionSess = "companion-scope-coherence";
  seedSession(db, companionSess, projBoard, "assistant");

  db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projBoard, mode: "read" });
  db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-status", projectId: projStatusOnly, mode: "read" });

  const orch = new OrchestrationMcpRouter(db, {});
  const client = await connect(orch.buildServer(companionSess, "assistant"));

  // (a) fully granted — board_list on the board-granted project succeeds.
  const granted = await call(client, "board_list", { project: projBoard });
  check("(a) fully granted: board_list on a board-reach-granted project succeeds (no {error})",
    granted.error === undefined && Array.isArray(granted.cards));

  // (b) partially granted — board_list on a project that has session-status but NOT board-reach is denied
  // WITH a message that names the missing capability AND the one that IS granted.
  const partial = await call(client, "board_list", { project: projStatusOnly });
  check("(b) partially granted: board_list on a session-status-only project is denied",
    typeof partial.error === "string" && partial.cards === undefined);
  check("(b) the denial names the MISSING capability (\"board-reach\")",
    partial.error.includes("board-reach"));
  check("(b) the denial names the OTHER capability that IS granted (\"session-status\")",
    partial.error.includes("session-status"));
  check("(b) the denial names the granted capability's mode (\"read\")",
    partial.error.includes("read"));

  // (c) fully ungranted — board_list on a project with NO grant at all falls back to the plain message,
  // and must NOT mention any other capability (there isn't one to name).
  const ungranted = await call(client, "board_list", { project: projNone });
  check("(c) fully ungranted: board_list on a no-grant project is denied",
    typeof ungranted.error === "string" && ungranted.cards === undefined);
  check("(c) the plain denial does NOT claim any other capability is granted",
    !ungranted.error.includes("is granted for"));
  check("(c) the plain denial is textually DISTINCT from the partial-grant coherent warning",
    ungranted.error !== partial.error);
  check("(c) the plain denial still names the project and says it's out of scope",
    ungranted.error.includes(projNone) && ungranted.error.includes("not in your granted scope"));

  await client.close();
  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a denied call on a partially-granted project names the missing capability + the one that IS granted (distinguishable from a fully-ungranted project's plain, unchanged denial message)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
