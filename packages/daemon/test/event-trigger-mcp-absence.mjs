import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Event-trigger MCP-ABSENCE scope test (Loom Event Triggers subsystem, card f5d07121 T2). The DoD's
// explicit requirement: "NO MCP writer — assert its ABSENCE in a scope test (the poll no-MCP precedent)."
// event_triggers is a REST-only, human-configured surface (mirrors poll_jobs/connections/schedules) —
// this dispatcher fires autonomously across arbitrary orchestration-lifecycle event kinds, broader than
// any agent should be able to self-configure, so NO MCP router may ever register an event-trigger tool.
//
// Two independent proofs:
//  (1) STATIC — every compiled MCP router source file (dist/mcp/*.js) is scanned for the substring
//      "event_trigger" / "eventTrigger". Cheap, hermetic, and covers EVERY router at once (including ones
//      this test doesn't dynamically spin up) — a future router that accidentally imports EventTrigger
//      machinery or names a tool "event_trigger_*" trips this immediately.
//  (2) DYNAMIC — the REAL OrchestrationMcpRouter (the manager-facing surface, and the most plausible spot
//      a "trigger management" tool would land) is driven over an in-process MCP InMemoryTransport (no
//      HTTP, no daemon — mirrors audit-surface.mjs's hermetic MCP-client pattern) and its FULL advertised
//      tool list is asserted to contain nothing trigger-related.
//
// Run: 1) build (turbo builds shared first), 2) node test/event-trigger-mcp-absence.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ============ (1) STATIC — no MCP router source mentions event-trigger machinery ============
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpDistDir = path.join(__dirname, "..", "dist", "mcp");
const mcpFiles = fs.readdirSync(mcpDistDir).filter((f) => f.endsWith(".js"));
check("static: found MCP router dist files to scan", mcpFiles.length > 0);
const offenders = [];
for (const f of mcpFiles) {
  const src = fs.readFileSync(path.join(mcpDistDir, f), "utf8");
  if (/event_trigger|eventTrigger/i.test(src)) offenders.push(f);
}
check(`static: NO compiled MCP router (${mcpFiles.join(", ")}) references event-trigger machinery (offenders: ${offenders.join(", ") || "none"})`, offenders.length === 0);

// ============ (2) DYNAMIC — the OrchestrationMcpRouter's full tool surface has nothing trigger-related ============
const tmpHome = path.join(os.tmpdir(), `loom-evtrig-mcpabs-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const repo = path.join(os.tmpdir(), `loom-evtrig-mcpabs-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# fixture repo\n");
execSync(`git init -q && git add . && git -c user.email=t@loom -c user.name=t commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pO", name: "Ord", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "aO", projectId: "pO", name: "work", startupPrompt: "", position: 0 });
db.insertSession({
  id: "M", projectId: "pO", agentId: "aO", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null,
});

class SeamHost extends PtyHost {
  createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const orchRouter = new OrchestrationMcpRouter(db, svc);

try {
  const roleInfo = orchRouter.resolveRole("M");
  check("dynamic: manager session M resolves an orchestration role (sanity — proves the router is live)", !!roleInfo && roleInfo.role === "manager");

  const server = orchRouter.buildServer("M", roleInfo.role);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "event-trigger-mcp-absence-test", version: "0" });
  await client.connect(clientT);

  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(`dynamic: the orchestration MCP surface (${tools.sort().join(",")}) has NO trigger-related tool name`,
    !tools.some((n) => /trigger/i.test(n)));
  check("dynamic: the orchestration MCP surface is non-empty (sanity — proves listTools actually returned real tools)", tools.length > 0);

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — no compiled MCP router source references event-trigger machinery, and the REAL OrchestrationMcpRouter's full advertised tool surface (driven over an in-process MCP transport, no HTTP/daemon) has zero trigger-related tools: event_triggers is REST-only, exactly like poll_jobs/connections/schedules."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
