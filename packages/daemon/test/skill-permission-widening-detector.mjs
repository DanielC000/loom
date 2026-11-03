import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Hermetic guard for the permission-widening DETECTOR and the two response fields it feeds (card
// 87a51903, from investigate-first card 28b2ca6f). Claude Code's skill loader honours three constructs
// with no workspace-trust gate; Loom DISCLOSES them and never strips them, so the only thing that can
// break is the detection itself — either by missing a real vector, or (the costlier direction) by
// flagging an ordinary doctrine skill and training the user to ignore the notice.
//
// PART A — the detector (dist/skills/permissionWidening.js; pure text, no fs/LOOM_HOME):
//   • one positive control per vector, in isolation, plus all four at once and the reported ORDER;
//   • card 712148f1 round 2's ALLOWLIST (frontmatterUnrecognizedSyntax, folded into the
//     `frontmatter-unrecognized` vector): every exotic YAML form the round-1 denylist could not
//     converge on (multi-line flow mapping, an escaped-character quoted key, an explicit/tagged/merge
//     key, an anchor/alias/tag value) now fails closed via ONE generic rule, plus the three allowlisted
//     shapes (a column-0 block sequence, an indented continuation, a column-0 comment) that must NOT
//     be flagged, plus frontmatterReadIncomplete's own truncated-open-fence coverage (MINOR 3);
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

const { detectPermissionWidening, permissionWideningField, frontmatterReadIncomplete } =
  await import("../dist/skills/permissionWidening.js");
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

  // --- card 712148f1: fail-closed widenings for forms the installed CLI binary was confirmed (or could
  // not be ruled out) to accept — see docs/decisions/712148f1-*.md for the evidence per form -----------
  check("[712148f1] opening fence with trailing whitespace (confirmed accepted by the real loader)",
    same(detectPermissionWidening('---  \nname: x\nallowed-tools: Bash(*)\n---\nbody\n'), ["allowed-tools"]));
  check("[712148f1] opening fence with a trailing tab",
    same(detectPermissionWidening('---\t\nname: x\nhooks: {}\n---\nbody\n'), ["hooks"]));
  // --- card 712148f1 ROUND 2: the allowlist now adds the generic `frontmatter-unrecognized` vector
  // alongside any specific key it still happens to label — a quoted key / flow mapping is no longer
  // treated as a cleanly-identified single vector; it is BOTH labeled (where the existing quote-tolerant
  // key regex can still name it) AND reported as unrecognized syntax (fail closed either way). ---------
  check("[712148f1][r2] a double-quoted frontmatter key is labeled AND flagged unrecognized",
    same(detectPermissionWidening('---\nname: x\n"allowed-tools": Bash(*)\n---\nbody\n'), ["allowed-tools", "frontmatter-unrecognized"]));
  check("[712148f1][r2] a single-quoted frontmatter key is labeled AND flagged unrecognized",
    same(detectPermissionWidening("---\nname: x\n'hooks': {}\n---\nbody\n"), ["hooks", "frontmatter-unrecognized"]));
  check("[712148f1] whitespace before the colon (still an allowlisted plain top-level line)",
    same(detectPermissionWidening('---\nname: x\nallowed-tools : Bash(*)\n---\nbody\n'), ["allowed-tools"]));
  check("[712148f1][r2] flow-mapping frontmatter: the hazard key is the FIRST key, right after { — labeled AND unrecognized",
    same(detectPermissionWidening('---\n{allowed-tools: Bash(*), name: x}\n---\nbody\n'), ["allowed-tools", "frontmatter-unrecognized"]));
  check("[712148f1][r2] flow-mapping frontmatter: the hazard key is a LATER key, after a comma — labeled AND unrecognized",
    same(detectPermissionWidening('---\n{name: x, hooks: {}}\n---\nbody\n'), ["hooks", "frontmatter-unrecognized"]));
  check("[712148f1][r2] flow-mapping frontmatter with a quoted key — labeled AND unrecognized",
    same(detectPermissionWidening("---\n{name: x, 'allowed-tools': Bash}\n---\nbody\n"), ["allowed-tools", "frontmatter-unrecognized"]));
  check("[712148f1][trap] a comma in an ORDINARY (non-flow-mapping) line's plain value is NOT flagged — "
      + "no `{` anywhere in the block means nothing here LOOKS like a flow mapping",
    same(detectPermissionWidening('---\nname: x, hooks: not a key\ndescription: d\n---\nbody\n'), []));
  check("[712148f1] fenced trigger indented 4+ spaces (CommonMark would read this as a literal/indented "
      + "code block, but the real loader's regex has no indentation check at all)",
    same(detectPermissionWidening(FM + 'body\n\n    ```!\n    cmd\n    ```\n'), ["shell-fenced"]));
  check("[712148f1] fenced trigger inside a blockquote",
    same(detectPermissionWidening(FM + 'body\n\n> ```!\n> cmd\n> ```\n'), ["shell-fenced"]));
  check("[712148f1] fenced trigger occurring mid-line (not a real fence boundary at all)",
    same(detectPermissionWidening(FM + 'see this: ```! mentioned inline\n'), ["shell-fenced"]));
  check("[712148f1] the triage-note case `` `!`x` `` is RESOLVED as NOT a bypass — the real loader's own "
      + "inline-trigger regex requires the `!` be preceded by whitespace/start, a strict SUBSET of this "
      + "detector's own (?<!`) exclusion, so a backtick-preceded `!` is inert on BOTH sides",
    same(detectPermissionWidening(FM + 'see `!`x`` here\n'), []));
  check("[712148f1][trap] a flow-mapping's own QUOTED STRING VALUE containing a `, hooks:`-shaped "
      + "substring is a KNOWN, ACCEPTED over-match once a real `{` is present elsewhere in the block — "
      + "documented here so it is never mistaken for a regression (and the { itself is independently "
      + "unrecognized syntax, round 2)",
    same(detectPermissionWidening('---\n{name: x, note: "a, hooks: looking substring"}\n---\nbody\n'), ["hooks", "frontmatter-unrecognized"]));
  check("[712148f1] `...` as a closing fence is confirmed NOT accepted by the real loader, so it is "
      + "correctly NOT treated as frontmatter here either (the whole file reads as ordinary body)",
    same(detectPermissionWidening('---\nname: x\nallowed-tools: Bash(*)\n...\nbody\n'), []));
  check("[712148f1] a tilde fence (~~~!) is confirmed NOT recognized by the real loader, so it correctly "
      + "stays unflagged here too",
    same(detectPermissionWidening(FM + 'body\n\n~~~!\ncmd\n~~~\n'), []));

  // --- card 712148f1 ROUND 2: the ALLOWLIST — every MAJOR-1/2 form the review named, each flagged via
  // the ONE generic `frontmatter-unrecognized` vector rather than a denylist branch per shape ----------
  check("[712148f1][r2] MULTI-LINE flow mapping (the brace sits on its OWN line) is now caught",
    same(detectPermissionWidening('---\n{\n  name: x,\n  allowed-tools: Bash\n}\n---\nbody\n'), ["frontmatter-unrecognized"]));
  check("[712148f1][r2] MULTI-LINE flow mapping naming hooks: is now caught",
    same(detectPermissionWidening('---\n{name: x,\n  hooks: {}}\n---\nbody\n'), ["frontmatter-unrecognized"]));
  check("[712148f1][r2] an ESCAPED-character double-quoted key (the literal bytes never spell "
      + "allowed-tools, only a YAML string-escape would) is caught as unrecognized syntax",
    same(detectPermissionWidening('---\nname: x\n"allowed\\x2dtools": Bash(*)\n---\nbody\n'), ["frontmatter-unrecognized"]));
  check("[712148f1][r2] an explicit YAML key (`? k` / `: v` on separate lines) is caught",
    same(detectPermissionWidening('---\nname: x\n? allowed-tools\n: Bash(*)\n---\nbody\n'), ["frontmatter-unrecognized"]));
  check("[712148f1][r2] a TAGGED key (`!!str allowed-tools: Bash`) is caught",
    same(detectPermissionWidening('---\nname: x\n!!str allowed-tools: Bash(*)\n---\nbody\n'), ["frontmatter-unrecognized"]));
  check("[712148f1][r2] a MERGE key (`<<: *a`) is caught",
    same(detectPermissionWidening('---\nname: x\n<<: *a\n---\nbody\n'), ["frontmatter-unrecognized"]));
  check("[712148f1][r2] a plain top-level value starting with an ANCHOR (&) is caught",
    same(detectPermissionWidening('---\nname: x\nbase: &anchor\n---\nbody\n'), ["frontmatter-unrecognized"]));
  check("[712148f1][r2] a plain top-level value starting with an ALIAS (*) is caught",
    same(detectPermissionWidening('---\nname: x\nref: *anchor\n---\nbody\n'), ["frontmatter-unrecognized"]));
  check("[712148f1][r2] a plain top-level value starting with a TAG (!) is caught",
    same(detectPermissionWidening('---\nname: x\nkind: !!str plain\n---\nbody\n'), ["frontmatter-unrecognized"]));

  // --- card 712148f1 ROUND 2: the allowlist's own POSITIVE forms must NOT be flagged ------------------
  check("[712148f1][r2][allow] a column-0 block sequence directly under an empty-valued key is ALLOWED",
    same(detectPermissionWidening('---\nname: x\ntags:\n- a\n- b\ndescription: d\n---\nbody\n'), []));
  check("[712148f1][r2][allow] a column-0 comment line between frontmatter keys is ALLOWED",
    same(detectPermissionWidening('---\nname: x\n# just a comment\ndescription: d\n---\nbody\n'), []));
  check("[712148f1][r2][allow] a blank line inside the frontmatter block is ALLOWED",
    same(detectPermissionWidening('---\nname: x\n\ndescription: d\n---\nbody\n'), []));
  check("[712148f1][r2][allow][trap] a column-0 `-` sequence item with NO preceding empty-valued key is "
      + "NOT allowlisted (it isn't continuing anything) — proves (iii) isn't a blanket dash exemption",
    same(detectPermissionWidening('---\n- a\nname: x\n---\nbody\n'), ["frontmatter-unrecognized"]));

  // --- card 712148f1 ROUND 3, MAJOR 1: the four CR round-2 repros — an indented ROOT (no top-level key
  // seen yet) used to be treated as a blanket-neutral continuation; it is now "anything else", same as a
  // quoted/flow/explicit/tagged/merge-key line. ------------------------------------------------------
  check("[712148f1][r3][MAJOR1] an indented allowed-tools: line with no preceding top-level key is caught",
    same(detectPermissionWidening('---\n  allowed-tools: Bash\n---'), ["frontmatter-unrecognized"]));
  check("[712148f1][r3][MAJOR1] an indented escaped-character quoted key with no preceding top-level key is caught",
    same(detectPermissionWidening('---\n  "allowed\\x2dtools": Bash\n---'), ["frontmatter-unrecognized"]));
  check("[712148f1][r3][MAJOR1] a comment then an indented quoted key with no preceding top-level key is caught",
    same(detectPermissionWidening('---\n# c\n  "hook\\x73": {}\n---'), ["frontmatter-unrecognized"]));
  check("[712148f1][r3][MAJOR1] an indented explicit-key pair with no preceding top-level key is caught",
    same(detectPermissionWidening('---\n ? allowed-tools\n : Bash\n---'), ["frontmatter-unrecognized"]));
  check("[712148f1][r3][MAJOR1][CRLF] the same indented-root repro under CRLF line endings is still caught",
    same(detectPermissionWidening('---\r\n  allowed-tools: Bash\r\n---'), ["frontmatter-unrecognized"]));
  check("[712148f1][r3][MAJOR1] a REGRESSION control: the SAME key, NOT indented (a genuine top-level "
      + "key), stays the ordinary recognized/labeled-only form — this round's fix is about indentation "
      + "with NO preceding top-level key, not about a bare top-level key becoming unrecognized",
    same(detectPermissionWidening('---\nallowed-tools: Bash\n---'), ["allowed-tools"]));
  check("[712148f1][r3][MAJOR1] the accepted residual is UNCHANGED: a nested key AFTER a real top-level key "
      + "is still a neutral continuation (this round's fix is about the ROOT having no key yet, not about "
      + "nested keys under one that already exists)",
    same(detectPermissionWidening('---\nname: x\ncapabilities:\n  hooks: not-the-same-field\n---\nbody\n'), []));

  // --- frontmatterReadIncomplete: MINOR 3 — a truncated read whose OPEN fence itself carries the
  // confirmed-accepted trailing-whitespace widening must still be recognized as "opened" -------------
  check("[712148f1][r2][MINOR3] a read truncated mid-frontmatter, opening fence with trailing whitespace",
    frontmatterReadIncomplete('---  \nname: x\nallowed-tools: Bash(*\n') === true);
  check("[712148f1][r2][MINOR3] same truncated read, opening fence with a trailing tab",
    frontmatterReadIncomplete('---\t\nname: x\nhooks: {}\n') === true);
  check("frontmatterReadIncomplete: no frontmatter at all is NOT incomplete (nothing to miss)",
    frontmatterReadIncomplete('# just a markdown file\n\nbody\n') === false);
  check("frontmatterReadIncomplete: a block that closes well within content is NOT incomplete",
    frontmatterReadIncomplete('---\nname: x\n---\nbody\n') === false);
  check("frontmatterReadIncomplete: a block that never closes anywhere in content IS incomplete",
    frontmatterReadIncomplete('---\nname: x\nallowed-tools: Bash(*)\n') === true);

  // --- card 9d01b4c1 round 2: frontmatterReadIncomplete's OWN internal BOM split, exercised DIRECTLY
  // with NO caller pre-split — `scanCwdSkillsForPermissionFrontmatter` (the only real caller) already
  // splits the BOM itself before calling this, so a fixture routed through the scan can never tell this
  // function's own internal split apart from the caller's; this must be proven at the unit level instead.
  check("[9d01b4c1 r2] frontmatterReadIncomplete splits a leading BOM internally — a BOM-prefixed, "
      + "truncated-open frontmatter (raw, un-split) is still reported incomplete",
    frontmatterReadIncomplete("﻿---  \nname: x\nallowed-tools: Bash(*\n") === true);
  check("[9d01b4c1 r2] ...negative control, same BOM prefix: a frontmatter block that DOES close is NOT incomplete",
    frontmatterReadIncomplete("﻿---\nname: x\n---\nbody\n") === false);

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

  // --- card 9d01b4c1 round 2: listSkills()'s own `permissionWideningField(content)` call reads the RAW
  // file content — a leading UTF-8 BOM (U+FEFF) ahead of the real `---` fence used to hide the frontmatter
  // from `detectPermissionWidening` entirely, so a BOM-prefixed hooks/unrecognized-syntax skill showed NO
  // badge even though the refuse/strip path (permissionGuard.ts) already caught identical content. The fix
  // pushed the BOM split INTO detectPermissionWidening itself, so this call site needed no change. --------
  const BOM = "﻿";
  writeSkill("pw-bom-hooks", BOM + skillMd("pw-bom-hooks", "hooks:\n  Stop:\n    - type: command\n      command: node x.js\n", "Ordinary body."), "human");
  writeSkill("pw-bom-unrecognized", BOM + skillMd("pw-bom-unrecognized", "? weird-key\n: value\n", "Ordinary body."), "human");
  const byNameBom = Object.fromEntries(listSkills().map((s) => [s.name, s]));
  check("[B][9d01b4c1 r2] a BOM-prefixed hooks skill carries ['hooks'] via listSkills — before the fix this key was silently absent",
    same(byNameBom["pw-bom-hooks"]?.permissionWidening, ["hooks"]));
  check("[B][9d01b4c1 r2] a BOM-prefixed unrecognized-syntax skill carries ['frontmatter-unrecognized'] via listSkills",
    same(byNameBom["pw-bom-unrecognized"]?.permissionWidening, ["frontmatter-unrecognized"]));

  // ===================================================================================================
  // PART C — REST, via the real buildServer + app.inject
  // ===================================================================================================
  const db = new Db(path.join(home, "rest.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub,
    auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

  const list = await app.inject({ method: "GET", url: "/api/skills" });
  const rows = list.json();
  check("[C] GET /api/skills 200 and still returns the seven fixtures (identity, not just shape) — the "
      + "original five plus the two BOM fixtures PART B added above",
    list.statusCode === 200 && same(rows.map((r) => r.name).sort(),
      ["pw-bom-hooks", "pw-bom-unrecognized", "pw-clean", "pw-fenced", "pw-hooks", "pw-shell", "pw-tools"]));
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

  // --- card 9d01b4c1 round 2: the same BOM-prefixed fixture, over the REST field (GET /api/skills/:name
  // reads `s.content` raw — the THIRD raw-content path this round closes, alongside listSkills above). ---
  const listBom = await app.inject({ method: "GET", url: "/api/skills" });
  check("[C][9d01b4c1 r2] GET /api/skills carries permissionWidening for the BOM-prefixed hooks fixture",
    same(listBom.json().find((r) => r.name === "pw-bom-hooks")?.permissionWidening, ["hooks"]));
  const oneBom = await app.inject({ method: "GET", url: "/api/skills/pw-bom-hooks" });
  check("[C][9d01b4c1 r2] GET /api/skills/:name carries permissionWidening for the BOM-prefixed hooks fixture",
    oneBom.statusCode === 200 && same(oneBom.json().permissionWidening, ["hooks"]));

  await app.close();
  db.close(); // before cleanup: an open sqlite handle makes the temp-dir removal EBUSY on Windows
} finally {
  cleanupPathSync(root);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — detector (per-vector positives + the prose/nesting negative traps) + listSkills + REST list/get fields."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
