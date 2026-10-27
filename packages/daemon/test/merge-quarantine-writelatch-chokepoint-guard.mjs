// Board card 4e987303 — every writeMergeQuarantineLatch reference in this WHOLE FILE must live inside
// writeLatchAndAdopt's own body (the one call site that adopts a divergent returned entry back into
// memory — see that function's own doc), never a bare call or an aliased reference anywhere else.
// Unlike merge-quarantine-boot-write-chokepoint-guard.mjs (card 97cff6db, scoped to ONE function's body),
// this guard scans the ENTIRE source file — writeMergeQuarantineLatch has call sites spread across many
// unrelated functions, not just one.
// This is a source-text/AST scan (never an import), because the property under test is "which references
// exist in the SOURCE", not runtime behavior any black-box test could observe.
//
// NOT a member of CHANGED_TS_TEXT_SCANNER_REPO_PATHS (worktrees.ts) — this is shape (2) from that list's
// own doc comment: a TS-COMPILER AST-NARROWED extraction anchored on a real DECLARED NAME (found via the
// real parser, not a text search), immune to a comment-only diff by construction, same posture as
// merge-quarantine-boot-write-chokepoint-guard.mjs itself (also not a member, for the same reason).
//
// @decision 4e987303 — comment-stripped first, so a comment mention can never flip the verdict; counts
// IDENTIFIER REFERENCES via the real AST (never a substring match), so an aliased reference is caught too.
//
// Run: node test/merge-quarantine-writelatch-chokepoint-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_PATH = path.join(__dirname, "..", "src", "git", "merge-quarantine.ts");
const TARGET_NAME = "writeMergeQuarantineLatch";
const CHOKEPOINT_NAME = "writeLatchAndAdopt";

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

/** Count every IDENTIFIER reference to `targetName` anywhere in `sourceFile`, EXCLUDING:
 *  (a) `targetName`'s OWN FunctionDeclaration name (its declaration, not a reference to itself), and
 *  (b) anything inside `[excludeStart, excludeEnd)` (the chokepoint's own body range). */
function countIdentifierRefsOutside(sourceFile, targetName, targetDecl, excludeStart, excludeEnd) {
  let count = 0;
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === targetName) {
      if (node === targetDecl.name) return; // the declaration's own name — not a reference
      const pos = node.getStart(undefined, false);
      if (pos < excludeStart || pos >= excludeEnd) count++;
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return count;
}

const rawSource = fs.readFileSync(SRC_PATH, "utf8");
const stripped = stripComments(rawSource);
const sourceFile = ts.createSourceFile("scanned.ts", stripped, ts.ScriptTarget.ES2022, true);

const targetDecl = findFunctionDecl(sourceFile, TARGET_NAME);
check(`found a FunctionDeclaration named ${TARGET_NAME} to scan around`, !!targetDecl);
const chokepointDecl = findFunctionDecl(sourceFile, CHOKEPOINT_NAME);
check(`found the ${CHOKEPOINT_NAME} chokepoint's own declaration`, !!chokepointDecl?.body);
if (!targetDecl || !chokepointDecl?.body) { console.log(`\n❌ FAILURE(S) — cannot proceed without both declarations.`); process.exit(1); }

// @decision 4e987303 — an `export` on the target would let it be imported and called directly from
// OUTSIDE this file (a test, or a future production module), bypassing this whole in-file scan entirely.
const hasExportModifier = (decl) => (decl.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

// POSITIVE CONTROL — prove the export check itself can detect a real export, not just report clean vacuously.
const exportedFabrication = stripped.replace(`function ${TARGET_NAME}`, `export function ${TARGET_NAME}`);
check("(positive control precondition, export check) the fabrication actually changed the source", exportedFabrication !== stripped);
const exportedSourceFile = ts.createSourceFile("exported-fabricated.ts", exportedFabrication, ts.ScriptTarget.ES2022, true);
const exportedTargetDecl = findFunctionDecl(exportedSourceFile, TARGET_NAME);
check(
  "(positive control) the export check detects an injected `export` on a fabricated copy",
  !!exportedTargetDecl && hasExportModifier(exportedTargetDecl),
);

check(
  `*** THE INVARIANT *** ${TARGET_NAME}'s own declaration carries NO export modifier (module-private)`,
  !hasExportModifier(targetDecl),
);

const excludeStart = chokepointDecl.body.getStart(sourceFile, false);
const excludeEnd = chokepointDecl.body.end;

// POSITIVE CONTROL — prove the detector can actually see a violation, not just report zero vacuously.
// Parse a FABRICATED copy of the real source with an extra, aliased reference injected OUTSIDE the
// chokepoint's own body, and confirm the SAME counting logic reports a non-zero count there.
const fabricatedSource = stripped.replace(
  `function ${CHOKEPOINT_NAME}`,
  `const _w = ${TARGET_NAME}; function ${CHOKEPOINT_NAME}`,
);
check("(positive control precondition) the fabrication actually changed the source — never a no-op replace", fabricatedSource !== stripped);
const fabricatedSourceFile = ts.createSourceFile("fabricated.ts", fabricatedSource, ts.ScriptTarget.ES2022, true);
const fabricatedTargetDecl = findFunctionDecl(fabricatedSourceFile, TARGET_NAME);
const fabricatedChokepointDecl = findFunctionDecl(fabricatedSourceFile, CHOKEPOINT_NAME);
const fabricatedCount = countIdentifierRefsOutside(
  fabricatedSourceFile, TARGET_NAME, fabricatedTargetDecl,
  fabricatedChokepointDecl.body.getStart(fabricatedSourceFile, false), fabricatedChokepointDecl.body.end,
);
check(
  `(positive control) the counting logic detects the injected ALIASED reference in a fabricated copy (found ${fabricatedCount}, expected >= 1)`,
  fabricatedCount >= 1,
);

const realCount = countIdentifierRefsOutside(sourceFile, TARGET_NAME, targetDecl, excludeStart, excludeEnd);
check(
  `*** THE INVARIANT (card 4e987303) *** every ${TARGET_NAME} reference in this file lives INSIDE ${CHOKEPOINT_NAME}'s own body — zero references anywhere else (found ${realCount})`,
  realCount === 0,
);

console.log(failures === 0
  ? `\n✅ ALL CHECKS PASS — every ${TARGET_NAME} write routes through the single ${CHOKEPOINT_NAME} chokepoint; no other reference (call or alias) exists anywhere else in this file.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
