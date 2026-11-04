import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text + dist-import scan
// Card 712148f1 round 2 (MINOR 4): `skill-permission-widening-guard.mjs` deliberately keeps its OWN TEXT
// COPY of every pattern `skills/permissionWidening.ts` exports (no build step there — a bare `node
// test/*.mjs` source-text scan), per that file's own header comment. The two are supposed to stay
// byte-for-byte in lockstep, but nothing has ever CHECKED that beyond a human reading both files side by
// side at review time. This is the dist-importing assertion: it imports the REAL module and extracts the
// guard file's own regex-literal TEXT (never re-deriving the regexes by hand), and fails loudly the
// moment either file's copy drifts from the other — in EITHER direction.
//
// Covers every REGEX-LITERAL CONSTANT the guard mirrors (card 712148f1 round 3: corrected from "covers
// every pattern" — a const-only check does NOT cover the guard's own hand-rolled LOGIC; see MINOR 3
// below for the check that does): FRONTMATTER_RE, FLOW_MAPPING_KEY_RE, INLINE_SHELL_RE, FENCED_SHELL_RE,
// and (card 712148f1 round 2) PLAIN_TOP_LEVEL_KEY_LINE_RE/SEQUENCE_ITEM_RE/
// FRONTMATTER_VALUE_START_FORBIDDEN_RE — plus the inline key-line regex `topLevelKeysOf` uses, which
// must still equal FRONTMATTER_KEY_LINE_RE's own `.source` even though it has no named const of its own
// in the guard file.
//
// Card 712148f1 round 3, MINOR 3: the checks above cover only the regex-literal CONSTANTS the guard
// copies — they never exercised the guard's own `frontmatterUnrecognizedSyntax` LOGIC (the loop, the
// seenTopLevelKey/prevTopLevelKeyEmpty state machine), so a mutant making e.g. quoted-key lines neutral
// in the GUARD's own copy, while leaving every regex-literal const byte-identical, stayed green against
// every check above. The DIFFERENTIAL check below extracts that function's (and `frontmatterBlockOf`'s)
// real source text verbatim and runs it, alongside the real module's own `frontmatterUnrecognizedSyntax`
// export, over one shared fixture corpus — every round-1/2/3 form plus the benign shapes (block scalars,
// quoted values, sequences, comments) — asserting identical outputs.
//
// Run after build: node test/skill-permission-widening-lockstep.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARD_PATH = path.join(TEST_DIR, "skill-permission-widening-guard.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const {
  FRONTMATTER_RE, FRONTMATTER_KEY_LINE_RE, FLOW_MAPPING_KEY_RE, INLINE_SHELL_RE, FENCED_SHELL_RE,
  PLAIN_TOP_LEVEL_KEY_LINE_RE, SEQUENCE_ITEM_RE, FRONTMATTER_VALUE_START_FORBIDDEN_RE,
  REAL_LOADER_FENCE_RE, frontmatterUnrecognizedSyntax, frontmatterFenceUnrecognized,
} = await import("../dist/skills/permissionWidening.js");

const guardSrc = fs.readFileSync(GUARD_PATH, "utf8");

/** Extracts the regex literal text assigned to `const <name> = <literal>;` in `guardSrc`, parses it with
 *  `new Function` (never a hand-rolled regex-of-regexes), and returns the real RegExp — or throws with a
 *  clear message if the const isn't found, so a rename in the guard file fails loudly here too. */
function extractConstRegex(name) {
  const m = guardSrc.match(new RegExp(`const ${name} = (\\/(?:\\\\.|[^/\\n\\\\])*\\/[a-z]*);`));
  if (!m) throw new Error(`skill-permission-widening-guard.mjs: no "const ${name} = /.../;" line found`);
  // eslint-disable-next-line no-new-func -- parsing a regex LITERAL's own text, not arbitrary code
  return new Function(`return ${m[1]};`)();
}

/** Extracts the regex literal text inside `topLevelKeysOf`'s own `line.match(/.../)` call — it has no
 *  named const of its own in the guard file, unlike the others above. */
