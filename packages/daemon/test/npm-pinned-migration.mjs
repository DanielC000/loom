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
// A SECOND, SEPARATE migration — migrateImageGenNpmPinnedVersionBump (card b7d6b7f3) — bumps an EXISTING
// install's "image-gen" row off the pre-bump mcp-imagenate pin onto the current one, WITHOUT changing
// `kind` (it stays npm-pinned throughout; only the pinned `version` field moves). Proves:
//   (h) a real pre-bump npm-pinned row is rewritten onto the current pin, every other field preserved.
//   (i) idempotent: a second call on the now-migrated row is a no-op.
//   (j) an owner-customized npm-pinned row (same stale version, different bin path) is left untouched.
//   (k) a row already on the current pin is left untouched (nothing to do).
//   (l) no "image-gen" row at all ⇒ no-op, returns false — never throws.
//   (m) end-to-end boot ORDER: a genuinely fresh install's seed already lands the current pin directly,
//       and this migration on top of it is a correct no-op.
//   (n) a row pinned to an unrecognized OTHER version (an owner who bumped ahead by hand) is left untouched.
//   (o) a row still on the legacy "bundled" kind (never yet reached npm-pinned) is left untouched by THIS
//       migration — it only ever acts on an already-npm-pinned row, layering correctly with (a)-(g) above.
//
// Run: 1) build, 2) node test/npm-pinned-migration.mjs
import fs from "node:fs";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("npm-pinned-mig-");

const { Db } = await import("../dist/db.js");
const {
  seedDefaultCapabilities, bundledCapabilities, migrateImageGenCapabilityToNpmPinned, migrateImageGenNpmPinnedVersionBump,
} = await import("../dist/capabilities/seed.js");

const LOOM_HOME = process.env.LOOM_HOME;
const LEGACY_PROVISION = { kind: "bundled", command: "npx", args: ["-y", "mcp-imagenate@0.2.1"], outputDirEnvVar: "NANO_BANANA_OUTPUT_DIR" };
// The CURRENT live pin, read dynamically off the real seed row (card b7d6b7f3's own bump target) — never
// hardcoded here, so this file doesn't go stale on the NEXT version bump the way its own fixed "0.2.1"
// literal above legitimately can (that one names a frozen HISTORICAL shape, not a moving target).
const CURRENT_PIN = JSON.parse(bundledCapabilities().find((c) => c.slug === "image-gen").provisionJson).version;
const STALE_PIN = "0.2.1"; // card b7d6b7f3's pre-bump pin — frozen, mirrors seed.ts's own STALE_MCP_IMAGENATE_VERSION

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
  check(`(a) provisionJson.version is the current pin ('${CURRENT_PIN}')`, provision.version === CURRENT_PIN);
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

// ===================== migrateImageGenNpmPinnedVersionBump (card b7d6b7f3) =====================
// A SEPARATE migration from the one above: it never touches `kind` (stays npm-pinned throughout), it
// only re-stamps the pinned `version` field on an EXISTING install still carrying the pre-bump pin.

