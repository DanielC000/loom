import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Proof for the boot auto-retire of orphaned store skill-dirs left behind by a bundled-skill RENAME
// (board card 5ddc2289, e.g. `pickup` -> `loom-pickup`). seedGlobalSkills() is seed-IF-ABSENT — it adds
// the new `loom-*` name but never removes the old store dir, so a renamed-away skill lingers forever and
// injectSkills keeps mirroring it into every session.
//
// The critical safety assertion: retirement must be SAFE, not just effective. A store dir is retired
// ONLY when it (a) has no matching current bundled asset, (b) is pristine (mine == its own base
// snapshot, i.e. customized:false), and (c) is in the hardcoded RETIRED_BUNDLED_SKILL_NAMES allowlist.
// This test asserts BOTH cases in the same run: a genuine renamed-bundled orphan (removed) and a
// user-created asset-less skill of unrelated name (survives) — the both-cases test the task requires.
//
// Fully hermetic — sets LOOM_HOME (store+base) AND LOOM_ASSET_SKILLS (bundled asset) to TEMP dirs BEFORE
// importing dist. NEVER touches ~/.loom, :4317, or the real repo asset. Run after build.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-retire-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const assetDir = path.join(root, "assets", "skills");
const skillsDir = path.join(home, "skills");
const baseDir = path.join(home, "skill-base");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });

delete process.env.LOOM_DEV;
process.env.LOOM_HOME = home;             // BEFORE import — paths.ts computes SKILLS_DIR / SKILL_BASE_DIR at load
process.env.LOOM_PORT = "45421";
process.env.LOOM_ASSET_SKILLS = assetDir; // BEFORE import — store.ts computes ASSET_SKILLS at load
const sandboxHome = path.join(root, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const store = await import("../dist/skills/store.js");
const { retireOrphanedBundledSkillDirs, readSkill, RETIRED_BUNDLED_SKILL_NAMES } = store;

const writeSkillDir = (name, content) => { fs.mkdirSync(path.join(skillsDir, name), { recursive: true }); fs.writeFileSync(path.join(skillsDir, name, "SKILL.md"), content); };
const writeBaseFile = (name, content) => { fs.mkdirSync(baseDir, { recursive: true }); fs.writeFileSync(path.join(baseDir, `${name}.md`), content); };
const writeAsset = (name, content) => { fs.mkdirSync(path.join(assetDir, name), { recursive: true }); fs.writeFileSync(path.join(assetDir, name, "SKILL.md"), content); };

try {
  const retiredName = RETIRED_BUNDLED_SKILL_NAMES[0]; // "pickup" — a genuine renamed-bundled orphan
  const doc = "---\nname: x\ndescription: x desc\n---\n\n# x\n\nBody.\n";

  // ===================================================================================================
  // CASE 1 — renamed-bundled orphan: pristine (mine == base), no current asset, allowlisted name.
  // MUST be removed.
  // ===================================================================================================
  const orphanDoc = doc.replace("name: x", `name: ${retiredName}`);
  writeBaseFile(retiredName, orphanDoc);   // base snapshot survives from before the rename
  writeSkillDir(retiredName, orphanDoc);   // mine == base — never edited by the user
  // No asset dir for retiredName — it's been renamed away in the current bundle.
  check("[orphan] precondition: store dir exists before retire", fs.existsSync(path.join(skillsDir, retiredName)));

  // ===================================================================================================
  // CASE 2 — a CUSTOMIZED renamed-bundled orphan (same retired name, different scenario would collide,
  // so use the 2nd allowlisted name): pristine check must fail because mine != base. MUST survive.
  // ===================================================================================================
  const customizedRetiredName = RETIRED_BUNDLED_SKILL_NAMES[1]; // "doc-hygiene"
  const custBase = doc.replace("name: x", `name: ${customizedRetiredName}`);
  const custMine = custBase.replace("Body.", "Body — EDITED BY USER.");
  writeBaseFile(customizedRetiredName, custBase);
  writeSkillDir(customizedRetiredName, custMine);

  // ===================================================================================================
  // CASE 3 — user-created, asset-less skill sharing NO allowlisted name (has no base snapshot at all,
  // exactly like a real UI-created skill). MUST survive — this is the data-loss guard.
  // ===================================================================================================
  const userSkill = "my-custom-notes";
  const userDoc = doc.replace("name: x", `name: ${userSkill}`);
  writeSkillDir(userSkill, userDoc);
  // Deliberately no base file and no asset dir for userSkill.

  // ===================================================================================================
  // CASE 4 — a bundled skill that's STILL bundled (asset present) but happens to be pristine. Even if a
  // future asset ever reused a retired name, a live asset must never be retired. Use the 3rd allowlisted
  // name with a live asset to prove (b) — asset presence — wins over the allowlist.
  // ===================================================================================================
  const reshippedName = RETIRED_BUNDLED_SKILL_NAMES[2]; // "session-end"
  const reshippedDoc = doc.replace("name: x", `name: ${reshippedName}`);
  writeAsset(reshippedName, reshippedDoc);
  writeBaseFile(reshippedName, reshippedDoc);
  writeSkillDir(reshippedName, reshippedDoc);

  // --- run the boot auto-retire ------------------------------------------------------------------------
  const retired = retireOrphanedBundledSkillDirs();

  // CASE 1: removed.
  check("[orphan] returned in the retired list", retired.includes(retiredName));
  check("[orphan] store dir gone", !fs.existsSync(path.join(skillsDir, retiredName)));
  check("[orphan] base snapshot also cleaned up", !fs.existsSync(path.join(baseDir, `${retiredName}.md`)));
  check("[orphan] readSkill returns null", readSkill(retiredName) === null);

  // CASE 2: customized orphan survives untouched.
  check("[customized-orphan] NOT in the retired list", !retired.includes(customizedRetiredName));
  check("[customized-orphan] store dir survives", fs.existsSync(path.join(skillsDir, customizedRetiredName)));
  check("[customized-orphan] content byte-for-byte unchanged (user edit preserved)",
    readSkill(customizedRetiredName)?.content === custMine);

  // CASE 3: user-created asset-less skill survives (the data-loss guard).
  check("[user-created] NOT in the retired list", !retired.includes(userSkill));
  check("[user-created] store dir survives", fs.existsSync(path.join(skillsDir, userSkill)));
  check("[user-created] content unchanged", readSkill(userSkill)?.content === userDoc);

  // CASE 4: still-bundled skill with a live asset survives even though its name is allowlisted.
  check("[still-bundled] NOT in the retired list", !retired.includes(reshippedName));
  check("[still-bundled] store dir survives", fs.existsSync(path.join(skillsDir, reshippedName)));

  // Idempotent: a second run finds nothing left to retire.
  check("[idempotent] second run retires nothing", retireOrphanedBundledSkillDirs().length === 0);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry: WAL handle on Windows */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot retires only pristine, allowlisted, asset-less renamed-bundled orphans; user edits and user-created skills survive."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
