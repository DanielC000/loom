import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1) — pure text in/out below, no Db used
//
// Card f39341d5, item 3: permission-scan.ts's SKILL_PERMISSION_FIELD_LABEL and permissionGuard.ts's VECTOR_LABEL were two independently-authored vector-label tables; both now derive from permissionWidening.ts's shared VECTOR_TEXT (`.terse` for the scan/push label, `.verbose` for the write-time refusal error).
// This test pins VECTOR_TEXT itself, SKILL_PERMISSION_FIELD_LABEL directly, and VECTOR_LABEL indirectly
// (it is module-private — not exported, since every vector is reachable through
// permissionWideningRefusalError's own returned text; see the fixtures below).
//
// The EXPECTED_* strings are the exact PRE-REFACTOR literals, captured via
// `git show 134be681e5f44c9300e439bfde35024b882e737f:packages/daemon/src/skills/permission-scan.ts` and
// `...permissionGuard.ts` — a FIXED sha, never HEAD (HEAD moves once this card's commit lands; lesson
// 250). The two shell-vector `terse` strings are new (permission-scan.ts's scan never covered them —
// see SkillPermissionField's own doc) and were not previously duplicated between the two production
// tables; they are pinned against the pre-existing test-only copy in
// skill-permission-widening-guard.mjs's own VECTOR_LABEL, which already used this exact wording.
//
// Run after build: node test/skill-permission-vector-text.mjs
import { VECTOR_TEXT, detectPermissionWidening } from "../dist/skills/permissionWidening.js";
import { SKILL_PERMISSION_FIELD_LABEL } from "../dist/skills/permission-scan.js";
import { permissionWideningRefusalError } from "../dist/skills/permissionGuard.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const NBSP = String.fromCharCode(0xa0);

// ── Pre-refactor literals, pinned to sha 134be681e5f44c9300e439bfde35024b882e737f ────────────────────

const EXPECTED_TERSE = {
  "allowed-tools": "allowed-tools:",
  hooks: "hooks:",
  "frontmatter-unrecognized": "unrecognized frontmatter syntax",
  "frontmatter-fence-unrecognized": "frontmatter fence the CLI's own loader parses differently",
};

const EXPECTED_VERBOSE = {
  "allowed-tools": "a frontmatter `allowed-tools:` grant",
  hooks: "a frontmatter `hooks:` registration",
  "frontmatter-unrecognized": "frontmatter syntax this detector cannot confidently parse (e.g. a quoted "
    + "key, a flow mapping, an anchor/alias/tag value, an explicit/tagged/merge key)",
  "frontmatter-fence-unrecognized": "a frontmatter fence shape the installed CLI's own loader parses "
    + "differently than this detector does",
  "shell-inline": "an inline `` !`cmd` `` shell injection",
  "shell-fenced": "a fenced ` ```! ` shell block",
};

// Not duplicated between the two production tables before this card (permission-scan.ts's scan excludes
// both shell forms) — pinned against skill-permission-widening-guard.mjs's own pre-existing test-only
// VECTOR_LABEL copy for these two ids, which already used this exact wording.
const EXPECTED_SHELL_TERSE = {
  "shell-inline": "inline shell injection (!`cmd`)",
  "shell-fenced": "fenced shell injection (```!)",
};

// ── VECTOR_TEXT itself: every vector's terse + verbose half ─────────────────────────────────────────

for (const [vector, expected] of Object.entries(EXPECTED_TERSE)) {
  check(`[VECTOR_TEXT] ${vector}.terse is the pre-refactor literal`, VECTOR_TEXT[vector]?.terse === expected);
}
for (const [vector, expected] of Object.entries(EXPECTED_SHELL_TERSE)) {
  check(`[VECTOR_TEXT] ${vector}.terse matches the test-only guard's pre-existing copy`, VECTOR_TEXT[vector]?.terse === expected);
}
for (const [vector, expected] of Object.entries(EXPECTED_VERBOSE)) {
  check(`[VECTOR_TEXT] ${vector}.verbose is the pre-refactor literal`, VECTOR_TEXT[vector]?.verbose === expected);
}
check("[VECTOR_TEXT] exhaustive over exactly the six known vectors (no extra, none missing)",
  deepEqual(Object.keys(VECTOR_TEXT).sort(), Object.keys(EXPECTED_VERBOSE).sort()));

// ── SKILL_PERMISSION_FIELD_LABEL (permission-scan.ts): direct pin ──────────────────────────────────

check("[SKILL_PERMISSION_FIELD_LABEL] matches the pre-refactor literal, key-for-key and byte-for-byte",
  deepEqual(SKILL_PERMISSION_FIELD_LABEL, EXPECTED_TERSE));

// ── VECTOR_LABEL (permissionGuard.ts, module-private): indirect pin through the refusal error's own
//    returned text — one fixture per vector, each confirmed (precondition) to actually trip that vector.
// ────────────────────────────────────────────────────────────────────────────────────────────────────

const FIXTURES = {
  "allowed-tools": "---\nname: x\ndescription: d\nallowed-tools: Bash(*)\n---\n\nbody\n",
  hooks: "---\nname: x\ndescription: d\nhooks:\n  Stop: []\n---\n\nbody\n",
  "shell-inline": "---\nname: x\n---\nRun this first: !`node sentinel.js A`\n",
  "shell-fenced": "---\nname: x\n---\nbody\n\n```!\nnode sentinel.js B\n```\n",
  // An indented root with NO preceding top-level key — card 712148f1 round 3, MAJOR 1 — is reported as
  // frontmatter-unrecognized alone (an indented line never matches the column-0 key scan either).
  "frontmatter-unrecognized": "---\n  allowed-tools: Bash\n---\n\nbody\n",
  // card 99f2ae1a: an opening fence followed by NBSP disagrees with the installed CLI loader's own
  // (wider) fence tolerance — frontmatter-fence-unrecognized, independently of any key inside the block.
  "frontmatter-fence-unrecognized": `---${NBSP}\nhooks:\n  Stop: []\n---\nbody`,
};

for (const [vector, content] of Object.entries(FIXTURES)) {
  const vectors = detectPermissionWidening(content);
  check(`[VECTOR_LABEL][${vector}] precondition: the fixture actually trips this vector`,
    vectors.includes(vector));
  const err = permissionWideningRefusalError(content) ?? "";
  // MINOR (card f39341d5, CR round 3): a bare `err.includes(EXPECTED_VERBOSE[vector])` pins only the
  // label's START — a mutant that appends "(drifted suffix)" after the real label would still pass. Pin
  // the EXACT joined segment `permissionWideningRefusalError` actually assembles instead — every
  // fixture here trips exactly one vector (the precondition above proves it), so `named`/`vectors.join`
  // degrade to the single label/id, never a multi-vector join — matching that function's own
  // `carries ${named} (${vectors.join(", ")})` construction byte-for-byte, both ends.
  check(`[VECTOR_LABEL][${vector}] precondition: the fixture trips ONLY this vector (boundary pin below assumes a single-vector join)`,
    vectors.length === 1);
  check(`[VECTOR_LABEL][${vector}] permissionWideningRefusalError's text carries the exact pre-refactor label, at its exact boundary`,
    err.includes(`carries ${EXPECTED_VERBOSE[vector]} (${vector})`));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — VECTOR_TEXT, SKILL_PERMISSION_FIELD_LABEL, and VECTOR_LABEL (via the refusal error) all pin to the exact pre-refactor label text."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
