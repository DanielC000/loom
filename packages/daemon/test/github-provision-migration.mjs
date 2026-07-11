import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Boot migration: an EXISTING install's "github" capability_defs row (the archived
// bundled/npx/@modelcontextprotocol/server-github shape) is rewritten in place to the new
// github-binary/version shape — migrateGithubCapabilityToBinary (capabilities/seed.ts). Mirrors the
// "Getting Started" → "Platform" home rename test's discipline (setup-home.mjs): hand-seed the EXACT
// pre-migration row shape a real upgraded install would carry (seedDefaultCapabilities is seed-if-absent
// and would never overwrite it — that's the whole reason this migration exists), run the migration
// directly, and assert both the positive rewrite AND every guard that must leave a row untouched.
//
// Proves:
//   (a) a pre-migration row (kind:"bundled", command:"npx", args:["-y","@modelcontextprotocol/server-github"])
//       is rewritten to kind:"github-binary", provisionJson:{kind:"github-binary",version:GITHUB_MCP_SERVER_VERSION}.
//   (b) idempotent: calling the migration again on the now-migrated row is a no-op (already github-binary).
//   (c) an OWNER-CUSTOMIZED row (same kind "bundled" but a DIFFERENT command/args) is left completely untouched
//       — the narrow match never touches a row a human deliberately reconfigured.
//   (d) a row already on some OTHER kind (e.g. "command") is left untouched.
//   (e) no "github" row at all (fresh install, pre-seed) ⇒ no-op, returns false — never throws.
//   (f) end-to-end boot ORDER: seedDefaultCapabilities (seed-if-absent) then the migration — a genuinely
//       fresh install's seed lands the NEW shape directly, and the migration is a correct no-op on top of it
//       (never "double migrates" or corrupts a freshly-seeded row).
//
// Run: 1) build, 2) node test/github-provision-migration.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-ghmig-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { seedDefaultCapabilities, migrateGithubCapabilityToBinary } = await import("../dist/capabilities/seed.js");
const { GITHUB_MCP_SERVER_VERSION } = await import("../dist/capabilities/github-binary.js");

// ===================== (a) the real pre-migration shape is rewritten =====================
{
  const db = new Db(path.join(tmpHome, "a.db"));
  // Hand-seed the EXACT pre-migration row a real upgraded install carries — bypassing seedDefaultCapabilities
  // (which is seed-if-absent and would never touch an existing row), simulating the DB state an install
  // upgraded from a pre-github-binary Loom version actually has on disk.
  db.createCapabilityDef({
    slug: "github", name: "GitHub", description: "d", transport: "stdio", kind: "bundled",
    provisionJson: JSON.stringify({ kind: "bundled", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }),
    toolAllowlistJson: JSON.stringify(["mcp__github"]), wantsScratchDir: false,
    requiresConnection: true, secretEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
  });
  const migrated = migrateGithubCapabilityToBinary(db);
  check("(a) migrateGithubCapabilityToBinary returns true (a rewrite happened)", migrated === true);
  const row = db.getCapabilityDefBySlug("github");
  check("(a) row.kind is now 'github-binary'", row.kind === "github-binary");
  const provision = JSON.parse(row.provisionJson);
  check("(a) provisionJson.kind is 'github-binary'", provision.kind === "github-binary");
  check("(a) provisionJson.version is the pinned GITHUB_MCP_SERVER_VERSION", provision.version === GITHUB_MCP_SERVER_VERSION);
  check("(a) every OTHER field is unchanged (slug/name/requiresConnection/secretEnvVar/toolAllowlistJson)",
    row.slug === "github" && row.name === "GitHub" && row.requiresConnection === true
    && row.secretEnvVar === "GITHUB_PERSONAL_ACCESS_TOKEN" && JSON.parse(row.toolAllowlistJson).includes("mcp__github"));

  // ===================== (b) idempotent — a second call on the now-migrated row is a no-op =====================
  const secondCall = migrateGithubCapabilityToBinary(db);
  check("(b) a second call on the migrated row returns false (no-op, idempotent)", secondCall === false);
  const rowAfter = db.getCapabilityDefBySlug("github");
  check("(b) the row is unchanged after the idempotent no-op", JSON.stringify(rowAfter) === JSON.stringify(row));
  db.close();
}

