import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source scan
// STANDING GUARD (card 69547e0e) — forbids REINTRODUCING the fragile message-text regex idiom
// `/waitUntil: timed out/.test(err?.message ?? "")` as a way to discriminate a genuine `_wait.mjs`
// `waitUntil` timeout from a rethrown foreign/persistent-throw error. Card d5ca8d57 gave `_wait.mjs`'s
// thrown timeout Error a structured `exhaustedOnThrow` boolean specifically because the message text is
// no longer a reliable discriminator: it now legitimately starts with "waitUntil: timed out" even when
// the underlying cause was a persistent throw (see `_wait.mjs`'s own doc comment — the source of truth
// for the canonical form and the reasoning). Card 69547e0e migrated all 75 call sites that used the old
// idiom onto `if (err?.exhaustedOnThrow !== false) throw err;`; this guard exists so a NEW wrapper copied
// from an older reference/example never regenerates the regex it replaced.
//
// WHAT THIS ASSERTS: no `packages/daemon/test/*.mjs` file contains a live (non-comment) line that names
// the literal message text "waitUntil: timed out" together with a `.test(`, `.match(`, or `.includes(`
// call testing it — the shape every real instance of the old idiom took. A comment MENTIONING the old
// idiom (this guard's own header, `_wait.mjs`'s doc comment, `wait-until-predicate-throw.mjs`'s
// historical note) is not itself a violation — only live code that actually re-discriminates on the
// message text is.
//
// WHAT IT CANNOT SEE (stated plainly, same posture as this corpus's sibling guards): a reworded
// discriminator that names the message text without using `.test(`/`.match(`/`.includes(` (e.g. a manual
// substring index check) would escape this guard's narrow shape. Not observed anywhere in this corpus as
// of this card; widen `DISCRIMINATOR_CALLS` below if one ever appears.
//
// Run: node packages/daemon/test/waituntil-message-regex-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = __dirname;
const SELF = path.basename(__filename);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const MESSAGE_LITERAL = "waitUntil: timed out";
const DISCRIMINATOR_CALLS = [".test(", ".match(", ".includes("];

// Per-line comment mask covering both `//` line comments and `/* ... */` block comments — same shape as
// real-home-scope-guard.mjs's own (this file's header and `_wait.mjs`'s doc comment both discuss the
// forbidden idiom in prose; without masking, the scanner would flag its own and its sibling's docs).
function computeCommentMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock) {
      mask[i] = true;
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      mask[i] = true;
      const blockStart = line.indexOf("/*");
      if (blockStart !== -1 && line.indexOf("*/", blockStart + 2) === -1) inBlock = true;
      continue;
    }
  }
  return mask;
}

// The reusable classifier — unit-tested directly below (positive + negative controls) before it's ever
// trusted against the real corpus, per this project's standing verification posture.
function lineViolates(line) {
  if (!line.includes(MESSAGE_LITERAL)) return false;
  return DISCRIMINATOR_CALLS.some((call) => line.includes(call));
}

function walkTestFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs") && f !== SELF);
}

function classifyFile(file) {
  const text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
  const lines = text.split("\n");
  const isComment = computeCommentMask(lines);
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    if (isComment[i]) continue;
    if (lineViolates(lines[i])) violations.push({ lineNo: i + 1, text: lines[i].trim() });
  }
  return violations;
}

// ── Classifier self-test (RED/GREEN proof, in-memory — no fixture file needed, since the whole point of
// this guard is that zero real sites should exist in the corpus post-migration). ───────────────────────
check("classifier RED-PROOF: the old `.test(` idiom on live code is caught",
  lineViolates('    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;') === true);
check("classifier RED-PROOF (variant): a `.match(` discriminator is also caught",
  lineViolates("    if (!/waitUntil: timed out/.match(err.message)) throw err;") === true);
check("classifier RED-PROOF (variant): an `.includes(` discriminator is also caught",
  lineViolates('    if (!String(err?.message).includes("waitUntil: timed out")) throw err;') === true);
check("classifier negative control: the new canonical form does not trip it",
  lineViolates("    if (err?.exhaustedOnThrow !== false) throw err;") === false);
check("classifier negative control: the message literal alone, with no discriminator call, does not trip it",
  lineViolates("  const absentErr = new Error(`waitUntil: timed out after ${timeoutMs}ms...`);") === false);

// ── Corpus scan ────────────────────────────────────────────────────────────────────────────────────────
const files = walkTestFiles();
const rawMentions = files
  .flatMap((f) => fs.readFileSync(path.join(TEST_DIR, f), "utf8").split("\n").filter((l) => l.includes(MESSAGE_LITERAL)))
  .length;
check(`sanity: the literal "${MESSAGE_LITERAL}" still appears somewhere in the corpus (found ${rawMentions} line(s) total, comments+code — confirms this isn't a typo'd pattern matching nothing; _wait.mjs constructs that message itself and documents the retired idiom)`,
  rawMentions > 0);

let allViolations = [];
for (const file of files) {
  const violations = classifyFile(file);
  for (const v of violations) allViolations.push({ file, ...v });
}

check(`no packages/daemon/test/*.mjs file discriminates a waitUntil timeout by regexing/matching the message text (found ${allViolations.length} violation(s) — use the structured \`err?.exhaustedOnThrow !== false\` check instead, per _wait.mjs's own doc comment)`,
  allViolations.length === 0);
for (const v of allViolations) console.log(`  MESSAGE-REGEX-VIOLATION  ${v.file}:${v.lineNo}  ${v.text}`);

console.log(failures === 0
  ? `\n✅ ALL PASS — no live discrimination on the "${MESSAGE_LITERAL}" message text found across ${files.length} test files.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
