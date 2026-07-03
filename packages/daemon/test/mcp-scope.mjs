// End-to-end MCP auto-scoping test (§6). Seeds two projects + sessions, then drives the
// REAL MCP client through the daemon and asserts each session sees ONLY its project's tasks.
// Run: 1) start the daemon (node dist/index.js), 2) node test/mcp-scope.mjs
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv({ port: true }); // prod-guard: abort unless LOOM_HOME=<temp> + LOOM_PORT != 4317
const BASE = `http://127.0.0.1:${process.env.LOOM_PORT || 4317}`;
const now = new Date().toISOString();

// --- seed the daemon's DB directly ---
const db = new Database(path.join(process.env.LOOM_HOME || path.join(os.homedir(), ".loom"), "loom.db"));
db.exec("DELETE FROM tasks; DELETE FROM sessions; DELETE FROM agents; DELETE FROM projects;");
const proj = db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)");
proj.run("projA", "Alpha", "C:/tmp/a", "C:/tmp/a", "{}", now);
proj.run("projB", "Beta", "C:/tmp/b", "C:/tmp/b", "{}", now);
const agent = db.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)");
agent.run("tA", "projA", "work", "");
agent.run("tB", "projB", "work", "");
const sess = db.prepare("INSERT INTO sessions (id,project_id,agent_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error) VALUES (?,?,?,NULL,NULL,?,'live','unknown',0,?,?,NULL)");
sess.run("SA", "projA", "tA", "C:/tmp/a", now, now);
sess.run("SB", "projB", "tB", "C:/tmp/b", now, now);
const task = db.prepare("INSERT INTO tasks (id,project_id,title,body,column_key,position,created_at,updated_at) VALUES (?,?,?,'','backlog',?,?,?)");
task.run("taskAlpha", "projA", "ALPHA-TASK", 1, now, now);
task.run("taskBeta", "projB", "BETA-TASK", 1, now, now);
db.close();

async function connect(sessionId) {
  const client = new Client({ name: "scope-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${sessionId}`)));
  return client;
}
// tasks_list returns NEWLINE-DELIMITED JSON (one task per line, card dc647ae2) — not a JSON array.
const titles = (res) => res.content[0].text.split("\n").filter(Boolean).map((l) => JSON.parse(l).title);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const A = await connect("SA");
const B = await connect("SB");

// 1) Tool schema has NO projectId parameter (scoping is implicit).
const tools = await A.listTools();
const names = tools.tools.map((t) => t.name).sort();
// tasks_* (the project-scoped board) + wake_* (the self-scheduled wake_me primitive) — both ride the
// per-session loom-tasks surface. Keep this list in sync as the tasks-MCP tool surface grows.
const expectedTaskTools = "tasks_create,tasks_get,tasks_list,tasks_update,wake_cancel,wake_list,wake_me";
check(`tools = ${expectedTaskTools}  (got ${names.join(",")})`,
  names.join(",") === expectedTaskTools);
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
console.log(failures === 0 ? "\nALL PASS — MCP auto-scoping holds (§6)." : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
