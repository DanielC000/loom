import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Proof for the boot auto-fast-forward of PRISTINE bundled skills (board card bf87b783): on boot the
// daemon must advance ONLY customized:false skills (mine == base) that have a shipped update —
// LOSSLESS, since there's nothing the user edited to preserve — so self-host doctrine changes go live
// on restart like code does. A customized:true skill must NEVER be auto-advanced (the critical safety
// assertion; this is the sensitive 1175a84 / dd940682 staleness area).
//
// The gate is the SAME merge-engine equality used everywhere: normalizeForCompare(mine) ==
// normalizeForCompare(base) is "customized:false", and normalizeForCompare(base) != shipped is
// "updateAvailable:true". No new heuristic.
//
// Fully hermetic — sets LOOM_HOME (store+base) AND LOOM_ASSET_SKILLS (bundled asset) to TEMP dirs BEFORE
// importing dist. NEVER touches ~/.loom, :4317, or the real repo asset. Run after build.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-autoff-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const assetDir = path.join(root, "assets", "skills");
const skillsDir = path.join(home, "skills");
const baseDir = path.join(home, "skill-base");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });

delete process.env.LOOM_DEV;
process.env.LOOM_HOME = home;             // BEFORE import — paths.ts computes SKILLS_DIR / SKILL_BASE_DIR at load
process.env.LOOM_PORT = "45420";
process.env.LOOM_ASSET_SKILLS = assetDir; // BEFORE import — store.ts computes ASSET_SKILLS at load
const sandboxHome = path.join(root, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const store = await import("../dist/skills/store.js");
const { listSkills, writeSkill, readSkill, autoFastForwardPristineSkills, skillUpdateAvailable } = store;

// normalizeForCompare is module-internal — mirror it so assertions mean "no SEMANTIC difference".
const norm = (s) => s.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "");

const writeAsset = (name, content) => { fs.mkdirSync(path.join(assetDir, name), { recursive: true }); fs.writeFileSync(path.join(assetDir, name, "SKILL.md"), content); };
const writeBaseFile = (name, content) => { fs.mkdirSync(baseDir, { recursive: true }); fs.writeFileSync(path.join(baseDir, `${name}.md`), content); };
const state = (name) => { const s = listSkills().find((x) => x.name === name); return { customized: s?.customized, updateAvailable: s?.updateAvailable }; };

try {
  // Shared shapes: an old base/mine and a newer shipped that adds doctrine lines.
  const oldDoc = "---\nname: x\ndescription: x desc\n---\n\n# x\n\nLine one.\nLine two.\n";
  const newShipped = "---\nname: x\ndescription: x desc\n---\n\n# x\n\nLine one.\nNEW doctrine A.\nLine two.\nNEW doctrine B.\n";

  // ===================================================================================================
  // PRISTINE (customized:false, shipped != base): MUST be auto-advanced on boot.
  // ===================================================================================================
  // mine carries the realistic CRLF / trailing-space / no-final-newline skew that normalizeForCompare
  // discounts — so "mine == base" holds semantically even though it isn't byte-identical.
  const baseLf = oldDoc.replace("name: x", "name: pristine");
  const shippedP = newShipped.replace("name: x", "name: pristine");
  const mineSkew = baseLf.replace(/\n/g, "\r\n").replace("Line two.", "Line two.  ").replace(/\r\n$/, "");
  writeAsset("pristine", shippedP);
  writeBaseFile("pristine", baseLf);   // base = the prior shipped
  writeSkill("pristine", mineSkew);    // mine = the user's never-edited store copy (cosmetic skew only)
  check("[pristine] precondition: customized:false, updateAvailable:true",
    state("pristine").customized === false && state("pristine").updateAvailable === true);

  // ===================================================================================================
  // CUSTOMIZED (customized:true, shipped != base): MUST be left UNTOUCHED — the critical safety case.
  // ===================================================================================================
  const baseC = oldDoc.replace("name: x", "name: custom");
  const shippedC = newShipped.replace("name: x", "name: custom");
  const mineEdited = baseC.replace("Line one.", "Line one — EDITED BY USER.");
  writeAsset("custom", shippedC);
  writeBaseFile("custom", baseC);
  writeSkill("custom", mineEdited);
  check("[custom] precondition: customized:true, updateAvailable:true",
    state("custom").customized === true && state("custom").updateAvailable === true);

  // ===================================================================================================
  // NO-OP (fresh install: mine == base == shipped): nothing to advance.
  // ===================================================================================================
  const sameDoc = oldDoc.replace("name: x", "name: fresh");
  writeAsset("fresh", sameDoc);
  writeBaseFile("fresh", sameDoc);
  writeSkill("fresh", sameDoc);
  check("[fresh] precondition: pristine, no update", state("fresh").customized === false && state("fresh").updateAvailable === false);

  // --- run the boot auto-fast-forward ---------------------------------------------------------------
  const advanced = autoFastForwardPristineSkills();

  // PRISTINE: advanced to shipped verbatim; state now reports updateAvailable:false, customized:false.
  check("[pristine] returned names include it", advanced.includes("pristine"));
  check("[pristine] mine == shipped after boot FF (additions landed)", norm(readSkill("pristine").content) === norm(shippedP));
  check("[pristine] every shipped-added line is in the served copy",
    ["NEW doctrine A.", "NEW doctrine B."].every((l) => readSkill("pristine").content.includes(l)));
  check("[pristine] state is now pristine — no lingering update",
    state("pristine").customized === false && state("pristine").updateAvailable === false && skillUpdateAvailable("pristine") === false);

  // CUSTOMIZED: byte-for-byte UNCHANGED and STILL updateAvailable:true — never auto-advanced.
  check("[custom] NOT in the advanced list", !advanced.includes("custom"));
  check("[custom] mine UNCHANGED byte-for-byte (user edit preserved)", readSkill("custom").content === mineEdited);
  check("[custom] still customized:true, updateAvailable:true (waits for manual adopt)",
    state("custom").customized === true && state("custom").updateAvailable === true && skillUpdateAvailable("custom") === true);

  // NO-OP: untouched, not advanced.
  check("[fresh] NOT in the advanced list", !advanced.includes("fresh"));
  check("[fresh] mine UNCHANGED", readSkill("fresh").content === sameDoc);

  // Idempotent: a second boot finds nothing left to advance.
  check("[idempotent] second run advances nothing", autoFastForwardPristineSkills().length === 0);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { /* retry: WAL handle on Windows */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot auto-fast-forwards customized:false skills to shipped; customized:true is never auto-advanced."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
