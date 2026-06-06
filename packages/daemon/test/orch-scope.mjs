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

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv({ port: true }); // prod-guard: abort unless LOOM_HOME=<temp> + LOOM_PORT != 4317
const BASE = `http://127.0.0.1:${process.env.LOOM_PORT || 4317}`;
const now = new Date().toISOString();

// --- seed the daemon's DB directly ---
const db = new Database(path.join(process.env.LOOM_HOME || path.join(os.homedir(), ".loom"), "loom.db"));
db.exec("DELETE FROM orchestration_events; DELETE FROM schedules; DELETE FROM tasks; DELETE FROM sessions; DELETE FROM agents; DELETE FROM profiles; DELETE FROM projects;");
db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
  .run("projO", "Orch", "C:/tmp/o", "C:/tmp/o", "{}", now);
// A SECOND project + agent — agent_list on a projO manager must NEVER surface projX's agent (scope proof).
db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
  .run("projX", "Other", "C:/tmp/x", "C:/tmp/x", "{}", now);
db.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)")
  .run("aX", "projX", "other-work", "");
// A Dev profile (role 'worker') bound to a projO agent — exercises agent_list's resolved-role field.
db.prepare("INSERT INTO profiles (id,name,role,description,allow_delta,skills,model,icon) VALUES (?,?,?,?,?,?,?,?)")
  .run("profDev", "Dev", "worker", "", "[]", null, null, null);
db.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)")
  .run("tO", "projO", "work", "");
db.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position,profile_id) VALUES (?,?,?,?,1,?)")
  .run("tD", "projO", "dev-rig", "", "profDev");
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
// Give M a KNOWN measured occupancy (120k of a 1M Opus window → pct 12) so my_context is deterministic;
// W1 stays unmeasured (ctx_input_tokens NULL) to exercise the pct:null + note path.
db.prepare("UPDATE sessions SET ctx_input_tokens=?, ctx_updated_at=?, model=? WHERE id=?")
  .run(120_000, now, "claude-opus-4-8", "M");
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
// the worker_* coordination surface + my_context (own-occupancy self-assessment, any role) + the
// manager self-management tools (daemon_restart self-deploy, idle_report for the asleep-at-the-wheel
// watcher, inbox_pull fast-drain, recycle_me for context-recycle) + the manager self-service management
// surface (agent_list read-only directory, agent_assign_profile/agent_update, project_update/project_archive,
// schedule_create/schedule_update — Task 3de74275) + platform_escalate (the one upward channel to the
// Platform Lead). Keep in sync as the manager-MCP surface grows.
const expected = "agent_assign_profile,agent_list,agent_update,daemon_restart,idle_report,inbox_pull,my_context,platform_escalate,project_archive,project_update,recycle_me,schedule_create,schedule_update,worker_list,worker_merge,worker_merge_confirm,worker_message,worker_recycle,worker_spawn,worker_status,worker_stop,worker_transcript";
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

// 4b) my_context (no args) returns M's OWN measured occupancy — server-derived from the URL path,
//     so there's no way to ask about another session. M was seeded with 120k of a 1M Opus window.
const myCtx = parse(await M.callTool({ name: "my_context", arguments: {} }));
check(`my_context(M) = {ctxInputTokens:120000, contextWindow:1M, pct:12, model:opus-4-8} (got ${JSON.stringify(myCtx)})`,
  myCtx.ctxInputTokens === 120_000 && myCtx.contextWindow === 1_000_000 && myCtx.pct === 12 &&
  myCtx.model === "claude-opus-4-8" && myCtx.measuredAt === now);

// 4c) agent_list (no args) — project-scoped SERVER-SIDE: M (in projO) sees projO's agents [tO, tD]
//     ordered by position, and NEVER projX's agent aX. Carries id/name/role/profileId/position; the
//     role is resolved from the bound profile (tD→'worker' via profDev; tO→null, no profile).
const agents = parse(await M.callTool({ name: "agent_list", arguments: {} }));
const ids = agents.map((a) => a.id);
check(`agent_list on M = projO's agents [tO,tD] by position, NEVER projX's aX  (got ${JSON.stringify(ids)})`,
  ids.length === 2 && ids[0] === "tO" && ids[1] === "tD" && !ids.includes("aX"));
const tD = agents.find((a) => a.id === "tD");
const tO = agents.find((a) => a.id === "tO");
check("agent_list DTO carries name/profileId/position + role resolved from the bound profile",
  tD?.name === "dev-rig" && tD?.profileId === "profDev" && tD?.role === "worker" && tD?.position === 1 &&
  tO?.role === null && tO?.profileId === null);

await M.close();

// 5) ROLE-BASED surface: a WORKER connects but sees ONLY [my_context, worker_report] (no manager
//    coordination tools — the depth-1 tree holds at the surface, not just a gate). my_context is the
//    own-occupancy self-assessment tool, available to any role; worker_report is NOT a manager tool.
const W = await connect("W1");
const wTools = (await W.listTools()).tools.map((t) => t.name).sort();
check(`worker W1 sees ONLY [my_context, worker_report]  (got ${wTools.join(",")})`, wTools.join(",") === "my_context,worker_report");
// my_context on an UNMEASURED session (W1 has no ctx_input_tokens) → pct null + a note, never a fake 0.
const wCtx = parse(await W.callTool({ name: "my_context", arguments: {} }));
check(`my_context(W1) unmeasured → ctxInputTokens null, pct null, note present (got ${JSON.stringify(wCtx)})`,
  wCtx.ctxInputTokens === null && wCtx.pct === null && typeof wCtx.note === "string" && wCtx.note.length > 0);
await W.close();

// A PLAIN session (no role) still gets nothing — connect is rejected (404 → throw).
const rejected = async (id) => { try { const c = await connect(id); await c.close(); return false; } catch { return true; } };
check("plain session P still rejected (no orchestration surface)", await rejected("P"));

console.log(failures === 0
  ? "\nALL PASS — orchestration MCP is manager-scoped and role-gated (only managers, only own workers)."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
