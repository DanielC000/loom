import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source scan
// STANDING GUARD (card 27383e5a) — catches a test-local `class X extends PtyHost` subclass with a
// hardcoded, fictional pid that does NOT override `reapExitedDescendants` to a no-op.
//
// BACKGROUND (card d634cd2e): `PtyHost.reapExitedDescendants(rootPid)` runs an OS-WIDE process-tree
// enumeration + SIGKILL sweep against `rootPid` on every pty exit — real production behavior, needed to
// reap an orphaned descendant (board card 621ef252). `test/_seam-host-fixture.mjs`'s SHARED fake pty
// returns a fixed, fictional `pid: 4242` and overrides this seam to a no-op so hermetic tests never run
// that real sweep against whatever pid 4242 happens to be on the host (harmless on a dev box, but a real
// pid 4242 on Linux CI is plausible — the card 4e762baf flaky-lane class). Card 27383e5a found ~47 OTHER
// test files that define their OWN `class X extends PtyHost` with their own fictional pid, bypassing the
// shared fixture entirely, and migrated every one of them to override the seam directly. This guard is
// the structural backstop so a FUTURE such subclass can't reintroduce the same class of flaky-lane risk.
//
// WHAT THIS IS: a static AST scan (via the `typescript` compiler API — same shape as
// `onexit-discard-guard.mjs`) over `packages/daemon/test/*.mjs` source text. It finds every class
// declaration/expression whose `extends` clause is the BARE identifier `PtyHost` (never
// `createSeamHost(PtyHost)` — a CallExpression heritage clause is structurally a different shape and is
// already safe, since `createSeamHost`'s returned class carries the override), and asserts that class
// also declares a `reapExitedDescendants` member (any spelling: method, arrow property, or function-
// expression property — matched the same way `onexit-discard-guard.mjs` matches `onExit`, since a future
// subclass could spell it any of those ways).
//
// EXEMPTIONS — a small, individually-justified, hand-reviewed allowlist (same posture as
// `onexit-discard-guard.mjs`'s KNOWN_ONEXIT_DISCARD_DEBT / `codescape-privacy-guard.mjs`'s
// KNOWN_LEAKING_FILES): each entry is a file whose `PtyHost` subclass genuinely never runs a fictional-pid
// exit through the real reaper, so the override is either unreachable or actively wrong there. A FUTURE
// addition to this list needs the same per-file audit these five got, not a reflex add to silence a
// finding:
//   - dev-server-teardown.mjs: deliberately wires a REAL spawned process's real pid through `onExit` to
//     prove the real reap works end to end (this card's own DoD: "Keep dev-server-teardown.mjs on the
//     REAL reaper; it is the real-process coverage").
//   - mcp-config-secret-lifecycle.mjs: `NoMcpTokenPtyHost.createPty` delegates to the REAL
//     `super.createPty()` (a real `fake-claude.cmd` wrapper process) — a real OS pid, not a fictional one.
//   - harness-drain-status.mjs / harness-switch-now.mjs: their `PtyHost` subclass's `createPty` THROWS by
//     design (asserts the code path under test must never spawn) — no pty, no exit, no reap ever reachable.
//   - platform-agent-clone.mjs: same shape — `createPty() { throw new Error(...); }`, documented inline as
//     "there is no onExit/kill to share".
//
// Run: node packages/daemon/test/pty-subclass-reap-seam-guard.mjs (no build needed — pure source-text/AST scan)
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(__filename);
const SELF_BASENAME = path.basename(__filename);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// See header for the justification of each entry. Keyed by basename, not a line/snippet — the whole
// FILE is exempted (its PtyHost subclass structurally never reaches the real reaper), not one finding.
const EXEMPT_FILES = new Set([
  "dev-server-teardown.mjs",
  "mcp-config-secret-lifecycle.mjs",
  "harness-drain-status.mjs",
  "harness-switch-now.mjs",
  "platform-agent-clone.mjs",
]);

// ---------------------------------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------------------------------

function getKeyName(member) {
  const key = member.name;
  if (!key) return null;
  if (ts.isIdentifier(key) || ts.isStringLiteral(key)) return key.text ?? key.escapedText?.toString();
  if (ts.isComputedPropertyName(key) && ts.isStringLiteral(key.expression)) return key.expression.text;
  return null;
}

/** Does `cls` declare a `reapExitedDescendants` member, in any of method / arrow-property /
 *  function-expression-property spelling (mirrors `onexit-discard-guard.mjs`'s member-shape coverage —
 *  it doesn't matter HOW it's spelled, only that the seam is overridden at all). */
