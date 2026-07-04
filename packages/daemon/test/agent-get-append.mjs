import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// GAP 1 (manager tooling): the loom-orchestration `agent_get` read + `agent_update`'s new append mode.
// HERMETIC + CLAUDE-FREE, in the style of agent-id-prefix.mjs: a REAL Db + SessionService against a fake
// pty, and the REAL OrchestrationMcpRouter (manager role) over an in-process MCP InMemoryTransport (no
// HTTP, no daemon boot).
//
// Proves:
//   (1) agent_get returns the FULL record (incl. startupPrompt) for an exact id, and for an unambiguous
//       8-char id-prefix — same resolution as worker_spawn/the platform agent_get;
//   (2) agent_get on an ambiguous prefix errors, naming BOTH candidate ids; on an unknown id → "agent not
//       found"; on an agent in ANOTHER project (even the exact full id) → "agent not found" (never leaks
//       cross-project existence) — the manager's project is derived SERVER-SIDE, never agent-passed;
//   (3) agent_update's `appendToStartupPrompt` CONCATENATES onto the existing prompt (blank-line joined),
//       and appends bare (no leading blank line) when the existing prompt is empty;
//   (4) agent_update's plain `startupPrompt` full-replace still works UNCHANGED (regression);
//   (5) passing BOTH `startupPrompt` and `appendToStartupPrompt` in one call is REJECTED with NO write;
//   (6) agent_get AND agent_list surface the RESOLVED browserTesting/documentConversion/restrictedTools
//       flags (Auditor finding 64430a50): an agent bound to a browser profile shows true/true/false;
//       a profile-less agent backstops to false/false/false — matching resolveProfile exactly.
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-get-append.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-aga-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db(path.join(tmpHome, "loom.db"));

