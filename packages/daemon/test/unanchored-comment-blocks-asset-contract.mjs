import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Asset export-contract backstop for detectUnanchoredAddedCommentBlocks (card 9d0c004e, code-review
// follow-up point 1 / the dbad4b59 scoping note — see docs/decisions/9d0c004e-*.md). The detector imports
// the DAEMON'S OWN packaged comment-anchor-lint.mjs and fails SAFE (silently disables the advisory) on a
// missing/renamed export — see unanchored-comment-blocks-safety.mjs's (I2) for that fail-safe behavior
// itself. That silence is exactly the risk: a real rename of `extractCommentBlocks`/`isInScope`/
// `DEFAULT_MIN_LINES` in comment-anchor-lint.mjs would disable this whole advisory with NO error anywhere.
// This test is the loud backstop — it imports the REAL packaged asset directly (the same path
// COMMENT_ANCHOR_LINT_SCRIPT resolves, and the same file the detector's own default path points at) and
// asserts those three exports exist with the expected shapes, so a rename fails HERE, at the gate,
// instead of silently degrading a live feature in production.
// Run: 1) build daemon (pnpm build), 2) node test/unanchored-comment-blocks-asset-contract.mjs
import { pathToFileURL } from "node:url";

const { COMMENT_ANCHOR_LINT_SCRIPT } = await import("../dist/paths.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const mod = await import(pathToFileURL(COMMENT_ANCHOR_LINT_SCRIPT).href);

check("comment-anchor-lint.mjs exports DEFAULT_MIN_LINES as a number", typeof mod.DEFAULT_MIN_LINES === "number");
check("comment-anchor-lint.mjs exports extractCommentBlocks as a function", typeof mod.extractCommentBlocks === "function");
check("comment-anchor-lint.mjs exports isInScope as a function", typeof mod.isInScope === "function");

// Behavioral sanity, not just a `typeof` check — catches a SIGNATURE-only rename (same name, different
// shape/arity) that a bare typeof check would miss.
if (typeof mod.extractCommentBlocks === "function") {
  const blocks = mod.extractCommentBlocks(["// a", "// b", "code();"]);
  check("extractCommentBlocks(lines) returns an array of block objects with the expected shape",
    Array.isArray(blocks) && blocks.length === 1
    && typeof blocks[0].startLine === "number" && typeof blocks[0].endLine === "number"
    && typeof blocks[0].length === "number" && Array.isArray(blocks[0].anchorIds));
}
if (typeof mod.isInScope === "function") {
  // A positive control (a real in-scope path) alongside the negative one below — proves the function
  // actually discriminates rather than degenerately returning null/non-null for everything.
  check("isInScope returns non-null for a real in-scope path",
    mod.isInScope("/repo", "/repo/packages/daemon/src/example.ts") !== null);
  check("isInScope returns null for an out-of-scope path", mod.isInScope("/repo", "/repo/docs/example.md") === null);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the packaged comment-anchor-lint.mjs still exports DEFAULT_MIN_LINES/extractCommentBlocks/isInScope with the shapes detectUnanchoredAddedCommentBlocks depends on; a rename or signature change here would fail loudly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