function declaresReapOverride(cls) {
  for (const member of cls.members) {
    if (getKeyName(member) !== "reapExitedDescendants") continue;
    if (ts.isMethodDeclaration(member)) return true;
    if (ts.isPropertyDeclaration(member) && member.initializer &&
        (ts.isFunctionExpression(member.initializer) || ts.isArrowFunction(member.initializer))) return true;
  }
  return false;
}

/** Is this class's heritage clause the BARE identifier `PtyHost` (not `createSeamHost(PtyHost)` or any
 *  other call/member-expression wrapper, which is a structurally different, already-safe shape)? */
function extendsBarePtyHost(cls) {
  const heritage = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  const expr = heritage?.types?.[0]?.expression;
  return !!expr && ts.isIdentifier(expr) && expr.text === "PtyHost";
}

/**
 * THE ONE traversal — scan a parsed `SourceFile` for `extends PtyHost` subclasses missing the override.
 * Both `scanFile` (real files) and `scanSnippet` (synthetic positive-control text, below) call THIS
 * function, so a control exercises the exact same code path the real scan runs.
 */
function scanSourceFile(sf) {
  const hits = [];
  const visit = (node) => {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && extendsBarePtyHost(node) && !declaresReapOverride(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const name = node.name?.text ?? "<anonymous>";
      hits.push({ line, name });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function scanFile(file) {
  const full = path.join(TEST_DIR, file);
  const text = fs.readFileSync(full, "utf8");
  const sf = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return scanSourceFile(sf).map((h) => ({ file, ...h }));
}

function scanSnippet(text) {
  const sf = ts.createSourceFile("synthetic.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return scanSourceFile(sf);
}

// =====================================================================================================
// POSITIVE / NEGATIVE CONTROL — prove the scanner can actually catch the defect (RED) and correctly
// clears every legitimate shape (GREEN) before trusting a clean result on the real corpus below.
// =====================================================================================================

{
  check(
    "[falsification] catches a class extends PtyHost with NO override at all (method-shorthand createPty, no override)",
    scanSnippet(`class Fake extends PtyHost { createPty() { return { pid: 4242 }; } }`).length === 1
  );
  check(
    "[falsification] catches it even with other unrelated members present",
    scanSnippet(`class Fake extends PtyHost { constructor(e) { super(e); } createPty() { return { pid: 4242 }; } isAlive() { return true; } }`).length === 1
  );

  check(
    "[negative control] clears a class extends PtyHost that DOES override reapExitedDescendants (method)",
    scanSnippet(`class Fake extends PtyHost { reapExitedDescendants(_rootPid) {} createPty() { return { pid: 4242 }; } }`).length === 0
  );
  check(
    "[negative control] clears the arrow-property spelling of the override",
    scanSnippet(`class Fake extends PtyHost { reapExitedDescendants = (_rootPid) => {}; createPty() { return { pid: 4242 }; } }`).length === 0
  );
  check(
    "[negative control] clears the function-expression-property spelling of the override",
    scanSnippet(`class Fake extends PtyHost { reapExitedDescendants = function (_rootPid) {}; createPty() { return { pid: 4242 }; } }`).length === 0
  );

  check(
    "[discriminator] does NOT flag `extends createSeamHost(PtyHost)` — a CallExpression heritage is a different, already-safe shape",
    scanSnippet(`class Fake extends createSeamHost(PtyHost) { createPty(opts) { return super.createPty(opts); } }`).length === 0
  );
  check(
    "[discriminator] does NOT flag a class extending something else entirely named PtyHostSomething",
    scanSnippet(`class Fake extends PtyHostSomething { createPty() { return { pid: 4242 }; } }`).length === 0
  );
  check(
    "[discriminator] does NOT flag a non-PtyHost class that happens to declare createPty",
    scanSnippet(`class Fake extends SomethingElse { createPty() { return { pid: 4242 }; } }`).length === 0
  );
}

// =====================================================================================================
// THE REAL SCAN — every packages/daemon/test/*.mjs file (excluding this guard's own source and the
// shared fixture, which already carries the canonical override).
// =====================================================================================================

const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs") && f !== SELF_BASENAME);
check(`the real corpus scan opened at least one test/*.mjs file (found ${files.length})`, files.length > 0);

const newViolations = [];
for (const file of files) {
  if (EXEMPT_FILES.has(file)) continue;
  for (const hit of scanFile(file)) newViolations.push(hit);
}

check(`every "extends PtyHost" subclass outside the exemption list overrides reapExitedDescendants (found ${newViolations.length} violation(s), scanned ${files.length} files, ${EXEMPT_FILES.size} exempt)`, newViolations.length === 0);
for (const v of newViolations) {
  console.log(`  MISSING OVERRIDE  ${v.file}:${v.line}  class ${v.name}`);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every test-local `extends PtyHost` subclass (outside the documented exemption list) overrides reapExitedDescendants to a no-op."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
