import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Proof for board card 426dbb37: `research` shipped in real PUBLISHED releases (v0.3.0 through v0.12.0,
// 2026-06-17 through 2026-06-29 — added to the bundled assets at dba60dc3 on 2026-06-04, and only moved
// into DEV_ONLY_SKILLS (scripts/curate-release-skills.mjs) at 17f14025 on 2026-06-30, first taking effect
// in v0.13.0) before being curated OUT of the published bundle as install-specific (bespoke to the
// owner's own geopolitics/history vault). Any end user who installed/updated during that ~12-day window
// had their global skill store seeded with `research` — an ORPHAN store dir whose name is no longer a
// bundled asset on their install (the curated dist/assets/skills lacks it), exactly the class
// retireOrphanedBundledSkillDirs() (card 5ddc2289, commit d3cfa27) already handles for a bundled-skill
// RENAME, and that codescape (card 187873f9) reused for a PUBLISHED-only unbundle. `research` was missing
// from that same RETIRED_BUNDLED_SKILL_NAMES allowlist (packages/daemon/src/skills/store.ts) — this test
// proves it now retires a pristine leftover while a customized copy survives untouched.
//
// Structured after skills-codescape-unbundle-retire.mjs's own hermetic pattern: sets LOOM_HOME
// (store+base) AND LOOM_ASSET_SKILLS (bundled asset) to TEMP dirs BEFORE importing dist, so this never
// touches the real repo asset (which DOES still ship research for dev/self-host) or ~/.loom. The fake
// asset dir here deliberately has NO research entry, simulating the curated end-user dist/assets/skills
// this card's fix targets.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-research-unbundle-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const assetDir = path.join(root, "assets", "skills"); // deliberately WITHOUT a research entry
const skillsDir = path.join(home, "skills");
const baseDir = path.join(home, "skill-base");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });

delete process.env.LOOM_DEV;
process.env.LOOM_HOME = home;             // BEFORE import — paths.ts computes SKILLS_DIR / SKILL_BASE_DIR at load
process.env.LOOM_PORT = String(hermeticPort());
process.env.LOOM_ASSET_SKILLS = assetDir; // BEFORE import — store.ts computes ASSET_SKILLS at load
const sandboxHome = path.join(root, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const store = await import("../dist/skills/store.js");
const { retireOrphanedBundledSkillDirs, readSkill, RETIRED_BUNDLED_SKILL_NAMES } = store;

const writeSkillDir = (name, content) => { fs.mkdirSync(path.join(skillsDir, name), { recursive: true }); fs.writeFileSync(path.join(skillsDir, name, "SKILL.md"), content); };
const writeBaseFile = (name, content) => { fs.mkdirSync(baseDir, { recursive: true }); fs.writeFileSync(path.join(baseDir, `${name}.md`), content); };

try {
  check("precondition: research IS in the retired-names allowlist", RETIRED_BUNDLED_SKILL_NAMES.includes("research"));
  check("precondition: the fake asset set has NO research dir (simulates the curated end-user bundle)",
    !fs.existsSync(path.join(assetDir, "research")));

  const doc = "---\nname: research\ndescription: research doctrine\n---\n\n# research\n\nBody.\n";

  // ===================================================================================================
  // CASE 1 — pristine leftover from a pre-fix release that DID bundle research (v0.3.0-v0.12.0): mine ==
  // base, no current asset. MUST be retired.
  // ===================================================================================================
  writeBaseFile("research", doc);   // base snapshot survives from when it was still bundled
  writeSkillDir("research", doc);   // mine == base — never edited by the user
  check("[pristine] precondition: store dir exists before retire", fs.existsSync(path.join(skillsDir, "research")));

  // --- run the boot auto-retire ------------------------------------------------------------------------
  const retired = retireOrphanedBundledSkillDirs();

  check("[pristine] returned in the retired list", retired.includes("research"));
  check("[pristine] store dir gone", !fs.existsSync(path.join(skillsDir, "research")));
  check("[pristine] base snapshot also cleaned up", !fs.existsSync(path.join(baseDir, "research.md")));
  check("[pristine] readSkill returns null", readSkill("research") === null);

  // Idempotent: a second run finds nothing left to retire.
  check("[idempotent] second run retires nothing", retireOrphanedBundledSkillDirs().length === 0);

  // ===================================================================================================
  // CASE 2 — a CUSTOMIZED copy (a user hand-edited their local research doctrine before this fix): mine
  // != base. MUST survive untouched — the data-loss guard this whole mechanism exists for.
  // ===================================================================================================
  const custBase = doc;
  const custMine = doc.replace("Body.", "Body — EDITED BY USER.");
  writeBaseFile("research", custBase);
  writeSkillDir("research", custMine);

  const retired2 = retireOrphanedBundledSkillDirs();
  check("[customized] NOT in the retired list", !retired2.includes("research"));
  check("[customized] store dir survives", fs.existsSync(path.join(skillsDir, "research")));
  check("[customized] content byte-for-byte unchanged (user edit preserved)",
    readSkill("research")?.content === custMine);

  // ===================================================================================================
  // FALSIFICATION — prove this test can actually catch a broken predicate, not just pass by construction.
  // Re-run the pristine CASE 1 scenario but with research TEMPORARILY removed from the allowlist (guard
  // (a) broken) — the retirement assertion must go RED, then restoring it must go back GREEN.
  // ===================================================================================================
  fs.rmSync(path.join(skillsDir, "research"), { recursive: true, force: true });
  fs.rmSync(path.join(baseDir, "research.md"), { force: true });
  writeBaseFile("research", doc);
  writeSkillDir("research", doc);

  const originalIndex = RETIRED_BUNDLED_SKILL_NAMES.indexOf("research");
  const mutableNames = store.RETIRED_BUNDLED_SKILL_NAMES;
  // RETIRED_BUNDLED_SKILL_NAMES is `readonly string[]` at the type level only — at runtime it's a plain
  // array, so this in-process splice is how we falsify guard (a) without a second process/build.
  const removed = mutableNames.splice(originalIndex, 1);
  const brokenRetired = retireOrphanedBundledSkillDirs();
  const wentRed = !brokenRetired.includes("research") && fs.existsSync(path.join(skillsDir, "research"));
  console.log(`${wentRed ? "PASS" : "FAIL"}  [falsification] with research removed from the allowlist, retirement correctly does NOT fire (this is the RED state a broken predicate would also produce for the real assertions above)`);
  if (!wentRed) failures++;

  mutableNames.splice(originalIndex, 0, ...removed); // restore
  const restoredRetired = retireOrphanedBundledSkillDirs();
  const wentGreen = restoredRetired.includes("research") && !fs.existsSync(path.join(skillsDir, "research"));
  console.log(`${wentGreen ? "PASS" : "FAIL"}  [falsification] restoring research to the allowlist makes retirement fire again (GREEN) — proves the earlier PASS asserts something real, not a vacuous no-op`);
  if (!wentGreen) failures++;
} finally {
  cleanupPathSync(root);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — unbundling research from the published release retires only a pristine, allowlisted, asset-less orphan copy; a customized copy survives untouched, and the predicate is proven falsifiable."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