// ===================== (h) a real pre-bump npm-pinned row is rewritten onto the current pin =====================
{
  const db7 = new Db(path.join(LOOM_HOME, "g.db"));
  db7.createCapabilityDef({
    slug: "image-gen", name: "Image Generation (Gemini/Imagen)", description: "d", transport: "stdio", kind: "npm-pinned",
    provisionJson: JSON.stringify({
      kind: "npm-pinned", package: "mcp-imagenate", version: STALE_PIN,
      binRelativeToPackageJson: "dist/index.js", outputDirEnvVar: "NANO_BANANA_OUTPUT_DIR",
    }),
    toolAllowlistJson: JSON.stringify(["mcp__image-gen"]), wantsScratchDir: true,
    requiresConnection: true, secretEnvVar: "GEMINI_API_KEY",
  });
  const migrated = migrateImageGenNpmPinnedVersionBump(db7);
  check("(h) migrateImageGenNpmPinnedVersionBump returns true (a rewrite happened)", migrated === true);
  const row = db7.getCapabilityDefBySlug("image-gen");
  check("(h) row.kind stays 'npm-pinned' (version-only re-stamp, not a kind change)", row.kind === "npm-pinned");
  const provision = JSON.parse(row.provisionJson);
  check(`(h) provisionJson.version is now the current pin ('${CURRENT_PIN}')`, provision.version === CURRENT_PIN);
  check("(h) provisionJson.package/bin/outputDirEnvVar are preserved", provision.package === "mcp-imagenate"
    && provision.binRelativeToPackageJson === "dist/index.js" && provision.outputDirEnvVar === "NANO_BANANA_OUTPUT_DIR");
  check("(h) every OTHER field is unchanged (slug/wantsScratchDir/requiresConnection/secretEnvVar/toolAllowlistJson)",
    row.slug === "image-gen" && row.wantsScratchDir === true && row.requiresConnection === true
    && row.secretEnvVar === "GEMINI_API_KEY" && JSON.parse(row.toolAllowlistJson).includes("mcp__image-gen"));

  // ===================== (i) idempotent — a second call on the now-migrated row is a no-op =====================
  const secondCall = migrateImageGenNpmPinnedVersionBump(db7);
  check("(i) a second call on the migrated row returns false (no-op, idempotent)", secondCall === false);
  check("(i) the row is unchanged after the idempotent no-op", JSON.stringify(db7.getCapabilityDefBySlug("image-gen")) === JSON.stringify(row));
  db7.close();
}

// ===================== (j) an owner-customized npm-pinned row at the stale pin is left untouched =====================
{
  const db8 = new Db(path.join(LOOM_HOME, "h.db"));
  db8.createCapabilityDef({
    slug: "image-gen", name: "Image Generation (Gemini/Imagen)", description: "d", transport: "stdio", kind: "npm-pinned",
    // same stale version, but a DIFFERENT bin path — an owner who hand-edited this row before the bump shipped
    provisionJson: JSON.stringify({
      kind: "npm-pinned", package: "mcp-imagenate", version: STALE_PIN,
      binRelativeToPackageJson: "dist/my-fork-entry.js", outputDirEnvVar: "NANO_BANANA_OUTPUT_DIR",
    }),
    toolAllowlistJson: JSON.stringify(["mcp__image-gen"]), wantsScratchDir: true,
    requiresConnection: true, secretEnvVar: "GEMINI_API_KEY",
  });
  const before = db8.getCapabilityDefBySlug("image-gen");
  const result = migrateImageGenNpmPinnedVersionBump(db8);
  check("(j) an owner-customized npm-pinned row is left untouched (returns false)", result === false);
  check("(j) the row is byte-identical before/after", JSON.stringify(before) === JSON.stringify(db8.getCapabilityDefBySlug("image-gen")));
  db8.close();
}

// ===================== (k) a row already on the current pin is left untouched (nothing to do) =====================
{
  const db9 = new Db(path.join(LOOM_HOME, "i.db"));
  db9.createCapabilityDef({
    slug: "image-gen", name: "Image Generation (Gemini/Imagen)", description: "d", transport: "stdio", kind: "npm-pinned",
    provisionJson: JSON.stringify({
      kind: "npm-pinned", package: "mcp-imagenate", version: CURRENT_PIN,
      binRelativeToPackageJson: "dist/index.js", outputDirEnvVar: "NANO_BANANA_OUTPUT_DIR",
    }),
    toolAllowlistJson: JSON.stringify(["mcp__image-gen"]), wantsScratchDir: true,
    requiresConnection: true, secretEnvVar: "GEMINI_API_KEY",
  });
  const before = db9.getCapabilityDefBySlug("image-gen");
  const result = migrateImageGenNpmPinnedVersionBump(db9);
  check("(k) a row already on the current pin returns false (no-op)", result === false);
  check("(k) the row is byte-identical before/after", JSON.stringify(before) === JSON.stringify(db9.getCapabilityDefBySlug("image-gen")));
  db9.close();
}

// ===================== (l) no 'image-gen' row at all ⇒ no-op, never throws =====================
{
  const db10 = new Db(path.join(LOOM_HOME, "j.db"));
  check("(l) precondition: no 'image-gen' row yet", db10.getCapabilityDefBySlug("image-gen") === undefined);
  let threw = false;
  let result;
  try { result = migrateImageGenNpmPinnedVersionBump(db10); } catch { threw = true; }
  check("(l) migrateImageGenNpmPinnedVersionBump never throws on an absent row", !threw);
  check("(l) returns false when the row is absent", result === false);
  db10.close();
}

