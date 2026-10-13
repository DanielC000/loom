import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Proof for board cards 187873f9 (`codescape`) and 426dbb37 (`research`): unbundling a skill from the
// PUBLISHED release (moved into DEV_ONLY_SKILLS — see scripts/curate-release-skills.mjs) must not strand
// an existing end-user install that ran a pre-fix release with that skill genuinely shipped: their
// ~/.loom/skills/<name> store dir is now an ORPHAN — a store dir whose name is no longer a bundled asset
// on THIS install (the curated dist/assets/skills lacks it) — exactly the class
// retireOrphanedBundledSkillDirs() (card 5ddc2289, commit d3cfa27) already handles for a bundled-skill
// RENAME, and that `codescape` (card 187873f9) first reused for a PUBLISHED-only unbundle, then `research`
// (card 426dbb37, the same shape: shipped v0.3.0-v0.12.0, 2026-06-17 through 2026-06-29, added at dba60dc3
// on 2026-06-04, moved into DEV_ONLY_SKILLS at 17f14025 on 2026-06-30) reused identically. Both names were
// added to the same RETIRED_BUNDLED_SKILL_NAMES allowlist (packages/daemon/src/skills/store.ts) to reuse
// the identical safety predicate: retire ONLY when (a) allowlisted, (b) NOT a current bundled asset on
// this install, (c) PRISTINE (mine == its own base snapshot, i.e. customized:false). A customized copy —
// an owner who hand-edited their local doctrine before this fix — must survive untouched.
//
// Parameterized over BOTH names (card 3493d0b6 — these were two near-identical, name-swapped files;
// folded into one to stop carrying two full copies of the same generic-mechanism harness). Each name
// still gets its own full run of every case below — this is not a reduction in assertion coverage, only
// in file count.
//
// Structured after skills-retire-orphaned.mjs's own hermetic pattern: sets LOOM_HOME (store+base) AND
// LOOM_ASSET_SKILLS (bundled asset) to TEMP dirs BEFORE importing dist, so this never touches the real
// repo asset (which DOES still ship both names for dev/self-host — see skills-codescape-reconcile.mjs's
// scope note) or ~/.loom. The fake asset dir here deliberately has NO entry for either name, simulating
// the curated end-user dist/assets/skills these cards produce.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-unbundle-retire-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const assetDir = path.join(root, "assets", "skills"); // deliberately WITHOUT either name's entry
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

// Runs the full retire/idempotent/customized-survives/falsification sequence for one allowlisted name.
// Isolated per name: each call starts from a clean skillsDir/baseDir entry for that name only, so the two
// runs below (codescape, research) cannot interfere with each other even though they share one process.
function runUnbundleRetireCase(name) {
  try {
    check(`[${name}] precondition: ${name} IS in the retired-names allowlist`, RETIRED_BUNDLED_SKILL_NAMES.includes(name));
    check(`[${name}] precondition: the fake asset set has NO ${name} dir (simulates the curated end-user bundle)`,
      !fs.existsSync(path.join(assetDir, name)));

    const doc = `---\nname: ${name}\ndescription: ${name} doctrine\n---\n\n# ${name}\n\nBody.\n`;

    // =====================================================================================================
    // CASE 1 — pristine leftover from a pre-fix release that DID bundle this name: mine == base, no
    // current asset. MUST be retired.
    // =====================================================================================================
    writeBaseFile(name, doc);   // base snapshot survives from when it was still bundled
    writeSkillDir(name, doc);   // mine == base — never edited by the user
    check(`[${name}][pristine] precondition: store dir exists before retire`, fs.existsSync(path.join(skillsDir, name)));

    // --- run the boot auto-retire ----------------------------------------------------------------------
    const retired = retireOrphanedBundledSkillDirs();

    check(`[${name}][pristine] returned in the retired list`, retired.includes(name));
    check(`[${name}][pristine] store dir gone`, !fs.existsSync(path.join(skillsDir, name)));
    check(`[${name}][pristine] base snapshot also cleaned up`, !fs.existsSync(path.join(baseDir, `${name}.md`)));
    check(`[${name}][pristine] readSkill returns null`, readSkill(name) === null);

    // Idempotent: a second run finds nothing left to retire.
    check(`[${name}][idempotent] second run retires nothing`, retireOrphanedBundledSkillDirs().length === 0);

    // =====================================================================================================
    // CASE 2 — a CUSTOMIZED copy (the owner hand-edited their local doctrine before this fix): mine != base.
    // MUST survive untouched — the data-loss guard this whole mechanism exists for.
    // =====================================================================================================
    const custBase = doc;
    const custMine = doc.replace("Body.", "Body — EDITED BY USER.");
    writeBaseFile(name, custBase);
    writeSkillDir(name, custMine);

    const retired2 = retireOrphanedBundledSkillDirs();
    check(`[${name}][customized] NOT in the retired list`, !retired2.includes(name));
    check(`[${name}][customized] store dir survives`, fs.existsSync(path.join(skillsDir, name)));
    check(`[${name}][customized] content byte-for-byte unchanged (user edit preserved)`,
      readSkill(name)?.content === custMine);

    // =====================================================================================================
    // FALSIFICATION — prove this test can actually catch a broken predicate, not just pass by construction.
    // Re-run the pristine CASE 1 scenario but with this name TEMPORARILY removed from the allowlist (guard
    // (a) broken) — the retirement assertion must go RED, then restoring it must go back GREEN.
    // =====================================================================================================
    fs.rmSync(path.join(skillsDir, name), { recursive: true, force: true });
    fs.rmSync(path.join(baseDir, `${name}.md`), { force: true });
    writeBaseFile(name, doc);
    writeSkillDir(name, doc);

    const originalIndex = RETIRED_BUNDLED_SKILL_NAMES.indexOf(name);
    const mutableNames = store.RETIRED_BUNDLED_SKILL_NAMES;
    // RETIRED_BUNDLED_SKILL_NAMES is `readonly string[]` at the type level only — at runtime it's a plain
    // array, so this in-process splice is how we falsify guard (a) without a second process/build.
    const removed = mutableNames.splice(originalIndex, 1);
    const brokenRetired = retireOrphanedBundledSkillDirs();
    const wentRed = !brokenRetired.includes(name) && fs.existsSync(path.join(skillsDir, name));
    console.log(`${wentRed ? "PASS" : "FAIL"}  [${name}][falsification] with ${name} removed from the allowlist, retirement correctly does NOT fire (this is the RED state a broken predicate would also produce for the real assertions above)`);
    if (!wentRed) failures++;

    mutableNames.splice(originalIndex, 0, ...removed); // restore
    const restoredRetired = retireOrphanedBundledSkillDirs();
    const wentGreen = restoredRetired.includes(name) && !fs.existsSync(path.join(skillsDir, name));
    console.log(`${wentGreen ? "PASS" : "FAIL"}  [${name}][falsification] restoring ${name} to the allowlist makes retirement fire again (GREEN) — proves the earlier PASS asserts something real, not a vacuous no-op`);
    if (!wentGreen) failures++;
  } finally {
    // Clean this name's entries so the next name's run starts from a known-empty state.
    fs.rmSync(path.join(skillsDir, name), { recursive: true, force: true });
    fs.rmSync(path.join(baseDir, `${name}.md`), { force: true });
  }
}

try {
  for (const name of ["codescape", "research"]) runUnbundleRetireCase(name);
} finally {
  cleanupPathSync(root);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — unbundling codescape/research from the published release retires only a pristine, allowlisted, asset-less orphan copy; a customized copy survives untouched, and the predicate is proven falsifiable for both."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
