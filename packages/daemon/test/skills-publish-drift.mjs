// Hermetic guard for the Skills drift indicator + Publish-to-repo sync (store ↔ bundled asset).
// Covers: (1) drift compare is line-ending/whitespace tolerant — a CRLF store vs LF asset that are
// otherwise identical reads diverged:false; a real edit reads diverged:true. (2) publishSkillToBundled
// writes store→asset, restricted to names that already exist as a bundled asset. (3) regression guard:
// right after reset OR publish, diverged is false.
// Fully hermetic — sets LOOM_HOME (store) AND LOOM_ASSET_SKILLS (bundled asset) to TEMP dirs BEFORE
// importing (store.ts reads both at load). NEVER touches ~/.loom, :4317, or the real repo asset.
// Run after build: node test/skills-publish-drift.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = path.join(os.tmpdir(), `loom-skills-publish-${Date.now()}`);
const home = path.join(root, "loomhome");
const skillsDir = path.join(home, "skills");
const assetDir = path.join(root, "assets", "skills");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });

process.env.LOOM_HOME = home;               // BEFORE importing — paths.ts computes SKILLS_DIR at load
process.env.LOOM_ASSET_SKILLS = assetDir;   // BEFORE importing — store.ts computes ASSET_SKILLS at load
const { listSkills, publishSkillToBundled, resetSkillToBundled, writeSkill } = await import("../dist/skills/store.js");

const diverged = (name) => listSkills().find((s) => s.name === name)?.diverged;
const writeFile = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
const assetMd = (name) => path.join(assetDir, name, "SKILL.md");
const storeMd = (name) => path.join(skillsDir, name, "SKILL.md");

try {
  // A bundled skill whose store copy differs ONLY by line-endings + a trailing newline → NOT diverged.
  const BODY_LF = "---\nname: loom-x\ndescription: X\n---\n\n# loom-x\n\nDo the thing.\n";
  writeFile(assetMd("loom-x"), BODY_LF);                              // asset: LF
  writeFile(storeMd("loom-x"), BODY_LF.replace(/\n/g, "\r\n") + "\r\n"); // store: CRLF + extra trailing newline
  check("bundled skill is reported bundled", listSkills().find((s) => s.name === "loom-x")?.bundled === true);
  check("line-ending/whitespace-only difference reads diverged:false", diverged("loom-x") === false);

  // A real content edit → diverged:true.
  writeSkill("loom-x", "---\nname: loom-x\ndescription: X\n---\n\n# loom-x\n\nEDITED in the UI.\n");
  check("a genuine store edit reads diverged:true", diverged("loom-x") === true);

  // Publish store→asset: returns true, asset now equals the store byte-for-byte, drift clears.
  check("publishSkillToBundled returns true for a bundled skill", publishSkillToBundled("loom-x") === true);
  check("asset SKILL.md was overwritten with the store content (read back)",
    fs.readFileSync(assetMd("loom-x"), "utf8") === fs.readFileSync(storeMd("loom-x"), "utf8"));
  check("after publish, diverged:false (regression guard)", diverged("loom-x") === false);

  // Reset (asset→store) then drift must also be false (the original regression: a clean skill must
  // never read permanently out of sync).
  writeSkill("loom-x", "---\nname: loom-x\ndescription: X\n---\n\nLOCAL EDIT to be reverted.\n");
  check("edit before reset reads diverged:true", diverged("loom-x") === true);
  check("resetSkillToBundled returns true", resetSkillToBundled("loom-x") === true);
  check("after reset, diverged:false (regression guard)", diverged("loom-x") === false);

  // Restriction: a store-only skill (no bundled asset) can't be published — and no asset dir is minted.
  writeSkill("local-y", "---\nname: local-y\ndescription: Y\n---\n\nUser-created.\n");
  check("publish on a non-bundled skill returns false", publishSkillToBundled("local-y") === false);
  check("no asset dir minted for a non-bundled skill", fs.existsSync(path.join(assetDir, "local-y")) === false);
  check("non-bundled skill carries no diverged flag", diverged("local-y") === undefined);

  // Invalid name is rejected.
  check("publish with an invalid name returns false", publishSkillToBundled("../escape") === false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ ALL PASS — drift compare is line-ending tolerant; publish writes store→asset (bundled-only); reset/publish clear drift." : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
