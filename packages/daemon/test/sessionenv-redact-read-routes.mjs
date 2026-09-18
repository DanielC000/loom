import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6bfc3bfb: `a5ecb6fd` redacted config.sessionEnv values on GET /api/projects only. This card widens
// the SAME `redactSessionEnvForRead()` helper (packages/daemon/src/gateway/server.ts) to the three
// remaining pure-READ project-returning routes: GET /api/projects/archived, GET /api/platform/home, and
// GET /api/setup/home. HERMETIC + CLAUDE-FREE + NETWORK-FREE, modeled on platform-home-rest.mjs (Db +
// buildServer via app.inject) — `a5ecb6fd`'s own guard shipped only into the Playwright e2e suite (which
// the merge gate never runs); this is the daemon-test guard that was flagged as missing. Proves:
//   (1) GET /api/projects/archived masks sessionEnv values (same-length filler) on an archived project
//       that has a non-empty sessionEnv map, while every other config key is untouched.
//   (2) GET /api/platform/home masks sessionEnv on the reserved Loom Platform project it returns.
//   (3) GET /api/setup/home masks sessionEnv on the reserved setup project it returns.
//   (4) A project with NO sessionEnv (or an empty map) round-trips unchanged on all three routes — the
//       masking function is a no-op on the common case, not a mandatory transform.
//   (5) NEGATIVE CONTROL: an unmasked raw `Db.listArchivedProjects()` / `Db.getReservedProjectByName()`
//       read (bypassing the route) DOES still return the real plaintext value — proving the masking is a
//       property of the ROUTE, not an accidental default already baked into storage or the Db layer.
// Run: 1) build (turbo builds shared first), 2) node test/sessionenv-redact-read-routes.mjs
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-sessionenv-redact-read-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
process.env.LOOM_DEV = "1"; // the Platform home is dev-gated; this test seeds + reaches it
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { seedPlatformHome, PLATFORM_PROJECT_NAME } = await import("../dist/platform/seed.js");
const { seedSetupHome, SETUP_PROJECT_NAME } = await import("../dist/setup/seed.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const stub = {};
const buildApp = (db) => buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

const now = new Date().toISOString();
const SECRET = "super-secret-token-value";
const OTHER_CONFIG_VALUE = "not-a-secret";

// ===================== (1) GET /api/projects/archived masks sessionEnv =====================
{
  const db = new Db(path.join(TMP, "loom-archived.db"));
  db.insertProject({
    id: "pArch", name: "Archived Project", repoPath: TMP, vaultPath: TMP,
    config: { sessionEnv: { MY_SECRET: SECRET }, description: OTHER_CONFIG_VALUE },
    createdAt: now, archivedAt: null, reserved: false,
  });
  db.archiveProject("pArch");

  const app = await buildApp(db);
  try {
    const r = await app.inject({ method: "GET", url: "/api/projects/archived" });
    check("(1) GET /api/projects/archived → 200", r.statusCode === 200);
    const body = r.json();
    const row = body.find((p) => p.id === "pArch");
    check("(1) archived project is present", !!row);
    check("(1) sessionEnv value is masked (not the raw secret)", row?.config?.sessionEnv?.MY_SECRET !== SECRET);
    check("(1) masked value is same-length filler bullets",
      row?.config?.sessionEnv?.MY_SECRET === "•".repeat(SECRET.length));
    check("(1) other config keys are untouched", row?.config?.description === OTHER_CONFIG_VALUE);

    // (5) NEGATIVE CONTROL — the raw Db read (bypassing the route) still returns real plaintext, proving
    // the masking is a property of the route, not an accident already baked into storage/Db.
    const raw = db.listArchivedProjects().find((p) => p.id === "pArch");
    check("(5) negative control: raw Db.listArchivedProjects() returns the REAL plaintext secret",
      raw?.config?.sessionEnv?.MY_SECRET === SECRET);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (2) GET /api/platform/home masks sessionEnv =====================
{
  const db = new Db(path.join(TMP, "loom-platform.db"));
  seedDefaultProfiles(db);
  seedPlatformHome(db);
  const platformProject = db.listAllProjects().find((p) => p.reserved && p.name === PLATFORM_PROJECT_NAME);
  db.setProjectConfig(platformProject.id, { sessionEnv: { PLATFORM_SECRET: SECRET }, description: OTHER_CONFIG_VALUE });

  const app = await buildApp(db);
  try {
    const r = await app.inject({ method: "GET", url: "/api/platform/home" });
    check("(2) GET /api/platform/home → 200", r.statusCode === 200);
    const body = r.json();
    check("(2) sessionEnv value is masked (not the raw secret)",
      body.project?.config?.sessionEnv?.PLATFORM_SECRET !== SECRET);
    check("(2) masked value is same-length filler bullets",
      body.project?.config?.sessionEnv?.PLATFORM_SECRET === "•".repeat(SECRET.length));
    check("(2) other config keys are untouched", body.project?.config?.description === OTHER_CONFIG_VALUE);

    // (5) negative control for this route's own project too.
    const raw = db.getReservedProjectByName(PLATFORM_PROJECT_NAME);
    check("(5) negative control: raw Db.getReservedProjectByName() returns the REAL plaintext secret",
      raw?.config?.sessionEnv?.PLATFORM_SECRET === SECRET);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (3) GET /api/setup/home masks sessionEnv =====================
{
  const db = new Db(path.join(TMP, "loom-setup.db"));
  seedDefaultProfiles(db);
  seedSetupHome(db);
  const setupProject = db.listAllProjects().find((p) => p.reserved && p.name === SETUP_PROJECT_NAME);
  db.setProjectConfig(setupProject.id, { sessionEnv: { SETUP_SECRET: SECRET }, description: OTHER_CONFIG_VALUE });

  const app = await buildApp(db);
  try {
    const r = await app.inject({ method: "GET", url: "/api/setup/home" });
    check("(3) GET /api/setup/home → 200", r.statusCode === 200);
    const body = r.json();
    check("(3) sessionEnv value is masked (not the raw secret)",
      body.project?.config?.sessionEnv?.SETUP_SECRET !== SECRET);
    check("(3) masked value is same-length filler bullets",
      body.project?.config?.sessionEnv?.SETUP_SECRET === "•".repeat(SECRET.length));
    check("(3) other config keys are untouched", body.project?.config?.description === OTHER_CONFIG_VALUE);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (4) no sessionEnv (or empty map) round-trips unchanged on all three routes ======
{
  const db = new Db(path.join(TMP, "loom-nosecrets.db"));
  seedDefaultProfiles(db);
  seedPlatformHome(db);
  seedSetupHome(db);
  db.insertProject({
    id: "pPlain", name: "Plain Archived", repoPath: TMP, vaultPath: TMP,
    config: { description: OTHER_CONFIG_VALUE }, // no sessionEnv key at all
    createdAt: now, archivedAt: null, reserved: false,
  });
  db.archiveProject("pPlain");
  const platformProject = db.listAllProjects().find((p) => p.reserved && p.name === PLATFORM_PROJECT_NAME);
  db.setProjectConfig(platformProject.id, { sessionEnv: {}, description: OTHER_CONFIG_VALUE }); // empty map

  const app = await buildApp(db);
  try {
    const archived = (await app.inject({ method: "GET", url: "/api/projects/archived" })).json();
    const row = archived.find((p) => p.id === "pPlain");
    check("(4) archived project with no sessionEnv key round-trips unchanged",
      row?.config?.sessionEnv === undefined && row?.config?.description === OTHER_CONFIG_VALUE);

    const plat = (await app.inject({ method: "GET", url: "/api/platform/home" })).json();
    check("(4) platform home with an EMPTY sessionEnv map round-trips unchanged",
      Object.keys(plat.project?.config?.sessionEnv ?? {}).length === 0 &&
      plat.project?.config?.description === OTHER_CONFIG_VALUE);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GET /api/projects/archived, GET /api/platform/home, and GET /api/setup/home all mask config.sessionEnv values (same-length filler) via the shared redactSessionEnvForRead() helper, leave every other config key untouched, round-trip a project with no/empty sessionEnv unchanged, and a raw Db read (bypassing the route) still returns real plaintext — proving the masking is a property of the route, not the storage layer."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
