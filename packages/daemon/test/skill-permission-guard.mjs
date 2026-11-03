import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Hermetic unit test for `skills/permissionGuard.ts` (card 51a2462a, from investigate-first card
// 28b2ca6f; decision record 87a51903 is why this logic lives in its own module rather than in
// permissionWidening.ts): the refuse-at-write + strip-at-injection logic for an agent-written skill's
// permission-widening content. Pure text in/out, no fs/LOOM_HOME needed — permissionWideningRefusalError
// takes a string and returns a string/undefined; stripPermissionWidening takes a string and returns a
// string, or null when it fails closed (see PART D' below).
//
// PART A — permissionWideningRefusalError: undefined for a clean skill; a named error for each vector
//   alone and combined; BOM fail-closed (a BOM-led hazard is still caught, a BOM-led clean skill is not
//   falsely flagged).
// PART B — stripPermissionWidening: exactly what gets removed for each vector (frontmatter KEY + its
//   nested lines for allowed-tools/hooks, just the TRIGGER character for the two shell forms), with
//   every other field/line reproduced byte-for-byte; frontmatter edge shapes (hooks as the LAST key,
//   an inline flow value, a key line with trailing spaces); a clean skill returns the SAME reference
//   (no write-worthy change); CRLF preservation (no mixed endings after a strip); BOM handling.
// PART C — the closure property: detectPermissionWidening(stripPermissionWidening(x)) is always [],
//   and stripPermissionWidening is idempotent, across every PART B fixture — proving detect and strip
//   provably agree, since they import the SAME pattern set from permissionWidening.ts.
// PART D — round 2's fixpoint fix: a DOUBLED (`!!`cmd``, ` ```!! `) and a TRIPLED
//   (`!!!`cmd``, ` ```!!! `) trigger, which a single stripping pass MANUFACTURES back into the
//   canonical single-`!` form instead of removing — stripPermissionWidening must loop to a fixpoint and
//   return a result with nothing left to detect, never a partially-stripped string still carrying one.
// PART D' — round 3 MAJOR fix: the fail-closed `null` postcondition was UNTESTED (a reviewer deleted
//   `permissionGuard.ts`'s `return null` line in the compiled output and every existing test above stayed
//   green). Round 3 also ships a WHOLE-RUN strip (see the decision record's "Round 3" section), so there
//   is no longer a REAL combination of the four known vectors that can survive a single fixpoint pass —
//   a crafted stress fixture (any number of stacked `!`s) would just strip clean and prove nothing about
//   this branch. So this part uses a DELIBERATELY INJECTED (forced-always-dirty) detector instead: a
//   throwaway copy of permissionGuard.js importing a throwaway permissionWidening.js whose
//   detectPermissionWidening always reports non-empty, isolating "does the postcondition return null when
//   detection-after-strip is non-empty" from "can real content ever make that true" (the latter is, by
//   round 3's own design, no longer reachable through the four known vectors).
//
// Run after build: node test/skill-permission-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { permissionWideningRefusalError, stripPermissionWidening } from "../dist/skills/permissionGuard.js";
import { detectPermissionWidening } from "../dist/skills/permissionWidening.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const BOM = "﻿";
const CRLF = (s) => s.replace(/\n/g, "\r\n");

const CLEAN = "---\nname: x\ndescription: a clean skill\n---\n\nOrdinary body. Run `pnpm build` when done.\n";

const FIXTURES = {
  "allowed-tools": "---\nname: x\ndescription: d\nallowed-tools: Bash(*)\n---\n\nbody\n",
  "allowed-tools (inline flow value)": "---\nname: x\ndescription: d\nallowed-tools: [Bash, Read]\n---\n\nbody\n",
  "allowed-tools (trailing spaces)": "---\nname: x\ndescription: d\nallowed-tools: Bash(*)   \n---\n\nbody\n",
  hooks: "---\nname: x\ndescription: d\nhooks:\n  Stop:\n    - type: command\n      command: node x.js\n---\n\nbody\n",
  "hooks (last key before closing ---)": "---\nname: x\ndescription: d\nhooks:\n  Stop:\n    - type: command\n      command: node x.js\n---\n\nbody\n",
  "shell-inline": "---\nname: x\ndescription: d\n---\n\nRun this first: !`node sentinel.js A`\n",
  "shell-fenced": "---\nname: x\ndescription: d\n---\n\nbody\n\n```!\nnode sentinel.js B\n```\n",
  "all four combined": "---\nname: x\ndescription: d\nallowed-tools: Bash(*)\nhooks:\n  Stop: []\n---\n\nRun: !`node a.js`\n\n```!\nnode b.js\n```\n",
  // --- PART D fixtures (round 2, MAJOR finding 2): a single strip pass MANUFACTURES the canonical
  // trigger back out of a doubled/tripled one instead of removing it — these prove the fixpoint loop.
  "shell-inline (doubled !!)": "---\nname: x\ndescription: d\n---\n\nrun !!`whoami`\n",
  "shell-fenced (doubled !!)": "---\nname: x\ndescription: d\n---\n\nbody\n\n```!!\nwhoami\n```\n",
  "shell-inline (tripled !!!)": "---\nname: x\ndescription: d\n---\n\nrun !!!`whoami`\n",
  // --- round 3: a stacked run FAR past STRIP_FIXPOINT_MAX_PASSES (16) — proving the whole-run strip
  // resolves it in effectively one combined pass, rather than needing (and failing to get) 20 fixpoint
  // iterations. See PART D' below for the complementary null-postcondition proof.
  "shell-inline (20x !)": `---\nname: x\ndescription: d\n---\n\nrun ${"!".repeat(20)}\`whoami\`\n`,
  "shell-fenced (20x !)": `---\nname: x\ndescription: d\n---\n\nbody\n\n\`\`\`${"!".repeat(20)}\nwhoami\n\`\`\`\n`,
};

try {
  // =================================================================================================
  // PART A — permissionWideningRefusalError
  // =================================================================================================
  check("[A] a clean skill refuses nothing", permissionWideningRefusalError(CLEAN) === undefined);
  for (const [label, content] of Object.entries(FIXTURES)) {
    const err = permissionWideningRefusalError(content);
    check(`[A] ${label}: refused with a non-empty error`, typeof err === "string" && err.length > 0);
  }
  check("[A] allowed-tools: the error names the vector id",
    /allowed-tools/.test(permissionWideningRefusalError(FIXTURES["allowed-tools"]) ?? ""));
  check("[A] hooks: the error names the vector id",
    /hooks/.test(permissionWideningRefusalError(FIXTURES.hooks) ?? ""));
  check("[A] shell-inline: the error names the vector id",
    /shell-inline/.test(permissionWideningRefusalError(FIXTURES["shell-inline"]) ?? ""));
  check("[A] shell-fenced: the error names the vector id",
    /shell-fenced/.test(permissionWideningRefusalError(FIXTURES["shell-fenced"]) ?? ""));
  const allErr = permissionWideningRefusalError(FIXTURES["all four combined"]) ?? "";
  check("[A] all four combined: every vector id is named in one error",
    ["allowed-tools", "hooks", "shell-inline", "shell-fenced"].every((v) => allErr.includes(v)));

  // --- BOM fail-closed (card 51a2462a's own instruction: treat a BOM-led block as frontmatter) -------
  const bomHazard = BOM + "---\nname: x\ndescription: d\nallowed-tools: Bash(*)\n---\n\nbody\n";
  check("[A] a BOM-led skill carrying allowed-tools is STILL refused (fail closed)",
    typeof permissionWideningRefusalError(bomHazard) === "string");
  const bomClean = BOM + CLEAN;
  check("[A] a BOM-led CLEAN skill is NOT falsely flagged",
    permissionWideningRefusalError(bomClean) === undefined);

  // =================================================================================================
  // PART B — stripPermissionWidening
  // =================================================================================================
  check("[B] a clean skill returns the EXACT SAME reference (no write-worthy change)",
    stripPermissionWidening(CLEAN) === CLEAN);

  const strippedTools = stripPermissionWidening(FIXTURES["allowed-tools"]);
  check("[B] allowed-tools: the key line is gone",
    !/allowed-tools/.test(strippedTools));
  check("[B] allowed-tools: name/description/closing --- and the body survive byte-identical",
    strippedTools === "---\nname: x\ndescription: d\n---\n\nbody\n");

  const strippedToolsFlow = stripPermissionWidening(FIXTURES["allowed-tools (inline flow value)"]);
  check("[B] allowed-tools (inline flow value [Bash, Read]): removed cleanly",
    strippedToolsFlow === "---\nname: x\ndescription: d\n---\n\nbody\n");

  const strippedToolsTrailing = stripPermissionWidening(FIXTURES["allowed-tools (trailing spaces)"]);
  check("[B] allowed-tools (trailing spaces after the value): still removed",
    strippedToolsTrailing === "---\nname: x\ndescription: d\n---\n\nbody\n");

  const strippedHooks = stripPermissionWidening(FIXTURES.hooks);
  check("[B] hooks: the key AND every nested line are gone",
    !/hooks/.test(strippedHooks) && !/Stop/.test(strippedHooks) && !/command/.test(strippedHooks));
  check("[B] hooks: name/description/closing --- and the body survive byte-identical",
    strippedHooks === "---\nname: x\ndescription: d\n---\n\nbody\n");

  // Edge shape: hooks as the LAST key before the closing --- (the nested-line scan must stop AT the
  // fence, not run past it) — same fixture as `hooks` above but the assertion is specifically about the
  // closing fence surviving, stated as its own check per the DoD.
  const strippedHooksLast = stripPermissionWidening(FIXTURES["hooks (last key before closing ---)"]);
  check("[B] hooks as the LAST key: the closing --- fence is intact and immediately follows description:",
    strippedHooksLast.includes("description: d\n---\n"));

  const strippedInline = stripPermissionWidening(FIXTURES["shell-inline"]);
  check("[B] shell-inline: only the leading ! is dropped, the command text stays visible",
    strippedInline === "---\nname: x\ndescription: d\n---\n\nRun this first: `node sentinel.js A`\n");

  const strippedFenced = stripPermissionWidening(FIXTURES["shell-fenced"]);
  check("[B] shell-fenced: only the trailing ! is dropped from the fence, the command text stays visible",
    strippedFenced === "---\nname: x\ndescription: d\n---\n\nbody\n\n```\nnode sentinel.js B\n```\n");

  const strippedAll = stripPermissionWidening(FIXTURES["all four combined"]);
  check("[B] all four combined: nothing left to detect",
    detectPermissionWidening(strippedAll).length === 0);
  check("[B] all four combined: the command texts are still visible (not deleted wholesale)",
    strippedAll.includes("node a.js") && strippedAll.includes("node b.js"));

  // --- CRLF: a fully-CRLF fixture, both the frontmatter key-drop and the body trigger strip ----------
  const crlfFixture = CRLF(FIXTURES["all four combined"]);
  const strippedCrlf = stripPermissionWidening(crlfFixture);
  const crCount = (strippedCrlf.match(/\r/g) ?? []).length;
  const lfCount = (strippedCrlf.match(/\n/g) ?? []).length;
  check("[B][CRLF] the stripped result has NO mixed line endings (CR count === LF count)", crCount === lfCount && crCount > 0);
  check("[B][CRLF] every line ending is still CRLF (no bare, un-paired LF)", !/(?<!\r)\n/.test(strippedCrlf));
  check("[B][CRLF] nothing left to detect after stripping", detectPermissionWidening(strippedCrlf).length === 0);
  check("[B][CRLF] the command texts survive", strippedCrlf.includes("node a.js") && strippedCrlf.includes("node b.js"));
  const crlfClean = CRLF(CLEAN);
  check("[B][CRLF] a clean CRLF skill returns the SAME reference", stripPermissionWidening(crlfClean) === crlfClean);

  // --- BOM: held aside, re-prepended, fail-closed on detection ----------------------------------------
  const strippedBomHazard = stripPermissionWidening(bomHazard);
  check("[B][BOM] the BOM is preserved at the front of the stripped result", strippedBomHazard.startsWith(BOM));
  check("[B][BOM] the hazard is actually removed", !/allowed-tools/.test(strippedBomHazard));
  check("[B][BOM] nothing left to detect once the BOM is accounted for",
    detectPermissionWidening(strippedBomHazard.slice(BOM.length)).length === 0);
  check("[B][BOM] a BOM-led CLEAN skill is returned UNCHANGED, BOM included (same reference)",
    stripPermissionWidening(bomClean) === bomClean);

  // =================================================================================================
  // PART C — closure + idempotence, across every fixture (plus the two CRLF/BOM cases above), including
  // the PART D doubled/tripled-trigger fixtures (round 2) added to FIXTURES above.
  // =================================================================================================
  const ALL_CASES = [CLEAN, ...Object.values(FIXTURES), crlfFixture, crlfClean, bomHazard, bomClean];
  for (const [i, content] of ALL_CASES.entries()) {
    const once = stripPermissionWidening(content);
    check(`[C] case ${i}: strip did not fail closed to null`, once !== null);
    if (once === null) continue; // nothing further to assert against a null result
    const twice = stripPermissionWidening(once);
    check(`[C] case ${i}: idempotent — strip(strip(x)) === strip(x)`, twice === once);
    const scanTarget = once.startsWith(BOM) ? once.slice(BOM.length) : once;
    check(`[C] case ${i}: closure — detect(strip(x)) finds nothing`, detectPermissionWidening(scanTarget).length === 0);
  }

  // =================================================================================================
  // PART D — the fixpoint loop itself (round 2, MAJOR finding 2): a single pass over a doubled/tripled
  // trigger MANUFACTURES the canonical single-`!` form, which is STILL flagged — proving the loop (not
  // just the end-to-end closure check in PART C, which a lucky single pass could pass vacuously for a
  // fixture needing only 2 iterations) actually ran more than once.
  // =================================================================================================
  const strippedDoubledInline = stripPermissionWidening(FIXTURES["shell-inline (doubled !!)"]);
  check("[D] doubled inline (!!): not null", strippedDoubledInline !== null);
  check("[D] doubled inline (!!): a naive single pass would still leave `!`whoami`` detectable — the real result has nothing left",
    detectPermissionWidening(strippedDoubledInline ?? "").length === 0);
  check("[D] doubled inline (!!): the command text survives", (strippedDoubledInline ?? "").includes("whoami"));

  const strippedDoubledFenced = stripPermissionWidening(FIXTURES["shell-fenced (doubled !!)"]);
  check("[D] doubled fenced (```!!): not null", strippedDoubledFenced !== null);
  check("[D] doubled fenced (```!!): nothing left to detect",
    detectPermissionWidening(strippedDoubledFenced ?? "").length === 0);

  const strippedTripledInline = stripPermissionWidening(FIXTURES["shell-inline (tripled !!!)"]);
  check("[D] tripled inline (!!!): not null", strippedTripledInline !== null);
  check("[D] tripled inline (!!!): nothing left to detect (needs 3 passes to resolve)",
    detectPermissionWidening(strippedTripledInline ?? "").length === 0);
  check("[D] tripled inline (!!!): the command text survives", (strippedTripledInline ?? "").includes("whoami"));

  // --- round 3: a run of 20 `!`s — more than STRIP_FIXPOINT_MAX_PASSES (16) — resolves anyway, because
  // the whole-run strip removes the ENTIRE run in one application rather than one `!` per pass.
  const strippedTwentyInline = stripPermissionWidening(FIXTURES["shell-inline (20x !)"]);
  check("[D] 20x inline (!x20): NOT null — the whole run strips in one application, never needing 20 fixpoint passes",
    strippedTwentyInline !== null);
  check("[D] 20x inline (!x20): nothing left to detect", detectPermissionWidening(strippedTwentyInline ?? "").length === 0);
  check("[D] 20x inline (!x20): the command text survives", (strippedTwentyInline ?? "").includes("whoami"));

  const strippedTwentyFenced = stripPermissionWidening(FIXTURES["shell-fenced (20x !)"]);
  check("[D] 20x fenced (```!x20): NOT null — the whole run strips in one application",
    strippedTwentyFenced !== null);
  check("[D] 20x fenced (```!x20): nothing left to detect", detectPermissionWidening(strippedTwentyFenced ?? "").length === 0);

  // =================================================================================================
  // PART D' — the fail-closed `null` postcondition (round 3 MAJOR finding 1): a DELIBERATELY INJECTED
  // (forced-always-dirty) detector, since round 3's whole-run strip above means no REAL input survives
  // the fixpoint loop anymore (see the two checks just above) — so this is the only way left to exercise
  // `stripPermissionWidening`'s own `if (detectPermissionWidening(current).length > 0) return null;`
  // branch. Mutant M1 (delete that `return null` line, keep the API) was confirmed to turn this section
  // RED before this fix landed, and GREEN after — verified by hand against the real `permissionGuard.ts`
  // source, rebuilt, and restored; not re-run automatically here.
  // =================================================================================================
  const distSkillsDir = path.dirname(fileURLToPath(new URL("../dist/skills/permissionGuard.js", import.meta.url)));
  const suffix = `${Date.now()}-${process.pid}`;
  const mutantWideningPath = path.join(distSkillsDir, `permissionWidening.mutant-nullpath-${suffix}.js`);
  const mutantGuardPath = path.join(distSkillsDir, `permissionGuard.mutant-nullpath-${suffix}.js`);
  try {
    // Re-exports every REAL shared pattern (so stripFrontmatterKeys/stripShellTriggers still run their
    // genuine logic) but FORCES detectPermissionWidening to always report non-empty — the "deliberately
    // injected detector".
    fs.writeFileSync(mutantWideningPath,
      'export { FRONTMATTER_RE, FRONTMATTER_KEY_LINE_RE, INLINE_SHELL_RE, FENCED_SHELL_RE } from "./permissionWidening.js";\n' +
      'export function detectPermissionWidening(_content) { return ["allowed-tools"]; }\n');

    const realGuardSrc = fs.readFileSync(path.join(distSkillsDir, "permissionGuard.js"), "utf8");
    check("[D'] precondition: the real permissionGuard.js imports from \"./permissionWidening.js\" (so the redirect below actually targets something)",
      realGuardSrc.includes('"./permissionWidening.js"'));
    const mutantGuardSrc = realGuardSrc.replace('"./permissionWidening.js"', `"./permissionWidening.mutant-nullpath-${suffix}.js"`);
    check("[D'] precondition: the redirect actually changed the import specifier",
      mutantGuardSrc !== realGuardSrc && mutantGuardSrc.includes(`permissionWidening.mutant-nullpath-${suffix}.js`));
    fs.writeFileSync(mutantGuardPath, mutantGuardSrc);

    const { stripPermissionWidening: mutantStrip } = await import(pathToFileURL(mutantGuardPath).href);

    check("[D'] a forced-always-dirty detector makes stripPermissionWidening return null for a HAZARD fixture",
      mutantStrip(FIXTURES["allowed-tools"]) === null);
    check("[D'] a forced-always-dirty detector makes stripPermissionWidening return null EVEN for already-clean content",
      mutantStrip(CLEAN) === null);
    check("[D'] a forced-always-dirty detector makes stripPermissionWidening return null for a doubled-trigger fixture",
      mutantStrip(FIXTURES["shell-inline (doubled !!)"]) === null);
  } finally {
    try { fs.rmSync(mutantWideningPath, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(mutantGuardPath, { force: true }); } catch { /* best effort */ }
  }
} finally {
  // pure-text module under test — nothing to clean up (no fs, no LOOM_HOME, no temp dirs)
}

console.log(failures === 0
  ? "\n✅ ALL PASS — permissionWideningRefusalError refuses every vector (BOM fail-closed); stripPermissionWidening removes exactly the flagged construct(s), byte-identical otherwise, CRLF-preserving, idempotent, and closes against the shared detector."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
