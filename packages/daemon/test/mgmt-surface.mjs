// Manager self-service management surface test (Task 3de74275, Option B). Mirrors orch-scope.mjs /
// platform-scope.mjs: seeds the daemon's DB directly, drives a REAL MCP client over StreamableHTTP,
// NO claude. Proves the six new MANAGER-ONLY tools work end-to-end (visible via REST), that the
// trust-boundary guardrails hold (gateCommand rejected on the agent path; a profile can only be
// ASSIGNED if a human already minted it — a non-existent profileId is rejected; profile CREATE/edit
// is NOT on the surface), and that a WORKER never sees any of them (role gate at the surface).
//
// RUN against a fresh isolated LOOM_HOME daemon:
//   1) LOOM_HOME=<temp> node dist/index.js
//   2) LOOM_HOME=<temp> node test/mgmt-surface.mjs        (SAME LOOM_HOME)
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "@loom/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv({ port: true }); // prod-guard: abort unless LOOM_HOME=<temp> + LOOM_PORT != 4317
const BASE = `http://127.0.0.1:${process.env.LOOM_PORT || 4317}`;
const LOOM = process.env.LOOM_HOME || path.join(os.homedir(), ".loom");
const now = new Date().toISOString();
const get = async (u) => (await fetch(BASE + u)).json();
const patchJson = async (u, body) => {
  const r = await fetch(BASE + u, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

// --- seed the daemon's DB directly: a project + agent, a human-authored profile, and one session per role ---
const db = new Database(path.join(LOOM, "loom.db"));
db.exec("DELETE FROM orchestration_events; DELETE FROM schedules; DELETE FROM tasks; DELETE FROM sessions; DELETE FROM agents; DELETE FROM profiles; DELETE FROM projects;");
db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
  .run("projM", "Mgmt", "C:/tmp/m", "C:/tmp/m", "{}", now);
db.prepare("INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
  .run("projArch", "ToArchive", "C:/tmp/a", "C:/tmp/a", "{}", now);
db.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position,profile_id) VALUES (?,?,?,?,0,NULL)")
  .run("tM", "projM", "lead", "do the thing");
// A human-authored profile (the only kind that exists — profile CREATE is human-only). Assignable.
db.prepare("INSERT INTO profiles (id,name,role,description,allow_delta,skills,model,icon,browser_testing) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("profQA", "QA Tester", "worker", "browser rig", "[]", null, null, null, 1);
const sess = db.prepare(`INSERT INTO sessions
  (id,project_id,agent_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role,parent_session_id)
  VALUES (@id,'projM','tM',NULL,NULL,'C:/tmp/m','live','unknown',0,@now,@now,NULL,@role,@parent)`);
sess.run({ id: "M", now, role: "manager", parent: null }); // manager under test
sess.run({ id: "W", now, role: "worker", parent: "M" });   // its worker
sess.run({ id: "P", now, role: null, parent: null });      // plain
db.close();

async function connect(base, sessionId) {
  const client = new Client({ name: "mgmt-surface-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/${base}/${sessionId}`)));
  return client;
}
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (c, name, args) => parse(await c.callTool({ name, arguments: args }));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const M = await connect("mcp-orch", "M");

// 0) Surface: the manager sees the six new management tools alongside the existing surface.
const mTools = (await M.listTools()).tools.map((t) => t.name);
const six = ["agent_assign_profile", "agent_update", "project_update", "project_archive", "schedule_create", "schedule_update"];
check(`manager surface includes all six management tools (missing: ${six.filter((t) => !mTools.includes(t)).join(",") || "none"})`,
  six.every((t) => mTools.includes(t)));

// 1) agent_assign_profile — ASSIGN an existing human-authored profile (the core QA-rig fix).
const assigned = await call(M, "agent_assign_profile", { agentId: "tM", profileId: "profQA" });
check("agent_assign_profile: assigns an existing profile (no error)", assigned.profileId === "profQA" && !assigned.error);
const agentsAfter = await get("/api/projects/projM/agents");
check("agent_assign_profile: REST reflects the assignment", agentsAfter.find((a) => a.id === "tM")?.profileId === "profQA");

// 1a) GUARDRAIL (no-capability-minting): a non-existent profileId is REJECTED (can't conjure a rig).
const badProfile = await call(M, "agent_assign_profile", { agentId: "tM", profileId: "does-not-exist" });
check("agent_assign_profile: non-existent profileId rejected (no minting)", badProfile.error === "profile not found");
check("agent_assign_profile: a rejected assign left the prior assignment intact",
  (await get("/api/projects/projM/agents")).find((a) => a.id === "tM")?.profileId === "profQA");

// 1b) profileId: null clears the assignment.
const cleared = await call(M, "agent_assign_profile", { agentId: "tM", profileId: null });
check("agent_assign_profile: null clears the assignment", cleared.profileId === null && !cleared.error);

// 2) agent_update — name (title) + startupPrompt; reflected via REST. Structural only.
const updated = await call(M, "agent_update", { agentId: "tM", name: "lead-2", startupPrompt: "new brief" });
check("agent_update: updates name + startupPrompt", updated.name === "lead-2" && updated.startupPrompt === "new brief" && !updated.error);
const agentRest = (await get("/api/projects/projM/agents")).find((a) => a.id === "tM");
check("agent_update: REST reflects the edit", agentRest.name === "lead-2" && agentRest.startupPrompt === "new brief");
check("agent_update: a missing agent is rejected", (await call(M, "agent_update", { agentId: "nope", name: "x" })).error === "agent not found");

// 3) project_update — structural (name/vaultPath) + a VALID config override.
const newVaultPath = path.join(os.tmpdir(), "m2");
const pu = await call(M, "project_update", { projectId: "projM", name: "Mgmt-2", vaultPath: newVaultPath });
check("project_update: updates name + vaultPath", pu.name === "Mgmt-2" && pu.vaultPath === newVaultPath && !pu.error);
const okCfg = await call(M, "project_update", { projectId: "projM", config: { kanbanColumns: [{ key: "a", label: "A", role: "defaultLanding" }, { key: "b", label: "B", role: "terminal" }] } });
check("project_update: a valid config override is accepted", !okCfg.error);
const board = await get("/api/projects/projM/board");
check("project_update: resolveConfig reflects the config override (board columns)", board.columns.length === 2);

// 3a) TRUST BOUNDARY — orchestration.gateCommand (host-RCE) is REJECTED on the agent path.
const rce = await call(M, "project_update", { projectId: "projM", config: { orchestration: { gateCommand: "calc.exe" } } });
check("project_update: REJECTS orchestration.gateCommand (agent path)", typeof rce.error === "string" && rce.error.includes("invalid config"));
const projAfterRce = (await get("/api/projects")).find((p) => p.id === "projM");
check("project_update: rejected gateCommand left stored config UNCHANGED (default gateCommand)",
  resolveConfig(projAfterRce.config).orchestration.gateCommand === "" &&
  JSON.stringify((await get("/api/projects/projM/board")).columns) === JSON.stringify(board.columns));
// 3b) An unknown config key is rejected too (strict schema — same reject-set posture).
const badKey = await call(M, "project_update", { projectId: "projM", config: { alertWebhook: "http://evil" } });
check("project_update: REJECTS an unknown config key (e.g. alertWebhook)", typeof badKey.error === "string");
// 3c) The HUMAN REST path keeps full power — it still accepts gateCommand.
const restGate = await patchJson("/api/projects/projM/config", { config: { orchestration: { gateCommand: "pnpm build && pnpm test" } } });
check("trust-boundary: REST PATCH still accepts gateCommand (human path)", restGate.status === 200 && !restGate.body.error);

// 4) schedule_create — valid cron schedule appears via REST; invalid cron + missing agent rejected.
const sched = await call(M, "schedule_create", { agentId: "tM", cron: "0 9 * * *" });
check("schedule_create: returns a schedule with an id + computed nextFireAt", !!sched.id && !!sched.nextFireAt && !sched.error);
check("schedule_create: the schedule appears via GET /api/schedules", (await get("/api/schedules")).some((s) => s.id === sched.id));
check("schedule_create: an invalid cron expression is rejected", (await call(M, "schedule_create", { agentId: "tM", cron: "not a cron" })).error === "invalid cron expression");
check("schedule_create: a missing agent is rejected", (await call(M, "schedule_create", { agentId: "nope", cron: "0 9 * * *" })).error === "agent not found");

// 5) schedule_update — toggle enabled + change cron (recomputes nextFireAt); invalid cron rejected.
const su = await call(M, "schedule_update", { scheduleId: sched.id, enabled: false, cron: "30 8 * * *" });
check("schedule_update: applies enabled=false + new cron", su.enabled === false && su.cron === "30 8 * * *" && !su.error);
check("schedule_update: an invalid cron is rejected", (await call(M, "schedule_update", { scheduleId: sched.id, cron: "bogus" })).error === "invalid cron expression");
check("schedule_update: a missing schedule is rejected", (await call(M, "schedule_update", { scheduleId: "nope", enabled: true })).error === "schedule not found");

// 6) project_archive — own-project-scope trust boundary (commit 6008062, business-rule coverage lives
//    in mgr-own-project-scope.mjs, which calls the service directly). This proves the SAME boundary
//    holds over the REAL wire — the MCP tool actually returns an {error} shape instead of throwing raw
//    — plus the end-to-end success path. Runs LAST for M: archiving M's own project (projM) would break
//    every earlier check above that references projM/tM, so this can't run any earlier.
check("project_archive: projArch (a DIFFERENT project) is present before the rejected attempt", (await get("/api/projects")).some((p) => p.id === "projArch"));
const archForeign = await call(M, "project_archive", { projectId: "projArch" });
check("project_archive: a projectId outside M's own project is REJECTED (trust boundary)",
  typeof archForeign.error === "string" && /outside your project/.test(archForeign.error));
check("project_archive: the rejected attempt left projArch un-archived", (await get("/api/projects")).some((p) => p.id === "projArch"));
const archOwn = await call(M, "project_archive", { projectId: "projM" });
check("project_archive: M's OWN project succeeds", archOwn.archived === true && !archOwn.error);
check("project_archive: projM no longer in the active list", !(await get("/api/projects")).some((p) => p.id === "projM"));

await M.close();

// 7) ROLE GATE — a WORKER connects but sees ONLY {gate_status, my_context, run_gate, worker_report}; NONE
//    of the management tools. (This assertion was already stale before card 7f96aa09 — it never accounted
//    for my_context, added to the worker branch by 5561afb8 — fixed as a drive-by while updating it for
//    run_gate, the same worker-surface-enumeration assertion category. gate_status, card fc243a43's
//    read-only own-op-scoped complement to run_gate, is the latest addition.)
const W = await connect("mcp-orch", "W");
const wTools = (await W.listTools()).tools.map((t) => t.name).sort();
check(`role-gate: worker sees ONLY [gate_status, my_context, run_gate, worker_report] (got ${wTools.join(",")})`, wTools.join(",") === "gate_status,my_context,run_gate,worker_report");
check("role-gate: worker sees NONE of the six management tools", six.every((t) => !wTools.includes(t)));
await W.close();
// A plain session gets no orchestration surface at all (404 → throw).
const rejected = async (id) => { try { const c = await connect("mcp-orch", id); await c.close(); return false; } catch { return true; } };
check("role-gate: plain session rejected (no orchestration surface)", await rejected("P"));

// 8) agent_create profileId (platform surface, Task item 2): the platform-lead path may ASSIGN an
//    existing profile at create time (stops the inert profileId:null hardcode) but cannot mint one.
//    Seed a platform session and exercise it directly.
const db2 = new Database(path.join(LOOM, "loom.db"));
db2.prepare(`INSERT INTO sessions
  (id,project_id,agent_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role,parent_session_id)
  VALUES (@id,'projM','tM',NULL,NULL,'C:/tmp/m','live','unknown',0,@now,@now,NULL,'platform',NULL)`).run({ id: "PL", now });
db2.close();
const PL = await connect("mcp-platform", "PL");
const ac = await call(PL, "agent_create", { projectId: "projM", name: "qa", startupPrompt: "test", profileId: "profQA" });
check("agent_create: assigns an existing profileId (no inert profileId:null)", ac.profileId === "profQA" && !ac.error);
const acBad = await call(PL, "agent_create", { projectId: "projM", name: "qa2", profileId: "ghost" });
check("agent_create: a non-existent profileId is rejected (no minting)", acBad.error === "profile not found" && !acBad.id);
await PL.close();

console.log(failures === 0
  ? "\n✅ ALL PASS — the manager self-service management surface works end-to-end (assign profile / update agent / update+archive project / create+update schedule), the trust-boundary guardrails hold (gateCommand rejected on the agent path; profiles can only be ASSIGNED, never minted), and workers/plain sessions never see it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
