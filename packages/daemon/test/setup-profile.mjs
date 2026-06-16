import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Setup Assistant E1-1: the `setup` SessionRole + profile-role enum + the bundled "Setup Assistant"
// profile. HERMETIC + CLAUDE-FREE: isolated LOOM_HOME, imports dist/* + @loom/shared, no daemon, no
// real claude. Proves the design (Setup Assistant Design cards 1+4):
//   (1) validateProfile accepts role:"setup" (and normalizes it through), and STILL rejects role:"auditor"
//       — auditor is caller-set via startAuditor, never mintable on a profile (the security boundary).
//   (2) the bundled "Setup Assistant" profile seeds with LOOM_DEV UNSET (it is CORE, not the dev Platform
//       layer): isPlatformProfile() is false for role "setup", so it ships ungated like the worker rigs.
//   (3) the two PLATFORM profiles still DON'T seed when LOOM_DEV is unset (no platform-gate regression).
//   (4) resetProfileToBundled restores a tampered Setup Assistant row to the shipped values.
//
// Run: 1) build (turbo builds shared first), 2) node test/setup-profile.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set LOOM_HOME BEFORE importing dist (paths.ts reads it at import time). Leave LOOM_DEV UNSET — the
// whole point is that the Setup Assistant rig seeds in the default (non-dev) boot.
const tmpHome = path.join(os.tmpdir(), `loom-setupprof-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
delete process.env.LOOM_DEV; // ensure the default-OFF state — Setup Assistant must seed anyway

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { seedDefaultProfiles, BUNDLED_PROFILES, resetProfileToBundled } = await import("../dist/profiles/seed.js");
const { validateProfile } = await import("../dist/profiles/validate.js");
const { isLoomDev } = await import("../dist/paths.js");

try {
  check("(precondition) isLoomDev() is FALSE (LOOM_DEV unset)", isLoomDev() === false);

  // --- (1) validator accepts "setup", rejects "auditor" -----------------------------------------
  const okSetup = validateProfile({ name: "S", role: "setup" });
  check("(1) validateProfile accepts role:'setup'", okSetup.ok === true && okSetup.value.role === "setup");
  check("(1) validateProfile still accepts the existing roles", ["manager", "worker", "platform"].every(
    (r) => validateProfile({ name: "S", role: r }).ok === true));
  check("(1) validateProfile REJECTS role:'auditor' (caller-set only, never profile-mintable)",
    validateProfile({ name: "S", role: "auditor" }).ok === false);
  check("(1) validateProfile still rejects a bogus role", validateProfile({ name: "S", role: "boss" }).ok === false);

  // --- (2) the bundled Setup Assistant rig seeds in the DEFAULT (non-dev) boot --------------------
  const bundledSetup = BUNDLED_PROFILES.find((b) => b.name === "Setup Assistant");
  check("(2) BUNDLED_PROFILES contains a 'Setup Assistant' with role 'setup'",
    !!bundledSetup && bundledSetup.role === "setup");
  check("(2) the bundled Setup Assistant is NOT browser-capable (browserTesting unset/false)",
    bundledSetup.browserTesting !== true);

  const db = new Db();
  const seeded = seedDefaultProfiles(db);
  check("(2) seed (LOOM_DEV unset) INCLUDES 'Setup Assistant'", seeded.includes("Setup Assistant"));
  const byName = new Map(db.listProfiles().map((p) => [p.name, p]));
  const seededRow = byName.get("Setup Assistant");
  check("(2) the seeded row has role 'setup' + a non-empty description blurb",
    seededRow?.role === "setup" && typeof seededRow?.description === "string" && seededRow.description.length > 0);

  // --- (3) NO platform-gate regression: the two platform profiles still don't seed by default ----
  check("(3) Platform-lead is NOT seeded when LOOM_DEV is unset", !byName.has("Platform-lead"));
  check("(3) Platform-audit is NOT seeded when LOOM_DEV is unset", !byName.has("Platform-audit"));

  // --- (4) reset restores a tampered Setup Assistant row to the shipped values --------------------
  db.updateProfile(seededRow.id, { description: "tampered", icon: "💥" });
  check("(4) precondition: the row is tampered", db.getProfile(seededRow.id)?.description === "tampered");
  const reset = resetProfileToBundled(db, seededRow.id);
  const after = db.getProfile(seededRow.id);
  check("(4) resetProfileToBundled returns true and restores role/description/icon",
    reset === true && after?.role === "setup" &&
    after?.description === bundledSetup.description && after?.icon === bundledSetup.icon);

  // Re-seed is idempotent (Setup Assistant already present → not re-seeded).
  check("(4) re-seed does NOT re-seed Setup Assistant (idempotent)",
    !seedDefaultProfiles(db).includes("Setup Assistant"));

  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle on Windows) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — 'setup' is a valid profile role (auditor still isn't), and the ungated 'Setup Assistant' rig seeds in the default boot with no platform-gate regression."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
