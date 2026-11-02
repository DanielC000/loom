import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Boot migration: an EXISTING install's "image-gen" capability_defs row (the original bundled/npx-
// mcp-imagenate shape) is rewritten in place to the new npm-pinned shape — migrateImageGenCapabilityToNpmPinned
// (capabilities/seed.ts). Mirrors github-provision-migration.mjs's discipline exactly (card e7d6e43b):
// hand-seed the EXACT pre-migration row shape a real upgraded install would carry (seedDefaultCapabilities
// is seed-if-absent and would never overwrite it — that's the whole reason this migration exists), run
// the migration directly, and assert both the positive rewrite AND every guard that must leave a row
// untouched.
//
// Proves:
//   (a) a pre-migration row (kind:"bundled", command:"npx", args:["-y","mcp-imagenate@0.2.1"],
//       outputDirEnvVar:"NANO_BANANA_OUTPUT_DIR") is rewritten to kind:"npm-pinned",
//       provisionJson:{kind:"npm-pinned",package:"mcp-imagenate",version:MCP_IMAGENATE_VERSION,
//       binRelativeToPackageJson:"dist/index.js",outputDirEnvVar:"NANO_BANANA_OUTPUT_DIR"}.
//   (b) idempotent: calling the migration again on the now-migrated row is a no-op (already npm-pinned).
//   (c) an OWNER-CUSTOMIZED row (same kind "bundled" but a DIFFERENT command/args/version) is left
//       completely untouched — the narrow match never touches a row a human deliberately reconfigured.
//   (d) a row already on some OTHER kind (e.g. "command") is left untouched.
//   (e) no "image-gen" row at all (fresh install, pre-seed) ⇒ no-op, returns false — never throws.
//   (f) end-to-end boot ORDER: seedDefaultCapabilities (seed-if-absent) then the migration — a genuinely
//       fresh install's seed lands the NEW npm-pinned shape directly, and the migration is a correct
//       no-op on top of it (never "double migrates" or corrupts a freshly-seeded row).
//   (g) the migration's narrow match is version-specific — a row pinned to a DIFFERENT mcp-imagenate
//       version than the one this migration knows about is left untouched (an owner/future-version bump
//       must not be silently overwritten with a stale version string).
//
// Run: 1) build, 2) node test/npm-pinned-migration.mjs
import fs from "node:fs";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("npm-pinned-mig-");

const { Db } = await import("../dist/db.js");
const { seedDefaultCapabilities, migrateImageGenCapabilityToNpmPinned } = await import("../dist/capabilities/seed.js");

const LOOM_HOME = process.env.LOOM_HOME;
const LEGACY_PROVISION = { kind: "bundled", command: "npx", args: ["-y", "mcp-imagenate@0.2.1"], outputDirEnvVar: "NANO_BANANA_OUTPUT_DIR" };

// ===================== (a) the real pre-migration shape is rewritten =====================
{
  const db = new Db(path.join(LOOM_HOME, "a.db"));
  db.createCapabilityDef({
    slug: "image-gen", name: "Image Generation (Gemini/Imagen)", description: "d", transport: "stdio", kind: "bundled",
    provisionJson: JSON.stringify(LEGACY_PROVISION),
    toolAllowlistJson: JSON.stringify(["mcp__image-gen"]), wantsScratchDir: true,
    requiresConnection: true, secretEnvVar: "GEMINI_API_KEY",
  });
  const migrated = migrateImageGenCapabilityToNpmPinned(db);
  check("(a) migrateImageGenCapabilityToNpmPinned returns true (a rewrite happened)", migrated === true);
  const row = db.getCapabilityDefBySlug("image-gen");
  check("(a) row.kind is now 'npm-pinned'", row.kind === "npm-pinned");
  const provision = JSON.parse(row.provisionJson);
  check("(a) provisionJson.kind is 'npm-pinned'", provision.kind === "npm-pinned");
  check("(a) provisionJson.package is 'mcp-imagenate'", provision.package === "mcp-imagenate");
  check("(a) provisionJson.version is '0.2.1'", provision.version === "0.2.1");
  check("(a) provisionJson.binRelativeToPackageJson is 'dist/index.js'", provision.binRelativeToPackageJson === "dist/index.js");
  check("(a) provisionJson.outputDirEnvVar is preserved ('NANO_BANANA_OUTPUT_DIR')", provision.outputDirEnvVar === "NANO_BANANA_OUTPUT_DIR");
  check("(a) every OTHER field is unchanged (slug/name/wantsScratchDir/requiresConnection/secretEnvVar/toolAllowlistJson)",
    row.slug === "image-gen" && row.wantsScratchDir === true && row.requiresConnection === true
    && row.secretEnvVar === "GEMINI_API_KEY" && JSON.parse(row.toolAllowlistJson).includes("mcp__image-gen"));

  // ===================== (b) idempotent — a second call on the now-migrated row is a no-op =====================
  const secondCall = migrateImageGenCapabilityToNpmPinned(db);
  check("(b) a second call on the migrated row returns false (no-op, idempotent)", secondCall === false);
  const rowAfter = db.getCapabilityDefBySlug("image-gen");
  check("(b) the row is unchanged after the idempotent no-op", JSON.stringify(rowAfter) === JSON.stringify(row));
  db.close();
}

