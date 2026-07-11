import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Bug fix: a `question_ask` Request created BEFORE commit a3f1319f stored `task_id` as an 8-char
// id-PREFIX (e.g. "369dde3c"), not the full 36-char task UUID that `resolveProjectTaskId` resolves
// every caller's `taskId` to. `db.listQuestionsForTask`'s plain `task_id = ?` equality never matched
// those legacy rows, so a manager reading a card's connected requests via tasks_get/task_requests_list
// saw NONE even though the owner had already answered one — an owner decision made invisible.
// Board.tsx already tolerated this UI-side (`task.id.startsWith(q.taskId + "-")`); this test proves the
// DB-query path now mirrors that same prefix tolerance.
//
// HERMETIC, claude-free — a REAL Db + the REAL TaskMcpRouter over an in-process MCP InMemoryTransport,
// with the legacy row inserted DIRECTLY via db.insertQuestion (bypassing question_ask, which — since
// card 9be9784a — resolves a prefix to the full id before storing, so it can no longer itself produce a
// genuinely-prefix-stored row; only a pre-a3f1319f row looks like this).
//
// Covers:
//   (1) a legacy 8-char-prefix-linked question surfaces in tasks_get's connected-requests summary and in
//       task_requests_list, for the task whose full id that prefix names.
//   (2) task_request_get with the full task id as the optional taskId scope also accepts the legacy link.
//   (3) NEGATIVE CONTROL — a question in ANOTHER project carrying the SAME 8-char prefix is NOT surfaced
//       (the project_id scoping guard still holds under the new OR-prefix branch).
//   (4) a full-id-linked row (the normal, post-fix case) still matches exactly as before.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-requests-legacy-prefix.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-task-requests-legacy-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const dbFile = path.join(tmpHome, "tr.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "lp-proj", otherProjId = "lp-proj-2";
const agentId = "lp-agent", mgrId = "lp-mgr";
const otherAgentId = "lp2-agent", otherMgrId = "lp2-mgr";

async function taskClient(router, projectId, sessionId) {
  const server = router.buildServer(projectId, sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "task-requests-legacy-prefix-test", version: "0" });
  await client.connect(clientT);
  return {
    client,
    call: async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text),
    callList: async (name, args) => {
      const text = (await client.callTool({ name, arguments: args })).content[0].text;
      const rows = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return rows.length === 1 && "error" in rows[0] ? rows[0] : rows;
    },
  };
}

let questionCounter = 0;
function insertLegacyQuestion(db, { sessionId, projectId, taskIdPrefix, title, state = "answered" }) {
  const id = `lp-q-${++questionCounter}`;
  db.insertQuestion({
    id, sessionId, projectId, type: "decision", title, body: "b", options: ["A", "B"], recommendation: null,
    taskId: taskIdPrefix, permissionAction: null, permissionScope: null, permissionExpiresAt: null,
    credentialEnvVar: null, state, chosenOption: state === "answered" ? "A" : null, note: null,
    createdAt: now, answeredAt: state === "answered" ? now : null, consumedAt: null,
  });
  return id;
}

try {
  db.insertProject({ id: projId, name: "LP", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: otherProjId, name: "LP2", repoPath: otherProjId, vaultPath: otherProjId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: "eng-lp", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  db.insertAgent({ id: otherAgentId, projectId: otherProjId, name: "Other Manager", startupPrompt: "", position: 0 });
  db.insertSession({
    id: otherMgrId, projectId: otherProjId, agentId: otherAgentId, engineSessionId: "eng-lp2", title: null, cwd: otherProjId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  const T = "369dde3c-0000-4000-8000-000000000001"; // full task id; its 8-char prefix is "369dde3c"
  const prefix = T.slice(0, 8);
  db.insertTask({ id: T, projectId: projId, title: "card with a legacy-linked request", body: "b", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

  // A task in the OTHER project that happens to share the SAME 8-char prefix — proves the prefix match
  // doesn't accidentally cross project boundaries via the prefix alone.
  const otherT = `${prefix}-0000-4000-9000-000000000002`;
  db.insertTask({ id: otherT, projectId: otherProjId, title: "other project, same prefix", body: "b", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

  // (1)/(2) the legacy row: task_id stored as the bare 8-char prefix, in THIS project.
  const legacyId = insertLegacyQuestion(db, { sessionId: mgrId, projectId: projId, taskIdPrefix: prefix, title: "Legacy prefix-linked decision" });

  // (3) negative control: a question in the OTHER project, ALSO carrying the same 8-char prefix.
  const foreignId = insertLegacyQuestion(db, { sessionId: otherMgrId, projectId: otherProjId, taskIdPrefix: prefix, title: "Foreign project, same prefix" });

  // (4) a normal full-id-linked row on the same task, for comparison.
  const fullId = insertLegacyQuestion(db, { sessionId: mgrId, projectId: projId, taskIdPrefix: T, title: "Full-id-linked decision" });

  const { client: tClient, call: tCall, callList: tCallList } = await taskClient(new TaskMcpRouter(db, new WakeService({
    db, pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null }, resume: () => {},
  })), projId, mgrId);

  // ---- (1) tasks_get's connected-requests summary surfaces the legacy prefix-linked row ----
  const taskRead = await tCall("tasks_get", { id: T });
  check("(1) tasks_get resolves the full-id task", !taskRead.error && taskRead.id === T);
  check("(1) requests.total counts BOTH the legacy prefix-linked row and the full-id row", taskRead.requests.total === 2);
  check("(1) requests.items includes the legacy prefix-linked question", taskRead.requests.items.some((it) => it.id === legacyId));
  check("(1) requests.items includes the full-id-linked question", taskRead.requests.items.some((it) => it.id === fullId));
  check("(1) requests.items does NOT include the foreign-project question", !taskRead.requests.items.some((it) => it.id === foreignId));

  // ---- (1) task_requests_list mirrors the same set ----
  const listed = await tCallList("task_requests_list", { taskId: T });
  check("(1) task_requests_list returns exactly the 2 in-project rows", Array.isArray(listed) && listed.length === 2);
  check("(1) task_requests_list includes the legacy prefix-linked row", listed.some((r) => r.id === legacyId && r.title === "Legacy prefix-linked decision"));

  // ---- (2) task_request_get with an explicit taskId scope accepts the legacy link ----
  const gotten = await tCall("task_request_get", { id: legacyId, taskId: T });
  check("(2) task_request_get accepts the legacy prefix-linked row when scoped to the full task id", !gotten.error && gotten.state === "answered");

  // ---- (3) negative control: the OTHER project's tasks_get must NOT see the in-project legacy row, and
  //          vice versa — the project_id scope still holds under the new OR-prefix branch.
  const { call: tCallOther } = await taskClient(new TaskMcpRouter(db, new WakeService({
    db, pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null }, resume: () => {},
  })), otherProjId, otherMgrId);
  const otherTaskRead = await tCallOther("tasks_get", { id: otherT });
  check("(3) the OTHER project's same-prefix task sees only ITS OWN question, not the first project's", otherTaskRead.requests.total === 1 && otherTaskRead.requests.items[0].id === foreignId);

  await tClient.close();
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a legacy question row whose task_id is an 8-char id-PREFIX (pre-a3f1319f) now surfaces in tasks_get's connected-requests summary and task_requests_list for the full-id task it names, and in task_request_get's optional taskId scoping; a full-id-linked row still matches exactly; and a foreign-project question carrying the SAME 8-char prefix is correctly excluded (the project_id scope survives the new OR-prefix branch)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
