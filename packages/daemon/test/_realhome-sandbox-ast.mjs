// Shared AST machinery for a "does this test sandbox a real-homedir env var before its first dist
// import" guard (card 7f2263fd, factored out of transcript-realhome-sandbox-guard.mjs so a sibling guard
// — e.g. codex-transcript-realhome-sandbox-guard.mjs — reuses it rather than duplicating it). Nothing in
// this file knows about any SPECIFIC env var, function name, or allowlist — that stays in each guard.
//
// Underscore-prefixed (not a test itself — scripts/test-daemon.mjs's own discovery walk excludes any
// path with an underscore-prefixed segment).
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Parse `text` into a TS SourceFile. */
export function parseSource(text) {
  return ts.createSourceFile("x.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

export function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** The raw `import("<spec>")` CallExpression's own string-literal spec, or null. Shared by the static
 *  and dynamic binding collectors below. */
export function importCallSpec(node) {
  if (!node || !ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  const arg = node.arguments[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

/** Every import binding DECLARED DIRECTLY inside `scope`'s own statement list (never a deeper-nested
 *  one — that is a DIFFERENT scope, resolved separately by the caller) — covering a static named import
 *  (`import { X [as Y] } from "spec"`), a static namespace import (`import * as T from "spec"`), and the
 *  dynamic destructure/namespace shape every hermetic test in this corpus actually uses (`const { X [:
 *  Y] } = await import("spec")` / `const T = await import("spec")`, awaited or not). Each entry is
 *  `{name, realName, spec, pos}` — `name` is the LOCAL binding identifier actually referenced at a call
 *  site; `realName` is the ORIGINAL exported name (`propertyName ?? name` for a named/destructured
 *  binding — equal to `name` when there's no alias; `null` for a whole-module namespace binding, which
 *  has no single "real name" of its own); `pos` is the declaring STATEMENT's own start offset, used by
 *  the caller to pick the nearest PRECEDING declaration within this same scope — never a single
 *  whole-file last-seen-wins map, which can misattribute a call to a binding that is lexically out of
 *  scope for it, or that is declared AFTER it. */
export function directBindingDeclsInScope(scope) {
  const decls = [];
  for (const stmt of scope.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteralLike(stmt.moduleSpecifier) && stmt.importClause) {
      const nb = stmt.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          decls.push({ name: el.name.text, realName: (el.propertyName ?? el.name).text, spec: stmt.moduleSpecifier.text, pos: stmt.getStart() });
        }
      } else if (nb && ts.isNamespaceImport(nb)) {
        decls.push({ name: nb.name.text, realName: null, spec: stmt.moduleSpecifier.text, pos: stmt.getStart() });
      }
    }
    if (ts.isVariableStatement(stmt)) {
      for (const declNode of stmt.declarationList.declarations) {
        if (!declNode.initializer) continue;
        const init = ts.isAwaitExpression(declNode.initializer) ? declNode.initializer.expression : declNode.initializer;
        const spec = importCallSpec(init);
        if (!spec) continue;
        if (ts.isObjectBindingPattern(declNode.name)) {
          for (const el of declNode.name.elements) {
            if (ts.isIdentifier(el.name)) decls.push({ name: el.name.text, realName: (el.propertyName ?? el.name).text, spec, pos: stmt.getStart() });
          }
        } else if (ts.isIdentifier(declNode.name)) {
          decls.push({ name: declNode.name.text, realName: null, spec, pos: stmt.getStart() });
        }
      }
    }
  }
  return decls;
}

/** The nearest enclosing lexical-scope boundary (a Block or the SourceFile itself) strictly ABOVE
 *  `node` — i.e. starts the walk from `node.parent`, never `node` itself. */
export function findEnclosingScope(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isSourceFile(cur) || ts.isBlock(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** Resolve the binding `localName` refers to AT `fromNode` — walks outward through `fromNode`'s own
 *  enclosing-scope chain (innermost Block first, then each Block/SourceFile above it), and within each
 *  scope picks the declaration with the LARGEST `pos` that still precedes `fromNode`'s own start (the
 *  closest PRECEDING declaration actually in scope there) — never a single global last-seen-wins map.
 *  Returns the matching decl `{name, realName, spec, pos}`, or `null` if no in-scope, preceding
 *  declaration of that name exists anywhere up the chain. */
export function resolveBinding(fromNode, localName) {
  const fromPos = fromNode.getStart();
  let node = fromNode;
  while (true) {
    const scope = findEnclosingScope(node);
    if (!scope) return null;
    const decls = directBindingDeclsInScope(scope).filter((d) => d.name === localName && d.pos < fromPos);
    if (decls.length) {
      decls.sort((a, b) => b.pos - a.pos);
      return decls[0];
    }
    node = scope;
    if (ts.isSourceFile(scope)) return null; // already at the top — nowhere further to climb
  }
}

/** Every static `import ... from "<spec>"` whose spec contains "dist/", as `{spec, line}`. */
export function findStaticDistImports(sf) {
  const hits = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text.includes("dist/")) {
      hits.push({ spec: node.moduleSpecifier.text, line: lineOf(sf, node) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits;
}

/** Every dynamic `import("<spec>")` call whose spec contains "dist/", as `{spec, line}`. */
export function findDynamicDistImports(sf) {
  const hits = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg) && arg.text.includes("dist/")) {
        hits.push({ spec: arg.text, line: lineOf(sf, node) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits;
}

export const FUNCTION_LIKE_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
]);
/** True if `node` sits inside any function/method/accessor body. Used to require an env-override to be
 *  a genuinely TOP-LEVEL, unconditionally-executed statement — a caller compares source line ORDER, not
 *  execution, so an override sitting inside a function this guard has no way to prove is ever actually
 *  CALLED must never count. */
export function isInsideFunctionLike(node) {
  let cur = node.parent;
  while (cur) {
    if (FUNCTION_LIKE_KINDS.has(cur.kind)) return true;
    cur = cur.parent;
  }
  return false;
}

/** Every static `import ... from "<spec>"` in `sf` whose spec is a LOCAL relative helper (starts with
 *  "./" or "../", excluding "../dist/..." itself — {@link findStaticDistImports} already covers that
 *  directly — and excluding any spec ending in one of `excludeSpecSuffixes`, a caller-owned list of its
 *  OWN known-safe shared-fixture-helper modules) that ITSELF, read from disk relative to `baseDir`,
 *  carries a static import of something under "dist/" — a ONE-LEVEL-DEEP transitive hoisted dist import
 *  reached via a local wrapper/re-export helper. Returns `{spec, line, transitiveSpec}` for the first
 *  offending helper found, or `null`. An unreadable/unresolvable helper path is silently skipped — this
 *  check's job is to catch a transitive hazard it CAN see, never to validate every relative import path
 *  resolves. */
export function findTransitiveStaticDistImport(sf, baseDir, excludeSpecSuffixes = []) {
  const localHelperImports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const isLocalHelper = (spec.startsWith("./") || spec.startsWith("../")) && !spec.includes("dist/")
        && !excludeSpecSuffixes.some((suffix) => spec.endsWith(suffix));
      if (isLocalHelper) localHelperImports.push({ spec, line: lineOf(sf, node) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  for (const helperImport of localHelperImports) {
    let helperText;
    try { helperText = fs.readFileSync(path.join(baseDir, helperImport.spec), "utf8"); } catch { continue; }
    const helperStaticDist = findStaticDistImports(parseSource(helperText));
    if (helperStaticDist.length > 0) {
      return { spec: helperImport.spec, line: helperImport.line, transitiveSpec: helperStaticDist[0].spec };
    }
  }
  return null;
}
