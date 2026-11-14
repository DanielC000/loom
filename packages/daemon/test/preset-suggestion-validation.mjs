import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// ONE validation rule for a preset-prompt SUGGESTION across all three writers: REST
// POST /api/preset-prompt-suggestions, the dev auditor's preset_suggestion_suggest, and the end-user
// workspace-auditor's preset_suggestion_suggest. An empty / whitespace-only label (or prompt) must be
// refused by every writer and store nothing; a valid one still lands (label trimmed).
// Run: 1) build, 2) node test/preset-suggestion-validation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-preset-valid-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");
const { WorkspaceAuditMcpRouter } = await import("../dist/mcp/user-audit.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

try {
  const db = new Db(path.join(tmpHome, "v.db"));
  const now = new Date().toISOString();
  db.insertProject({ id: "p", name: "Proj", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertAgent({ id: "a", projectId: "p", name: "Agent", startupPrompt: "GO", position: 0, profileId: null });
  const seed = (id, role) => db.insertSession({
    id, projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: tmpHome,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role, parentSessionId: null,
  });
  seed("AUD", "auditor");
  seed("WSA", "workspace-auditor");

  const connect = async (router, sid) => {
    const server = router.buildServer(sid);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "preset-valid-test", version: "0" });
    await client.connect(c);
    return async (args) => JSON.parse((await client.callTool({ name: "preset_suggestion_suggest", arguments: args })).content[0].text);
  };
  const surfaces = [
    ["dev auditor MCP", await connect(new AuditMcpRouter(db, {}), "AUD")],
    ["user (workspace) auditor MCP", await connect(new WorkspaceAuditMcpRouter(db, {}), "WSA")],
  ];
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const bad = [
    ["empty label", { label: "", prompt: "P-empty-label" }, "label"],
    ["whitespace-only label", { label: "   \t", prompt: "P-ws-label" }, "label"],
    ["empty prompt", { label: "L", prompt: "" }, "prompt"],
    ["whitespace-only prompt", { label: "L", prompt: "  \n " }, "prompt"],
    ["over-long label", { label: "x".repeat(201), prompt: "P-long-label" }, "label"],
    ["over-long rationale", { label: "L", prompt: "P-long-rat", rationale: "r".repeat(2001) }, "rationale"],
  ];
  for (const [name, payload, field] of bad) {
    const rest = await app.inject({ method: "POST", url: "/api/preset-prompt-suggestions", payload });
    check(`REST refuses ${name} (400 naming ${field})`, rest.statusCode === 400 && String(rest.json().error).includes(field));
    for (const [sname, call] of surfaces) {
      const r = await call(payload);
      check(`${sname} refuses ${name} (error naming ${field})`, typeof r.error === "string" && r.error.includes(field) && !r.created && !r.deduped);
    }
  }
  check("refused writes stored nothing", db.listPresetPromptSuggestions().length === 0);

  // Valid writes still land through every writer, label trimmed.
  const rest = await app.inject({ method: "POST", url: "/api/preset-prompt-suggestions", payload: { label: "  Rest ok  ", prompt: "P-rest" } });
  check("REST accepts a valid suggestion (201, label trimmed)", rest.statusCode === 201 && rest.json().label === "Rest ok");
  for (const [sname, call] of surfaces) {
    const r = await call({ label: "  Ok  ", prompt: `P-${sname}`, rationale: "why" });
    check(`${sname} accepts a valid suggestion`, r.created === true && typeof r.id === "string");
    check(`${sname} stored the TRIMMED label`, db.getPresetPromptSuggestion(r.id)?.label === "Ok");
  }
  db.close();
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0 ? "\n✅ ALL PASS — preset suggestion validation is one rule across REST + both auditor MCP surfaces." : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
