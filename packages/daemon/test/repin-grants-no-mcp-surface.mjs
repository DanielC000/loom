import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 6745e4bc — repinSessionGrants is HUMAN-ONLY REST, never an MCP tool anywhere. Belt-and-
// suspenders sweep: build every REAL router for every role and assert no tool name matches /re-?pin/i —
// same technique agent-prompt-lint-surface-drift.mjs/companion-capability-grants.mjs already use.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a real Db on a temp LOOM_HOME, every router built with the
// stub-tolerant `(db, {})` construction the drift guard already relies on. No real claude, no daemon.
//
// Run: 1) build (turbo builds shared first), 2) node test/repin-grants-no-mcp-surface.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-repin-surface-${Date.now()}-${process.pid}`);
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
const { RunMcpRouter } = await import("../dist/mcp/run.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// ============ 0. SELF-TEST (RED proof): the regex itself can catch a real violation ============
// Shown against a synthetic fixture rather than a real planted router tool — cheaper and hermetic, but
// proves the exact same discriminator the real sweep below relies on.
// Card 158cb01a: the read-only GET /api/sessions/:id/grant-drift twin is HUMAN-only REST too, so the same
// sweep also refuses any tool named for a grant drift.
const REPIN_PATTERN = /re-?pin|grant.?drift|drift.?grant/i;
{
  const plantedViolations = ["grant_repin", "repin_grants", "session_repin", "grant_drift", "session_grant_drift", "drift_grants"];
  const innocentNames = ["tasks_list", "worker_report", "session_message", "pending_bindings"];
  check("(0) RED proof: the sweep pattern DOES match every planted violation name",
    plantedViolations.every((n) => REPIN_PATTERN.test(n)));
  check("(0) GREEN proof: the sweep pattern does NOT match any real, unrelated tool name",
    innocentNames.every((n) => !REPIN_PATTERN.test(n)));
}

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "p1", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "a1", projectId: "p1", name: "A", startupPrompt: "x", position: 0, profileId: null });

const roles = ["manager", "worker", "assistant", "platform", "setup", "auditor", "workspace-auditor", "run"];
for (const role of roles) {
  db.insertSession({
    id: `s-${role}`, projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role, parentSessionId: null,
  });
}

async function listToolNames(server) {
  const client = new Client({ name: "repin-grants-surface-sweep", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names;
}

try {
  const orch = new OrchestrationMcpRouter(db, {});
  const platform = new PlatformMcpRouter(db, {});
  const setup = new SetupMcpRouter(db, {});
  const audit = new AuditMcpRouter(db, {});
  const userAudit = new WorkspaceAuditMcpRouter(db, {});
  const run = new RunMcpRouter(db, {});
  const tasks = new TaskMcpRouter(db, {});

  // @decision 6745e4bc — every (router, role) pair this feature could conceivably reach, PLUS every
  // other role (belt-and-suspenders — the whole point is that NO surface anywhere gets this tool).
  const surfaces = [
    ["orchestration/manager", orch.buildServer("s-manager", "manager")],
    ["orchestration/worker", orch.buildServer("s-worker", "worker")],
    ["orchestration/assistant", orch.buildServer("s-assistant", "assistant")],
    ["orchestration/platform", orch.buildServer("s-platform", "platform")],
    ["platform", platform.buildServer("s-platform")],
    ["setup", setup.buildServer("s-setup")],
    ["audit", audit.buildServer("s-auditor")],
    ["workspace-audit", userAudit.buildServer("s-workspace-auditor")],
    ["run", run.buildServer("s-run")],
    ["tasks/manager", tasks.buildServer("p1", "s-manager")],
    ["tasks/worker", tasks.buildServer("p1", "s-worker")],
    ["tasks/assistant", tasks.buildServer("p1", "s-assistant")],
    ["tasks/platform", tasks.buildServer("p1", "s-platform")],
  ];

  const allNames = new Set();
  for (const [label, server] of surfaces) {
    const names = await listToolNames(server);
    for (const n of names) allNames.add(n);
    check(`(1) ${label}: no tool name matches /re-?pin/i`, !names.some((n) => REPIN_PATTERN.test(n)));
  }
  check("(2) union of every surface above: no tool anywhere matches /re-?pin/i", ![...allNames].some((n) => REPIN_PATTERN.test(n)));
  console.log(`  (union had ${allNames.size} distinct tool names across ${surfaces.length} (router,role) surfaces)`);
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the /re-?pin/i sweep pattern discriminates correctly (RED on a planted name, GREEN on real ones), and no real MCP router/role surface registers anything matching it — repinSessionGrants (POST /api/sessions/:id/repin-grants) stays HUMAN-ONLY REST, never an MCP tool."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
