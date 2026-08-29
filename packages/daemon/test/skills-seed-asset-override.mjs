import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 86e84e1c: seed.ts's ASSET_SKILLS constant used to be hardcoded to the real dist-relative
// assets/skills dir, so any hermetic test calling seedGlobalSkills() silently cpSync'd the REAL repo
// assets into its temp store — the cpSync-backfill -> base-snapshot-backfill hand-off (the one path
// where a brand-new file first enters the store and gets its first base snapshot) could never be
// exercised end-to-end for a SYNTHETIC skill. Fixed by mirroring store.ts's own precedent
// (LOOM_ASSET_SKILLS override, itself modelled on LOOM_MARKITDOWN_BIN): a human/ops-only env seam that
// doubles as the test seam. This file proves the override works end-to-end through the REAL
// seedGlobalSkills() pipeline for synthetic skills. See skills-seed-asset-override-default.mjs (separate
// process, so ASSET_SKILLS-at-module-load is computed under a clean env) for the "override unset ->
// production default unchanged" half of the DoD.
//
// Fully hermetic — LOOM_HOME (store+base) and LOOM_ASSET_SKILLS (bundled asset) both point at fresh temp
// dirs BEFORE importing dist. Never touches ~/.loom, :4317, or the real repo asset dir. Run after build.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-seedoverride-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
const baseDir = path.join(home, "skill-base");
const assetDir = path.join(root, "synthetic-assets");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });

const writeFile = (p, content) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

// Seed the synthetic asset dir BEFORE the daemon import — a skill that is entirely absent from the
// store, so the FIRST seedGlobalSkills() call below exercises the real missing-dir cpSync branch
// (fs.cpSync(src, dest, { recursive: true }), not the force:false backfill branch).
const synthMd = "---\nname: synth-new-skill\ndescription: d\n---\n\n# synth-new-skill\n";
writeFile(path.join(assetDir, "synth-new-skill", "SKILL.md"), synthMd);
writeFile(path.join(assetDir, "synth-new-skill", "references", "doc.md"), "SYNTHETIC doctrine.\n");

delete process.env.LOOM_DEV;
process.env.LOOM_HOME = home;         // BEFORE import — paths.ts computes SKILLS_DIR / SKILL_BASE_DIR at load
process.env.LOOM_ASSET_SKILLS = assetDir; // BEFORE import — seed.ts (this card) + store.ts both compute
// their own ASSET_SKILLS constant at module load
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(root, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { seedGlobalSkills } = await import("../dist/skills/seed.js");
const { listSkills } = await import("../dist/skills/store.js");

try {
  // ===================================================================================================
  // (a) ENTIRELY NEW SKILL — exercises the real cpSync missing-dir branch, then the real
  //     seedBaseSnapshots/seedFileBaseSnapshots backfill on top: the genuine cpSync-backfill ->
  //     base-snapshot-backfill hand-off, for a file that is brand new to the store.
  // ===================================================================================================
  const seeded = seedGlobalSkills();

  check("[a] the synthetic skill (absent from the real repo assets) was seeded via the override",
    seeded.includes("synth-new-skill"));
  check("[a] cpSync-backfill: SKILL.md landed in the store from the synthetic asset dir",
    fs.readFileSync(path.join(skillsDir, "synth-new-skill", "SKILL.md"), "utf8") === synthMd);
  check("[a] cpSync-backfill: the reference file (new to the store) landed too",
    fs.readFileSync(path.join(skillsDir, "synth-new-skill", "references", "doc.md"), "utf8") === "SYNTHETIC doctrine.\n");
  check("[a] base-snapshot-backfill: SKILL.md's base was recorded (hand-off completed)",
    fs.existsSync(path.join(baseDir, "synth-new-skill.md"))
      && fs.readFileSync(path.join(baseDir, "synth-new-skill.md"), "utf8") === synthMd);
  check("[a] base-snapshot-backfill: the NEW reference file's base was recorded too (the file-new-to-the-store hand-off)",
    fs.readFileSync(path.join(baseDir, "synth-new-skill", "references", "doc.md"), "utf8") === "SYNTHETIC doctrine.\n");
  check("[a] the freshly-handed-off skill reads fully pristine (no false customized/updateAvailable)", (() => {
    const s = listSkills().find((x) => x.name === "synth-new-skill");
    return s?.customized === false && s?.updateAvailable === false;
  })());
  check("[a] no real repo-bundled skill leaked in (the loop only saw the synthetic asset dir)",
    !fs.existsSync(path.join(skillsDir, "worker")));

  // ===================================================================================================
  // (b) NEW FILE IN AN ALREADY-SEEDED SKILL — the force:false backfill branch: the skill already has a
  //     SKILL.md in the store, but a reference file the bundle just added is new to the store. Proves
  //     the hand-off for the OTHER shape of "new to the store".
  // ===================================================================================================
  writeFile(path.join(assetDir, "synth-new-skill", "references", "second.md"), "SECOND new file.\n");
  const seededAgain = seedGlobalSkills();

  check("[b] a new reference file added to an EXISTING synthetic skill backfills via cpSync(force:false)",
    fs.readFileSync(path.join(skillsDir, "synth-new-skill", "references", "second.md"), "utf8") === "SECOND new file.\n");
  check("[b] its base was backfilled too (hand-off completed for this shape as well)",
    fs.readFileSync(path.join(baseDir, "synth-new-skill", "references", "second.md"), "utf8") === "SECOND new file.\n");
  check("[b] an already-pristine skill with only a new file is not re-reported as freshly seeded",
    !seededAgain.includes("synth-new-skill"));
} finally {
  cleanupPathSync(root);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — LOOM_ASSET_SKILLS override exercises the real cpSync-backfill -> base-snapshot-backfill hand-off end-to-end for synthetic skills."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