function extractInlineKeyLineRegex() {
  const m = guardSrc.match(/function topLevelKeysOf[\s\S]*?line\.match\((\/(?:\\.|[^/\n\\])*\/[a-z]*)\)/);
  if (!m) throw new Error("skill-permission-widening-guard.mjs: topLevelKeysOf's inline key-line regex not found");
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1]};`)();
}

// FRONTMATTER_RE is a KNOWN, documented exception: the guard's own copy additionally consumes the
// newline AFTER the closing fence (`\r?\n?` at the end) — `frontmatterBlockOf`'s own doc explains why
// (its caller wants the block text with the trailing newline already consumed), while the real module's
// export deliberately does not, leaving that to its own callers. Pre-existing, not a round-2 drift —
// assert the guard's copy is the real source PLUS exactly that documented suffix, never bare equality.
const guardFrontmatterRe = extractConstRegex("FRONTMATTER_RE");
check("FRONTMATTER_RE: guard's text copy .source is the real module's .source plus the documented "
    + "trailing `\\r?\\n?` exception (frontmatterBlockOf consumes the post-fence newline; the real "
    + "export's own callers do that themselves) — never bare equality",
  guardFrontmatterRe.source === `${FRONTMATTER_RE.source}\\r?\\n?`);
check("FRONTMATTER_RE: guard's text copy .flags matches the real module export",
  guardFrontmatterRe.flags === FRONTMATTER_RE.flags);

const pairs = [
  ["REAL_LOADER_FENCE_RE", extractConstRegex("REAL_LOADER_FENCE_RE"), REAL_LOADER_FENCE_RE],
  ["FLOW_MAPPING_KEY_RE", extractConstRegex("FLOW_MAPPING_KEY_RE"), FLOW_MAPPING_KEY_RE],
  ["INLINE_SHELL_RE", extractConstRegex("INLINE_SHELL_RE"), INLINE_SHELL_RE],
  ["FENCED_SHELL_RE", extractConstRegex("FENCED_SHELL_RE"), FENCED_SHELL_RE],
  ["PLAIN_TOP_LEVEL_KEY_LINE_RE", extractConstRegex("PLAIN_TOP_LEVEL_KEY_LINE_RE"), PLAIN_TOP_LEVEL_KEY_LINE_RE],
  ["SEQUENCE_ITEM_RE", extractConstRegex("SEQUENCE_ITEM_RE"), SEQUENCE_ITEM_RE],
  ["FRONTMATTER_VALUE_START_FORBIDDEN_RE", extractConstRegex("FRONTMATTER_VALUE_START_FORBIDDEN_RE"), FRONTMATTER_VALUE_START_FORBIDDEN_RE],
];

for (const [name, guardRe, realRe] of pairs) {
  check(`${name}: guard's text copy .source matches the real module export`, guardRe.source === realRe.source);
  check(`${name}: guard's text copy .flags matches the real module export`, guardRe.flags === realRe.flags);
}

const inlineKeyLineRe = extractInlineKeyLineRegex();
check("topLevelKeysOf's inline key-line regex .source matches FRONTMATTER_KEY_LINE_RE's own .source",
  inlineKeyLineRe.source === FRONTMATTER_KEY_LINE_RE.source);
check("topLevelKeysOf's inline key-line regex .flags matches FRONTMATTER_KEY_LINE_RE's own .flags",
  inlineKeyLineRe.flags === FRONTMATTER_KEY_LINE_RE.flags);

// Negative control: the extraction itself must actually discriminate, not vacuously pass because it
// never looks at real text — prove it FAILS against a deliberately wrong comparison.
check("[control] the comparison genuinely discriminates: FRONTMATTER_RE does NOT equal FLOW_MAPPING_KEY_RE",
  FRONTMATTER_RE.source !== FLOW_MAPPING_KEY_RE.source);

// =====================================================================================================
// MINOR 3 — the DIFFERENTIAL check: extract the guard's own `frontmatterBlockOf`/`frontmatterUnrecognizedSyntax`
// function source VERBATIM (never re-authored here) and run it, closed over the guard's own already-
// extracted regex-literal constants, side by side with the real module's own export.
// =====================================================================================================

/** Extracts the string-literal text assigned to `const <name> = "...";` in `guardSrc` and parses it with
 *  `new Function` (never a hand-typed copy) — the string-constant sibling of `extractConstRegex` above,
 *  for a plain string constant like the guard's own `BOM`. */
function extractConstString(name) {
  const m = guardSrc.match(new RegExp(`const ${name} = ("(?:\\\\.|[^"\\\\])*");`));
  if (!m) throw new Error(`skill-permission-widening-guard.mjs: no "const ${name} = \\"...\\";" line found`);
  // eslint-disable-next-line no-new-func -- parsing a string literal's own text, not arbitrary code
  return new Function(`return ${m[1]};`)();
}

