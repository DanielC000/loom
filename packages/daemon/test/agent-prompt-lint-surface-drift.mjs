import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5338a86a's REQUIRED drift guard: agents/promptLint.ts hand-authors a per-role tool-name table
// (Layer B — the exact tool names inside each role-gated MCP router) because deriving it live on the
// agent_create/agent_update write path would mean constructing a full SessionService per lint call,
// which is too heavy/fragile for a WARN-ONLY feature to depend on. A hand-authored table WILL rot the
// moment a router's registered tools change without a matching edit here — exactly the doc-code-
// mismatch class this card exists to close, so THIS test is the required backstop: it instantiates
// the REAL routers (same stub-tolerant construction platform-agent-update.mjs already uses safely —
// `new PlatformMcpRouter(db, {})`) and connects an in-process InMemoryTransport client per role,
// reading the REAL registered tool set via listTools(). Any mismatch against promptLint.ts's static
// tables FAILS this test — update the table there, not here, when a router's tools change.
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-prompt-lint-surface-drift.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-apld-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
const repo = path.join(tmpHome, "repo");
fs.mkdirSync(repo, { recursive: true });

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");
const { WorkspaceAuditMcpRouter } = await import("../dist/mcp/user-audit.js");
const { OperatorMcpRouter } = await import("../dist/mcp/operator.js");
const { RunMcpRouter } = await import("../dist/mcp/run.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const {
  PLATFORM_TOOLS, SETUP_TOOLS, AUDIT_TOOLS, USER_AUDIT_TOOLS, OPERATOR_TOOLS, RUN_TOOLS,
  ORCH_MANAGER_TOOLS, ORCH_WORKER_TOOLS, ORCH_ASSISTANT_TOOLS,
  TASKS_UNIVERSAL_TOOLS, TASKS_ASSISTANT_EXCLUDED_TOOLS,
} = await import("../dist/agents/promptLint.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "p1", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "a1", projectId: "p1", name: "A", startupPrompt: "x", position: 0, profileId: null });

const roles = ["manager", "worker", "assistant", "platform", "setup", "auditor", "workspace-auditor", "operator", "run"];
for (const role of roles) {
  db.insertSession({
    id: `s-${role}`, projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role, parentSessionId: null,
  });
}

// Connect a real McpServer (built by the real router) to a real Client over an in-process transport
// and read its ACTUAL registered tool names — no reliance on any SDK-internal field.
async function listToolNames(server) {
  const client = new Client({ name: "surface-drift-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  await client.close();
  return names;
}
const sameSet = (a, b) => {
  const as = [...a].sort(), bs = [...b].sort();
  return JSON.stringify(as) === JSON.stringify(bs);
};
const diff = (label, actual, expected) => {
  const a = new Set(actual), e = new Set(expected);
  const missing = expected.filter((t) => !a.has(t)); // in the table but the router no longer registers it
  const extra = actual.filter((t) => !e.has(t)); // the router registers it but the table doesn't know it
  if (missing.length || extra.length) {
    console.log(`  ${label}: table-only=[${missing.join(",")}] router-only=[${extra.join(",")}]`);
  }
};

const orch = new OrchestrationMcpRouter(db, {});
const managerActual = await listToolNames(orch.buildServer("s-manager", "manager"));
diff("orchestration manager", managerActual, ORCH_MANAGER_TOOLS);
check("ORCH_MANAGER_TOOLS matches the real manager tool set", sameSet(managerActual, ORCH_MANAGER_TOOLS));

const workerActual = await listToolNames(orch.buildServer("s-worker", "worker"));
diff("orchestration worker", workerActual, ORCH_WORKER_TOOLS);
check("ORCH_WORKER_TOOLS matches the real worker tool set", sameSet(workerActual, ORCH_WORKER_TOOLS));

const assistantActual = await listToolNames(orch.buildServer("s-assistant", "assistant"));
diff("orchestration assistant", assistantActual, ORCH_ASSISTANT_TOOLS);
check("ORCH_ASSISTANT_TOOLS matches the real assistant (non-companion) tool set", sameSet(assistantActual, ORCH_ASSISTANT_TOOLS));

const platformActual = await listToolNames(new PlatformMcpRouter(db, {}).buildServer("s-platform"));
diff("platform", platformActual, PLATFORM_TOOLS);
check("PLATFORM_TOOLS matches the real loom-platform tool set", sameSet(platformActual, PLATFORM_TOOLS));

const setupActual = await listToolNames(new SetupMcpRouter(db, {}).buildServer("s-setup"));
diff("setup", setupActual, SETUP_TOOLS);
check("SETUP_TOOLS matches the real loom-setup tool set", sameSet(setupActual, SETUP_TOOLS));

const auditActual = await listToolNames(new AuditMcpRouter(db, {}).buildServer("s-auditor"));
diff("audit", auditActual, AUDIT_TOOLS);
check("AUDIT_TOOLS matches the real loom-audit tool set", sameSet(auditActual, AUDIT_TOOLS));

const userAuditActual = await listToolNames(new WorkspaceAuditMcpRouter(db, {}).buildServer("s-workspace-auditor"));
diff("user-audit", userAuditActual, USER_AUDIT_TOOLS);
check("USER_AUDIT_TOOLS matches the real loom-user-audit tool set", sameSet(userAuditActual, USER_AUDIT_TOOLS));

try { db.setPlatformConfig?.({ operatorEnabled: true }); } catch { /* best-effort — resolveRole gate, not buildServer */ }
const operatorActual = await listToolNames(new OperatorMcpRouter(db, {}).buildServer("s-operator"));
diff("operator", operatorActual, OPERATOR_TOOLS);
check("OPERATOR_TOOLS matches the real loom-operator tool set", sameSet(operatorActual, OPERATOR_TOOLS));

const runActual = await listToolNames(new RunMcpRouter(db, {}).buildServer("s-run"));
diff("run", runActual, RUN_TOOLS);
check("RUN_TOOLS matches the real loom-run tool set", sameSet(runActual, RUN_TOOLS));

const tasksManagerActual = await listToolNames(new TaskMcpRouter(db, {}).buildServer("p1", "s-manager"));
diff("tasks (manager)", tasksManagerActual, TASKS_UNIVERSAL_TOOLS);
check("TASKS_UNIVERSAL_TOOLS matches the real loom-tasks tool set (non-assistant)", sameSet(tasksManagerActual, TASKS_UNIVERSAL_TOOLS));

const tasksAssistantActual = await listToolNames(new TaskMcpRouter(db, {}).buildServer("p1", "s-assistant"));
const tasksAssistantExpected = TASKS_UNIVERSAL_TOOLS.filter((t) => !TASKS_ASSISTANT_EXCLUDED_TOOLS.includes(t));
diff("tasks (assistant)", tasksAssistantActual, tasksAssistantExpected);
check("TASKS_ASSISTANT_EXCLUDED_TOOLS matches the real assistant carve-out", sameSet(tasksAssistantActual, tasksAssistantExpected));

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED — update packages/daemon/src/agents/promptLint.ts's tables to match.`);
db.close();
for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
process.exit(failures === 0 ? 0 : 1);
