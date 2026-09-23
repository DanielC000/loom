import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f4bc2d11: every tool REALLY registered on a role's MCP surface must be NAMED in that role's shipped
// doctrine skill (packages/daemon/assets/skills/<skill>/SKILL.md or its references/**), or carry an entry in
// the commented ALLOWLIST below. Origin: platform-audit's skill called the Auditor surface a CLOSED set while
// omitting the registered `requests_list` — doctrine for a tool then lives only in a per-agent prompt, which
// does not survive a respawn from a different prompt.
//
// Registered tools are read the way agent-prompt-lint-surface-drift.mjs reads them: build the REAL routers and
// listTools() over an in-process transport (never a grep for registerTool, which would drift).
//
// "NAMED" = the tool name appears as a whole token (not a substring of a longer identifier) in SKILL.md OR any
// file under that skill's references/**. references/** counts because a skill legitimately pushes detail into
// on-demand references; SKILL.md-only would force ambient bloat. This is a name-PRESENCE check (not that the
// doctrine explains the tool correctly, and not that an agent ever opens a reference).
//
// ROLE -> SKILL MAPPING (explicit; source: each skill's own description):
//   manager           -> orchestrate        (orchestration router, manager role + loom-tasks manager)
//   worker            -> worker             (orchestration router, worker role + loom-tasks worker)
//   platform          -> platform-lead      (loom-platform)
//   auditor           -> platform-audit     (loom-audit)
//   workspace-auditor -> workspace-audit    (loom-user-audit)
//   setup             -> setup-assistant    (loom-setup)
// A surface with NO doctrine skill (assistant/companion, operator, run) is NOT checked; it is listed in
// NO_DOCTRINE_SKILL below and printed as SKIP, so the exemption is a visible decision, not a silent skip.
// A surface that gains a skill should be moved into SURFACES.
//
// Run: 1) build, 2) node test/role-surface-tools-named-in-doctrine.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rstd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
const repo = path.join(tmpHome, "repo");
fs.mkdirSync(repo, { recursive: true });

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");
const { WorkspaceAuditMcpRouter } = await import("../dist/mcp/user-audit.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const skillsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "skills");

// ALLOWLIST of deliberate omissions: "<surface id>:<tool>" -> one-line reason. Every entry must still be
// registered AND still unnamed (checked below), so a stale entry fails rather than silently lingering.
// Two kinds of reason, distinguished by prefix so a reader can tell a decision from a debt:
//   SELF: — a deliberate omission: plain CRUD/read whose tool description IS the contract; no procedure to teach.
//   GAP:  — a KNOWN doctrine gap seeded so the test can land green; each is a follow-up (see the card report),
//           NOT an endorsement. Fix by naming the tool in the skill, then delete the entry (the stale-entry
//           check below forces that deletion).
const ALLOWLIST = {};
const allow = (surface, tools, reason) => { for (const t of tools) ALLOWLIST[`${surface}:${t}`] = reason; };

allow("orchestration manager", ["agent_assign_profile", "agent_delete", "profile_delete", "project_archive", "project_update",
  "board_column_create", "board_column_delete", "board_column_rename"], "SELF: admin CRUD; tool description is the contract");
allow("orchestration manager", ["schedule_create", "schedule_get", "schedule_list", "schedule_update"], "SELF: recurring-schedule CRUD; tool description is the contract");
allow("orchestration manager", ["worker_relink"], "SELF: explicit self-heal backstop every per-worker tool already runs automatically; description is the contract");
allow("loom-tasks (manager)", ["wake_cancel", "wake_list"], "SELF: siblings of wake_me, which is named; description is the contract");
allow("loom-tasks (manager)", ["tasks_defer_item", "tasks_defer_item_ack"], "SELF: structured defer-item hand-off between cards; description is the contract");
allow("loom-tasks (worker)", ["memory_forget"], "SELF: rarely-needed inverse of memory_write; description is the contract");
allow("loom-tasks (worker)", ["tasks_defer_item", "tasks_defer_item_ack"], "SELF: structured defer-item hand-off between cards; description is the contract");
allow("platform", ["agent_clone", "agent_clone_batch", "agent_create", "agent_delete", "agent_get", "agent_update", "profile_assign",
  "profile_delete", "profile_get", "project_archive", "project_create", "project_get", "project_init", "project_update",
  "schedule_create", "schedule_delete", "schedule_get", "schedule_update", "platform_config_get", "project_memory_search",
  "agent_prompt_search", "template_apply", "template_list", "skill_list"], "SELF: admin CRUD/read; tool description is the contract");

// Surfaces with no shipped doctrine skill — not checked (see header).
const NO_DOCTRINE_SKILL = {
  "assistant (orchestration + loom-tasks)": "no assistant/companion doctrine skill ships under assets/skills",
  "operator (loom-operator)": "opt-in, human-spawned; no doctrine skill ships",
  "run (loom-run)": "run sessions are prompt-driven; no doctrine skill ships",
};

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "p1", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "a1", projectId: "p1", name: "A", startupPrompt: "x", position: 0, profileId: null });
for (const role of ["manager", "worker"]) {
  db.insertSession({
    id: `s-${role}`, projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role, parentSessionId: null,
  });
}

