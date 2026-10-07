// Board card 97cff6db, round 4, Lead ruling 1: reenterMergeQuarantinesAtBoot's own writeMergeQuarantineLatch
// references must ALL live inside the ONE boot-write chokepoint (bootWriteLatch) — never a bare call, or
// an aliased reference (e.g. `const w = writeMergeQuarantineLatch`), anywhere else in that function's body.
// This is a source-text/AST scan (never an import), because the property under test is "which references
// exist in the SOURCE", not runtime behavior any black-box test could observe.
//
// Pure fs + the TypeScript compiler API (parse-only, never executed) — no daemon/DB, no LOOM_HOME, nothing
// hermetic to set up. Run: node test/merge-quarantine-boot-write-chokepoint-guard.mjs
//
// @decision 97cff6db — comment-stripped first (via ts.transpileModule's removeComments:true, the SAME
// mechanism computeEmitCompareGate's own soundness proof already trusts), so a `// writeMergeQuarantineLatch(`
// mention in a comment can never flip the verdict — the same comment-immunity shape CLAUDE.md's
// CHANGED_TS_TEXT_SCANNER_REPO_PATHS doc names as shape (3) ("an EXPLICIT comment-stripped whole-file
// scan"); deliberately NOT added to that list for this reason. Counts IDENTIFIER REFERENCES via the real
// AST, never a `.indexOf("writeMergeQuarantineLatch(")` substring match — a call-syntax-only scan misses
// an aliased reference (`const w = writeMergeQuarantineLatch; w(entry)`) that would still reach the real
// write primitive while evading a naive text match. A hand-rolled brace-counting scanner was tried and
// abandoned here: @decision 2154b6ad's own "Do not" already warns `ts.createScanner` desyncs on
// template-literal interpolation (confirmed firsthand — every `${...}` console.error/warn call in this
// file corrupted a manual brace count). The parser's own AST gives exact boundaries and exact identifiers.
//
// @decision 97cff6db (round 5) — SCOPE, stated exactly rather than implied: this counts only
// `writeMergeQuarantineLatch` references INSIDE `reenterMergeQuarantinesAtBoot`'s own function body. It
// does NOT see (a) `quarantineAllRegisteredFailClosed` (called from inside that body on a readdir
// failure, before anything is read — a real boot write site with its own, separate write primitive,
// never bootWriteLatch), (b) `writeSafetyTmpResidue` (a DIFFERENT write primitive from
// writeMergeQuarantineLatch, deliberately outside this chokepoint — see Lead ruling 1/2 in the decision
// record for why the safety-tmp phase runs BEFORE any bootWriteLatch-gated write), or (c) a direct
// `fs.unlinkSync`/`fs.writeFileSync` call anywhere in this file. Do not read a GREEN here as "no boot
// write bypasses the gating rules" — it proves only that no OTHER reference to this ONE primitive exists
// outside this ONE chokepoint.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_PATH = path.join(__dirname, "..", "src", "git", "merge-quarantine.ts");
const TARGET_NAME = "writeMergeQuarantineLatch";
const FN_NAME = "reenterMergeQuarantinesAtBoot";
const CHOKEPOINT_NAME = "bootWriteLatch";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

/** Comment-strip `source` via the TypeScript compiler's own removeComments — never a hand-rolled regex
 *  stripper, which could be fooled by a `//`/`/*` sequence inside a string literal or template. */
function stripComments(source) {
  return ts.transpileModule(source, {
    compilerOptions: { removeComments: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, noEmitHelpers: true },
  }).outputText;
}

/** Find the top-level FunctionDeclaration node named `fnName` in `sourceFile`. */
function findFunctionDecl(sourceFile, fnName) {
  let found;
  sourceFile.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) found = node;
  });
  return found;
}

/** Find the first VariableDeclaration named `varName` anywhere inside `root` (used to locate the
 *  chokepoint's own definition range, so its ONE legitimate internal reference can be excluded). */