db.insertProject({ id: "pMine", name: "Mine", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pOther", name: "Other", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });

// CRAFTED UUID-shaped ids: one with a UNIQUE 8-char prefix, two that SHARE an 8-char prefix.
const ID_SOLO = "12ab34cd-0000-4000-8000-000000000001"; // unique prefix "12ab34cd"
const ID_DUP_A = "feedface-0000-4000-8000-00000000000a"; // shares prefix "feedface" with…
const ID_DUP_B = "feedface-0000-4000-8000-00000000000b"; // …this one
const ID_OTHER = "deadbeef-0000-4000-8000-000000000009"; // lives in pOther
db.insertAgent({ id: ID_SOLO, projectId: "pMine", name: "Solo", startupPrompt: "BASE PROMPT", position: 0, profileId: null });
db.insertAgent({ id: ID_DUP_A, projectId: "pMine", name: "Alpha", startupPrompt: "A", position: 1, profileId: null });
db.insertAgent({ id: ID_DUP_B, projectId: "pMine", name: "Bravo", startupPrompt: "B", position: 2, profileId: null });
db.insertAgent({ id: "aEmpty", projectId: "pMine", name: "Empty", startupPrompt: "", position: 3, profileId: null });
db.insertAgent({ id: ID_OTHER, projectId: "pOther", name: "Foreign", startupPrompt: "OTHER PROJECT PROMPT", position: 0, profileId: null });

// A browser-capable profile + an agent bound to it, vs. the profile-less agents above (ID_SOLO etc.).
db.insertProfile({
  id: "profBrowser", name: "Web Designer", role: null, description: "browser rig", allowDelta: [],
  skills: null, model: null, icon: null, browserTesting: true, documentConversion: false, restrictedTools: false,
});
const ID_BROWSER = "b0000001-0000-4000-8000-000000000007";
db.insertAgent({ id: ID_BROWSER, projectId: "pMine", name: "Browsy", startupPrompt: "BROWSER PROMPT", position: 4, profileId: "profBrowser" });

db.insertSession({
  id: "M", projectId: "pMine", agentId: ID_SOLO, engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager", parentSessionId: null,
});

const pty = { enqueueStdin: () => ({ delivered: false }) };
const svc = new SessionService(db, pty, new OrchestrationControl());
const router = new OrchestrationMcpRouter(db, svc);
const server = router.buildServer("M", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "agent-get-append-test", version: "0" });
await client.connect(clientT);
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

try {
  // ===================== (1) agent_get: exact id + unambiguous prefix, FULL record =====================
  const gExact = await call("agent_get", { agentId: ID_SOLO });
  check("(1) agent_get exact id resolves the FULL record incl. startupPrompt",
    gExact.id === ID_SOLO && gExact.startupPrompt === "BASE PROMPT" && gExact.name === "Solo");
  const gPrefix = await call("agent_get", { agentId: "12ab34cd" });
  check("(1) agent_get resolves an unambiguous 8-char id-prefix", gPrefix.id === ID_SOLO);

  // ===================== (2) agent_get: ambiguous / unknown / cross-project =====================
  const gAmb = await call("agent_get", { agentId: "feedface" });
  check("(2) agent_get on an ambiguous prefix errors, naming BOTH candidate ids",
    typeof gAmb.error === "string" && gAmb.error.includes("ambiguous") && gAmb.error.includes(ID_DUP_A) && gAmb.error.includes(ID_DUP_B));
  const gMiss = await call("agent_get", { agentId: "99999999" });
  check("(2) agent_get on an unknown id/prefix → 'agent not found'", gMiss.error === "agent not found");
  const gForeign = await call("agent_get", { agentId: ID_OTHER });
  check("(2) agent_get on an agent in ANOTHER project (even the exact full id) → 'agent not found' (no leak)",
    gForeign.error === "agent not found");

  // ===================== (3) agent_update appendToStartupPrompt CONCATENATES =====================
  const appended = await call("agent_update", { agentId: ID_SOLO, appendToStartupPrompt: "MORE CONTEXT" });
  check("(3) append concatenates onto the existing prompt (blank-line joined)",
    appended.startupPrompt === "BASE PROMPT\n\nMORE CONTEXT");
  check("(3) append made NO change to name", appended.name === "Solo");
  const appendedAgain = await call("agent_update", { agentId: ID_SOLO, appendToStartupPrompt: "AND MORE" });
  check("(3) a second append concatenates onto the ALREADY-appended prompt",
    appendedAgain.startupPrompt === "BASE PROMPT\n\nMORE CONTEXT\n\nAND MORE");
  const appendedToEmpty = await call("agent_update", { agentId: "aEmpty", appendToStartupPrompt: "FIRST CONTENT" });
  check("(3) appending to an EMPTY existing prompt appends bare (no leading blank line)",
    appendedToEmpty.startupPrompt === "FIRST CONTENT");

  // ===================== (4) plain startupPrompt full-replace still works (regression) =====================
  const replaced = await call("agent_update", { agentId: ID_SOLO, startupPrompt: "REPLACED WHOLESALE" });
  check("(4) plain startupPrompt still fully REPLACES (regression)", replaced.startupPrompt === "REPLACED WHOLESALE");

  // ===================== (5) BOTH in one call → REJECTED, no write =====================
  const before = db.getAgent(ID_SOLO).startupPrompt;
  const both = await call("agent_update", { agentId: ID_SOLO, startupPrompt: "X", appendToStartupPrompt: "Y" });
  check("(5) passing BOTH startupPrompt and appendToStartupPrompt is REJECTED",
    typeof both.error === "string" && both.error.includes("not both"));
  check("(5) the rejected call made NO write", db.getAgent(ID_SOLO).startupPrompt === before);

  // ===================== (6) resolved capability flags on agent_get + agent_list =====================
  const gBrowser = await call("agent_get", { agentId: ID_BROWSER });
  check("(6) agent_get on a browser-profile agent resolves browserTesting:true",
    gBrowser.browserTesting === true && gBrowser.documentConversion === false && gBrowser.restrictedTools === false);
  const gPlain = await call("agent_get", { agentId: ID_DUP_A });
  check("(6) agent_get on a profile-less agent backstops all flags to false",
    gPlain.browserTesting === false && gPlain.documentConversion === false && gPlain.restrictedTools === false);

  const list = await call("agent_list", {});
  const lBrowser = list.find((a) => a.id === ID_BROWSER);
  const lPlain = list.find((a) => a.id === ID_DUP_A);
  check("(6) agent_list on a browser-profile agent resolves browserTesting:true",
    lBrowser?.browserTesting === true && lBrowser?.documentConversion === false && lBrowser?.restrictedTools === false);
  check("(6) agent_list on a profile-less agent backstops all flags to false",
    lPlain?.browserTesting === false && lPlain?.documentConversion === false && lPlain?.restrictedTools === false);
} finally {
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — agent_get returns the full record for an exact id / unambiguous prefix, errors on ambiguous/unknown/cross-project; agent_update's appendToStartupPrompt concatenates (bare when empty), plain startupPrompt still fully replaces, passing both is rejected with no write, and agent_get/agent_list surface the resolved browserTesting/documentConversion/restrictedTools flags."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
