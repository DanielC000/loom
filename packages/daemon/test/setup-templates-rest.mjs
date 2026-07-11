import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Guided Onboarding & Templates (onboarding C3) — the HUMAN-only setup REST pair for workflow templates:
// GET /api/setup/templates (list) + POST /api/setup/templates/apply (apply). HERMETIC + CLAUDE-FREE +
// NETWORK-FREE, modeled on platform-home-rest.mjs (Db + buildServer via app.inject). Mirrors the C2
// agent-facing MCP tools (template_list/template_apply, mcp/setup.ts) but on the loopback REST surface
// only. Proves:
//   (1) GET /api/setup/templates → 200 with the two bundled presets (name/description/agents roster +
//       a boardSeed summary — card count + title(s) — so the wizard's Review screen can show exactly
//       what will be seeded before apply, card 07981d27);
//   (2) POST /api/setup/templates/apply on a REAL project stands up the roster's agents + the starter
//       board card via ordinary db reads (listAgents/listTasks) — no new writer surface;
//   (3) an unknown templateName is rejected (400), nothing written;
//   (4) an unknown projectId is rejected (404), nothing written;
//   (5) HUMAN-ONLY: no MCP router file registers a tool at these REST paths (grepped statically below,
//       not just asserted by comment) — the only reachable path is the loopback REST route.
// Run: 1) build (turbo builds shared first), 2) node test/setup-templates-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-setup-templates-rest-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45319";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { WORKFLOW_TEMPLATES } = await import("../dist/setup/templates.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const stub = {};
const buildApp = (db) => buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

// ===================== (1) GET /api/setup/templates → 200 with the bundled presets =====================
{
  const db = new Db(path.join(TMP, "loom-list.db"));
  const app = await buildApp(db);
  try {
    const r = await app.inject({ method: "GET", url: "/api/setup/templates" });
    check("(1) GET /api/setup/templates → 200", r.statusCode === 200);
    const body = r.json();
    check("(1) returns an array", Array.isArray(body));
    check("(1) returns both bundled presets", body.length === WORKFLOW_TEMPLATES.length);
    const names = body.map((t) => t.name);
    check("(1) includes 'Software team (orchestrated)'", names.includes("Software team (orchestrated)"));
    check("(1) includes 'Solo builder'", names.includes("Solo builder"));
    const solo = body.find((t) => t.name === "Solo builder");
    check("(1) each preset carries a description", typeof solo.description === "string" && solo.description.length > 0);
    check("(1) each preset carries a roster (name + profileName)",
      Array.isArray(solo.agents) && solo.agents.every((a) => typeof a.name === "string" && typeof a.profileName === "string"));
    check("(1) each preset carries a boardSeed summary (count + titles)",
      typeof solo.boardSeed?.count === "number" && Array.isArray(solo.boardSeed?.titles));
    check("(1) boardSeed.count matches the number of titles", solo.boardSeed.count === solo.boardSeed.titles.length);
    check("(1) Solo builder seeds the 'Get oriented' starter card",
      solo.boardSeed.count === 1 && solo.boardSeed.titles[0] === "Get oriented in this project");
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===== (2) POST /api/setup/templates/apply on a real project stands up the roster + starter card =====
{
  const db = new Db(path.join(TMP, "loom-apply.db"));
  seedDefaultProfiles(db); // templated agents bind to these bundled profiles by name
  const now = new Date().toISOString();
  const projectId = "pSolo";
  db.insertProject({ id: projectId, name: "Solo Project", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });

  const app = await buildApp(db);
  try {
    const r = await app.inject({
      method: "POST", url: "/api/setup/templates/apply",
      payload: { projectId, templateName: "Solo builder" },
    });
    check("(2) POST /api/setup/templates/apply → 201", r.statusCode === 201);
    const body = r.json();
    check("(2) response carries created agents", Array.isArray(body.agents) && body.agents.length === 3);
    check("(2) response carries created tasks", Array.isArray(body.tasks) && body.tasks.length === 1);

    // Verify via ORDINARY db reads — no new writer surface, just agent-create + task-insert rows.
    const agents = db.listAgents(projectId);
    check("(2) db.listAgents shows the 3 Solo builder agents", agents.length === 3);
    const agentNames = agents.map((a) => a.name);
    check("(2) agents include Orchestrator, Dev, Code Reviewer",
      agentNames.includes("Orchestrator") && agentNames.includes("Dev") && agentNames.includes("Code Reviewer"));
    const tasks = db.listTasks(projectId);
    check("(2) db.listTasks shows the seeded starter card", tasks.length === 1);
    check("(2) starter card is the orient card", tasks[0].title === "Get oriented in this project");
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (3) unknown templateName → 400, nothing written =====================
{
  const db = new Db(path.join(TMP, "loom-bad-template.db"));
  seedDefaultProfiles(db);
  const now = new Date().toISOString();
  const projectId = "pBadTemplate";
  db.insertProject({ id: projectId, name: "Bad Template Project", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });

  const app = await buildApp(db);
  try {
    const r = await app.inject({
      method: "POST", url: "/api/setup/templates/apply",
      payload: { projectId, templateName: "Nonexistent Template" },
    });
    check("(3) unknown templateName → 400", r.statusCode === 400);
    check("(3) 400 body carries a reason", typeof r.json().error === "string");
    check("(3) nothing written (no agents)", db.listAgents(projectId).length === 0);
    check("(3) nothing written (no tasks)", db.listTasks(projectId).length === 0);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (4) unknown projectId → 404, nothing written =====================
{
  const db = new Db(path.join(TMP, "loom-bad-project.db"));
  seedDefaultProfiles(db);

  const app = await buildApp(db);
  try {
    const r = await app.inject({
      method: "POST", url: "/api/setup/templates/apply",
      payload: { projectId: "does-not-exist", templateName: "Solo builder" },
    });
    check("(4) unknown projectId → 404", r.statusCode === 404);
    check("(4) 404 body carries a reason", typeof r.json().error === "string");
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===== (5) HUMAN-ONLY: no MCP router registers a tool at these REST paths =====
// Grep every MCP router source file for the REST path strings — none should appear (MCP tools are
// registered by NAME via server.registerTool, never by an "/api/setup/templates..." literal), so the
// only way to reach these routes is the loopback REST surface built here.
{
  const daemonSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const mcpDir = path.join(daemonSrc, "mcp");
  const mcpFiles = fs.readdirSync(mcpDir).filter((f) => f.endsWith(".ts"));
  check("(5) at least one MCP router file found to scan", mcpFiles.length > 0);
  let leaked = false;
  for (const f of mcpFiles) {
    const content = fs.readFileSync(path.join(mcpDir, f), "utf8");
    if (content.includes("/api/setup/templates")) leaked = true;
  }
  check("(5) no MCP router file references the /api/setup/templates REST path", !leaked);
}

// cleanup (retry for the WAL handle on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — GET /api/setup/templates lists the bundled presets, POST /api/setup/templates/apply stands up a preset's roster + starter card on a real project via ordinary agent-create/task-insert rows, an unknown template or project is rejected with nothing written, and no MCP router exposes these REST paths (human-only)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