// ===================== (m) end-to-end: a fresh install's seed already lands the current pin, and the
// version-bump migration on top is a correct no-op (never double-bumps / corrupts a fresh seed) =========
{
  const db11 = new Db(path.join(LOOM_HOME, "k.db"));
  const seeded = seedDefaultCapabilities(db11);
  check("(m) seedDefaultCapabilities seeds the 'image-gen' row on a fresh install", seeded.includes("image-gen"));
  const freshRow = db11.getCapabilityDefBySlug("image-gen");
  check(`(m) the freshly-seeded row is ALREADY on the current pin ('${CURRENT_PIN}')`,
    JSON.parse(freshRow.provisionJson).version === CURRENT_PIN);
  const migratedFresh = migrateImageGenNpmPinnedVersionBump(db11);
  check("(m) running the version-bump migration on top of a fresh seed is a correct no-op (returns false)", migratedFresh === false);
  check("(m) the fresh row is unchanged after the no-op migration", JSON.stringify(db11.getCapabilityDefBySlug("image-gen")) === JSON.stringify(freshRow));
  db11.close();
}

// ===================== (n) a row pinned to some OTHER version (owner bumped ahead by hand) is left untouched ======
{
  const db12 = new Db(path.join(LOOM_HOME, "l.db"));
  db12.createCapabilityDef({
    slug: "image-gen", name: "Image Generation (Gemini/Imagen)", description: "d", transport: "stdio", kind: "npm-pinned",
    provisionJson: JSON.stringify({
      kind: "npm-pinned", package: "mcp-imagenate", version: "9.9.9",
      binRelativeToPackageJson: "dist/index.js", outputDirEnvVar: "NANO_BANANA_OUTPUT_DIR",
    }),
    toolAllowlistJson: JSON.stringify(["mcp__image-gen"]), wantsScratchDir: true,
    requiresConnection: true, secretEnvVar: "GEMINI_API_KEY",
  });
  const before = db12.getCapabilityDefBySlug("image-gen");
  const result = migrateImageGenNpmPinnedVersionBump(db12);
  check("(n) a row pinned to an unrecognized OTHER version is left untouched (returns false)", result === false);
  check("(n) the row is byte-identical before/after", JSON.stringify(before) === JSON.stringify(db12.getCapabilityDefBySlug("image-gen")));
  db12.close();
}

// ===================== (o) a row still on the legacy 'bundled' kind (never yet reached npm-pinned) is left
// untouched by THIS migration — it only ever acts on an already-npm-pinned row (layering with (a)-(g)) ===
{
  const db13 = new Db(path.join(LOOM_HOME, "m.db"));
  db13.createCapabilityDef({
    slug: "image-gen", name: "Image Generation (Gemini/Imagen)", description: "d", transport: "stdio", kind: "bundled",
    provisionJson: JSON.stringify(LEGACY_PROVISION),
    toolAllowlistJson: JSON.stringify(["mcp__image-gen"]), wantsScratchDir: true,
    requiresConnection: true, secretEnvVar: "GEMINI_API_KEY",
  });
  const before = db13.getCapabilityDefBySlug("image-gen");
  const result = migrateImageGenNpmPinnedVersionBump(db13);
  check("(o) a row still on the legacy 'bundled' kind is left untouched (returns false)", result === false);
  check("(o) the row is byte-identical before/after", JSON.stringify(before) === JSON.stringify(db13.getCapabilityDefBySlug("image-gen")));
  db13.close();
}

try { fs.rmSync(LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort — the harness registry also sweeps this */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — image-gen capability boot migrations: (1) npx → npm-pinned (a real pre-migration row is rewritten in place, every other field preserved, idempotent, owner-customized/different-kind/different-version left untouched, absent row never throws, no-op on a fresh seed), and (2) the npm-pinned version bump off the stale mcp-imagenate pin onto the current one (same discipline: real stale row rewritten in place, idempotent, owner-customized/already-current/unrecognized-version/absent/still-legacy-kind all left untouched, no-op on a fresh seed)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
