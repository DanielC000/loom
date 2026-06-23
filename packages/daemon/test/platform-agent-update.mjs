import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform Lead #2 part A — the elevated loom-platform `agent_update` MCP tool (a PATCH wrapper for the
// human REST POST /api/agents/:id), so the Lead stops needing raw REST. HERMETIC + CLAUDE-FREE +
// NETWORK-FREE: a REAL Db, the REAL PlatformMcpRouter over an in-process MCP InMemoryTransport (no HTTP),
// AND the REAL gateway buildServer driven via app.inject for the REST-parity check. The only thing
// faked is the SessionService (agent_update touches only db — no spawn).
//
// Proves the DoD:
//   (1) PATCH semantics — only PRESENT keys are applied; an omitted key is left UNCHANGED; profileId:null
//       CLEARS the assignment;
//   (2) 404 (structured error) on an unknown agent id;
//   (3) the SAME validator (agents/validate.ts › validateAgentPatch) is REUSED — a bogus (non-existent)
//       profileId is rejected IDENTICALLY by the MCP tool ("profile not found") AND the REST path (404
//       "profile not found"); a rejected patch leaves the stored agent UNCHANGED;
//   (4) the human-only Agent Runs endpoint/ioSchema flags are NOT settable through this MCP tool
//       (human-REST-only — never an agent/elevated MCP surface).
// Run: 1) build (turbo builds shared first), 2) node test/platform-agent-update.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME + sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-pau-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
const repo = path.join(tmpHome, "repo");
fs.mkdirSync(repo, { recursive: true });

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { validateAgentPatch } = await import("../dist/agents/validate.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentA", projectId: "pOrd", name: "Original", startupPrompt: "ORIGINAL PROMPT", position: 0, profileId: null });
db.insertProfile({ id: "profReal", name: "Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, browserTesting: false });
// A platform session (the role the router gates on) + a manager session (the negative role-gate case).
db.insertSession({
  id: "PL", projectId: "pOrd", agentId: "agentA", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "platform", parentSessionId: null,
});
db.insertSession({
  id: "M", projectId: "pOrd", agentId: "agentA", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null,
});

const router = new PlatformMcpRouter(db, /* sessions (unused by agent_update) */ {});
const parse = (res) => JSON.parse(res.content[0].text);

// REST app for the parity check (POST /api/agents/:id touches only deps.db; the rest can be stubs).
const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

try {
  // --- role gate: the tool only exists for a platform session (handle() 404s a non-platform role) ---
  check("role gate: platform session HAS the surface", !!router.resolveRole("PL"));
  check("role gate: manager session gets NO surface (resolveRole null)", router.resolveRole("M") === null);

  // --- connect a REAL MCP client to the router's server over an in-memory transport (no HTTP) ---
  const server = router.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "platform-agent-update-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  // 0) surface: agent_update is registered; its inputSchema does NOT expose endpoint/ioSchema (human-only).
  const tools = (await client.listTools()).tools;
  const au = tools.find((t) => t.name === "agent_update");
  check("agent_update is registered on loom-platform", !!au);
  const auProps = Object.keys(au?.inputSchema?.properties ?? {});
  check("agent_update inputSchema exposes ONLY agentId/name/startupPrompt/profileId (no endpoint/ioSchema)",
    auProps.length === 4 && ["agentId", "name", "startupPrompt", "profileId"].every((k) => auProps.includes(k)) &&
    !auProps.includes("endpoint") && !auProps.includes("ioSchema"));

  // ===================== (1) PATCH semantics — present keys applied, omitted left as-is =====================
  const r1 = await call("agent_update", { agentId: "agentA", name: "Renamed" });
  check("(1) name-only patch updates name", r1.name === "Renamed");
  check("(1) name-only patch leaves startupPrompt UNCHANGED", r1.startupPrompt === "ORIGINAL PROMPT");

  const r2 = await call("agent_update", { agentId: "agentA", startupPrompt: "NEW BRIEF" });
  check("(1) startupPrompt-only patch updates startupPrompt", r2.startupPrompt === "NEW BRIEF");
  check("(1) startupPrompt-only patch leaves name UNCHANGED (still Renamed)", r2.name === "Renamed");

  // profileId: SET → an unrelated name-only patch leaves it → null CLEARS.
  const r3 = await call("agent_update", { agentId: "agentA", profileId: "profReal" });
  check("(1) profileId patch SETS the assignment", r3.profileId === "profReal");
  const r4 = await call("agent_update", { agentId: "agentA", name: "Renamed2" });
  check("(1) a name-only patch leaves the profile assignment intact", r4.profileId === "profReal" && r4.name === "Renamed2");
  const r5 = await call("agent_update", { agentId: "agentA", profileId: null });
  check("(1) profileId:null CLEARS the assignment", r5.profileId === null);

  // ===================== (2) 404 on an unknown agent id =====================
  const ghost = await call("agent_update", { agentId: "no-such-agent", name: "x" });
  check("(2) unknown agent id → structured 'agent not found'", ghost.error === "agent not found");

  // ===================== (3) validator REUSE — bogus profileId rejected identically on MCP + REST =====================
  const mcpBad = await call("agent_update", { agentId: "agentA", profileId: "no-such-profile" });
  check("(3) MCP: a bogus profileId is rejected with 'profile not found'", mcpBad.error === "profile not found");
  check("(3) MCP: the rejected patch left the agent UNCHANGED (still cleared, still Renamed2)",
    db.getAgent("agentA").profileId === null && db.getAgent("agentA").name === "Renamed2");

  const restBad = await app.inject({ method: "POST", url: "/api/agents/agentA", payload: { profileId: "no-such-profile" } });
  check("(3) REST: the SAME bogus profileId is rejected 404 'profile not found' (validator reused)",
    restBad.statusCode === 404 && JSON.parse(restBad.body).error === "profile not found");

  // The shared validator is the single source of truth both paths call — exercise it directly too.
  const direct = validateAgentPatch({ profileId: "no-such-profile" }, () => false, { allowEndpointFlags: false });
  check("(3) validateAgentPatch itself rejects a bogus profileId as notFound", direct.ok === false && direct.kind === "notFound" && direct.error === "profile not found");
  const directOmit = validateAgentPatch({ name: "only-name" }, () => true);
  check("(3) validateAgentPatch builds a patch with ONLY present keys (startupPrompt/profileId absent)",
    directOmit.ok === true && "name" in directOmit.patch && !("startupPrompt" in directOmit.patch) && !("profileId" in directOmit.patch));

  // ===================== (4) endpoint/ioSchema NOT settable via MCP (human-REST-only) =====================
  // The inputSchema lacks endpoint/ioSchema; the handler passes allowEndpointFlags:false. Even if the keys
  // are smuggled into the call args, they never become a patch — the stored endpoint flag stays false.
  await call("agent_update", { agentId: "agentA", name: "Renamed3", endpoint: true, ioSchema: { hacked: true } });
  const after = db.getAgent("agentA");
  check("(4) MCP agent_update applied its allowed field (name)", after.name === "Renamed3");
  check("(4) MCP agent_update did NOT flip the human-only endpoint flag", after.endpoint === false && after.ioSchema === null);

  await client.close();
} finally {
  await app.close();
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — loom-platform agent_update is a faithful PATCH wrapper for POST /api/agents/:id (present keys applied, omitted left as-is, profileId:null clears), 404s an unknown agent, REUSES the shared validator (a bogus profileId is rejected identically on the MCP + REST paths, stored agent unchanged), and keeps the human-only endpoint/ioSchema flags off the MCP surface — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
