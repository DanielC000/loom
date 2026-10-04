// End-to-end MCP auto-scoping test (§6) — HERMETIC (card 44b7774a). Builds the REAL `TaskMcpRouter`
// in-process (the same construction `agent-prompt-lint-surface-drift.mjs` already uses safely: `new
// TaskMcpRouter(db, {})` + its "private" `buildServer` called directly off the compiled JS) against two
// real projects/sessions/tasks in a throwaway temp LOOM_HOME, and drives it over an in-process
// `InMemoryTransport` — no live daemon, no HTTP, no port, no real `claude` spawn risk.
//
// Previously this test spawned a REAL daemon over LOOM_PORT and drove it via a real HTTP MCP client
// (two incidents of this launching a real `claude` against an un-stamped home), and hand-listed the
// expected tasks-MCP tool set, which went stale (missing `decisions_for`) with no gate to catch it
// (the file was NOT_HERMETIC — see test-daemon.mjs's own NOT_HERMETIC set). Both are fixed here: the
// expected tool list is DERIVED from `agents/promptLint.ts`'s `TASKS_UNIVERSAL_TOOLS` (itself
// drift-tested against this exact router by agent-prompt-lint-surface-drift.mjs) instead of hand-listed,
// and the whole test now runs hermetically — card 44b7774a also removed "mcp-scope" from test-daemon.mjs's
// NOT_HERMETIC set, so this now runs on every gate.
//
// Run: 1) build (turbo builds shared first), 2) node test/mcp-scope.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

const tmpHome = path.join(os.tmpdir(), `loom-mcpscope-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
const repoA = path.join(tmpHome, "repoA");
const repoB = path.join(tmpHome, "repoB");
fs.mkdirSync(repoA, { recursive: true });
fs.mkdirSync(repoB, { recursive: true });
requireHermeticEnv(); // prod-guard: no live daemon/port here — just an isolated temp LOOM_HOME

const { Db } = await import("../dist/db.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { TASKS_UNIVERSAL_TOOLS } = await import("../dist/agents/promptLint.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- seed the (temp, throwaway) DB directly via the real Db class — never raw SQL. ---
const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "projA", name: "Alpha", repoPath: repoA, vaultPath: repoA, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "projB", name: "Beta", repoPath: repoB, vaultPath: repoB, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "tA", projectId: "projA", name: "work", startupPrompt: "", position: 0, profileId: null });
db.insertAgent({ id: "tB", projectId: "projB", name: "work", startupPrompt: "", position: 0, profileId: null });
db.insertAgent({ id: "tR", projectId: "projA", name: "run", startupPrompt: "", position: 1, profileId: null });
const baseSession = { engineSessionId: null, title: null, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, parentSessionId: null };
db.insertSession({ ...baseSession, id: "SA", projectId: "projA", agentId: "tA", cwd: repoA, role: null });
db.insertSession({ ...baseSession, id: "SB", projectId: "projB", agentId: "tB", cwd: repoB, role: null });
// A "run"-role session is the ONE role that never mounts loom-tasks (mountsTaskMcp) — real behavioral
// coverage of the §6 server-side scoping gate, not just the two ordinary sessions above.
db.insertSession({ ...baseSession, id: "SR", projectId: "projA", agentId: "tR", cwd: repoA, role: "run" });
db.insertTask({ id: "taskAlpha", projectId: "projA", title: "ALPHA-TASK", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: "taskBeta", projectId: "projB", title: "BETA-TASK", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const router = new TaskMcpRouter(db, {});

// 0) Session -> project resolution is SERVER-SIDE and scoped — the ACTUAL function `handle()` calls.
check("resolveProject(SA) -> projA", router.resolveProject("SA") === "projA");
check("resolveProject(SB) -> projB", router.resolveProject("SB") === "projB");
check("resolveProject(SR) -> null (role=run never mounts loom-tasks)", router.resolveProject("SR") === null);
check("resolveProject(unknown) -> null", router.resolveProject("unknown-session") === null);

async function connect(sessionId) {
  const projectId = router.resolveProject(sessionId);
  const server = router.buildServer(projectId, sessionId);
  const client = new Client({ name: "scope-test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
// tasks_list returns NEWLINE-DELIMITED JSON (one task per line, card dc647ae2) — not a JSON array.
const titles = (res) => res.content[0].text.split("\n").filter(Boolean).map((l) => JSON.parse(l).title);

const A = await connect("SA");
const B = await connect("SB");

// 1) Tool schema has NO projectId parameter (scoping is implicit), and the expected tool SET is DERIVED
// from agents/promptLint.ts's TASKS_UNIVERSAL_TOOLS (itself drift-tested against this same router by
// agent-prompt-lint-surface-drift.mjs) — never hand-listed here, so it can't go stale a second time.
const tools = await A.listTools();
const names = tools.tools.map((t) => t.name).sort();
const expectedTaskTools = [...TASKS_UNIVERSAL_TOOLS].sort();
check(`tools = ${expectedTaskTools.join(",")}  (got ${names.join(",")})`,
  names.join(",") === expectedTaskTools.join(","));
const listSchema = JSON.stringify(tools.tools.find((t) => t.name === "tasks_list").inputSchema);
check("tasks_list takes no projectId param", !listSchema.includes("projectId") && !listSchema.includes("project"));
const createSchema = JSON.stringify(tools.tools.find((t) => t.name === "tasks_create").inputSchema);
check("tasks_create takes no projectId param", !createSchema.includes("projectId"));

// 2) Each session sees ONLY its own project's tasks.
const aTitles = titles(await A.callTool({ name: "tasks_list", arguments: {} }));
const bTitles = titles(await B.callTool({ name: "tasks_list", arguments: {} }));
check(`session A sees [ALPHA-TASK] only  (got ${JSON.stringify(aTitles)})`,
  aTitles.length === 1 && aTitles[0] === "ALPHA-TASK");
check(`session B sees [BETA-TASK] only  (got ${JSON.stringify(bTitles)})`,
  bTitles.length === 1 && bTitles[0] === "BETA-TASK");

// 3) Writes are scoped: a task created via A lands in A and is invisible to B.
await A.callTool({ name: "tasks_create", arguments: { title: "GAMMA-FROM-A" } });
const aAfter = titles(await A.callTool({ name: "tasks_list", arguments: {} }));
const bAfter = titles(await B.callTool({ name: "tasks_list", arguments: {} }));
check(`A now has GAMMA-FROM-A  (got ${JSON.stringify(aAfter)})`, aAfter.includes("GAMMA-FROM-A"));
check(`B still cannot see GAMMA-FROM-A  (got ${JSON.stringify(bAfter)})`, !bAfter.includes("GAMMA-FROM-A"));

await A.close();
await B.close();
db.close();
cleanupPathSync(tmpHome);
console.log(failures === 0 ? "\nALL PASS — MCP auto-scoping holds (§6)." : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
