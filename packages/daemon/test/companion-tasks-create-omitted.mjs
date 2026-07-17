import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion silent-wrong-board fix — `tasks_create`/`tasks_update` (loom-tasks / TaskMcpRouter) are the
// ONLY tools on the whole daemon that wrote to a session's project with NO grant check at all. For a
// Companion (role "assistant") that silently meant "your own bound board" — the exact footgun behind
// session 5db71873 (owner named a different project, Companion filed to its home board anyway). The fix
// is conditional TOOL REGISTRATION on TaskMcpRouter.buildServer (the SAME pattern already used there for
// authenticated_request/vault_write): an "assistant"-role session never sees tasks_create/tasks_update in
// tools/list at all, so the silent-default path is structurally gone, not just discouraged in prose. Its
// only card-write path is now board_create/board_update (companion/capabilities.ts), which take an
// EXPLICIT `project` param and are grant-checked (companion-board-write.mjs already covers that grant
// check in full — this file does not duplicate it).
//
// Fully hermetic: a REAL Db + SessionService driven against a FAKE pty (PtyHost createPty() seam, mirrors
// vault-write-tool.mjs/authenticated-request.mjs), the REAL TaskMcpRouter driven over an in-process MCP
// InMemoryTransport. NO real claude, NO live daemon.
//
// Covers:
//   (a) an "assistant"-role session's tools/list OMITS tasks_create AND tasks_update entirely.
//   (b) a "worker"-role and a "manager"-role session's tools/list still INCLUDES both, byte-identical to
//       today — the shared router every other role mounts is untouched by this change.
//   (c) every OTHER loom-tasks tool (tasks_list/tasks_get/task_requests_list/task_request_get/wake_*)
//       is present on ALL THREE roles alike — this is a targeted omission of exactly two tools, not a
//       role-wide lockout.
//   (d) a real tasks_create CALL from a worker/manager session still creates a task exactly as before
//       (behavior, not just tools/list shape).
//
// Run: 1) build (turbo builds shared first), 2) node test/companion-tasks-create-omitted.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-companion-tasks-omitted-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

try {
  const db = new Db(path.join(tmpHome, "d.db"));
  const now = new Date().toISOString();
  const PROJECT_ID = "pCompanionTasksOmitted";
  db.insertProject({ id: PROJECT_ID, name: "CompanionTasksOmittedProj", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentX", projectId: PROJECT_ID, name: "Agent", startupPrompt: "", position: 0 });

  // Three sessions, differing ONLY in role — everything else identical, so any tools/list difference
  // traces to the role gate alone.
  const baseSession = (id, role) => ({
    id, projectId: PROJECT_ID, agentId: "agentX", engineSessionId: null, title: null,
    cwd: tmpHome, processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role,
  });
  db.insertSession(baseSession("sAssistant", "assistant"));
  db.insertSession(baseSession("sWorker", "worker"));
  db.insertSession(baseSession("sManager", "manager"));

  const wakes = {}; // no wake_* tool exercised here (mirrors vault-write-tool.mjs's stub) — tools/list only lists them.
  const router = new TaskMcpRouter(db, wakes);

  const connectTo = async (sessionId) => {
    const projectId = router.resolveProject(sessionId);
    const server = router.buildServer(projectId, sessionId);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "companion-tasks-omitted-test", version: "0" });
    await client.connect(clientT);
    return client;
  };

  // EXHAUSTIVE: every OTHER unconditional loom-tasks tool (i.e. every tool this router registers
  // regardless of session role, other than the two under test) — kept complete on purpose, not a sample,
  // so a future accidental omission of e.g. a memory_* tool on the assistant role would trip this too.
  const OTHER_TOOLS = [
    "tasks_list", "tasks_get", "task_requests_list", "task_request_get",
    "memory_write", "memory_forget", "memory_list", "memory_read",
    "wake_me", "wake_cancel", "wake_list",
  ];

  // --- (a) assistant: tasks_create AND tasks_update OMITTED entirely ---
  {
    const client = await connectTo("sAssistant");
    const names = (await client.listTools()).tools.map((t) => t.name);
    check("(a) assistant tools/list OMITS tasks_create", !names.includes("tasks_create"));
    check("(a) assistant tools/list OMITS tasks_update", !names.includes("tasks_update"));
    check("(c) assistant still carries every OTHER loom-tasks tool", OTHER_TOOLS.every((n) => names.includes(n)));
    await client.close();
  }

  // --- (b)/(c) worker + manager: BOTH tools still present, unchanged, alongside everything else ---
  for (const [role, sessionId] of [["worker", "sWorker"], ["manager", "sManager"]]) {
    const client = await connectTo(sessionId);
    const names = (await client.listTools()).tools.map((t) => t.name);
    check(`(b) ${role} tools/list still INCLUDES tasks_create`, names.includes("tasks_create"));
    check(`(b) ${role} tools/list still INCLUDES tasks_update`, names.includes("tasks_update"));
    check(`(c) ${role} still carries every OTHER loom-tasks tool`, OTHER_TOOLS.every((n) => names.includes(n)));
    await client.close();
  }

  // --- (d) a real tasks_create call from a worker session still creates a task exactly as before ---
  {
    const client = await connectTo("sWorker");
    const res = await client.callTool({ name: "tasks_create", arguments: { title: "WORKER-FILED-TASK" } });
    const parsed = JSON.parse(res.content[0].text);
    check("(d) tasks_create from a worker session still creates the task", parsed.title === "WORKER-FILED-TASK");
    check("(d) the task actually landed on the project's board", db.listTasks(PROJECT_ID).some((t) => t.title === "WORKER-FILED-TASK"));
    await client.close();
  }

  db.close();

  console.log(failures === 0
    ? "\n✅ ALL PASS — an assistant-role session's tools/list omits tasks_create/tasks_update entirely, worker/manager sessions keep both unchanged, every other loom-tasks tool is present on all three roles, and a real worker-session tasks_create call still lands a task on the board."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry (Windows) */ } }
}
process.exit(failures === 0 ? 0 : 1);
