import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card F (db6f0606, epic ccdb1e0c lever 7a) — companion `sessions_status` gains an optional `state`
// input ("live" default | "exited" | "all") so the Companion can enumerate STOPPED sessions (to later
// resume one), mirroring the Lead's own list_all_sessions state filter (mcp/platform.ts ~L781).
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory
// MCP transport. NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   (a) default (no `state`) ⇒ only live sessions — BYTE-IDENTICAL to pre-card behavior.
//   (b) state:"exited" ⇒ only exited/stopped sessions in granted scope.
//   (c) state:"all" ⇒ both live and exited sessions in granted scope.
//   (d) scope is still enforced regardless of `state` — an ungranted project's sessions never appear.
// Run: 1) build (turbo builds shared first), 2) node test/companion-session-state.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-session-state-${Date.now()}-${process.pid}`);
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
  const client = new Client({ name: "companion-session-state-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const now = new Date().toISOString();
function seedProject(db, id, name) {
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role, opts = {}) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role, startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: opts.title ?? null, cwd: projectId,
    processState: opts.processState ?? "live", resumability: "resumable", busy: opts.busy ?? false,
    createdAt: now, lastActivity: now, lastError: null, role, taskId: opts.taskId ?? null,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

try {
  const db = tmpDb();
  const projA = "proj-a", projB = "proj-b";
  seedProject(db, projA, "A");
  seedProject(db, projB, "B");
  const companionSess = "companion-state";
  seedSession(db, companionSess, projA, "assistant");

  const liveInA = "live-a";
  seedSession(db, liveInA, projA, "worker", { busy: true, taskId: "task-a" });
  const exitedInA = "exited-a";
  seedSession(db, exitedInA, projA, "worker", { processState: "exited" });
  const liveInB = "live-b";
  seedSession(db, liveInB, projB, "worker");
  const exitedInB = "exited-b";
  seedSession(db, exitedInB, projB, "worker", { processState: "exited" });

  // Grant session-status for projA only — projB stays ungranted for the scope-enforcement check.
  db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-status", projectId: projA });

  const orch = new OrchestrationMcpRouter(db, {});
  const client = await connect(orch.buildServer(companionSess, "assistant"));

  // (a) default (no `state`) ⇒ only live sessions in scope — byte-identical to pre-card behavior.
  // (The companion's own session is also live and in projA, so "live" scope = {companionSess, liveInA}.)
  const byDefault = await call(client, "sessions_status", {});
  check("(a) default: includes the live session in the granted project", byDefault.sessions.some((s) => s.sessionId === liveInA));
  check("(a) default: excludes the exited session in the granted project", !byDefault.sessions.some((s) => s.sessionId === exitedInA));
  check("(a) default: only the live in-scope sessions are returned", byDefault.sessions.length === 2);

  // Explicit state:"live" must match the default exactly.
  const explicitLive = await call(client, "sessions_status", { state: "live" });
  check("(a) state:\"live\" matches the default exactly", JSON.stringify(explicitLive) === JSON.stringify(byDefault));

  // (b) state:"exited" ⇒ only exited sessions in scope.
  const exited = await call(client, "sessions_status", { state: "exited" });
  check("(b) state:\"exited\": includes the exited session in the granted project", exited.sessions.some((s) => s.sessionId === exitedInA));
  check("(b) state:\"exited\": excludes the live session in the granted project", !exited.sessions.some((s) => s.sessionId === liveInA));
  check("(b) state:\"exited\": only the one exited in-scope session is returned", exited.sessions.length === 1);

  // (c) state:"all" ⇒ both live and exited sessions in scope.
  const all = await call(client, "sessions_status", { state: "all" });
  check("(c) state:\"all\": includes the live session in the granted project", all.sessions.some((s) => s.sessionId === liveInA));
  check("(c) state:\"all\": includes the exited session in the granted project", all.sessions.some((s) => s.sessionId === exitedInA));
  check("(c) state:\"all\": every in-scope session is returned", all.sessions.length === 3);

  // (d) scope is still enforced regardless of state — projB's sessions never appear, at any state.
  check("(d) default: excludes the ungranted project's live session", !byDefault.sessions.some((s) => s.sessionId === liveInB));
  check("(d) state:\"exited\": excludes the ungranted project's exited session", !exited.sessions.some((s) => s.sessionId === exitedInB));
  check("(d) state:\"all\": excludes BOTH of the ungranted project's sessions",
    !all.sessions.some((s) => s.sessionId === liveInB) && !all.sessions.some((s) => s.sessionId === exitedInB));

  await client.close();
  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — sessions_status's `state` filter defaults to \"live\" byte-identical to pre-card behavior, \"exited\" surfaces only stopped sessions, \"all\" surfaces both, and per-project grant scope holds at every state value."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
