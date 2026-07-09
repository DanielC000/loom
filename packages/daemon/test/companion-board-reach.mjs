import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — `board-reach` READ half (a `board_list` tool
// reporting board cards across the companion's granted projects). Mirrors
// companion-decisions-relay.mjs's coverage shape. READ HALF ONLY — this card does not build the write
// half (create / move column / set priority / set held); that is a later card gated on injection-guard
// primitives.
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory MCP
// transport. NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   (a) grant present ⇒ board_list is registered + returns ONLY the granted project's cards (a card on
//       an ungranted project is excluded).
//   (b) a `project` selector naming an ungranted project is rejected with {error}.
//   (c) a multi-project grant (A+B) returns both projects' cards, each tagged with its project.
//   (d) no grant ⇒ board_list is NOT registered (inert + invisible; byte-identical tool surface).
//   (e) a grant row on a non-assistant-role session registers nothing (role gate).
//   (f) no create/move/priority/held/write tool is ever registered by this lever, even under mode:'act'.
// Run: 1) build (turbo builds shared first), 2) node test/companion-board-reach.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-board-reach-${Date.now()}-${process.pid}`);
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
  const client = new Client({ name: "companion-board-reach-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
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
function seedTask(db, id, projectId, opts = {}) {
  db.insertTask({
    id, projectId, title: opts.title ?? `Task ${id}`, body: opts.body ?? "",
    columnKey: opts.columnKey ?? "backlog", position: opts.position ?? 0,
    priority: opts.priority ?? "p2", createdAt: now, updatedAt: now,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

try {
  // ============ (a)+(b) grant scoping: board_list returns ONLY the granted project's cards ============
  {
    const db = tmpDb();
    const projA = "proj-a", projB = "proj-b";
    seedProject(db, projA, "A");
    seedProject(db, projB, "B");
    const companionSess = "companion-board";
    seedSession(db, companionSess, projA, "assistant");

    seedTask(db, "t-a", projA, { title: "Card on A" });
    seedTask(db, "t-b", projB, { title: "Card on B" });
    // A done/terminal card on the granted project should be excluded, mirroring tasks_list's default.
    seedTask(db, "t-a-done", projA, { title: "Done card on A", columnKey: "done" });

    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projA, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(a) the GRANTED companion HAS board_list", tools.includes("board_list"));

    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const all = await call(client, "board_list", {});
    check("(a) board_list returns the granted project's card", all.cards.some((c) => c.id === "t-a"));
    check("(a) board_list excludes the UNGRANTED project's card", !all.cards.some((c) => c.id === "t-b"));
    check("board_list excludes a done/terminal card, mirroring tasks_list's default", !all.cards.some((c) => c.id === "t-a-done"));
    const row = all.cards.find((c) => c.id === "t-a");
    check("(a) carries title/columnKey/priority/position/updatedAt/projectId/projectName",
      row?.title === "Card on A" && row?.columnKey === "backlog" && row?.priority === "p2"
      && typeof row?.position === "number" && typeof row?.updatedAt === "string"
      && row?.projectId === projA && row?.projectName === "A");

    const scoped = await call(client, "board_list", { project: projA });
    check("board_list: an explicit `project` selector matching the grant is honored", scoped.cards.some((c) => c.id === "t-a"));

    const rejected = await call(client, "board_list", { project: projB });
    check("(b) a `project` selector OUTSIDE scope is REJECTED with an {error} (can never widen scope)",
      typeof rejected.error === "string" && rejected.cards === undefined);

    await client.close();
    db.close();
  }

  // ============ (c) multi-project grant returns both projects' cards, each tagged with its project ============
  {
    const db = tmpDb();
    const projA = "proj-multi-a", projB = "proj-multi-b";
    seedProject(db, projA, "Multi A");
    seedProject(db, projB, "Multi B");
    const companionSess = "companion-multi";
    seedSession(db, companionSess, projA, "assistant");

    seedTask(db, "m-a", projA, { title: "Multi card A" });
    seedTask(db, "m-b", projB, { title: "Multi card B" });

    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projA, mode: "read" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projB, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const all = await call(client, "board_list", {});
    check("(c) multi-project grant returns project A's card", all.cards.some((c) => c.id === "m-a" && c.projectId === projA));
    check("(c) multi-project grant returns project B's card", all.cards.some((c) => c.id === "m-b" && c.projectId === projB));
    await client.close();
    db.close();
  }

  // ============ (d) no grant ⇒ board_list is NOT registered (inert + invisible) ============
  {
    const db = tmpDb();
    const proj = "proj-no-grant";
    seedProject(db, proj, "No grant");
    const companionSess = "companion-no-grant";
    seedSession(db, companionSess, proj, "assistant");

    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(d) an ungranted companion does NOT have board_list", !tools.includes("board_list"));
    check("(f) no write tool is ever registered by this lever (no ACT half yet)",
      !tools.includes("board_create") && !tools.includes("board_move") && !tools.includes("board_set_priority") && !tools.includes("board_set_held"));
    db.close();
  }

  // ============ (e) registerCompanionCapabilities is role-gated to "assistant" ============
  {
    const db = tmpDb();
    const proj = "proj-role-gate";
    seedProject(db, proj, "Role gate");
    // A grant row on a NON-assistant session id — should never happen via the REST writer (it requires
    // role==="assistant"), but seed it directly to prove the belt-and-suspenders role gate holds even then.
    const mgrSess = "mgr-with-stray-grant";
    seedSession(db, mgrSess, proj, "manager");
    db.upsertCompanionCapabilityGrant({ sessionId: mgrSess, capability: "board-reach", projectId: null });

    const orch = new OrchestrationMcpRouter(db, {});
    const mgrTools = await listOf(orch.buildServer(mgrSess, "manager"));
    check("(e) a manager session with a STRAY grant row still does NOT get board_list (role gate)", !mgrTools.includes("board_list"));
    db.close();
  }

  // ============ (f) no write tool registered even for a companion granted mode 'act' ============
  {
    const db = tmpDb();
    const proj = "proj-act-mode";
    seedProject(db, proj, "Act mode");
    const companionSess = "companion-act-mode";
    seedSession(db, companionSess, proj, "assistant");
    // Even a mode:'act' grant must not light up a create/move/write tool — this card builds ONLY the read half.
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });

    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(f) board_list is still registered under an 'act' grant", tools.includes("board_list"));
    check("(f) no create/move/priority/held/write tool is registered even under an 'act' grant (read-half-only card)",
      !tools.includes("board_create") && !tools.includes("board_move") && !tools.includes("board_set_priority") && !tools.includes("board_set_held"));
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — board_list registers ONLY behind a board-reach grant and reports ONLY that grant's non-done cards scoped to the granted project(s), each tagged with its project; a project selector can never widen scope; an ungranted/non-assistant session gets nothing; and no create/move/priority/held/write tool is ever registered by this read-only card, even under a mode:'act' grant."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