// ===================== (c) an owner-customized "bundled" row is left untouched =====================
{
  const db2 = new Db(path.join(LOOM_HOME, "b.db"));
  db2.createCapabilityDef({
    slug: "image-gen", name: "Image Generation (Gemini/Imagen)", description: "d", transport: "stdio", kind: "bundled",
    // a DIFFERENT command/args than the legacy shape — an owner who hand-edited this row before the migration shipped
    provisionJson: JSON.stringify({ kind: "bundled", command: "/usr/local/bin/my-custom-image-gen", args: [] }),
    toolAllowlistJson: JSON.stringify(["mcp__image-gen"]), wantsScratchDir: true,
    requiresConnection: true, secretEnvVar: "GEMINI_API_KEY",
  });
  const before = db2.getCapabilityDefBySlug("image-gen");
  const result = migrateImageGenCapabilityToNpmPinned(db2);
  check("(c) an owner-customized 'bundled' row is left untouched (returns false)", result === false);
  const after = db2.getCapabilityDefBySlug("image-gen");
  check("(c) the row is byte-identical before/after (never rewritten)", JSON.stringify(before) === JSON.stringify(after));
  db2.close();
}

// ===================== (d) a row already on a different kind is left untouched =====================
{
  const db3 = new Db(path.join(LOOM_HOME, "c.db"));
  db3.createCapabilityDef({
    slug: "image-gen", name: "Image Generation (Gemini/Imagen)", description: "d", transport: "stdio", kind: "command",
    provisionJson: JSON.stringify({ kind: "command", command: "/opt/homebrew/bin/mcp-imagenate", args: [] }),
    toolAllowlistJson: JSON.stringify(["mcp__image-gen"]), wantsScratchDir: true,
    requiresConnection: true, secretEnvVar: "GEMINI_API_KEY",
  });
  const result = migrateImageGenCapabilityToNpmPinned(db3);
  check("(d) a row already on a different kind ('command') is left untouched", result === false);
  check("(d) row.kind stays 'command'", db3.getCapabilityDefBySlug("image-gen").kind === "command");
  db3.close();
}

// ===================== (e) no 'image-gen' row at all ⇒ no-op, never throws =====================
{
  const db4 = new Db(path.join(LOOM_HOME, "d.db"));
  check("(e) precondition: no 'image-gen' row yet", db4.getCapabilityDefBySlug("image-gen") === undefined);
  let threw = false;
  let result;
  try { result = migrateImageGenCapabilityToNpmPinned(db4); } catch { threw = true; }
  check("(e) migrateImageGenCapabilityToNpmPinned never throws on an absent row", !threw);
  check("(e) returns false when the row is absent", result === false);
  db4.close();
}

// ===================== (f) end-to-end boot ORDER: a fresh install's seed already lands the NEW shape,
// and running the migration on top is a correct no-op (never double-migrates / corrupts a fresh seed) =====
{
  const db5 = new Db(path.join(LOOM_HOME, "e.db"));
  check("(f) precondition: fresh db, no 'image-gen' row", db5.getCapabilityDefBySlug("image-gen") === undefined);
  const seeded = seedDefaultCapabilities(db5);
  check("(f) seedDefaultCapabilities seeds the 'image-gen' row on a fresh install", seeded.includes("image-gen"));
  const freshRow = db5.getCapabilityDefBySlug("image-gen");
  check("(f) the freshly-seeded row is ALREADY 'npm-pinned' (no legacy npx shape ever exists on a new install)",
    freshRow.kind === "npm-pinned" && JSON.parse(freshRow.provisionJson).kind === "npm-pinned");
  const migratedFresh = migrateImageGenCapabilityToNpmPinned(db5);
  check("(f) running the migration on top of a fresh seed is a correct no-op (returns false)", migratedFresh === false);
  check("(f) the fresh row is unchanged after the no-op migration", JSON.stringify(db5.getCapabilityDefBySlug("image-gen")) === JSON.stringify(freshRow));
  db5.close();
}

// ===================== (g) version-specific narrow match: a DIFFERENT pinned version is left untouched =====================
{
  const db6 = new Db(path.join(LOOM_HOME, "f.db"));
  db6.createCapabilityDef({
    slug: "image-gen", name: "Image Generation (Gemini/Imagen)", description: "d", transport: "stdio", kind: "bundled",
    // same shape, but a version this migration does NOT recognize (an owner who manually bumped the pin pre-migration)
    provisionJson: JSON.stringify({ kind: "bundled", command: "npx", args: ["-y", "mcp-imagenate@9.9.9"], outputDirEnvVar: "NANO_BANANA_OUTPUT_DIR" }),
    toolAllowlistJson: JSON.stringify(["mcp__image-gen"]), wantsScratchDir: true,
    requiresConnection: true, secretEnvVar: "GEMINI_API_KEY",
  });
  const before = db6.getCapabilityDefBySlug("image-gen");
  const result = migrateImageGenCapabilityToNpmPinned(db6);
  check("(g) a row pinned to a DIFFERENT version is left untouched (returns false)", result === false);
  check("(g) the row is byte-identical before/after", JSON.stringify(before) === JSON.stringify(db6.getCapabilityDefBySlug("image-gen")));
  db6.close();
}

try { fs.rmSync(LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort — the harness registry also sweeps this */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — image-gen capability boot migration (npx → npm-pinned): a real pre-migration row is rewritten in place (every other field preserved), idempotent on a second call, an owner-customized / different-kind / different-version row is left completely untouched, an absent row never throws, and the migration is a correct no-op on top of a fresh install's already-new-shape seed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