/** Extracts a `function <name>(...) { ... }` block's exact source text from `guardSrc`. The closing
 *  brace of every helper in this file sits at column 0, so the non-greedy `[\s\S]*?\n\}` can never stop
 *  early at an indented nested `}` inside the function body — it only matches a `}` immediately after a
 *  newline. Throws loudly if `name` isn't found, so a rename in the guard file fails here too. */
function extractFunctionSource(name) {
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = guardSrc.match(re);
  if (!m) throw new Error(`skill-permission-widening-guard.mjs: no "function ${name}(...) { ... }" block found`);
  return m[0];
}

// Rebuild the guard's own classifier from its EXTRACTED source text, closed over the guard's own
// (already-extracted-above) regex-literal copies — never a hand-reimplementation of the logic.
const guardClassify = new Function(
  "FRONTMATTER_RE", "SEQUENCE_ITEM_RE", "PLAIN_TOP_LEVEL_KEY_LINE_RE", "FRONTMATTER_VALUE_START_FORBIDDEN_RE",
  `${extractFunctionSource("frontmatterBlockOf")}\n${extractFunctionSource("frontmatterUnrecognizedSyntax")}\n` +
    "return function classify(raw) { const block = frontmatterBlockOf(raw); return block != null && frontmatterUnrecognizedSyntax(block); };",
)(guardFrontmatterRe, extractConstRegex("SEQUENCE_ITEM_RE"), extractConstRegex("PLAIN_TOP_LEVEL_KEY_LINE_RE"), extractConstRegex("FRONTMATTER_VALUE_START_FORBIDDEN_RE"));

const realClassify = (raw) => frontmatterUnrecognizedSyntax(raw);

// Shared fixture corpus — full file content WITH frontmatter fences, exactly as either classifier is
// actually called with in production. Every round-1/2/3 hazard form, the round-2 allowlist's own
// positive (benign) forms, and the round-3 MAJOR-1 indented-root repros.
const DIFFERENTIAL_FIXTURES = [
  // benign — must NOT be flagged by either classifier
  "---\nname: x\ndescription: d\n---\nbody\n",
  "---\nname: x\ntags:\n- a\n- b\n---\nbody\n",
  "---\nname: x\n# a comment\ndescription: d\n---\nbody\n",
  "---\nname: x\n\ndescription: d\n---\nbody\n",
  '---\nname: x\ndescription: "a quoted VALUE, not a key"\n---\nbody\n',
  "---\nname: x\nbody: |\n  a literal block scalar\n  spanning lines\n---\nbody\n",
  "---\nname: x\nbody: >\n  a folded block scalar\n  spanning lines\n---\nbody\n",
  "---\nname: x\ncapabilities:\n  hooks: not-the-same-field\n---\nbody\n",
  // round 1/2 hazard forms — unrecognized
  '---\nname: x\n"allowed-tools": Bash(*)\n---\nbody\n',
  "---\nname: x\n'hooks': {}\n---\nbody\n",
  "---\n{allowed-tools: Bash(*), name: x}\n---\nbody\n",
  "---\n{name: x, hooks: {}}\n---\nbody\n",
  "---\n{\n  name: x,\n  allowed-tools: Bash\n}\n---\nbody\n",
  '---\nname: x\n"allowed\\x2dtools": Bash(*)\n---\nbody\n',
  "---\nname: x\n? allowed-tools\n: Bash(*)\n---\nbody\n",
  "---\nname: x\n!!str allowed-tools: Bash(*)\n---\nbody\n",
  "---\nname: x\n<<: *a\n---\nbody\n",
  "---\nname: x\nbase: &anchor\n---\nbody\n",
  "---\nname: x\nref: *anchor\n---\nbody\n",
  "---\nname: x\nkind: !!str plain\n---\nbody\n",
  "---\n- a\nname: x\n---\nbody\n",
  // round 3, MAJOR 1 repros — an indented root with no top-level key seen yet
  "---\n  allowed-tools: Bash\n---",
  '---\n  "allowed\\x2dtools": Bash\n---',
  '---\n# c\n  "hook\\x73": {}\n---',
  "---\n ? allowed-tools\n : Bash\n---",
];

