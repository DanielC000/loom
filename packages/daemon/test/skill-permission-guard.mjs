import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Hermetic unit test for `skills/permissionGuard.ts` (card 51a2462a, from investigate-first card
// 28b2ca6f; decision record 87a51903 is why this logic lives in its own module rather than in
// permissionWidening.ts): the refuse-at-write + strip-at-injection logic for an agent-written skill's
// permission-widening content. No LOOM_HOME needed — permissionWideningRefusalError takes a string and
// returns a string/undefined; stripPermissionWidening takes a string and returns a string, or null when
// it fails closed (see PART D' below). PART D' alone touches `fs`, to write/clean up a throwaway mutant
// module pair under dist/skills/ — every other part stays pure text in/out.
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
// PART D' — the fail-closed `null` postcondition: a DELIBERATELY INJECTED (forced-always-dirty) detector
//   — a throwaway copy of permissionGuard.js importing a throwaway permissionWidening.js whose
//   detectPermissionWidening always reports non-empty — isolates "does the postcondition return null when
//   detection-after-strip is non-empty" from "can real content ever make that true" (the latter is
//   unreachable through the four known vectors once the whole-run strip in PART D ships).
// @decision 51a2462a
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
  // --- card 712148f1: fail-closed widenings that still strip cleanly (their key is still a single,
  // recognizable top-level line, or their trigger is still the same literal `` ```! `` substring the
  // now-unanchored FENCED_SHELL_RE/FENCED_SHELL_RUN_RE strip regardless of position). card 712148f1
  // ROUND 2: the quoted-key forms moved OUT of this dict — the allowlist now withholds them wholesale
  // rather than stripping, so they belong in the WITHHELD_FIXTURES dict instead; see "PART E" below.
  "allowed-tools (space before colon)": "---\nname: x\ndescription: d\nallowed-tools : Bash(*)\n---\n\nbody\n",
  "allowed-tools (opening fence trailing whitespace)": "---  \nname: x\ndescription: d\nallowed-tools: Bash(*)\n---\n\nbody\n",
  "shell-fenced (indented 4+ spaces)": "---\nname: x\ndescription: d\n---\n\nbody\n\n    ```!\n    cmd\n    ```\n",
  "shell-fenced (blockquoted)": "---\nname: x\ndescription: d\n---\n\nbody\n\n> ```!\n> cmd\n> ```\n",
  "shell-fenced (mid-line, not a real fence boundary)": "---\nname: x\ndescription: d\n---\n\nsee this: ```! mentioned inline\n",
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

  // Card 22813c50 round 2, mutant (a): `permissionWideningRefusalError` must pass `content` straight
  // through, UNSPLIT, to `detectPermissionWidening` — never a caller-side pre-split on top of that
  // function's own internal one-BOM split. A DOUBLE-BOM hazard is inert to the real CLI loader (it only
  // ever strips ONE leading BOM, same as this module's own `splitLeadingBom`) — a caller-side pre-split
  // here would strip a SECOND BOM and wrongly turn that inert file into a live detection.
  const doubleBomHazard = BOM + BOM + "---\nname: x\ndescription: d\nallowed-tools: Bash(*)\n---\n\nbody\n";
  check("[A][22813c50 r2] a DOUBLE-BOM-led hazard is NOT refused — matches the real loader's own "
      + "single-BOM-strip treatment (an extra leftover BOM keeps the block unparsed)",
    permissionWideningRefusalError(doubleBomHazard) === undefined);

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

  // --- card 712148f1: the three re-positioned fenced-trigger fixtures strip correctly even though
  // FENCED_SHELL_RE/FENCED_SHELL_RUN_RE no longer anchor to a line start — byte-exact, same shape as the
  // plain shell-fenced check just above, proving the strip side was re-checked, not just the detector.
  const strippedFencedIndented = stripPermissionWidening(FIXTURES["shell-fenced (indented 4+ spaces)"]);
  check("[B][712148f1] shell-fenced (indented): only the trailing ! is dropped, indentation preserved",
    strippedFencedIndented === "---\nname: x\ndescription: d\n---\n\nbody\n\n    ```\n    cmd\n    ```\n");
  const strippedFencedQuoted = stripPermissionWidening(FIXTURES["shell-fenced (blockquoted)"]);
  check("[B][712148f1] shell-fenced (blockquoted): only the trailing ! is dropped, the > prefix preserved",
    strippedFencedQuoted === "---\nname: x\ndescription: d\n---\n\nbody\n\n> ```\n> cmd\n> ```\n");
  const strippedFencedMidline = stripPermissionWidening(FIXTURES["shell-fenced (mid-line, not a real fence boundary)"]);
  check("[B][712148f1] shell-fenced (mid-line): only the trailing ! is dropped, the surrounding sentence survives",
    strippedFencedMidline === "---\nname: x\ndescription: d\n---\n\nsee this: ``` mentioned inline\n");

  // --- card 712148f1: the space-before-colon/trailing-opening-fence-whitespace fixtures still strip down
  // to the SAME clean result as the plain `allowed-tools`/`hooks` fixtures above — the widened
  // FRONTMATTER_KEY_LINE_RE still identifies a single, whole top-level key LINE for both of them, and
  // neither trips the round-2 allowlist (a space before the colon, and fence-level whitespace, are both
  // allowlisted forms). The quoted-key forms moved to PART E below.
  check("[B][712148f1] allowed-tools (space before colon): strips to the same clean result as the plain form",
    stripPermissionWidening(FIXTURES["allowed-tools (space before colon)"]) === "---\nname: x\ndescription: d\n---\n\nbody\n");
  check("[B][712148f1] allowed-tools (opening fence trailing whitespace): the fence's own trailing spaces are "
      + "consumed, not reproduced, since the rebuilt opening fence is always a bare `---`",
    stripPermissionWidening(FIXTURES["allowed-tools (opening fence trailing whitespace)"]) === "---\nname: x\ndescription: d\n---\n\nbody\n");

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

  // Card 22813c50 round 2, nit: a genuinely EMPTY frontmatter block (open/close fences on consecutive
  // lines, no blank line between — FRONTMATTER_RE's body capture group never even enters) has nothing
  // to strip either way. stripFrontmatterKeys must leave it byte-for-byte UNCHANGED while still
  // stripping a hazard elsewhere in the file, rather than reconstructing the block as a single blank
  // line — which would INSERT a line the original file never had.
  const emptyFmHazard = "---\n---\n\nRun this: !`cmd`\n";
  const strippedEmptyFmHazard = stripPermissionWidening(emptyFmHazard);
  check("[B][22813c50 r2][nit] a hazard elsewhere is stripped while a genuinely EMPTY frontmatter block is left byte-for-byte UNCHANGED — no blank line inserted",
    strippedEmptyFmHazard === "---\n---\n\nRun this: `cmd`\n");

  // Card 22813c50 round 2, mutant (a): `stripPermissionWidening` must pass `content` straight through,
  // UNSPLIT, to its own `detectPermissionWidening(content)` clean-check — a caller-side pre-split there
  // would make the SAME double-BOM-is-inert hazard above read as dirty, and strip it instead of
  // returning it unchanged.
  check("[B][22813c50 r2] a DOUBLE-BOM-led hazard is returned UNCHANGED (same reference) — treated as "
      + "clean, matching the real loader's own single-BOM-strip treatment",
    stripPermissionWidening(doubleBomHazard) === doubleBomHazard);

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
    // Re-exports every REAL shared export (so stripFrontmatterKeys/stripShellTriggers still run their
    // genuine logic) but FORCES detectPermissionWidening to always report non-empty — the "deliberately
    // injected detector". `export *` plus a same-named local override (Node ESM: the local declaration
    // wins over the star-export, no conflict) rather than a hand-maintained named re-export list, which
    // would silently go stale the moment permissionWidening.ts gains an export this mutant needs but the
    // list here was never updated for.
    fs.writeFileSync(mutantWideningPath,
      'export * from "./permissionWidening.js";\n' +
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

  // ===================================================================================================
  // PART E — card 712148f1: flow-mapping frontmatter is the ONE widened form the strip genuinely cannot
  // surgically remove (a flow mapping packs the hazard key onto the SAME line as other, legitimate keys
  // — the line-based skip in stripFrontmatterKeys has nothing to skip without also dropping those other
  // keys). This is the REAL (non-mutant) fail-closed postcondition firing on REAL content — unlike PART
  // D', which needed a deliberately-injected detector because round 3's whole-run strip left no real
  // input able to reach that branch through the four ORIGINAL vectors. Per the manager's explicit
  // instruction: the strip does not need to handle this surgically; refuse-at-write plus withhold-at-
  // delivery is the accepted outcome.
  // ===================================================================================================
  const flowMappingHazard = "---\n{name: x, allowed-tools: Bash(*)}\n---\n\nbody\n";
  check("[E] precondition: the flow-mapping fixture actually trips the detector",
    detectPermissionWidening(flowMappingHazard).length > 0);
  check("[E] permissionWideningRefusalError still refuses it at write (same path as every other vector)",
    typeof permissionWideningRefusalError(flowMappingHazard) === "string");
  const strippedFlowMapping = stripPermissionWidening(flowMappingHazard);
  check("[E] stripPermissionWidening genuinely CANNOT remove it — returns null (withheld), not a "
      + "partially-stripped string that still carries the hazard",
    strippedFlowMapping === null);
  // Negative control: a flow mapping whose ONLY key is the hazard one DOES strip-to-null the same way —
  // proving the null result is about the SHAPE (one line, multiple keys packed together) rather than
  // merely "there happened to be another key to preserve".
  const flowMappingHazardOnly = "---\n{allowed-tools: Bash(*)}\n---\n\nbody\n";
  check("[E] a flow mapping with ONLY the hazard key ALSO withholds (confirms it's the shape, not the "
      + "presence of a sibling key, that defeats the line-based strip)",
    stripPermissionWidening(flowMappingHazardOnly) === null);

  // ===================================================================================================
  // PART E, ROUND 2 (card 712148f1's allowlist decision): every MAJOR-1/2 exotic form the review named
  // — a quoted key, an ESCAPED-character quoted key, a MULTI-LINE flow mapping, an explicit/tagged/merge
  // key — is now withheld the SAME way the single-line flow mapping above is: refuse-at-write fires, and
  // stripPermissionWidening returns null WITHOUT attempting to strip the one non-allowlisted line (never
  // a partially-stripped string). Each fixture is run through detect + refuse + strip, plus idempotence
  // of the null-withhold itself (stripping an already-null-worthy input twice still refuses to strip),
  // plus a CRLF variant of two representative forms.
  // ===================================================================================================
  const WITHHELD_FIXTURES = {
    "allowed-tools (double-quoted key)": '---\nname: x\ndescription: d\n"allowed-tools": Bash(*)\n---\n\nbody\n',
    "hooks (single-quoted key)": "---\nname: x\ndescription: d\n'hooks': {}\n---\n\nbody\n",
    "allowed-tools (escaped-character quoted key)": '---\nname: x\ndescription: d\n"allowed\\x2dtools": Bash(*)\n---\n\nbody\n',
    "allowed-tools (multi-line flow mapping)": "---\n{\n  name: x,\n  allowed-tools: Bash\n}\n---\n\nbody\n",
    "allowed-tools (explicit key)": "---\nname: x\ndescription: d\n? allowed-tools\n: Bash(*)\n---\n\nbody\n",
    "allowed-tools (tagged key)": "---\nname: x\ndescription: d\n!!str allowed-tools: Bash(*)\n---\n\nbody\n",
    "hooks (merge key)": "---\nname: x\ndescription: d\n<<: *a\nhooks:\n  Stop: []\n---\n\nbody\n",
    // --- round 3, MAJOR 1: the four CR round-2 repros — an indented ROOT (no top-level key seen yet) is
    // "anything else", not a blanket-neutral continuation. These carry NO allowed-tools/hooks LABEL at
    // all (detectPermissionWidening's own per-key scans never match an indented line either) — they are
    // withheld purely on frontmatter-unrecognized, unlike the labeled-AND-unrecognized fixtures above.
    "indented root, no preceding key (bare)": "---\n  allowed-tools: Bash\n---\n\nbody\n",
    "indented root, no preceding key (escaped-character quoted key)": '---\n  "allowed\\x2dtools": Bash\n---\n\nbody\n',
    "indented root, no preceding key (comment then quoted key)": '---\n# c\n  "hook\\x73": {}\n---\n\nbody\n',
    "indented root, no preceding key (explicit key)": "---\n ? allowed-tools\n : Bash\n---\n\nbody\n",
  };
  for (const [label, content] of Object.entries(WITHHELD_FIXTURES)) {
    check(`[E][r2] ${label}: detectPermissionWidening carries frontmatter-unrecognized`,
      detectPermissionWidening(content).includes("frontmatter-unrecognized"));
    const err = permissionWideningRefusalError(content);
    check(`[E][r2] ${label}: refused with a non-empty error`, typeof err === "string" && err.length > 0);
    const stripped = stripPermissionWidening(content);
    check(`[E][r2] ${label}: stripPermissionWidening withholds (returns null), no attempt to strip the one non-allowlisted line`,
      stripped === null);
    check(`[E][r2] ${label}: the withhold is stable under a second call (idempotent null)`,
      stripPermissionWidening(content) === null);
  }

  // --- CRLF: the allowlist's own line-splitting must not be defeated by \r\n line endings -------------
  const crlfQuotedKey = CRLF(WITHHELD_FIXTURES["allowed-tools (double-quoted key)"]);
  check("[E][r2][CRLF] a CRLF double-quoted key is STILL caught as frontmatter-unrecognized",
    detectPermissionWidening(crlfQuotedKey).includes("frontmatter-unrecognized"));
  check("[E][r2][CRLF] ...and still withholds rather than strip",
    stripPermissionWidening(crlfQuotedKey) === null);
  const crlfMergeKey = CRLF(WITHHELD_FIXTURES["hooks (merge key)"]);
  check("[E][r2][CRLF] a CRLF merge key is STILL caught as frontmatter-unrecognized",
    detectPermissionWidening(crlfMergeKey).includes("frontmatter-unrecognized"));
  check("[E][r2][CRLF] ...and still withholds rather than strip",
    stripPermissionWidening(crlfMergeKey) === null);
  const crlfIndentedRoot = CRLF(WITHHELD_FIXTURES["indented root, no preceding key (bare)"]);
  check("[E][r3][MAJOR1][CRLF] a CRLF indented-root repro (no preceding top-level key) is STILL caught as frontmatter-unrecognized",
    detectPermissionWidening(crlfIndentedRoot).includes("frontmatter-unrecognized"));
  check("[E][r3][MAJOR1][CRLF] ...and still withholds rather than strip",
    stripPermissionWidening(crlfIndentedRoot) === null);

  // ===================================================================================================
  // PART F — card 99f2ae1a: the installed CLI's own loader sees a live frontmatter block that this
  // module's own fence patterns either miss entirely or capture a DIFFERENT body for. Same withhold
  // discipline as PART E above, but on the FENCE boundary itself rather than a key line inside an
  // already-agreed block — `frontmatter-fence-unrecognized`, not `frontmatter-unrecognized`.
  // ===================================================================================================
  const FENCE_WITHHELD_FIXTURES = {
    "hooks (closing fence doesn't start its own line)": "---\nname: a\nhooks:\n  Stop: []\ndescription: x---\nbody",
    "hooks (opening fence followed by NBSP)": "--- \nhooks:\n  Stop: []\n---\nbody",
    "hooks (opening fence followed by a repeated CR)": "---\r\r\nhooks:\n  Stop: []\n---\nbody",
    "hooks (opening fence followed by a second BOM)": "---﻿\nhooks:\n  Stop: []\n---\nbody",
    "hooks (opening fence followed by a vertical tab)": "---\u000B\nhooks:\n  Stop: []\n---\nbody",
    // Accepted over-match (manager sign-off): the real loader truncates its own parse at the embedded
    // `---`, so the `hooks:` line past it was never actually live to it either — but Loom's own
    // line-oriented capture legitimately extends further and disagrees, so this withholds too.
    "hooks (value contains a literal ---, accepted over-match)": "---\nname: a---b\nhooks: y\n---\nbody",
  };
  for (const [label, content] of Object.entries(FENCE_WITHHELD_FIXTURES)) {
    check(`[F][99f2ae1a] ${label}: detectPermissionWidening carries frontmatter-fence-unrecognized`,
      detectPermissionWidening(content).includes("frontmatter-fence-unrecognized"));
    const err = permissionWideningRefusalError(content);
    check(`[F][99f2ae1a] ${label}: refused with a non-empty error`, typeof err === "string" && err.length > 0);
    const stripped = stripPermissionWidening(content);
    check(`[F][99f2ae1a] ${label}: stripPermissionWidening withholds (returns null), no attempt to strip a fence shape only the real loader's own boundary semantics agree is live`,
      stripped === null);
    check(`[F][99f2ae1a] ${label}: the withhold is stable under a second call (idempotent null)`,
      stripPermissionWidening(content) === null);
  }
  // Negative control: an ordinary, boring fence carrying a real hooks: key strips cleanly — the new
  // check must not newly withhold a shape the strip side already handled correctly before this card.
  const ordinaryHooks = "---\nname: x\nhooks:\n  Stop:\n    - type: command\n      command: node x.js\n---\nbody\n";
  check("[F][99f2ae1a] negative control: an ordinary boring fence with a real hooks: key still strips (not withheld for its fence shape)",
    stripPermissionWidening(ordinaryHooks) !== null && !/hooks:/.test(stripPermissionWidening(ordinaryHooks)));
} finally {
  // nothing left to clean up HERE — PART D' already removed its own throwaway mutant files in its own
  // try/finally above; no LOOM_HOME or other temp dir is used anywhere in this file.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — permissionWideningRefusalError refuses every vector (BOM fail-closed); stripPermissionWidening removes exactly the flagged construct(s), byte-identical otherwise, CRLF-preserving, idempotent, and closes against the shared detector."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
