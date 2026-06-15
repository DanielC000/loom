import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform Manager P6 — GET /api/platform/home discovery endpoint (the web's only way to reach the
// reserved "Loom Platform" home, which the ordinary picker hides). HERMETIC + CLAUDE-FREE + NETWORK-FREE,
// modeled on platform-config.mjs (Db + buildServer via app.inject) + platform-home.mjs (seed). Proves:
//   (1) with the home seeded → 200 { project, agents }: project.reserved + name "Loom Platform", and
//       the two seeded agents (Platform Lead + Platform Auditor) are returned;
//   (2) the SAME reserved project is still EXCLUDED from GET /api/projects (the ordinary picker) — P6
//       must not regress the P1 picker exclusion;
//   (3) with NO reserved project seeded → 404 (the endpoint never invents a home);
//   (4) liveSessions surfaces each platform agent's LIVE sessions, preferring LIVE over RECENCY — a
//       recently-STOPPED Lead never masks an idle-but-LIVE one (the duplicate-singleton-spawn guard).
// Run: 1) build (turbo builds shared first), 2) node test/platform-home-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-platform-home-rest-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45318";
process.env.LOOM_DEV = "1"; // the Platform layer is dev-gated; this test seeds + reaches the home, so enable it
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { seedPlatformHome, PLATFORM_PROJECT_NAME } = await import("../dist/platform/seed.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const stub = {};
const buildApp = (db) => buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

// ===================== (1) + (2) seeded home → 200, still hidden from the picker =====================
{
  const db = new Db(path.join(TMP, "loom.db"));
  seedDefaultProfiles(db);            // the platform agents bind to the bundled profiles by name
  seedPlatformHome(db);               // seed the reserved home + Lead/Auditor agents
  // An ordinary project too, so the picker still returns normal projects while hiding the reserved one.
  const now = new Date().toISOString();
  db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });

  const app = await buildApp(db);
  try {
    const r = await app.inject({ method: "GET", url: "/api/platform/home" });
    check("(1) GET /api/platform/home → 200", r.statusCode === 200);
    const body = r.json();
    check("(1) returns the reserved project (reserved + name 'Loom Platform')",
      body.project?.reserved === true && body.project?.name === PLATFORM_PROJECT_NAME);
    check("(1) returns the two seeded agents", Array.isArray(body.agents) && body.agents.length === 2);
    const names = (body.agents ?? []).map((a) => a.name);
    check("(1) agents include Platform Lead + Platform Auditor",
      names.includes("Platform Lead") && names.includes("Platform Auditor"));
    check("(1) each returned agent is bound to the reserved project",
      (body.agents ?? []).every((a) => a.projectId === body.project.id));

    // (2) the picker MUST still hide the reserved project (no P1 regression).
    const picker = (await app.inject({ method: "GET", url: "/api/projects" })).json();
    check("(2) GET /api/projects (picker) EXCLUDES the reserved project",
      !picker.some((p) => p.reserved) && !picker.some((p) => p.name === PLATFORM_PROJECT_NAME));
    check("(2) GET /api/projects still returns the ordinary project", picker.some((p) => p.id === "pOrd"));
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===== (4) liveSessions surfaces LIVE over RECENCY (the duplicate-singleton guard) =====
// A recently-STOPPED Lead must NEVER mask an idle-but-LIVE one: db.listSessions is last_activity DESC,
// so the stopped row (newer last_activity) sorts AHEAD of the live row — yet only the LIVE one may show
// in liveSessions. Also proves a live Auditor surfaces and per-role counts are derivable.
{
  const db = new Db(path.join(TMP, "loom-live.db"));
  seedDefaultProfiles(db);
  seedPlatformHome(db);
  const agents = db.listAgents(db.listAllProjects().find((p) => p.reserved).id);
  const leadId = agents.find((a) => a.name === "Platform Lead").id;
  const auditorId = agents.find((a) => a.name === "Platform Auditor").id;
  const homeId = db.listAllProjects().find((p) => p.reserved).id;
  const mk = (id, agentId, role, processState, lastActivity) => db.insertSession({
    id, projectId: homeId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: TMP,
    processState, resumability: "unknown", busy: false, createdAt: "2026-06-15T00:00:00.000Z",
    lastActivity, lastError: null, role, parentSessionId: null,
  });
  // LIVE Lead is the OLDER row; the STOPPED Lead is MORE-RECENTLY-active (the recency trap).
  mk("lead-live", leadId, "platform", "live", "2026-06-15T10:00:00.000Z");
  mk("lead-stopped", leadId, "platform", "exited", "2026-06-15T12:00:00.000Z");
  mk("aud-live", auditorId, "auditor", "live", "2026-06-15T11:00:00.000Z");

  const app = await buildApp(db);
  try {
    const body = (await app.inject({ method: "GET", url: "/api/platform/home" })).json();
    const live = body.liveSessions ?? [];
    const ids = live.map((s) => s.id);
    check("(4) liveSessions is present (array)", Array.isArray(body.liveSessions));
    check("(4) the idle-but-LIVE Lead IS surfaced", ids.includes("lead-live"));
    check("(4) the recently-STOPPED Lead is NOT surfaced (live wins over recency)", !ids.includes("lead-stopped"));
    check("(4) the live Auditor IS surfaced", ids.includes("aud-live"));
    check("(4) every surfaced session is LIVE", live.every((s) => s.processState === "live"));
    check("(4) exactly one live Lead (role 'platform')", live.filter((s) => s.role === "platform").length === 1);
    check("(4) exactly one live Auditor (role 'auditor')", live.filter((s) => s.role === "auditor").length === 1);
    check("(4) each live entry carries its agentId for per-agent rollup",
      live.every((s) => s.agentId === leadId || s.agentId === auditorId));
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (3) no reserved project → 404 =====================
{
  const db = new Db(path.join(TMP, "loom-empty.db")); // fresh DB, NO seedPlatformHome
  const app = await buildApp(db);
  try {
    const r = await app.inject({ method: "GET", url: "/api/platform/home" });
    check("(3) GET /api/platform/home with no reserved home → 404", r.statusCode === 404);
    check("(3) 404 body carries a reason", typeof r.json().error === "string");
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// cleanup (retry for the WAL handle on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — GET /api/platform/home returns the reserved 'Loom Platform' home + its Lead/Auditor agents, the ordinary picker still hides the reserved project (no P1 regression), the endpoint 404s rather than inventing a home when none is seeded, and liveSessions surfaces LIVE sessions over recency (a stopped Lead can't mask a live one — the duplicate-singleton guard)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
