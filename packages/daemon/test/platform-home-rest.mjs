import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform Manager P6 — GET /api/platform/home discovery endpoint (the web's only way to reach the
// reserved "Loom Platform" home, which the ordinary picker hides). HERMETIC + CLAUDE-FREE + NETWORK-FREE,
// modeled on platform-config.mjs (Db + buildServer via app.inject) + platform-home.mjs (seed). Proves:
//   (1) with the home seeded → 200 { project, agents }: project.reserved + name "Loom Platform", and
//       the two seeded agents (Platform Lead + Platform Auditor) are returned;
//   (2) the SAME reserved project is still EXCLUDED from GET /api/projects (the ordinary picker) — P6
//       must not regress the P1 picker exclusion;
//   (3) with NO reserved project seeded → 404 (the endpoint never invents a home).
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
  ? "\n✅ ALL PASS — GET /api/platform/home returns the reserved 'Loom Platform' home + its Lead/Auditor agents, the ordinary picker still hides the reserved project (no P1 regression), and the endpoint 404s rather than inventing a home when none is seeded."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
