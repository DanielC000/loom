import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card afda2a26: `POST /api/projects` and `POST /api/setup/project-init` (gateway/server.ts) used to
// store a caller-supplied `config` RAW (`config: b.config ?? {}`), skipping `validateProjectConfigOverride`
// entirely — every rule the human REST `PATCH /api/projects/:id/config` enforces (sessionEnv shape,
// dotted keys, the CLAUDE_CONFIG_DIR rejection (card fbb6e8ec), unknown top-level keys, ...) was reachable
// at PATCH time but bypassed at CREATE time. Both routes now call the SAME `validateProjectConfigOverride`
// (mcp/platform.ts) BEFORE any disk/DB side effect, with the SAME `invalid config: ...` error shape PATCH
// already uses, and store the VALIDATED (tilde-expanded + pruned) result instead of the raw body.
//
// Proves, per route (POST /api/projects via its vault-only branch — no repoPath, so no real git repo is
// needed; POST /api/setup/project-init via kind:"vault" — no git init, mirroring
// setup-project-init-response-redaction.mjs's own fastest branch):
//   REJECTED, each a 400 with the PATCH-shaped "invalid config: ..." error, and NOTHING is created (no
//   new project row; for project-init, the predicted target directory never exists on disk):
//     (1) a dotted sessionEnv key ("a.b") — same rejection `validateProjectConfigOverride` already gives
//         PATCH (card 12400719).
//     (2) a sessionEnv key named CLAUDE_CONFIG_DIR — card fbb6e8ec's rejection, now also reachable from
//         CREATE for the first time.
//     (3) an unknown/invalid top-level config key — the `.strict()` schema rejection.
//   ACCEPTED:
//     (4) a create with NO `config` field at all stores `{}` (the validator's own `raw ?? {}` default —
//         this route passes `b.config` through unmodified, relying on that internal default rather than
//         pre-defaulting itself).
//     (5) a valid, non-empty config is stored NORMALISED, not the raw body: a `~/...` `obsidian.path`
//         is tilde-expanded, and a now-empty nested object (`codescape: {}`) is pruned away entirely —
//         both post-validation transforms `validateProjectConfigOverride` already applies for PATCH.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + the REAL Fastify gateway (app.inject),
// every other dep STUBBED — mirrors project-config-patch-merge.mjs's own minimal harness.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-create-config-validation.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-create-cfg-validate-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { resolveProjectInitTarget } = await import("../dist/setup/bootstrap.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const db = new Db(path.join(TMP, "loom.db"));
const stub = {};
let app;
try {
  app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  // vaultPath for POST /api/projects' vault-only branch must be an existing dir (no git repo needed).
  const newVaultDir = (tag) => {
    const dir = path.join(TMP, `vault-${tag}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  // ===================== POST /api/projects =====================
  const createProjects = (payload) => app.inject({ method: "POST", url: "/api/projects", payload });

  // --- (1) rejected: a dotted sessionEnv key ----------------------------------------------------------
  {
    const before = db.listAllProjects().length;
    const r = await createProjects({ name: "Dotted", vaultPath: newVaultDir("dotted"), config: { sessionEnv: { "a.b": "y" } } });
    check("(projects/1) dotted sessionEnv key → 400", r.statusCode === 400);
    const body = r.json();
    check("(projects/1) PATCH-shaped error prefix", typeof body.error === "string" && body.error.startsWith("invalid config: "));
    check("(projects/1) names the dot-path reason", /dot-path/i.test(body.error) && body.error.includes('"a.b"'));
    check("(projects/1) ★ NOTHING created — project count unchanged", db.listAllProjects().length === before);
  }

  // --- (2) rejected: a sessionEnv key named CLAUDE_CONFIG_DIR (card fbb6e8ec) -------------------------
  {
    const before = db.listAllProjects().length;
    const r = await createProjects({ name: "ClaudeConfigDir", vaultPath: newVaultDir("ccd"), config: { sessionEnv: { CLAUDE_CONFIG_DIR: "/elsewhere" } } });
    check("(projects/2) CLAUDE_CONFIG_DIR sessionEnv key → 400", r.statusCode === 400);
    const body = r.json();
    check("(projects/2) PATCH-shaped error prefix", typeof body.error === "string" && body.error.startsWith("invalid config: "));
    check("(projects/2) names the offending key", body.error.includes("CLAUDE_CONFIG_DIR"));
    check("(projects/2) ★ NOTHING created — project count unchanged", db.listAllProjects().length === before);
  }

  // --- (3) rejected: an unknown/invalid top-level config key -------------------------------------------
  {
    const before = db.listAllProjects().length;
    const r = await createProjects({ name: "BogusField", vaultPath: newVaultDir("bogus"), config: { bogusField: 1 } });
    check("(projects/3) unknown config key → 400", r.statusCode === 400);
    const body = r.json();
    check("(projects/3) PATCH-shaped error prefix", typeof body.error === "string" && body.error.startsWith("invalid config: "));
    check("(projects/3) names the offending key", body.error.includes("bogusField"));
    check("(projects/3) ★ NOTHING created — project count unchanged", db.listAllProjects().length === before);
  }

  // --- (4) accepted: no config field at all → stores {} -------------------------------------------------
  {
    const r = await createProjects({ name: "NoConfig", vaultPath: newVaultDir("noconfig") });
    check("(projects/4) create with no config field → 201", r.statusCode === 201);
    const stored = db.getProject(r.json().id).config;
    check("(projects/4) ★ stored config is {} (the validator's own raw ?? {} default)",
      stored && typeof stored === "object" && Object.keys(stored).length === 0);
  }

  // --- (5) accepted: a valid, non-empty config is stored NORMALISED, not raw ---------------------------
  {
    const r = await createProjects({
      name: "Normalised", vaultPath: newVaultDir("normalised"),
      config: { obsidian: { path: "~/my-config-dir" }, codescape: {} },
    });
    check("(projects/5) valid non-empty config → 201", r.statusCode === 201);
    const stored = db.getProject(r.json().id).config;
    check("(projects/5) ★ obsidian.path is TILDE-EXPANDED, not the raw '~/...' string",
      stored.obsidian?.path === path.join(os.homedir(), "my-config-dir"));
    check("(projects/5) ★ the now-empty codescape:{} is PRUNED away entirely", stored.codescape === undefined);
  }

  // ===================== POST /api/setup/project-init =====================
  const createInit = (payload) => app.inject({ method: "POST", url: "/api/setup/project-init", payload });
  // Mirrors the real handler's own target derivation (resolveProjectInitTarget) so the "no dir created"
  // assertion below checks the EXACT path the handler would have bootstrapped, not a guess.
  const initTargetFor = (name) => {
    const t = resolveProjectInitTarget({ name });
    if (!t.ok) throw new Error(`test setup: could not predict the project-init target for "${name}": ${t.error}`);
    return t.target;
  };

  // --- (6) rejected: a dotted sessionEnv key — no project row, no dir ----------------------------------
  {
    const before = db.listAllProjects().length;
    const target = initTargetFor("Init Dotted");
    const r = await createInit({ name: "Init Dotted", kind: "vault", config: { sessionEnv: { "a.b": "y" } } });
    check("(init/6) dotted sessionEnv key → 400", r.statusCode === 400);
    const body = r.json();
    check("(init/6) PATCH-shaped error prefix", typeof body.error === "string" && body.error.startsWith("invalid config: "));
    check("(init/6) names the dot-path reason", /dot-path/i.test(body.error) && body.error.includes('"a.b"'));
    check("(init/6) ★ NOTHING created — project count unchanged", db.listAllProjects().length === before);
    check("(init/6) ★ the predicted target directory was NEVER created", !fs.existsSync(target));
  }

  // --- (7) rejected: a sessionEnv key named CLAUDE_CONFIG_DIR — no project row, no dir -----------------
  {
    const before = db.listAllProjects().length;
    const target = initTargetFor("Init ClaudeConfigDir");
    const r = await createInit({ name: "Init ClaudeConfigDir", kind: "vault", config: { sessionEnv: { CLAUDE_CONFIG_DIR: "/elsewhere" } } });
    check("(init/7) CLAUDE_CONFIG_DIR sessionEnv key → 400", r.statusCode === 400);
    const body = r.json();
    check("(init/7) PATCH-shaped error prefix", typeof body.error === "string" && body.error.startsWith("invalid config: "));
    check("(init/7) names the offending key", body.error.includes("CLAUDE_CONFIG_DIR"));
    check("(init/7) ★ NOTHING created — project count unchanged", db.listAllProjects().length === before);
    check("(init/7) ★ the predicted target directory was NEVER created", !fs.existsSync(target));
  }

  // --- (8) rejected: an unknown/invalid top-level config key — no project row, no dir -------------------
  {
    const before = db.listAllProjects().length;
    const target = initTargetFor("Init BogusField");
    const r = await createInit({ name: "Init BogusField", kind: "vault", config: { bogusField: 1 } });
    check("(init/8) unknown config key → 400", r.statusCode === 400);
    const body = r.json();
    check("(init/8) PATCH-shaped error prefix", typeof body.error === "string" && body.error.startsWith("invalid config: "));
    check("(init/8) names the offending key", body.error.includes("bogusField"));
    check("(init/8) ★ NOTHING created — project count unchanged", db.listAllProjects().length === before);
    check("(init/8) ★ the predicted target directory was NEVER created", !fs.existsSync(target));
  }

  // --- (9) accepted: no config field at all → stores {} --------------------------------------------------
  {
    const r = await createInit({ name: "Init NoConfig", kind: "vault" });
    check("(init/9) create with no config field → 201", r.statusCode === 201);
    const stored = db.getProject(r.json().id).config;
    check("(init/9) ★ stored config is {} (the validator's own raw ?? {} default)",
      stored && typeof stored === "object" && Object.keys(stored).length === 0);
  }

  // --- (10) accepted: a valid, non-empty config is stored NORMALISED, not raw ---------------------------
  {
    const r = await createInit({
      name: "Init Normalised", kind: "vault",
      config: { obsidian: { path: "~/my-config-dir" }, codescape: {} },
    });
    check("(init/10) valid non-empty config → 201", r.statusCode === 201);
    const stored = db.getProject(r.json().id).config;
    check("(init/10) ★ obsidian.path is TILDE-EXPANDED, not the raw '~/...' string",
      stored.obsidian?.path === path.join(os.homedir(), "my-config-dir"));
    check("(init/10) ★ the now-empty codescape:{} is PRUNED away entirely", stored.codescape === undefined);
  }
} finally {
  try { await app?.close(); } catch { /* ignore */ }
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — POST /api/projects and POST /api/setup/project-init both validate `config` through the SAME validateProjectConfigOverride PATCH already uses (dotted sessionEnv keys, CLAUDE_CONFIG_DIR, and unknown top-level keys all 400 with the PATCH-shaped error and create NOTHING — no project row, no directory), while a missing config stores {} and a valid config is stored tilde-expanded + pruned rather than raw."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