for (const [i, fixture] of DIFFERENTIAL_FIXTURES.entries()) {
  const real = realClassify(fixture);
  const guard = guardClassify(fixture);
  check(`[diff ${i}] real frontmatterUnrecognizedSyntax and the guard's own extracted copy agree on ${JSON.stringify(fixture)}`,
    real === guard);
}
check("[diff][control] the corpus is non-vacuous — at least one fixture is clean and at least one is unrecognized under the REAL classifier",
  DIFFERENTIAL_FIXTURES.some((f) => realClassify(f) === false) && DIFFERENTIAL_FIXTURES.some((f) => realClassify(f) === true));

// =====================================================================================================
// card 99f2ae1a — the SAME differential discipline, for the guard's own `frontmatterFenceUnrecognized`.
// =====================================================================================================

// Closed over the GUARD's OWN extracted copies (REAL_LOADER_FENCE_RE, `guardFrontmatterRe` — the
// guard's own FRONTMATTER_RE, already extracted above — and, card 99f2ae1a round 2 item 4, its own BOM
// string + `splitLeadingBom` helper, since frontmatterFenceUnrecognized now calls that first) — never the
// real module's exports — same discipline as `guardClassify` above. The guard's trailing `\r?\n?` suffix
// sits OUTSIDE capture group 1, so it never changes what body text ends up compared, but closing over the
// guard's OWN copy, not the real module's, is what actually proves the GUARD FILE's own runtime behavior.
const guardFenceClassify = new Function(
  "REAL_LOADER_FENCE_RE", "FRONTMATTER_RE", "BOM",
  `${extractFunctionSource("splitLeadingBom")}\n${extractFunctionSource("stripLeadingBlankLines")}\n` +
    `${extractFunctionSource("frontmatterFenceUnrecognized")}\nreturn frontmatterFenceUnrecognized;`,
)(extractConstRegex("REAL_LOADER_FENCE_RE"), guardFrontmatterRe, extractConstString("BOM"));

const realFenceClassify = (raw) => frontmatterFenceUnrecognized(raw);

// Full file content, exactly as either classifier is called with in production. Every evasion fixture
// this card found live to the real loader, the accepted value-contains-`---` over-match, and a spread of
// the SAME benign fixtures above (no fence disagreement expected for any of them).
const FENCE_DIFFERENTIAL_FIXTURES = [
  ...DIFFERENTIAL_FIXTURES,
  "---\nname: a\nhooks:\n  Stop: []\ndescription: x---\nbody", // close-mid-line
  "--- \nhooks:\n  Stop: []\n---\nbody", // open NBSP
  "---\r\r\nhooks:\n  Stop: []\n---\nbody", // open repeated CR
  "---﻿\nhooks:\n  Stop: []\n---\nbody", // open second BOM
  "---\u000B\nhooks:\n  Stop: []\n---\nbody", // open vertical tab
  "---\nname: a---b\nhooks: y\n---\nbody", // accepted over-match: a value containing ---
  "---\nhooks:\n  Stop: []\n---\nbody", // ordinary boring fence — must NOT disagree
  "﻿---\nname: a\nhooks:\n  Stop: []\ndescription: x---\nbody", // card 99f2ae1a round 2: file-start BOM + mid-line close
  "﻿---\nhooks:\n  Stop: []\n---\nbody", // file-start BOM + an ordinary boring fence — must NOT disagree
  "---\n\nhooks:\n  Stop: []\n---\nbody\n", // card 99f2ae1a round 2, false positive (a): blank line after open
  "---\n\nname: a\nhooks:\n  Stop: []\ndescription: x---\nbody", // blank line must NOT mask a genuine disagreement further in
];

for (const [i, fixture] of FENCE_DIFFERENTIAL_FIXTURES.entries()) {
  const real = realFenceClassify(fixture);
  const guard = guardFenceClassify(fixture);
  check(`[fence-diff ${i}] real frontmatterFenceUnrecognized and the guard's own extracted copy agree on ${JSON.stringify(fixture)}`,
    real === guard);
}
check("[fence-diff][control] the corpus is non-vacuous — at least one fixture disagrees (fence-unrecognized) and at least one does not, under the REAL classifier",
  FENCE_DIFFERENTIAL_FIXTURES.some((f) => realFenceClassify(f) === false) && FENCE_DIFFERENTIAL_FIXTURES.some((f) => realFenceClassify(f) === true));

console.log(failures === 0
  ? "\n✅ ALL PASS — skill-permission-widening-guard.mjs's own text-copy regexes are byte-for-byte in lockstep with skills/permissionWidening.ts's real exports, and its frontmatterUnrecognizedSyntax LOGIC agrees with the real module's export across the shared differential fixture corpus."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
