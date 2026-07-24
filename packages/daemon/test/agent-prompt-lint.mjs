import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5338a86a — warn (never block) at agent create/update when a startupPrompt names a tool NOT on
// the resolved role's actual tool surface. HERMETIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db, real
// PlatformMcpRouter/SetupMcpRouter over an in-process MCP InMemoryTransport (no HTTP) — mirrors
// platform-agent-update.mjs. Proves:
//   (1) the pure lint (agents/promptLint.ts) matches on both mcp__server__tool AND bare snake_case
//       tool-name forms, and does NOT false-positive on ordinary prose or on a tool that IS on-surface;
//   (2) agent_create/agent_update on BOTH the setup and platform MCP surfaces attach a `promptWarning`
//       when the prompt names an off-surface tool, and omit it for a clean prompt.
// Run: 1) build (turbo builds shared first), 2) node test/agent-prompt-lint.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-apl-${Date.now()}-${process.pid}`);
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
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const {
  lintStartupPromptToolSurface, resolveKnownToolSurface, toolSurfaceWarning,
} = await import("../dist/agents/promptLint.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- Part A: the pure lint function, unit-level ---

// A worker never gets vault_write (mounted only via loom-platform's role:"platform" gate, or a
// vaultWrite-flagged profile's loom-tasks mount) — this is the card's own motivating case.
{
  const offending = lintStartupPromptToolSurface(
    "Maintain ONE rolling vault note (vault_write, keep it under 4KB).",
    { role: "worker" },
  );
  check("bare 'vault_write' in a worker prompt is flagged (the motivating case)", offending.includes("vault_write"));
}

// The mcp__server__tool form is also caught.
{
  const offending = lintStartupPromptToolSurface(
    "Use mcp__loom-platform__vault_write to save your findings.",
    { role: "worker" },
  );
  check("mcp__loom-platform__vault_write form is flagged for a worker", offending.includes("vault_write"));
}

// A manager-only tool named in a WORKER prompt is flagged (the doctrine-mismatch class, not just vault_write).
{
  const offending = lintStartupPromptToolSurface("Call worker_spawn to start your own sub-workers.", { role: "worker" });
  check("manager-only 'worker_spawn' named in a worker prompt is flagged", offending.includes("worker_spawn"));
}

// A tool that genuinely IS on the role's surface is never flagged.
{
  const offending = lintStartupPromptToolSurface("Call worker_report when done, and run_gate before that.", { role: "worker" });
  check("on-surface tools (worker_report, run_gate) are NOT flagged", offending.length === 0);
}

// vault_write on a role whose PROFILE has vaultWrite:true (loom-tasks conditional mount) is NOT flagged.
{
  const offending = lintStartupPromptToolSurface("Use vault_write to save your note.", { role: "worker", vaultWrite: true });
  check("vault_write is NOT flagged when the profile has vaultWrite:true", offending.length === 0);
}

// authenticated_request similarly gated on non-empty connections.
{
  const flagged = lintStartupPromptToolSurface("Call authenticated_request for the API.", { role: "worker" });
  const allowed = lintStartupPromptToolSurface("Call authenticated_request for the API.", { role: "worker", connections: ["conn1"] });
  check("authenticated_request flagged with no connections", flagged.includes("authenticated_request"));
  check("authenticated_request NOT flagged with a bound connection", allowed.length === 0);
}

// Plain English prose (no underscores) never false-positives, even with words that ALSO happen to be
// tool-name-ish in isolation ("list", "get", "read" alone are never registered Loom tool names).
{
  const offending = lintStartupPromptToolSurface(
    "Please read the list of tasks and get a summary before you write your report.",
    { role: "worker" },
  );
  check("plain prose with no underscore-joined tokens is never flagged", offending.length === 0);
}

// A snake_case word that ISN'T a real Loom tool name is never flagged (universe membership required).
{
  const offending = lintStartupPromptToolSurface("Set the retry_count and max_attempts before looping.", { role: "worker" });
  check("an unknown snake_case token is not flagged (must be a real tool name)", offending.length === 0);
}

// Companion-only tools (chat_reply etc.) are never flagged for the three orchestration-mounted roles —
// the deliberate live-state approximation gap, erring toward not-warning.
{
  const w = lintStartupPromptToolSurface("Use chat_reply to answer the user.", { role: "worker" });
  const m = lintStartupPromptToolSurface("Use chat_reply to answer the user.", { role: "manager" });
  const a = lintStartupPromptToolSurface("Use chat_reply to answer the user.", { role: "assistant" });
  check("chat_reply is never flagged for worker/manager/assistant (companion-gate approximation)", w.length === 0 && m.length === 0 && a.length === 0);
}

// An empty/absent prompt never warns.
check("an empty prompt lints clean", lintStartupPromptToolSurface("", { role: "worker" }).length === 0);
check("toolSurfaceWarning([]) is null", toolSurfaceWarning([]) === null);
check("toolSurfaceWarning(['x']) names the tool", toolSurfaceWarning(["x"]).includes("x"));

// role:null (profile-less "plain") surface is loom-tasks only.
{
  const surface = resolveKnownToolSurface({ role: null });
  check("plain (no role) surface has no orchestration tools", !surface.has("worker_spawn") && !surface.has("worker_report"));
  check("plain (no role) surface still has loom-tasks reads", surface.has("tasks_list"));
}

// --- Part B: end-to-end wiring — setup.ts agent_create/agent_update attach promptWarning ---

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "p1", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProfile({ id: "profWorker", name: "Worker Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, browserTesting: false });
db.insertAgent({ id: "aHost", projectId: "p1", name: "Host", startupPrompt: "x", position: 0, profileId: null });
db.insertSession({
  id: "S", projectId: "p1", agentId: "aHost", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "setup", parentSessionId: null,
});

async function connectRouter(router, sessionId) {
  const client = new Client({ name: "agent-prompt-lint-test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = router.buildServer(sessionId);
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (c, name, args) => parse(await c.callTool({ name, arguments: args }));

const setupClient = await connectRouter(new SetupMcpRouter(db, {}), "S");

const created = await call(setupClient, "agent_create", {
  projectId: "p1", name: "Scout", profileId: "profWorker",
  startupPrompt: "Maintain ONE rolling vault note (vault_write, keep it under 4KB).",
});
check("agent_create (setup): off-surface tool in prompt attaches promptWarning", typeof created.promptWarning === "string" && created.promptWarning.includes("vault_write"));

const createdClean = await call(setupClient, "agent_create", {
  projectId: "p1", name: "Scout2", profileId: "profWorker",
  startupPrompt: "Call worker_report when done.",
});
check("agent_create (setup): clean prompt has NO promptWarning field", createdClean.promptWarning === undefined);

const updated = await call(setupClient, "agent_update", {
  agentId: created.id, startupPrompt: "Call worker_spawn to fan out sub-workers.",
});
check("agent_update (setup): off-surface tool in the NEW prompt attaches promptWarning", typeof updated.promptWarning === "string" && updated.promptWarning.includes("worker_spawn"));

// Reset to a clean prompt explicitly, then confirm a name-only patch re-lints the unchanged prompt (clean).
await call(setupClient, "agent_update", { agentId: created.id, startupPrompt: "Call worker_report when done." });
const untouched = await call(setupClient, "agent_update", { agentId: created.id, name: "Scout (renamed again)" });
check("agent_update (setup): patch touching only name re-lints the unchanged (clean) prompt with no warning", untouched.promptWarning === undefined);

// --- Part C: platform.ts agent_create/agent_update (same behavior, elevated surface) ---

db.insertSession({
  id: "PL", projectId: "p1", agentId: "aHost", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "platform", parentSessionId: null,
});
const platformClient = await connectRouter(new PlatformMcpRouter(db, {}), "PL");

const pCreated = await call(platformClient, "agent_create", {
  projectId: "p1", name: "PScout", profileId: "profWorker",
  startupPrompt: "Use mcp__loom-platform__vault_write to save your findings.",
});
check("agent_create (platform): mcp__ form off-surface tool attaches promptWarning", typeof pCreated.promptWarning === "string" && pCreated.promptWarning.includes("vault_write"));

const pClean = await call(platformClient, "agent_update", { agentId: pCreated.id, startupPrompt: "Report via worker_report." });
check("agent_update (platform): a corrected clean prompt has no promptWarning", pClean.promptWarning === undefined);

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
db.close();
for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
process.exit(failures === 0 ? 0 : 1);
