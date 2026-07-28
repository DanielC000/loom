import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure fs/AST below, no Db used
// Card ef2fe628 — durability guard, not a behavior change. Origin: a Code Reviewer Minor on card
// `088afc94`'s P4 wiring branch: `088afc94` threads `repoPath` (always `project.repoPath`, never
// `targetRepo.path` — the multi-repo invariant is "one codescape graph per project, always the PRIMARY
// repo", documented in a sessions/service.ts comment from c835de5) onto `this.pty.spawn(...)` as an
// OPTIONAL SpawnOpts field across every codescape-enabled call site. Optional + caller-supplied means
// the NEXT spawn site added can silently omit it — no compile error, no runtime failure, just a session
// that quietly gets no codescape MCP mount. Two options were on the table (restructure SpawnOpts with a
// `getProjectRepoPath` seam vs. a guard test); the owner-equivalent decision (relayed via this card's
// kickoff) settled on the guard test as the cheaper fix for a problem that hasn't happened yet — the
// spawn path is load-bearing (CLAUDE.md) and a structural seam touches it for zero current benefit.
//
// This test finds every `this.pty.spawn(` call site in the COMPILED sessions/service.js by its REAL
// syntax-tree shape (card fdf93d3a's pattern, same as gateway-token.mjs / project-memory-version-guard.mjs)
// — never a fixed character window or a plain-text regex grep, both of which silently stop matching the
// moment the surrounding code reflows. For every site that passes `codescapeEnabled`, it asserts `repoPath`
// is ALSO passed, and that its value is the literal primary-repo expression `project.repoPath` — never
// `targetRepo.path` or anything else. `startRun` is the one deliberate, NAMED exclusion (role:"run" makes
// `buildMcpServers` hard-return before any codescape logic — see pty/host.ts's `role === "run"` branch,
// independently verified below to still exist and still precede the codescape gate).
//
// NON-VACUOUS BY CONSTRUCTION: every assertion below is a LOWER BOUND on how many real sites/matches it
// expects, with a message stating that expectation — a matcher that silently stopped matching (a renamed
// method, a changed call shape, a moved file) fails loudly here instead of reporting a cheerful, empty green.
//
// RED-FIRST evidence (not re-run by this file — see the card's worker report): a temporary edit that
// stripped `repoPath: project.repoPath,` from one real call site (recycleManager) while leaving
// `codescapeEnabled` in place reproducibly failed the "every codescapeEnabled site also passes repoPath"
// check below, naming that exact method + line; reverting the edit and rebuilding restored a clean pass.
//
// Run: 1) build (turbo builds shared first — this reads packages/daemon/dist AND packages/shared isn't
// needed here), 2) node test/codescape-spawn-repopath-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");

// ===================== structural helpers (AST, not text) =====================

/** Is `node` a `this.pty.spawn(...)` call expression? Matches the callee shape exactly — never a bare
 *  text search for "pty.spawn(", which would also match e.g. a comment or an unrelated `.pty.spawn`. */
function isThisPtySpawnCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "spawn") return false;
  const mid = callee.expression;
  if (!ts.isPropertyAccessExpression(mid) || mid.name.text !== "pty") return false;
  return mid.expression.kind === ts.SyntaxKind.ThisKeyword;
}

/** Nearest enclosing class-method name for `node` (walks up `.parent`), or null if none. Correctly
 *  skips over nested arrow functions / if-blocks / catch-blocks — it only stops at a real MethodDeclaration,
 *  so a spawn call nested inside a callback still attributes to the OUTER method that owns `this`. */
function enclosingMethodName(node, sourceFile) {
  let cur = node.parent;
  while (cur) {
    if (ts.isMethodDeclaration(cur) && cur.name) return cur.name.getText(sourceFile);
    cur = cur.parent;
  }
  return null;
}

/** Find a named property (either `name: value` or shorthand `name`) in an object literal. */
function findObjectProperty(obj, name) {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) return p;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p;
  }
  return null;
}

