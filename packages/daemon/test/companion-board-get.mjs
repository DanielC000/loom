import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — `board_get` (card 5a5d21aa), extending the
// EXISTING `board-reach` capability's READ half alongside `board_list`. Tier R — a pure read that never
// touches the trust window or Primitive A/B/C, registered UNCONDITIONALLY (before the `hasActGrant`
// gate), so a read-only grant sees it too. Reuses `getProjectTask` (mcp/tasks.ts), the same reader
// `tasks_get`/the Lead's `project_task_get` use.
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory MCP
// transport. NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   (a) read grant on project X ⇒ board_get returns the full body of a card in X
//   (b) a `project` not in scope ⇒ {error}
//   (c) a taskId not on the named project ⇒ not-found {error}
//   (d) no board-reach grant ⇒ tool absent
// Run: 1) build (turbo builds shared first), 2) node test/companion-board-get.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-board-get-${Date.now()}-${process.pid}`);
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
  const client = new Client({ name: "companion-board-get-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
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
    createdAt: now, lastActivity: now, lastError: null, role,
  });
}
function seedTask(db, id, projectId, opts = {}) {
  db.insertTask({
    id, projectId, title: opts.title ?? `Task ${id}`, body: opts.body ?? "",
    columnKey: opts.columnKey ?? "backlog", position: opts.position ?? 0,
    priority: opts.priority ?? "p2", createdAt: now, updatedAt: now,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

try {
  // ============ (a) read grant on project X ⇒ board_get returns the full body of a card in X ============
  {
    const db = tmpDb();
    const proj = "proj-read";
    seedProject(db, proj, "Read project");
    const companionSess = "companion-read";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-full", proj, { title: "Full card", body: "the full body text of this card", priority: "p1", columnKey: "in_progress" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "read" });
    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "board_get", { project: proj, taskId: "t-full" });
    check("(a) no error", res.error === undefined);
    check("(a) returns the full title", res.card?.title === "Full card");
    check("(a) returns the full body", res.card?.body === "the full body text of this card");
    check("(a) returns column/priority fields", res.card?.columnKey === "in_progress" && res.card?.priority === "p1");
    check("(a) returns the project id/name", res.card?.projectId === proj && res.card?.projectName === "Read project");

    await client.close();
    db.close();
  }

  // ============ (b) a `project` not in scope ⇒ {error} ============
  {
    const db = tmpDb();
    const projGranted = "proj-scoped";
    const projOther = "proj-unscoped";
    seedProject(db, projGranted, "Scoped");
    seedProject(db, projOther, "Unscoped");
    const companionSess = "companion-scope";
    seedSession(db, companionSess, projGranted, "assistant");
    seedTask(db, "t-other", projOther, { title: "Not yours", body: "secret body" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projGranted, mode: "read" });
    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "board_get", { project: projOther, taskId: "t-other" });
    check("(b) rejected with an {error}", typeof res.error === "string" && res.card === undefined);
    check("(b) no body leaked", JSON.stringify(res).includes("secret body") === false);

    await client.close();
    db.close();
  }

  // ============ (c) a taskId not on the named project ⇒ not-found {error} ============
  {
    const db = tmpDb();
    const projA = "proj-c-a";
    const projB = "proj-c-b";
    seedProject(db, projA, "Project A");
    seedProject(db, projB, "Project B");
    const companionSess = "companion-notfound";
    seedSession(db, companionSess, projA, "assistant");
    // The card actually lives on projB, but the grant + query both name projA.
    seedTask(db, "t-wrong-project", projB, { title: "Lives on B", body: "b's body" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projA, mode: "read" });
    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "board_get", { project: projA, taskId: "t-wrong-project" });
    check("(c) rejected with an {error}", typeof res.error === "string" && res.card === undefined);

    const resNoSuchId = await call(client, "board_get", { project: projA, taskId: "nonexistent-id" });
    check("(c) a totally unknown taskId is also rejected with an {error}", typeof resNoSuchId.error === "string" && resNoSuchId.card === undefined);

    await client.close();
    db.close();
  }

  // ============ (d) no board-reach grant ⇒ tool absent ============
  {
    const db = tmpDb();
    const proj = "proj-nogrant";
    seedProject(db, proj, "No grant");
    const companionSess = "companion-nogrant";
    seedSession(db, companionSess, proj, "assistant");
    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(d) board_get is NOT registered with no board-reach grant", !tools.includes("board_get"));
    check("(d) board_list is also not registered (sanity: whole capability absent)", !tools.includes("board_list"));
    db.close();
  }

  // ============ board_get is registered alongside board_list under a READ-ONLY grant (no act tools) ============
  {
    const db = tmpDb();
    const proj = "proj-readonly-surface";
    seedProject(db, proj, "Read-only surface");
    const companionSess = "companion-readonly-surface";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "read" });
    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("board_get is registered under a read-only grant", tools.includes("board_get"));
    check("board_list is registered under a read-only grant", tools.includes("board_list"));
    check("board_create is NOT registered under a read-only grant", !tools.includes("board_create"));
    check("board_update is NOT registered under a read-only grant", !tools.includes("board_update"));
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — board_get returns the full title/body/fields of a card within a granted project's scope, rejects an out-of-scope project or a taskId that doesn't resolve on the named project, and is registered ONLY when a board-reach grant exists (alongside board_list, even under a read-only grant with no act tools)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
