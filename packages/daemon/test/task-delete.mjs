// Human-only task-card DELETE test. HERMETIC + CLAUDE-FREE in the style of mgmt-project-agent.mjs
// (direct built Db + REAL buildServer driven by app.inject, all other deps STUBBED — no pty/claude boots).
// Covers the card's DoD:
//   A. db.deleteTask removes the row (and is idempotent on a missing id).
//   B. DELETE /api/tasks/:id deletes a card when NO live session is bound (200, ok; row gone).
//   C. LIVE-session guard: DELETE /api/tasks/:id with a live session bound to the task (task_id === id)
//      is REFUSED (400, "stop the worker first"); nothing is removed — mirrors the project/agent live block.
//   D. TRUST BOUNDARY: the loom-tasks MCP surface exposes NO delete tool and the module exports no delete
//      function — task deletion stays HUMAN-REST-only (an agent can only move a card to done).
// Run: 1) build the daemon (turbo builds shared first), 2) node test/task-delete.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

const tmpHome = path.join(os.tmpdir(), `loom-taskdel-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45419";
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const tasksMod = await import("../dist/mcp/tasks.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const db = new Db(path.join(tmpHome, "loom.db"));
const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

const mkProject = (id) => ({ id, name: id, repoPath: "C:/tmp/loom-taskdel", vaultPath: "C:/tmp/loom-taskdel/vault", config: {}, createdAt: now, archivedAt: null, reserved: false });
const mkAgent = (id, projectId) => ({ id, projectId, name: id, startupPrompt: "", position: 0, profileId: null, endpoint: false, ioSchema: null });
const mkSession = (id, projectId, agentId, over = {}) => ({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: "C:/tmp/loom-taskdel",
  processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, ...over,
});
const mkTask = (id, projectId) => ({ id, projectId, title: id, body: "", columnKey: "todo", position: 0, priority: "p2", createdAt: now, updatedAt: now });

try {
  db.insertProject(mkProject("pDel"));

  // ════════ A. db.deleteTask removes the row + idempotent on a missing id ════════
  db.insertTask(mkTask("tA", "pDel"));
  check("A: task present before delete", !!db.getTask("tA"));
  db.deleteTask("tA");
  check("A: db.deleteTask removed the row", !db.getTask("tA"));
  db.deleteTask("tA"); // second call must not throw
  db.deleteTask("does-not-exist"); // missing id is a no-op
  check("A: deleteTask idempotent on a missing id (no throw)", true);

  // ════════ B. REST DELETE with NO live session bound — deletes (200, row gone) ════════
  db.insertTask(mkTask("tB", "pDel"));
  const okDel = await app.inject({ method: "DELETE", url: "/api/tasks/tB" });
  check("B: DELETE /api/tasks/:id → 200 ok", okDel.statusCode === 200 && JSON.parse(okDel.body).ok === true);
  check("B: card row removed", !db.getTask("tB"));
  // Idempotent on a missing id (mirror the other DELETE routes — no 404).
  const okMissing = await app.inject({ method: "DELETE", url: "/api/tasks/tB" });
  check("B: DELETE unknown id → 200 (idempotent, no 404)", okMissing.statusCode === 200 && JSON.parse(okMissing.body).ok === true);

  // ════════ C. LIVE-session guard — a live session bound to the task blocks delete ════════
  db.insertAgent(mkAgent("aLive", "pDel"));
  db.insertTask(mkTask("tLive", "pDel"));
  db.insertSession(mkSession("sLive", "pDel", "aLive", { processState: "live", taskId: "tLive" }));
  check("C: countLiveSessionsForTask sees the bound live session", db.countLiveSessionsForTask("tLive") === 1);
  const blocked = await app.inject({ method: "DELETE", url: "/api/tasks/tLive" });
  check("C: DELETE with a live session bound → 400", blocked.statusCode === 400 && /stop the worker first/.test(JSON.parse(blocked.body).error));
  check("C: nothing removed (card survives the live block)", !!db.getTask("tLive"));
  // A NON-live (exited) session bound to the task does NOT block — only `live` counts.
  db.insertTask(mkTask("tExited", "pDel"));
  db.insertSession(mkSession("sExited", "pDel", "aLive", { processState: "exited", taskId: "tExited" }));
  check("C: an exited bound session does not count as live", db.countLiveSessionsForTask("tExited") === 0);
  const okExited = await app.inject({ method: "DELETE", url: "/api/tasks/tExited" });
  check("C: DELETE with only an exited session bound → 200 (deletes)", okExited.statusCode === 200 && !db.getTask("tExited"));

  // ════════ D. TRUST BOUNDARY — no delete tool on the REAL registered loom-tasks MCP surface ════════
  // Enumerated from tools/list over a REAL TaskMcpRouter + in-process MCP transport (mirrors
  // companion-tasks-create-omitted.mjs) — NOT a hand-maintained descriptor list. The old
  // TASK_TOOL_DESCRIPTORS array (card bb570cfc) duplicated the real registration and silently drifted
  // from it twice (an alias disclosure, then the role-conditional omission below); asserting against the
  // ACTUAL tools/list can never drift that way. Checked across BOTH a full-surface role ("worker") and
  // the reduced "assistant" role (tasks_create/tasks_update omitted, card 0784e5cb) — a role-conditional
  // check the old static list could never express.
  {
    const { TaskMcpRouter } = await import("../dist/mcp/server.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

    db.insertSession(mkSession("sWorkerD", "pDel", "aLive", { processState: "live", role: "worker" }));
    db.insertSession(mkSession("sAssistD", "pDel", "aLive", { processState: "live", role: "assistant" }));

    const wakesStub = {};
    const router = new TaskMcpRouter(db, wakesStub);
    const listToolNames = async (sessionId) => {
      const projectId = router.resolveProject(sessionId);
      const server = router.buildServer(projectId, sessionId);
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "task-delete-trust-boundary-test", version: "0" });
      await client.connect(clientT);
      const names = (await client.listTools()).tools.map((t) => t.name);
      await client.close();
      return names;
    };

    const workerNames = await listToolNames("sWorkerD");
    const taskToolNames = workerNames.filter((n) => n.startsWith("task"));
    check("D: the REAL registered task/tasks_* surface (worker role) is exactly the 6 known tools (create/get/list/update + the task_request_* read pair, card 988bb585)",
      JSON.stringify([...taskToolNames].sort()) === JSON.stringify(["task_request_get", "task_requests_list", "tasks_create", "tasks_get", "tasks_list", "tasks_update"]));
    check("D: NO registered tool name (worker role) mentions delete/remove/destroy", !workerNames.some((n) => /delete|remove|destroy/i.test(n)));

    const assistantNames = await listToolNames("sAssistD");
    check("D: assistant role omits tasks_create/tasks_update (card 0784e5cb) and still exposes no delete tool",
      !assistantNames.includes("tasks_create") && !assistantNames.includes("tasks_update") && !assistantNames.some((n) => /delete|remove|destroy/i.test(n)));
  }
  check("D: tasks MCP module exports NO delete function",
    Object.keys(tasksMod).every((k) => !/delete/i.test(k)));
} finally {
  await app.close();
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — db.deleteTask removes the row (idempotent); DELETE /api/tasks/:id deletes with no live session; the live-session guard refuses (400) and removes nothing; the loom-tasks MCP surface exposes NO delete tool/export (human-REST-only)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