async function listToolNames(server) {
  const client = new Client({ name: "role-surface-doctrine-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  await client.close();
  return names;
}

const orch = new OrchestrationMcpRouter(db, {});
const tasks = new TaskMcpRouter(db, {});
const SURFACES = [
  { id: "orchestration manager", skill: "orchestrate", tools: () => listToolNames(orch.buildServer("s-manager", "manager")) },
  { id: "loom-tasks (manager)", skill: "orchestrate", tools: () => listToolNames(tasks.buildServer("p1", "s-manager")) },
  { id: "orchestration worker", skill: "worker", tools: () => listToolNames(orch.buildServer("s-worker", "worker")) },
  { id: "loom-tasks (worker)", skill: "worker", tools: () => listToolNames(tasks.buildServer("p1", "s-worker")) },
  { id: "platform", skill: "platform-lead", tools: () => listToolNames(new PlatformMcpRouter(db, {}).buildServer("s-platform")) },
  { id: "auditor", skill: "platform-audit", tools: () => listToolNames(new AuditMcpRouter(db, {}).buildServer("s-auditor")) },
  { id: "workspace-auditor", skill: "workspace-audit", tools: () => listToolNames(new WorkspaceAuditMcpRouter(db, {}).buildServer("s-workspace-auditor")) },
  { id: "setup", skill: "setup-assistant", tools: () => listToolNames(new SetupMcpRouter(db, {}).buildServer("s-setup")) },
];

function readSkillText(skill) {
  const dir = path.join(skillsRoot, skill);
  const files = [path.join(dir, "SKILL.md")];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else files.push(p);
    }
  };
  if (fs.existsSync(path.join(dir, "references"))) walk(path.join(dir, "references"));
  return files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
}
const named = (text, tool) =>
  new RegExp(`(?<![A-Za-z0-9_])${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`).test(text);

for (const [id, why] of Object.entries(NO_DOCTRINE_SKILL)) console.log(`SKIP  ${id} — ${why}`);

const skillText = {};
const seenAllow = new Set();
for (const s of SURFACES) {
  skillText[s.skill] ??= readSkillText(s.skill);
  const tools = await s.tools();
  check(`${s.id}: surface registers tools (guards a vacuous pass)`, tools.length > 0);
  const gaps = [];
  for (const t of tools) {
    const key = `${s.id}:${t}`;
    const isNamed = named(skillText[s.skill], t);
    if (key in ALLOWLIST) {
      seenAllow.add(key);
      if (isNamed) gaps.push(`${t} (allowlisted but now NAMED — remove the stale allowlist entry)`);
    } else if (!isNamed) gaps.push(t);
  }
  if (gaps.length) console.log(`  ${s.id} -> skill "${s.skill}" missing: ${gaps.join(", ")}`);
  check(`${s.id}: every registered tool is named in skill "${s.skill}" (or allowlisted)`, gaps.length === 0);
}
for (const k of Object.keys(ALLOWLIST)) check(`allowlist entry ${k} still names a registered tool`, seenAllow.has(k));

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED — name the tool in the skill, or add a reasoned ALLOWLIST entry.`);
db.close();
cleanupPathSync(tmpHome);
process.exit(failures === 0 ? 0 : 1);