// ===================== (c) an owner-customized "bundled" row is left untouched =====================
{
  const db2 = new Db(path.join(tmpHome, "b.db"));
  db2.createCapabilityDef({
    slug: "github", name: "GitHub", description: "d", transport: "stdio", kind: "bundled",
    // a DIFFERENT command than the legacy npx shape — an owner who hand-edited this row before the migration shipped
    provisionJson: JSON.stringify({ kind: "bundled", command: "/usr/local/bin/my-custom-github-mcp", args: [] }),
    toolAllowlistJson: JSON.stringify(["mcp__github"]), wantsScratchDir: false,
    requiresConnection: true, secretEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
  });
  const before = db2.getCapabilityDefBySlug("github");
  const result = migrateGithubCapabilityToBinary(db2);
  check("(c) an owner-customized 'bundled' row is left untouched (returns false)", result === false);
  const after = db2.getCapabilityDefBySlug("github");
  check("(c) the row is byte-identical before/after (never rewritten)", JSON.stringify(before) === JSON.stringify(after));
  db2.close();
}

// ===================== (d) a row already on a different kind is left untouched =====================
{
  const db3 = new Db(path.join(tmpHome, "c.db"));
  db3.createCapabilityDef({
    slug: "github", name: "GitHub", description: "d", transport: "stdio", kind: "command",
    provisionJson: JSON.stringify({ kind: "command", command: "/opt/homebrew/bin/github-mcp-server", args: ["stdio"] }),
    toolAllowlistJson: JSON.stringify(["mcp__github"]), wantsScratchDir: false,
    requiresConnection: true, secretEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
  });
  const result = migrateGithubCapabilityToBinary(db3);
  check("(d) a row already on a different kind ('command') is left untouched", result === false);
  check("(d) row.kind stays 'command'", db3.getCapabilityDefBySlug("github").kind === "command");
  db3.close();
}

// ===================== (e) no 'github' row at all ⇒ no-op, never throws =====================
{
  const db4 = new Db(path.join(tmpHome, "d.db"));
  check("(e) precondition: no 'github' row yet", db4.getCapabilityDefBySlug("github") === undefined);
  let threw = false;
  let result;
  try { result = migrateGithubCapabilityToBinary(db4); } catch { threw = true; }
  check("(e) migrateGithubCapabilityToBinary never throws on an absent row", !threw);
  check("(e) returns false when the row is absent", result === false);
  db4.close();
}

// ===================== (f) end-to-end boot ORDER: a fresh install's seed already lands the NEW shape,
// and running the migration on top is a correct no-op (never double-migrates / corrupts a fresh seed) =====
{
  const db5 = new Db(path.join(tmpHome, "e.db"));
  check("(f) precondition: fresh db, no 'github' row", db5.getCapabilityDefBySlug("github") === undefined);
  const seeded = seedDefaultCapabilities(db5);
  check("(f) seedDefaultCapabilities seeds the 'github' row on a fresh install", seeded.includes("github"));
  const freshRow = db5.getCapabilityDefBySlug("github");
  check("(f) the freshly-seeded row is ALREADY 'github-binary' (no legacy npx shape ever exists on a new install)",
    freshRow.kind === "github-binary" && JSON.parse(freshRow.provisionJson).kind === "github-binary");
  const migratedFresh = migrateGithubCapabilityToBinary(db5);
  check("(f) running the migration on top of a fresh seed is a correct no-op (returns false)", migratedFresh === false);
  check("(f) the fresh row is unchanged after the no-op migration", JSON.stringify(db5.getCapabilityDefBySlug("github")) === JSON.stringify(freshRow));
  db5.close();
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — github capability boot migration (npx → github-binary): a real pre-migration row is rewritten in place (every other field preserved), idempotent on a second call, an owner-customized or already-migrated/different-kind row is left completely untouched, an absent row never throws, and the migration is a correct no-op on top of a fresh install's already-new-shape seed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