/** The source text of a property's VALUE — the initializer for `name: value`, or the identifier itself
 *  for a shorthand `name`. Null if the property is absent. */
function propertyValueText(prop, sourceFile) {
  if (!prop) return null;
  if (ts.isPropertyAssignment(prop)) return prop.initializer.getText(sourceFile);
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name.getText(sourceFile);
  return null;
}

/** Find an exported top-level FUNCTION's body text by name (buildMcpServers is a function, not a class
 *  method — classMethodBodyText's sibling for the non-class case). */
function functionBodyText(sourceFile, fnName) {
  let found;
  const visit = (node) => {
    if (!found && ts.isFunctionDeclaration(node) && node.name?.text === fnName && node.body) found = node.body;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found ? found.getText(sourceFile) : null;
}

// ===================== gather every this.pty.spawn( site in sessions/service.js =====================

const servicePath = path.join(distDir, "sessions", "service.js");
const serviceSrc = fs.readFileSync(servicePath, "utf8");
const serviceSourceFile = ts.createSourceFile(servicePath, serviceSrc, ts.ScriptTarget.Latest, /* setParentNodes */ true);

const sites = [];
(function visit(node) {
  if (isThisPtySpawnCall(node)) {
    const { line } = serviceSourceFile.getLineAndCharacterOfPosition(node.getStart(serviceSourceFile));
    const arg = node.arguments[0];
    const isObjectLiteral = !!arg && ts.isObjectLiteralExpression(arg);
    const codescapeEnabledProp = isObjectLiteral ? findObjectProperty(arg, "codescapeEnabled") : null;
    const repoPathProp = isObjectLiteral ? findObjectProperty(arg, "repoPath") : null;
    sites.push({
      line: line + 1,
      method: enclosingMethodName(node, serviceSourceFile),
      isObjectLiteral,
      hasCodescapeEnabled: !!codescapeEnabledProp,
      repoPathText: isObjectLiteral ? propertyValueText(repoPathProp, serviceSourceFile) : undefined,
      hasRepoPath: !!repoPathProp,
    });
  }
  ts.forEachChild(node, visit);
})(serviceSourceFile);

// ===================== (1) non-vacuous: the matcher must actually find real call sites =====================
check(
  `at least 14 \`this.pty.spawn(\` call sites found in sessions/service.js (found ${sites.length}) — a drop ` +
    "below 14 means this AST matcher stopped finding real call sites (a renamed method, a changed call " +
    "shape, or the file moving), which would otherwise let every check below pass vacuously",
  sites.length >= 14
);

// Every matched site's sole argument must actually be a plain object literal — a call passing a spread or
// a variable instead would silently defeat property detection below rather than surfacing as a violation.
const malformed = sites.filter((s) => !s.isObjectLiteral);
if (malformed.length) {
  for (const m of malformed) console.log(`  MALFORMED  ${m.method ?? "<unknown method>"} @ line ${m.line}: spawn's argument is not a plain object literal — cannot structurally verify its properties`);
}
check(
  `every matched \`this.pty.spawn(\` call passes a plain object-literal argument (found ${malformed.length} that don't)`,
  malformed.length === 0
);

// ===================== (2) startRun: a DELIBERATE, NAMED exclusion, not an incidental miss =====================
const startRunSites = sites.filter((s) => s.method === "startRun");
check(
  `exactly one \`this.pty.spawn(\` call site found inside startRun (found ${startRunSites.length}) — startRun ` +
    'is EXCLUDED from the codescape repoPath invariant below because its role:"run" makes buildMcpServers ' +
    'hard-return {loom-run} before any codescape logic ever runs (pty/host.ts\'s `role === "run"` branch, ' +
    "re-verified below to still exist and still precede the codescape gate); a count other than 1 means " +
    "startRun's shape or name changed and this exclusion needs re-checking, not silently carrying forward",
  startRunSites.length === 1
);
if (startRunSites.length === 1) {
  check(
    "startRun's own spawn call currently passes NO codescapeEnabled at all (today's deliberate state) — " +
      "if a future change ever adds codescapeEnabled to startRun's spawn, the general invariant check " +
      "below (section 4) will correctly start demanding a repoPath too, rather than silently exempting it forever",
    startRunSites[0].hasCodescapeEnabled === false
  );
}

// Structural backstop for WHY startRun is excluded: buildMcpServers must still hard-return on role==="run"
// BEFORE it ever reaches the codescape gate — if this ordering regresses, startRun's exclusion above is no
// longer justified and this test should fail rather than staying silently green.
const hostPath = path.join(distDir, "pty", "host.js");
const hostSrc = fs.readFileSync(hostPath, "utf8");
const hostSourceFile = ts.createSourceFile(hostPath, hostSrc, ts.ScriptTarget.Latest, /* setParentNodes */ true);
const buildMcpServersBody = functionBodyText(hostSourceFile, "buildMcpServers");
check("buildMcpServers is found in pty/host.js (structural backstop for startRun's exclusion)", buildMcpServersBody !== null);
if (buildMcpServersBody !== null) {
  const runReturnIdx = buildMcpServersBody.indexOf('role === "run"');
  const codescapeGateIdx = buildMcpServersBody.indexOf("codescapeEnabled");
  check(
    'buildMcpServers\'s `role === "run"` hard-return still precedes any codescapeEnabled gate logic — the ' +
      "reason startRun is safely excluded from the invariant above (a run session can never reach the " +
      "codescape mount branch at all, so it structurally cannot need repoPath)",
    runReturnIdx !== -1 && codescapeGateIdx !== -1 && runReturnIdx < codescapeGateIdx
  );
}

// ===================== (3) non-vacuous: the 13 non-startRun sites must actually exist and use the flag =====================
const regularSites = sites.filter((s) => s.method !== "startRun");
check(
  `at least 13 non-startRun \`this.pty.spawn(\` call sites found (found ${regularSites.length})`,
  regularSites.length >= 13
);
const regularWithCodescapeEnabled = regularSites.filter((s) => s.hasCodescapeEnabled);
check(
  `at least 13 of them currently pass codescapeEnabled (found ${regularWithCodescapeEnabled.length}) — ` +
    "today's known-good state (verified against card ef2fe628's own count); a drop here means the matcher " +
    "is failing to recognize real codescapeEnabled usages, which would silently empty out check (4) below",
  regularWithCodescapeEnabled.length >= 13
);

// ===================== (4) THE GUARD: codescapeEnabled ⇒ repoPath === project.repoPath, always =====================
const violations = [];
for (const s of sites) {
  if (!s.hasCodescapeEnabled) continue; // startRun and any future non-codescape site: nothing to check
  if (!s.hasRepoPath) {
    violations.push(`${s.method ?? "<unknown method>"} @ line ${s.line}: passes codescapeEnabled but OMITS repoPath entirely`);
    continue;
  }
  if (s.repoPathText !== "project.repoPath") {
    violations.push(`${s.method ?? "<unknown method>"} @ line ${s.line}: repoPath is \`${s.repoPathText}\`, not the primary-repo \`project.repoPath\` (multi-repo invariant violated — codescape indexes ONE graph per project, always the primary repo, never e.g. targetRepo.path)`);
  }
}
if (violations.length) {
  for (const v of violations) console.log(`  VIOLATION  ${v}`);
}
check(
  "every `this.pty.spawn(` site that passes codescapeEnabled ALSO passes `repoPath: project.repoPath`" +
    (violations.length ? ` — ${violations.length} violation(s), see above` : ""),
  violations.length === 0
);

console.log(
  failures === 0
    ? "\n✅ ALL PASS — every `this.pty.spawn(` site in sessions/service.js that passes codescapeEnabled also " +
        "passes repoPath: project.repoPath (never a different repo); startRun is verified as the one deliberate, " +
        "structurally-justified exclusion; and every assertion above is a non-vacuous lower bound, so a matcher " +
        "that stopped finding real call sites would fail loudly here rather than passing empty."
    : `\n❌ ${failures} FAILURE(S).`
);
process.exit(failures === 0 ? 0 : 1);
