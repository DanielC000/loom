// Platform MCP scope + guardrails test (PR #20, Pillar C). orch-scope style: seeds the daemon's DB
// directly, drives a REAL MCP client over StreamableHTTP, no claude. Proves the loom-platform
// surface is role-gated to 'platform' (manager/worker/plain → 404), that its three tools
// create/configure projects + topics end-to-end (visible via the REST API), and that the guardrails
// reject a bad repoPath (missing / non-git) and an invalid config (both project_create + configure).
//
// RUN against a fresh isolated LOOM_HOME daemon (real git is used for the repo guardrail):
//   1) LOOM_HOME=<temp> node dist/index.js
//   2) LOOM_HOME=<temp> node test/platform-scope.mjs        (SAME LOOM_HOME)
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { resolveConfig } from "@loom/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = "http://127.0.0.1:4317";
const LOOM = process.env.LOOM_HOME;
if (!LOOM) { console.error("LOOM_HOME must be set (and match the daemon's)."); process.exit(2); }
const get = async (u) => (await fetch(BASE + u)).json();
const now = new Date().toISOString();

// --- seed the daemon's DB directly: a host project/topic + one session per role ---
const db = new Database(path.join(LOOM, "loom.db"));
db.exec("DELETE FROM orchestration_events; DELETE FROM tasks; DELETE FROM sessions; DELETE FROM topics; DELETE FROM projects;");
db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
  .run("projPL", "Platform", "C:/tmp/pl", "C:/tmp/pl", "{}", now);
db.prepare("INSERT INTO topics (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)").run("tPL", "projPL", "lead", "");
const sess = db.prepare(`INSERT INTO sessions
  (id,project_id,topic_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role,parent_session_id)
  VALUES (@id,'projPL','tPL',NULL,NULL,'C:/tmp/pl','live','unknown',0,@now,@now,NULL,@role,@parent)`);
sess.run({ id: "PL", now, role: "platform", parent: null }); // platform-lead under test
sess.run({ id: "M", now, role: "manager", parent: null });
sess.run({ id: "W", now, role: "worker", parent: "M" });
sess.run({ id: "P", now, role: null, parent: null }); // plain
db.close();

async function connect(sessionId) {
  const client = new Client({ name: "platform-scope-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp-platform/${sessionId}`)));
  return client;
}
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (c, name, args) => parse(await c.callTool({ name, arguments: args }));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- temp dirs for the repo guardrail: one real git repo, one plain (non-git) dir ---
const gitRepo = path.join(os.tmpdir(), `loom-plat-repo-${Date.now()}`);
const nonGit = path.join(os.tmpdir(), `loom-plat-nongit-${Date.now()}`);
const missing = path.join(os.tmpdir(), `loom-plat-missing-${Date.now()}`); // never created
fs.mkdirSync(gitRepo, { recursive: true });
fs.writeFileSync(path.join(gitRepo, "README.md"), "# platform test repo\n");
execSync(`git init -q && git add . && git -c user.email=p@loom -c user.name=p commit -q -m "init"`, { cwd: gitRepo });
fs.mkdirSync(nonGit, { recursive: true });

try {
  // 1) Role gate: a platform-lead sees exactly the three platform tools.
  const PL = await connect("PL");
  const tools = (await PL.listTools()).tools.map((t) => t.name).sort();
  check(`tools = project_configure,project_create,topic_create  (got ${tools.join(",")})`,
    tools.join(",") === "project_configure,project_create,topic_create");

  // 2) project_create with a REAL git repo → created + visible via the API. vaultPath omitted → defaults to repoPath.
  const before = (await get("/api/projects")).length;
  const created = await call(PL, "project_create", { name: "Created", repoPath: gitRepo });
  check("project_create: returns a project with an id", !!created.id && !created.error);
  check("project_create: vaultPath defaults to repoPath", created.vaultPath === gitRepo);
  const list = await get("/api/projects");
  check("project_create: the project appears via GET /api/projects", list.some((p) => p.id === created.id) && list.length === before + 1);

  // 3) topic_create under the new project → created + visible.
  const topic = await call(PL, "topic_create", { projectId: created.id, name: "work", startupPrompt: "go" });
  check("topic_create: returns a topic with an id", !!topic.id && !topic.error);
  const topics = await get(`/api/projects/${created.id}/topics`);
  check("topic_create: the topic appears under the project", topics.some((t) => t.id === topic.id && t.startupPrompt === "go"));

  // 4) project_configure with a valid override → applied; resolveConfig reflects it (via /board).
  const cfg = { kanbanColumns: [{ key: "a", label: "A" }, { key: "b", label: "B" }] };
  const configured = await call(PL, "project_configure", { projectId: created.id, config: cfg });
  check("project_configure: accepted (no error)", configured.ok === true && !configured.error);
  const board = await get(`/api/projects/${created.id}/board`);
  check("project_configure: resolveConfig reflects the override (board columns)",
    JSON.stringify(board.columns) === JSON.stringify(cfg.kanbanColumns));
  const projAfter = (await get("/api/projects")).find((p) => p.id === created.id);
  check("project_configure: resolveConfig(project.config) reflects it too",
    resolveConfig(projAfter.config).kanbanColumns.length === 2);

  // 5) Guardrail — repoPath that does not exist → rejected, no project created.
  const n1 = (await get("/api/projects")).length;
  const badMissing = await call(PL, "project_create", { name: "Nope", repoPath: missing });
  check("guardrail: non-existent repoPath rejected", typeof badMissing.error === "string" && !badMissing.id);
  check("guardrail: non-existent repoPath created NO project", (await get("/api/projects")).length === n1);

  // 6) Guardrail — a real dir that is NOT a git repo → rejected, no project created.
  const badNonGit = await call(PL, "project_create", { name: "Nope2", repoPath: nonGit });
  check("guardrail: non-git dir rejected", typeof badNonGit.error === "string" && !badNonGit.id);
  check("guardrail: non-git dir created NO project", (await get("/api/projects")).length === n1);

  // 7) Guardrail — invalid config rejected by BOTH project_create and project_configure.
  const badCfgCreate = await call(PL, "project_create", { name: "Nope3", repoPath: gitRepo, config: { bogusField: 1 } });
  check("guardrail: project_create with an unknown config field rejected", typeof badCfgCreate.error === "string" && !badCfgCreate.id);
  check("guardrail: invalid-config create made NO project", (await get("/api/projects")).length === n1);
  const badCfgConfigure = await call(PL, "project_configure", { projectId: created.id, config: { orchestration: { maxConcurrentWorkers: "five" } } });
  check("guardrail: project_configure with a bad type rejected", typeof badCfgConfigure.error === "string" && !badCfgConfigure.ok);
  const boardStill = await get(`/api/projects/${created.id}/board`);
  check("guardrail: a rejected configure did NOT change the project's config", JSON.stringify(boardStill.columns) === JSON.stringify(cfg.kanbanColumns));

  await PL.close();

  // 8) Role gate negative: manager / worker / plain get NO platform surface (connect → 404 → throw).
  const rejected = async (id) => { try { const c = await connect(id); await c.close(); return false; } catch { return true; } };
  check("role-gate: manager M gets no platform surface", await rejected("M"));
  check("role-gate: worker W gets no platform surface", await rejected("W"));
  check("role-gate: plain session P gets no platform surface", await rejected("P"));
} finally {
  for (const d of [gitRepo, nonGit]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — loom-platform is role-gated to platform-leads; project_create/topic_create/project_configure work end-to-end (schema-validated); guardrails reject a missing/non-git repo and an invalid config without creating anything."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
