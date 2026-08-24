import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 86e84e1c: half of the DoD for making seed.ts's ASSET_SKILLS overridable via
// LOOM_ASSET_SKILLS (see skills-seed-asset-override.mjs for the override-in-use half) — production
// behavior with the override UNSET must be byte-identical to before this card. Proven by leaving
// LOOM_ASSET_SKILLS unset, seeding into a fresh temp store, and confirming a genuine repo-bundled skill
// (checked into assets/skills/, not synthetic) is picked up from the REAL asset dir untouched.
//
// Fully hermetic on the store side (temp LOOM_HOME + sandboxed HOME); deliberately reads the real,
// checked-in assets/skills/worker/SKILL.md as the comparison oracle. Never touches ~/.loom or :4317.
// Run after build, from the daemon package root (assets/skills/ is relative to process.cwd()).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-seedoverride-default-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
fs.mkdirSync(skillsDir, { recursive: true });

delete process.env.LOOM_DEV;
delete process.env.LOOM_ASSET_SKILLS; // explicitly UNSET — this is the assertion under test
process.env.LOOM_HOME = home;         // BEFORE import — paths.ts computes SKILLS_DIR at load
process.env.LOOM_PORT = "45425";
const sandboxHome = path.join(root, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { seedGlobalSkills } = await import("../dist/skills/seed.js");
const realWorkerSkillMd = path.join(process.cwd(), "assets", "skills", "worker", "SKILL.md");

try {
  check("[precondition] the real repo asset this test compares against exists", fs.existsSync(realWorkerSkillMd));

  const seeded = seedGlobalSkills();

  check("[default] override unset: a genuine repo-bundled skill (worker) is still seeded from the REAL assets dir",
    seeded.includes("worker") && fs.existsSync(path.join(skillsDir, "worker", "SKILL.md")));
  check("[default] its content matches the real repo asset byte-for-byte (unchanged resolution)",
    fs.readFileSync(path.join(skillsDir, "worker", "SKILL.md"), "utf8") === fs.readFileSync(realWorkerSkillMd, "utf8"));
} finally {
  cleanupPathSync(root);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — with LOOM_ASSET_SKILLS unset, seedGlobalSkills() still resolves the real repo assets dir, unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
