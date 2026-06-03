// Orchestration MCP scope + role-gate test (PR #13a). Mirrors mcp-scope.mjs: seeds the daemon's
// DB directly, drives a REAL MCP client over StreamableHTTP, no claude. Proves a manager sees ONLY
// its own workers (manager derived from the URL path, server-side — no managerId param) and that
// non-managers (workers / plain sessions) get no orchestration surface at all (role gate -> 404).
// Run: 1) start the daemon (node dist/index.js), 2) node test/orch-scope.mjs
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = `http://127.0.0.1:${process.env.LOOM_PORT || 4317}`;
const now = new Date().toISOString();

// --- seed the daemon's DB directly ---
const db = new Database(path.join(process.env.LOOM_HOME || path.join(os.homedir(), ".loom"), "loom.db"));
db.exec("DELETE FROM orchestration_events; DELETE FROM tasks; DELETE FROM sessions; DELETE FROM agents; DELETE FROM projects;");
db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
  .run("projO", "Orch", "C:/tmp/o", "C:/tmp/o", "{}", now);
db.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)")
  .run("tO", "projO", "work", "");
const sess = db.prepare(`INSERT INTO sessions
  (id,project_id,agent_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role,parent_session_id,task_id,branch)
  VALUES (@id,'projO','tO',NULL,NULL,'C:/tmp/o','live','unknown',@busy,@now,@now,NULL,@role,@parent,@taskId,@branch)`);
const mk = (id, role, parent, extra = {}) =>
  sess.run({ id, busy: extra.busy ?? 0, now, role, parent, taskId: extra.taskId ?? null, branch: extra.branch ?? null });
mk("M", "manager", null);                                            // manager under test
mk("W1", "worker", "M", { taskId: "task-w1", branch: "loom/task-w1", busy: 1 }); // M's worker
mk("M2", "manager", null);                                           // a second manager
mk("W2", "worker", "M2", { taskId: "task-w2", branch: "loom/task-w2" });         // M2's worker (NOT M's)
mk("P", null, null);                                                 // plain session (no role)
db.close();

async function connect(sessionId) {
  const client = new Client({ name: "orch-scope-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp-orch/${sessionId}`)));
  return client;
}
const parse = (res) => JSON.parse(res.content[0].text);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const M = await connect("M");

// 1) the manager's tool surface (read tools + lifecycle/messaging/recycle/merge-gate actions).
const toolList = (await M.listTools()).tools;
const tools = toolList.map((t) => t.name).sort();
const expected = "worker_list,worker_merge,worker_merge_confirm,worker_message,worker_recycle,worker_spawn,worker_status,worker_stop,worker_transcript";
check(`tools = ${expected}  (got ${tools.join(",")})`, tools.join(",") === expected);

// 1b) H3: worker_spawn's advertised schema carries taskId + kickoffPrompt but NOT the removed,
//     accepted-but-ignored skipPermissions field (a footgun that misled a manager).
const spawnProps = toolList.find((t) => t.name === "worker_spawn")?.inputSchema?.properties ?? {};
check("worker_spawn schema = {taskId, agentId, kickoffPrompt}, NO skipPermissions (H3)",
  "taskId" in spawnProps && "kickoffPrompt" in spawnProps && !("skipPermissions" in spawnProps));

// 2) worker_list is manager-scoped by construction — M sees W1 only, never W2.
const list = parse(await M.callTool({ name: "worker_list", arguments: {} }));
check(`worker_list on M returns exactly [W1]  (got ${JSON.stringify(list.map((w) => w.workerSessionId))})`,
  list.length === 1 && list[0].workerSessionId === "W1");
check("worker_list DTO carries taskId + branch + busy",
  list[0].taskId === "task-w1" && list[0].branch === "loom/task-w1" && list[0].busy === true);

// 3) worker_status: own worker returns the row; another manager's worker is denied.
const st1 = parse(await M.callTool({ name: "worker_status", arguments: { workerSessionId: "W1" } }));
check("worker_status(W1) on M returns W1's row", st1.id === "W1" && st1.parentSessionId === "M");
const st2 = parse(await M.callTool({ name: "worker_status", arguments: { workerSessionId: "W2" } }));
check("worker_status(W2) on M denied (cross-manager) → 'not your worker'", st2.error === "not your worker");

// 4) worker_transcript returns an array (empty is fine — no real engine transcript seeded).
const tx = parse(await M.callTool({ name: "worker_transcript", arguments: { workerSessionId: "W1" } }));
check("worker_transcript(W1) returns an array", Array.isArray(tx));

await M.close();

// 5) ROLE-BASED surface: a WORKER connects but sees ONLY worker_report (no manager tools —
//    the depth-1 tree holds at the surface, not just a gate). worker_report is NOT a manager tool.
const W = await connect("W1");
const wTools = (await W.listTools()).tools.map((t) => t.name).sort();
check(`worker W1 sees ONLY [worker_report]  (got ${wTools.join(",")})`, wTools.join(",") === "worker_report");
await W.close();

// A PLAIN session (no role) still gets nothing — connect is rejected (404 → throw).
const rejected = async (id) => { try { const c = await connect(id); await c.close(); return false; } catch { return true; } };
check("plain session P still rejected (no orchestration surface)", await rejected("P"));

console.log(failures === 0
  ? "\nALL PASS — orchestration MCP is manager-scoped and role-gated (only managers, only own workers)."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
