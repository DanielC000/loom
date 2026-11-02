import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Hermetic guard for the permission-widening DETECTOR and the two response fields it feeds (card
// 87a51903, from investigate-first card 28b2ca6f). Claude Code's skill loader honours three constructs
// with no workspace-trust gate; Loom DISCLOSES them and never strips them, so the only thing that can
// break is the detection itself — either by missing a real vector, or (the costlier direction) by
// flagging an ordinary doctrine skill and training the user to ignore the notice.
//
// PART A — the detector (dist/skills/permissionWidening.js; pure text, no fs/LOOM_HOME):
//   • one positive control per vector, in isolation, plus all four at once and the reported ORDER;
//   • the negative traps: the two-code-span prose false positive the `(?<!`)` lookbehind exists for,
//     an indented/nested `hooks:` that is a DIFFERENT field, the field names mentioned in body prose,
//     a body `---` horizontal rule that is not a second frontmatter block, and a realistic clean skill;
//   • permissionWideningField()'s omit-when-clean contract.
// PART B — listSkills() carries the field for a store skill, and OMITS the key entirely when clean.
// PART C — the REST shape, via the REAL buildServer driven by app.inject (network-free): both
//   GET /api/skills (list) and GET /api/skills/:name (single read).
//
// Fully hermetic — LOOM_HOME and LOOM_ASSET_SKILLS are TEMP dirs set BEFORE the dist import (paths.ts
// and store.ts read both at load), same shape as skills-customization.mjs. Never touches ~/.loom or :4317.
// Run after build: node test/skill-permission-widening-detector.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const root = path.join(os.tmpdir(), `loom-skill-permwiden-${Date.now()}-${process.pid}`);
const home = path.join(root, "loomhome");
const assetDir = path.join(root, "assets", "skills");
const skillsDir = path.join(home, "skills");
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });

delete process.env.LOOM_DEV;
process.env.LOOM_HOME = home;             // BEFORE import — paths.ts computes SKILLS_DIR at load
process.env.LOOM_PORT = String(hermeticPort());
process.env.LOOM_ASSET_SKILLS = assetDir; // BEFORE import — store.ts computes ASSET_SKILLS at load
const sandboxHome = path.join(root, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;    // Windows
process.env.HOME = sandboxHome;           // POSIX

const { detectPermissionWidening, permissionWideningField } = await import("../dist/skills/permissionWidening.js");
const { listSkills, writeSkill } = await import("../dist/skills/store.js");
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

// Backticks sit inside SINGLE quotes throughout, never a template literal — the body forms under test
// are made OF backticks, and escaping them inside a template would change the very bytes being scanned.
const FM = '---\nname: x\ndescription: d\n---\n';

try {
  // ===================================================================================================
  // PART A — the detector
  // ===================================================================================================

  // --- positive controls: each vector alone --------------------------------------------------------
  check("[A] frontmatter allowed-tools: → ['allowed-tools']",
    same(detectPermissionWidening('---\nname: x\nallowed-tools: Bash(*)\n---\nbody\n'), ["allowed-tools"]));
  check("[A] frontmatter hooks: → ['hooks']",
    same(detectPermissionWidening('---\nname: x\nhooks:\n  Stop:\n    - type: command\n      command: node x.js\n---\nbody\n'), ["hooks"]));
  check("[A] inline !`cmd` in the body → ['shell-inline']",
    same(detectPermissionWidening(FM + 'Run this first: !`node sentinel.js A`\n'), ["shell-inline"]));
  check("[A] a fenced ```! block → ['shell-fenced']",
    same(detectPermissionWidening(FM + 'body\n\n```!\nnode sentinel.js B\n```\n'), ["shell-fenced"]));

  // --- the reported set + its order ----------------------------------------------------------------
  const all = detectPermissionWidening(
    '---\nname: x\nallowed-tools: Bash(*)\nhooks:\n  Stop: []\n---\nRun: !`node a.js`\n\n```!\nnode b.js\n```\n');
  check("[A] all four at once are all reported, frontmatter keys first then body forms (stable order)",
    same(all, ["allowed-tools", "hooks", "shell-inline", "shell-fenced"]));
  check("[A] CRLF line endings defeat neither frontmatter nor body detection",
    same(detectPermissionWidening('---\r\nname: x\r\nallowed-tools: Bash(*)\r\n---\r\nRun: !`node a.js`\r\n\r\n```!\r\nnode b.js\r\n```\r\n'),
      ["allowed-tools", "shell-inline", "shell-fenced"]));
  check("[A] an UPPERCASE frontmatter key still matches (keys are compared case-insensitively)",
    same(detectPermissionWidening('---\nname: x\nAllowed-Tools: Bash(*)\n---\nbody\n'), ["allowed-tools"]));

  // --- negative traps: the scanner must NOT over-match ordinary doctrine prose ---------------------
  // THE trap this detector's lookbehind exists for: two unrelated code spans with a bare "!" between
  // them contain the literal substring "!`" followed by non-backticks and then another backtick.
  check("[A][trap] prose with two code spans and a bare ! between them is NOT flagged",
    same(detectPermissionWidening(FM + 'the `!` character, like `ls`, is ordinary markdown.\n'), []));
  check("[A][trap] a nested/indented hooks: key is a DIFFERENT field and is NOT flagged",
    same(detectPermissionWidening('---\nname: x\ncapabilities:\n  hooks: not-the-same-field\n  allowed-tools: nope\n---\nbody\n'), []));
  check("[A][trap] the field NAMES mentioned in body prose are NOT flagged",
    same(detectPermissionWidening(FM + "Never set allowed-tools: or hooks: in a skill you ship.\n"), []));
  check("[A][trap] a body --- horizontal rule is not a second frontmatter block, so a key under it is NOT flagged",
    same(detectPermissionWidening(FM + 'intro\n\n---\nallowed-tools: Bash(*)\n\nmore prose\n'), []));
  check("[A][trap] an ordinary fenced block (```sh) is NOT flagged",
    same(detectPermissionWidening(FM + 'body\n\n```sh\nnode sentinel.js B\n```\n'), []));
  check("[A][trap] a bare ! with no backtick-delimited command after it is NOT flagged",
    same(detectPermissionWidening(FM + 'Use ! to negate, and run node x.js yourself.\n'), []));
  check("[A][trap] a realistic clean SKILL.md is NOT flagged",
    same(detectPermissionWidening(FM + "# Example\n\nFollow the repo's `CLAUDE.md` and run `pnpm build` before you report done.\n"
      + 'Never use `!` to mean "not" in a shell conditional without quoting it.\n'), []));
  // Polarity control for the traps above: the SAME fixture bodies, with one genuine vector appended,
  // must flag — so a clean result above means "nothing there", not "the scan cannot fire on this shape".
  check("[A][trap] polarity control: the clean realistic fixture flags once a genuine !`cmd` is added",
    same(detectPermissionWidening(FM + "# Example\n\nFollow the repo's `CLAUDE.md` and run `pnpm build` before you report done.\n"
      + 'Never use `!` to mean "not" in a shell conditional without quoting it.\n\nSetup: !`node setup.js`\n'), ["shell-inline"]));

  // --- permissionWideningField()'s omit-when-clean contract ---------------------------------------
  const cleanField = permissionWideningField(FM + 'ordinary body\n');
  check("[A] permissionWideningField omits the key entirely for a clean skill (not an empty array)",
    !("permissionWidening" in cleanField) && Object.keys(cleanField).length === 0);
  check("[A] permissionWideningField carries the vectors for a dirty skill",
    same(permissionWideningField('---\nname: x\nhooks: {}\n---\nbody\n').permissionWidening, ["hooks"]));

  // ===================================================================================================
  // PART B — listSkills()
  // ===================================================================================================
  const skillMd = (name, extraFm, body) => `---\nname: ${name}\ndescription: ${name} desc\n${extraFm}---\n\n# ${name}\n\n${body}\n`;
  writeSkill("pw-clean", skillMd("pw-clean", "", "Nothing special here. Run `pnpm build` when you are done."), "human");
  writeSkill("pw-tools", skillMd("pw-tools", "allowed-tools: Bash(*)\n", "Ordinary body."), "human");
  writeSkill("pw-hooks", skillMd("pw-hooks", "hooks:\n  Stop:\n    - type: command\n      command: node x.js\n", "Ordinary body."), "human");
  writeSkill("pw-shell", skillMd("pw-shell", "", 'Context: !`node sentinel.js A`'), "human");
  writeSkill("pw-fenced", skillMd("pw-fenced", "", 'body\n\n```!\nnode sentinel.js B\n```'), "human");

  const byName = Object.fromEntries(listSkills().map((s) => [s.name, s]));
  check("[B] fixture identity: all five fixture skills are in the store and nothing else is",
    same(Object.keys(byName).sort(), ["pw-clean", "pw-fenced", "pw-hooks", "pw-shell", "pw-tools"]));
  check("[B] clean skill: the permissionWidening KEY is absent from the row, not an empty array",
    !("permissionWidening" in byName["pw-clean"]));
  check("[B] allowed-tools skill carries ['allowed-tools']", same(byName["pw-tools"].permissionWidening, ["allowed-tools"]));
  check("[B] hooks skill carries ['hooks']", same(byName["pw-hooks"].permissionWidening, ["hooks"]));
  check("[B] inline-shell skill carries ['shell-inline']", same(byName["pw-shell"].permissionWidening, ["shell-inline"]));
  check("[B] fenced-shell skill carries ['shell-fenced']", same(byName["pw-fenced"].permissionWidening, ["shell-fenced"]));
  // The field reports THIS content, not a stamp: it must follow an edit either way.
  writeSkill("pw-clean", skillMd("pw-clean", "hooks: {}\n", "Ordinary body."), "human");
  check("[B] editing a clean skill to add a vector makes the field appear",
    same(listSkills().find((s) => s.name === "pw-clean")?.permissionWidening, ["hooks"]));
  writeSkill("pw-tools", skillMd("pw-tools", "", "Ordinary body."), "human");
  check("[B] editing the vector back out removes the key again",
    !("permissionWidening" in listSkills().find((s) => s.name === "pw-tools")));

  // ===================================================================================================
  // PART C — REST, via the real buildServer + app.inject
  // ===================================================================================================
  const db = new Db(path.join(home, "rest.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub,
    auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const list = await app.inject({ method: "GET", url: "/api/skills" });
  const rows = list.json();
  check("[C] GET /api/skills 200 and still returns the five fixtures (identity, not just shape)",
    list.statusCode === 200 && same(rows.map((r) => r.name).sort(), ["pw-clean", "pw-fenced", "pw-hooks", "pw-shell", "pw-tools"]));
  check("[C] GET /api/skills carries permissionWidening on the hooks fixture",
    same(rows.find((r) => r.name === "pw-hooks").permissionWidening, ["hooks"]));
  check("[C] GET /api/skills omits the key on the clean fixture",
    !("permissionWidening" in rows.find((r) => r.name === "pw-tools")));

  const one = await app.inject({ method: "GET", url: "/api/skills/pw-shell" });
  const oneBody = one.json();
  check("[C] GET /api/skills/:name 200, keeps name+content, and adds permissionWidening",
    one.statusCode === 200 && oneBody.name === "pw-shell" && typeof oneBody.content === "string"
      && same(oneBody.permissionWidening, ["shell-inline"]));
  const oneClean = await app.inject({ method: "GET", url: "/api/skills/pw-tools" });
  check("[C] GET /api/skills/:name omits the key for a clean skill",
    oneClean.statusCode === 200 && !("permissionWidening" in oneClean.json()));
  check("[C] GET /api/skills/:name still 404s for an unknown name",
    (await app.inject({ method: "GET", url: "/api/skills/pw-nope" })).statusCode === 404);

  await app.close();
  db.close(); // before cleanup: an open sqlite handle makes the temp-dir removal EBUSY on Windows
} finally {
  cleanupPathSync(root);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — detector (per-vector positives + the prose/nesting negative traps) + listSkills + REST list/get fields."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
