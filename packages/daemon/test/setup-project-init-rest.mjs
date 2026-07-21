import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Guided Onboarding wizard "Create new" backend gap (follow-up to C5, card 07981d27): the HUMAN-only REST
// mirror of the agent-facing project_init MCP tool — POST /api/setup/project-init. HERMETIC + CLAUDE-FREE
// + NETWORK-FREE, modeled on setup-templates-rest.mjs (Db + buildServer via app.inject) and reusing the
// SAME confinement/traversal assertions the (j) block of setup-surface.mjs exercises against project_init
// itself — this REST route REUSES bootstrapProjectDir (setup/bootstrap.ts), the same fail-closed helper,
// so it must exhibit the identical guarantees. Proves:
//   (1) POST with just a name → 201, a REAL directory is created STRICTLY under the sanctioned
//       WORKSPACE_ROOT (confined to LOOM_HOME/workspaces), `git init`ed (kind defaults to "git"), and the
//       project is registered (repoPath === the created dir, vaultPath === "" — no vault bound, never
//       defaulted to the fresh code repo, reserved:false);
//   (2) kind:"vault" creates the dir WITHOUT git init, and vaultPath === repoPath (the created dir IS the vault);
//   (3) an explicit dirName lands under the sanctioned base as that exact leaf;
//   (4) missing name → 400, nothing written;
//   (5) TRAVERSAL/ESCAPE dirName ('../…' or absolute) → 400, REJECTED, nothing written outside the base,
//       no project row created (the load-bearing negative control);
//   (6) refuses to clobber an existing dir (same name → same slug) → 400, nothing written;
//   (7) HUMAN-ONLY: no MCP router file registers a tool at this REST path (grepped statically) — the only
//       reachable path is the loopback REST route (never an agent MCP tool).
// Run: 1) build (turbo builds shared first), 2) node test/setup-project-init-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-setup-project-init-rest-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45320";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { WORKSPACE_ROOT } = await import("../dist/paths.js");
const { isGitRepo: isGitRepoReal } = await import("../dist/git/reader.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const stub = {};
const buildApp = (db) => buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

// ===================== (1) POST with just a name → a real, confined, git-initialized project =====================
{
  const db = new Db(path.join(TMP, "loom-basic.db"));
  const app = await buildApp(db);
  try {
    const r = await app.inject({ method: "POST", url: "/api/setup/project-init", payload: { name: "Fresh Code" } });
    check("(1) POST /api/setup/project-init (name only) → 201", r.statusCode === 201);
    const body = r.json();
    check("(1) returns a project with an id", !!body.id && !body.error);
    check("(1) repoPath is CONFINED strictly under WORKSPACE_ROOT",
      body.repoPath.startsWith(path.resolve(WORKSPACE_ROOT) + path.sep));
    check("(1) vaultPath is empty (no vault bound, never defaulted to the code repo)", body.vaultPath === "");
    check("(1) the dir exists and was `git init`ed (.git present)", fs.existsSync(path.join(body.repoPath, ".git")));
    check("(1) the created repo passes a real isGitRepo check", await isGitRepoReal(body.repoPath));
    check("(1) persisted as a NON-reserved project", db.getProject(body.id)?.reserved === false);
    check("(1) db has exactly 1 project", db.listAllProjects().length === 1);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (2) kind:"vault" creates the dir WITHOUT git init =====================
{
  const db = new Db(path.join(TMP, "loom-vault.db"));
  const app = await buildApp(db);
  try {
    const r = await app.inject({ method: "POST", url: "/api/setup/project-init", payload: { name: "My Notes", kind: "vault" } });
    check("(2) POST kind:vault → 201", r.statusCode === 201);
    const body = r.json();
    check("(2) confined under WORKSPACE_ROOT", body.repoPath.startsWith(path.resolve(WORKSPACE_ROOT) + path.sep));
    check("(2) the dir exists but is NOT a git repo (no .git)",
      fs.existsSync(body.repoPath) && !fs.existsSync(path.join(body.repoPath, ".git")));
    check("(2) vaultPath === repoPath (the created dir IS the vault)", body.vaultPath === body.repoPath);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (3) an explicit dirName lands as that exact leaf =====================
{
  const db = new Db(path.join(TMP, "loom-dirname.db"));
  const app = await buildApp(db);
  try {
    const r = await app.inject({ method: "POST", url: "/api/setup/project-init", payload: { name: "Anything", kind: "vault", dirName: "explicit-dir" } });
    check("(3) explicit dirName → 201", r.statusCode === 201);
    const body = r.json();
    check("(3) lands under the sanctioned base as that leaf",
      body.repoPath === path.join(path.resolve(WORKSPACE_ROOT), "explicit-dir"));
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (4) missing name → 400, nothing written =====================
{
  const db = new Db(path.join(TMP, "loom-noname.db"));
  const app = await buildApp(db);
  try {
    const r = await app.inject({ method: "POST", url: "/api/setup/project-init", payload: {} });
    check("(4) missing name → 400", r.statusCode === 400);
    check("(4) nothing written", db.listAllProjects().length === 0);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===== (5) TRAVERSAL / ESCAPE — the load-bearing negative control =====
{
  const db = new Db(path.join(TMP, "loom-traversal.db"));
  const app = await buildApp(db);
  try {
    const escapeTarget = path.join(path.resolve(TMP), "escaped-project");
    const nBefore = db.listAllProjects().length;
    const rel = await app.inject({ method: "POST", url: "/api/setup/project-init", payload: { name: "Evil", dirName: "../escaped-project" } });
    check("(5) a traversal dirName ('../…') is REJECTED with 400", rel.statusCode === 400);
    check("(5) 400 body carries a reason", typeof rel.json().error === "string");
    check("(5) the rejected traversal created NO project row", db.listAllProjects().length === nBefore);
    check("(5) the rejected traversal wrote NOTHING outside the sanctioned base", !fs.existsSync(escapeTarget));

    const absTarget = path.join(path.resolve(TMP), "abs-escape");
    const abs = await app.inject({ method: "POST", url: "/api/setup/project-init", payload: { name: "Evil2", dirName: absTarget } });
    check("(5) an absolute dirName is REJECTED with 400", abs.statusCode === 400);
    check("(5) the rejected absolute-path create wrote NOTHING outside the base", !fs.existsSync(absTarget));
    check("(5) still NO project row after both rejections", db.listAllProjects().length === nBefore);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (6) refuses to clobber an existing dir =====================
{
  const db = new Db(path.join(TMP, "loom-clobber.db"));
  const app = await buildApp(db);
  try {
    const first = await app.inject({ method: "POST", url: "/api/setup/project-init", payload: { name: "Dup Project" } });
    check("(6) first create → 201", first.statusCode === 201);
    const nAfterFirst = db.listAllProjects().length;
    const second = await app.inject({ method: "POST", url: "/api/setup/project-init", payload: { name: "Dup Project" } });
    check("(6) same name → same slug → refused (400)", second.statusCode === 400);
    check("(6) the refused clobber created NO additional project", db.listAllProjects().length === nAfterFirst);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===== (7) HUMAN-ONLY: no MCP router registers a tool at this REST path =====
{
  const daemonSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const mcpDir = path.join(daemonSrc, "mcp");
  const mcpFiles = fs.readdirSync(mcpDir).filter((f) => f.endsWith(".ts"));
  check("(7) at least one MCP router file found to scan", mcpFiles.length > 0);
  let leaked = false;
  for (const f of mcpFiles) {
    const content = fs.readFileSync(path.join(mcpDir, f), "utf8");
    if (content.includes("/api/setup/project-init")) leaked = true;
  }
  check("(7) no MCP router file references the /api/setup/project-init REST path", !leaked);
}

// cleanup (retry for the WAL handle on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — POST /api/setup/project-init creates a confined, git-initialized project dir under the sanctioned WORKSPACE_ROOT (or a plain vault folder), rejects a traversal/absolute dirName and a name clash with nothing written, and no MCP router exposes this REST path (human-only)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