function findVariableDecl(root, varName) {
  let found;
  const visit = (node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === varName) { found = node; return; }
    node.forEachChild(visit);
  };
  root.forEachChild(visit);
  return found;
}

/** Count every IDENTIFIER reference to `targetName` inside `root`'s subtree whose position falls
 *  OUTSIDE `[excludeStart, excludeEnd)` — a reference, not merely a call: this also catches an aliasing
 *  assignment (`const w = writeMergeQuarantineLatch`) that a `name(` substring/call-expression match would
 *  miss entirely, since the identifier appears with no trailing `(` at all in that shape. */
function countIdentifierRefsOutsideRange(root, targetName, excludeStart, excludeEnd) {
  let count = 0;
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === targetName) {
      const pos = node.getStart(undefined, false);
      if (pos < excludeStart || pos >= excludeEnd) count++;
    }
    node.forEachChild(visit);
  };
  root.forEachChild(visit);
  return count;
}

const rawSource = fs.readFileSync(SRC_PATH, "utf8");
const stripped = stripComments(rawSource);
const sourceFile = ts.createSourceFile("scanned.ts", stripped, ts.ScriptTarget.ES2022, true);

const fnDecl = findFunctionDecl(sourceFile, FN_NAME);
check(`found a FunctionDeclaration named ${FN_NAME} to scan`, !!fnDecl?.body);
if (!fnDecl?.body) { console.log(`\n❌ 1 FAILURE(S) — cannot proceed without the function body.`); process.exit(1); }

const chokepointDecl = findVariableDecl(fnDecl.body, CHOKEPOINT_NAME);
check(`found the ${CHOKEPOINT_NAME} chokepoint's own declaration inside ${FN_NAME}`, !!chokepointDecl);
if (!chokepointDecl) { console.log(`\n❌ 1 FAILURE(S) — cannot proceed without the chokepoint's declaration.`); process.exit(1); }

const excludeStart = chokepointDecl.getStart(sourceFile, false);
const excludeEnd = chokepointDecl.end;

// POSITIVE CONTROL — prove the detector can actually see a violation, not just report zero vacuously.
// Parse a FABRICATED copy of the real source with an extra, aliased reference injected OUTSIDE the
// chokepoint's own declaration, and confirm the SAME counting logic reports a non-zero count there.
const fabricatedSource = stripped.replace(
  `const ${CHOKEPOINT_NAME}`,
  `const _w = ${TARGET_NAME}; const ${CHOKEPOINT_NAME}`,
);
check("(positive control precondition) the fabrication actually changed the source — never a no-op replace", fabricatedSource !== stripped);
const fabricatedSourceFile = ts.createSourceFile("fabricated.ts", fabricatedSource, ts.ScriptTarget.ES2022, true);
const fabricatedFnDecl = findFunctionDecl(fabricatedSourceFile, FN_NAME);
const fabricatedChokepointDecl = findVariableDecl(fabricatedFnDecl.body, CHOKEPOINT_NAME);
const fabricatedCount = countIdentifierRefsOutsideRange(
  fabricatedFnDecl.body, TARGET_NAME,
  fabricatedChokepointDecl.getStart(fabricatedSourceFile, false), fabricatedChokepointDecl.end,
);
check(
  `(positive control) the counting logic detects the injected ALIASED reference in a fabricated copy (found ${fabricatedCount}, expected >= 1)`,
  fabricatedCount >= 1,
);

const realCount = countIdentifierRefsOutsideRange(fnDecl.body, TARGET_NAME, excludeStart, excludeEnd);
check(
  `*** THE INVARIANT (round 4, Lead ruling 1) *** every ${TARGET_NAME} reference inside ${FN_NAME} lives INSIDE the ${CHOKEPOINT_NAME} chokepoint's own declaration — zero references anywhere else (found ${realCount})`,
  realCount === 0,
);

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — every boot-time latch write routes through the single bootWriteLatch chokepoint; no other reference (call or alias) to writeMergeQuarantineLatch exists anywhere else in this function's body."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
