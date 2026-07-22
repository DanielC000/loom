import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Proof for board card 187873f9: unbundling codescape from the PUBLISHED release (card moved it into
// DEV_ONLY_SKILLS — see scripts/curate-release-skills.mjs) must not strand an existing end-user install
// that ran a pre-fix release with codescape genuinely shipped: their ~/.loom/skills/codescape store dir
// is now an ORPHAN — a store dir whose name is no longer a bundled asset on THIS install (the curated
// dist/assets/skills lacks it) — exactly the class retireOrphanedBundledSkillDirs() (card 5ddc2289,
// commit d3cfa27) already handles for a bundled-skill RENAME. codescape was added to that same
// RETIRED_BUNDLED_SKILL_NAMES allowlist (packages/daemon/src/skills/store.ts) to reuse the identical
// safety predicate: retire ONLY when (a) allowlisted, (b) NOT a current bundled asset on this install,
// (c) PRISTINE (mine == its own base snapshot, i.e. customized:false). A customized copy — an owner who
// hand-edited their local codescape doctrine before this fix — must survive untouched.
//
// Structured after skills-retire-orphaned.mjs's own hermetic pattern: sets LOOM_HOME (store+base) AND
// LOOM_ASSET_SKILLS (bundled asset) to TEMP dirs BEFORE importing dist, so this never touches the real
// repo asset (which DOES still ship codescape for dev/self-host — see skills-codescape-reconcile.mjs's
// scope note) or ~/.loom. The fake asset dir here deliberately has NO codescape entry, simulating the
// curated end-user dist/assets/skills this card produces.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-codescape-unbundle-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const assetDir = path.join(root, "assets", "skills"); // deliberately WITHOUT a codescape entry
const skillsDir = path.join(home, "skills");
const baseDir = path.join(home, "skill-base");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });

delete process.env.LOOM_DEV;
process.env.LOOM_HOME = home;             // BEFORE import — paths.ts computes SKILLS_DIR / SKILL_BASE_DIR at load
process.env.LOOM_PORT = "45423";
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
  check("precondition: codescape IS in the retired-names allowlist", RETIRED_BUNDLED_SKILL_NAMES.includes("codescape"));
  check("precondition: the fake asset set has NO codescape dir (simulates the curated end-user bundle)",
    !fs.existsSync(path.join(assetDir, "codescape")));

  const doc = "---\nname: codescape\ndescription: codescape doctrine\n---\n\n# codescape\n\nBody.\n";

  // ===================================================================================================
  // CASE 1 — pristine leftover from a pre-fix release that DID bundle codescape: mine == base, no
  // current asset. MUST be retired.
  // ===================================================================================================
  writeBaseFile("codescape", doc);   // base snapshot survives from when it was still bundled
  writeSkillDir("codescape", doc);   // mine == base — never edited by the user
  check("[pristine] precondition: store dir exists before retire", fs.existsSync(path.join(skillsDir, "codescape")));

  // --- run the boot auto-retire ------------------------------------------------------------------------
  const retired = retireOrphanedBundledSkillDirs();

  check("[pristine] returned in the retired list", retired.includes("codescape"));
  check("[pristine] store dir gone", !fs.existsSync(path.join(skillsDir, "codescape")));
  check("[pristine] base snapshot also cleaned up", !fs.existsSync(path.join(baseDir, "codescape.md")));
  check("[pristine] readSkill returns null", readSkill("codescape") === null);

  // Idempotent: a second run finds nothing left to retire.
  check("[idempotent] second run retires nothing", retireOrphanedBundledSkillDirs().length === 0);

  // ===================================================================================================
  // CASE 2 — a CUSTOMIZED copy (the owner hand-edited their local codescape doctrine before this fix):
  // mine != base. MUST survive untouched — the data-loss guard this whole mechanism exists for.
  // ===================================================================================================
  const custBase = doc;
  const custMine = doc.replace("Body.", "Body — EDITED BY USER.");
  writeBaseFile("codescape", custBase);
  writeSkillDir("codescape", custMine);

  const retired2 = retireOrphanedBundledSkillDirs();
  check("[customized] NOT in the retired list", !retired2.includes("codescape"));
  check("[customized] store dir survives", fs.existsSync(path.join(skillsDir, "codescape")));
  check("[customized] content byte-for-byte unchanged (user edit preserved)",
    readSkill("codescape")?.content === custMine);

  // ===================================================================================================
  // FALSIFICATION — prove this test can actually catch a broken predicate, not just pass by construction.
  // Re-run the pristine CASE 1 scenario but with codescape TEMPORARILY removed from the allowlist (guard
  // (a) broken) — the retirement assertion must go RED, then restoring it must go back GREEN.
  // ===================================================================================================
  fs.rmSync(path.join(skillsDir, "codescape"), { recursive: true, force: true });
  fs.rmSync(path.join(baseDir, "codescape.md"), { force: true });
  writeBaseFile("codescape", doc);
  writeSkillDir("codescape", doc);

  const originalIndex = RETIRED_BUNDLED_SKILL_NAMES.indexOf("codescape");
  const mutableNames = store.RETIRED_BUNDLED_SKILL_NAMES;
  // RETIRED_BUNDLED_SKILL_NAMES is `readonly string[]` at the type level only — at runtime it's a plain
  // array, so this in-process splice is how we falsify guard (a) without a second process/build.
  const removed = mutableNames.splice(originalIndex, 1);
  const brokenRetired = retireOrphanedBundledSkillDirs();
  const wentRed = !brokenRetired.includes("codescape") && fs.existsSync(path.join(skillsDir, "codescape"));
  console.log(`${wentRed ? "PASS" : "FAIL"}  [falsification] with codescape removed from the allowlist, retirement correctly does NOT fire (this is the RED state a broken predicate would also produce for the real assertions above)`);
  if (!wentRed) failures++;

  mutableNames.splice(originalIndex, 0, ...removed); // restore
  const restoredRetired = retireOrphanedBundledSkillDirs();
  const wentGreen = restoredRetired.includes("codescape") && !fs.existsSync(path.join(skillsDir, "codescape"));
  console.log(`${wentGreen ? "PASS" : "FAIL"}  [falsification] restoring codescape to the allowlist makes retirement fire again (GREEN) — proves the earlier PASS asserts something real, not a vacuous no-op`);
  if (!wentGreen) failures++;
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry: WAL handle on Windows */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — unbundling codescape from the published release retires only a pristine, allowlisted, asset-less orphan copy; a customized copy survives untouched, and the predicate is proven falsifiable."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
