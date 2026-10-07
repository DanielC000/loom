// Board card fd189d91, item (c): a TEST-ONLY injection seam (e.g.
// `reenterMergeQuarantinesAtBootTestOnly`, merge-quarantine.ts) is only as "structurally unreachable from
// production" as the claim that nothing under `packages/daemon/src/**` ever imports it — a claim no prior
// guard actually checked. This guard checks it mechanically, for ANY export whose name ends in
// `TestOnly`, not just the one named example — so a FUTURE test-only seam gets the same protection without
// a new guard having to be written for it.
//
// AST scan (TypeScript compiler API) over the RAW source, never a text/regex match and never a
// comment-strip pre-pass — a bare `import ... from "..."` string search would miss an ALIASED import
// (`import { fooTestOnly as bar }`), but comment-stripping via `ts.transpileModule` first (the
// chokepoint-guard's own technique) is actively WRONG here, not merely unnecessary: transpileModule's
// isolated-module emit silently ELIDES an import with no corresponding value usage anywhere in the file —
// exactly the shape a bare, never-yet-called `*TestOnly` import can have, which would make this guard
// report a false "no violation" on the one case most worth catching. No stripping is needed anyway: a
// comment is lexer TRIVIA, never a real `ImportDeclaration` statement node, so scanning `sourceFile.
// statements` directly already can't match a commented-out import (verified below).
//
// SCOPE: every `packages/daemon/src/**/*.ts` file's own top-level `ImportDeclaration` NAMED-IMPORT
// specifiers (`import { x } from "..."` / `import { x as y } from "..."`) only. Does NOT see: a
// namespace import used via property access (`import * as ns from "..."; ns.fooTestOnly()`); a
// re-export (`export { fooTestOnly } from "..."`, which never produces an `ImportDeclaration` at all); or
// a dynamic `await import("...")`/`require(...)` call, computed or not. None of these shapes is used
// anywhere in this codebase for this purpose today, so a green run here is a claim about the NAMED-IMPORT
// shape specifically — not a proof that no `packages/daemon/src/**` file can EVER reach a `*TestOnly`
// export by any means.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");
const TEST_ONLY_SUFFIX_RE = /TestOnly$/;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every `*TestOnly`-suffixed name a file's own top-level import declarations name — resolved via the
 *  specifier's ORIGINAL imported name (`propertyName` when aliased, else `name`), never the local alias
 *  a `import { fooTestOnly as bar }` form binds it to. */
function testOnlyImportsIn(sourceFile) {
  const hits = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const bindings = stmt.importClause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const spec of bindings.elements) {
      const importedName = (spec.propertyName ?? spec.name).text;
      if (TEST_ONLY_SUFFIX_RE.test(importedName)) {
        hits.push({ importedName, pos: spec.getStart(sourceFile, false) });
      }
    }
  }
  return hits;
}

const files = walk(SRC_DIR, []);
check(`the real corpus scan opened at least one src/**/*.ts file (found ${files.length})`, files.length > 0);

// POSITIVE CONTROL — prove the detector can actually see a violation, not just report zero vacuously.
// Fabricate a throwaway import of a `*TestOnly` name and confirm the SAME detection logic catches it.
const fabricated = `import { reenterMergeQuarantinesAtBootTestOnly } from "./git/merge-quarantine.js";\nexport const x = 1;\n`;
const fabricatedSourceFile = ts.createSourceFile("fabricated.ts", fabricated, ts.ScriptTarget.ES2022, true);
const fabricatedHits = testOnlyImportsIn(fabricatedSourceFile);
check(`(positive control) the detector catches a fabricated *TestOnly import (found ${fabricatedHits.length}, expected >= 1)`, fabricatedHits.length >= 1);

// Aliased-import sanity — an `import { fooTestOnly as bar }` form must still be caught via the ORIGINAL
// (propertyName) name, never missed because the LOCAL binding "bar" doesn't itself end in "TestOnly".
const aliasedFixture = `import { fooTestOnly as bar } from "./x.js";\n`;
const aliasedSourceFile = ts.createSourceFile("aliased.ts", aliasedFixture, ts.ScriptTarget.ES2022, true);
const aliasedHits = testOnlyImportsIn(aliasedSourceFile);
check(`(sanity) an aliased \`fooTestOnly as bar\` import is still caught via its ORIGINAL name (found ${aliasedHits.length}, expected >= 1)`, aliasedHits.length >= 1);

// Negative-control sanity — an ordinary import of a name that merely CONTAINS, but does not END IN,
// "TestOnly" must never false-positive (e.g. a hypothetical `testOnlyish` helper).
const negativeFixture = `import { testOnlyishHelper } from "./x.js";\n`;
const negativeSourceFile = ts.createSourceFile("negative.ts", negativeFixture, ts.ScriptTarget.ES2022, true);
const negativeHits = testOnlyImportsIn(negativeSourceFile);
check(`(negative control) an import NOT ending in "TestOnly" is never flagged (found ${negativeHits.length}, expected 0)`, negativeHits.length === 0);

// Comment-immunity sanity — a COMMENTED-OUT import must never be mistaken for a real one, AND a real,
// genuinely UNUSED *TestOnly import (no call site anywhere in the same file) must still be caught — the
// exact shape a comment-stripping pre-pass would silently elide (see the header note above).
const commentFixture = `// import { reenterMergeQuarantinesAtBootTestOnly } from "./x.js";\nimport { reallyUnusedTestOnly } from "./y.js";\nexport const x = 1;\n`;
const commentSourceFile = ts.createSourceFile("comment.ts", commentFixture, ts.ScriptTarget.ES2022, true);
const commentHits = testOnlyImportsIn(commentSourceFile);
check(
  `(sanity) a commented-out import is ignored while a real, UNUSED *TestOnly import is still caught (found ${commentHits.length} hit(s), expected exactly 1, named ${JSON.stringify(commentHits.map((h) => h.importedName))})`,
  commentHits.length === 1 && commentHits[0].importedName === "reallyUnusedTestOnly",
);

const violations = [];
for (const file of files) {
  const rel = path.relative(SRC_DIR, file).replace(/\\/g, "/");
  const raw = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(rel, raw, ts.ScriptTarget.ES2022, true);
  for (const hit of testOnlyImportsIn(sourceFile)) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(hit.pos);
    violations.push({ file: rel, lineNo: line + 1, importedName: hit.importedName });
  }
}

check(`no packages/daemon/src/**/*.ts file imports a *TestOnly export (found ${violations.length})`, violations.length === 0);
for (const v of violations) console.log(`  VIOLATION  ${v.file}:${v.lineNo}  imports ${v.importedName}`);

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — no production src/** file NAMED-IMPORTS a *TestOnly export (see the header's own SCOPE note for the shapes this does NOT see — a namespace-import property access, a re-export, or a dynamic import)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
