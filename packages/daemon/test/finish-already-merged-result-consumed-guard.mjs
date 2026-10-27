import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure AST scan below, no Db used
// STANDING CHOKEPOINT GUARD (card e8e98d43, docs/decisions/e8e98d43-*.md — read it for the full
// narrative, including the CR finding that an earlier text-based version of this guard could both
// false-RED and be flipped by a comment-only edit). Asserts, via a REAL AST walk (`ts.createSourceFile`
// — shape 2 of `CHANGED_TS_TEXT_SCANNER_REPO_PATHS`'s own doc, hence not a member of either reduced-gate
// list; see the record for which exclusion ground applies to each), that every real
// `this.finishAlreadyMerged(` call site in `sessions/service.ts` genuinely consumes the result: a
// return/arrow-return, a binding later read via `.merged`, or a destructure including `merged` — never a
// bare discarded statement, an omitted-`merged` destructure, an unused binding, or a zero-param `.then(`.
//
// NAMED LIMITS (card d240fceb, m4) — this guard does NOT catch every way the result could be discarded:
// - `findFinishAlreadyMergedCalls` matches ONLY a literal `this.finishAlreadyMerged(` receiver — a
//   `.bind(this)`-produced alias, a computed `this["finishAlreadyMerged"](`, or a renamed receiver (e.g.
//   `const self = this; self.finishAlreadyMerged(...)`) is invisible to it entirely. None of the real
//   call sites use any of these shapes today; a future one adopting one would need its own check.
// - `identifierLaterReadsMerged` is SCOPE-BLIND BY DESIGN (see its own doc) — it matches `<name>.merged`
//   anywhere later in the WHOLE file by name alone, not by actual binding/scope. A same-named but
//   unrelated local in a different function would falsely satisfy this guard for an otherwise-unused
//   binding.
// - A `.then(cb)` whose callback takes a parameter is accepted (`"then-with-param"`) WITHOUT checking
//   whether that parameter is ever actually read in the callback body — see the comment at that branch.
//   `.then((r) => {})` (parameter declared, never used) passes this guard exactly like a genuine consumer.
// These are accepted, documented gaps, not a baseline to silence a real finding against — tighten the
// check (or escalate) rather than adding a new call site to an allowlist.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");
const SERVICE_TS = path.join(SRC_DIR, "sessions", "service.ts");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

/** Every `this.finishAlreadyMerged(` CallExpression in `sourceFile`, in source order. AST-matched (a
 *  PropertyAccessExpression whose receiver is literally `this` and whose member name is the method), so a
 *  comment or line break anywhere near the call can never hide or fabricate a match. */
function findFinishAlreadyMergedCalls(sourceFile) {
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.name.text === "finishAlreadyMerged") {
      out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** True iff `<name>.merged` (a PropertyAccessExpression on a bare identifier) appears ANYWHERE in
 *  `sourceFile` starting at or after `fromPos` — a simple, sufficient "is this binding's .merged field
 *  ever read" check for this single-file, single-pattern guard; never a generalized data-flow analysis. */
function identifierLaterReadsMerged(sourceFile, name, fromPos) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (node.getStart(sourceFile) >= fromPos && ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) && node.expression.text === name && node.name.text === "merged") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Classifies how ONE `this.finishAlreadyMerged(...)` CallExpression's resolved value is consumed.
 *  Returns {ok, reason} — `ok:false` is a violation; `reason` is a short, stable tag for reporting. */
function classifyConsumption(sourceFile, callExpr) {
  let node = callExpr;
  let parent = node.parent;
  if (ts.isAwaitExpression(parent) && parent.expression === node) { node = parent; parent = node.parent; }

  if (ts.isReturnStatement(parent)) return { ok: true, reason: "return" };
  if (ts.isArrowFunction(parent) && parent.body === node) return { ok: true, reason: "arrow-implicit-return" };

  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    if (ts.isObjectBindingPattern(parent.name)) {
      const hasMerged = parent.name.elements.some((el) => {
        const propName = el.propertyName ?? el.name;
        return ts.isIdentifier(propName) && propName.text === "merged";
      });
      return hasMerged ? { ok: true, reason: "destructure-includes-merged" } : { ok: false, reason: "destructure-omits-merged" };
    }
    if (ts.isIdentifier(parent.name)) {
      const used = identifierLaterReadsMerged(sourceFile, parent.name.text, parent.getEnd());
      return used ? { ok: true, reason: "binding-later-reads-merged" } : { ok: false, reason: "unused-binding" };
    }
    return { ok: false, reason: "unrecognized-binding-pattern" };
  }

  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) {
    if (ts.isIdentifier(parent.left)) {
      const used = identifierLaterReadsMerged(sourceFile, parent.left.text, parent.getEnd());
      return used ? { ok: true, reason: "reassignment-later-reads-merged" } : { ok: false, reason: "unused-binding" };
    }
    return { ok: false, reason: "unrecognized-assignment-target" };
  }

  // `<call>.then(cb)` with a ZERO-PARAMETER callback discards the resolved value outright — the CR's
  // "at minimum catch a .then(() => ...)-discarding" ask. A `.then` whose callback DOES take a parameter
  // is accepted here without inspecting that parameter's own body further (the CR's own "at minimum"
  // framing does not ask for a second level of data-flow analysis, and none of the real call sites use
  // this shape today).
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "then") {
    const outerCall = parent.parent;
    if (outerCall && ts.isCallExpression(outerCall) && outerCall.expression === parent) {
      const cb = outerCall.arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters.length === 0) {
        return { ok: false, reason: "then-discards-zero-param-callback" };
      }
      return { ok: true, reason: "then-with-param" };
    }
  }

  // The bare, unconsumed statement — the ORIGINAL bug shape this guard exists to catch.
  if (ts.isExpressionStatement(parent) && parent.expression === node) {
    return { ok: false, reason: "bare-discarded-statement" };
  }

  return { ok: false, reason: "unrecognized-shape" };
}

// ── RED CONTROL — a synthetic in-memory snippet shaped exactly like the bug, parsed through the SAME
// real AST path the file scan below uses (not just the classifier called on a hand-built node). Also
// covers the CR's two false-RED/comment specimens: a call split across lines, and an inline block comment
// between the consuming keyword and the call — both must classify as CONSUMED (not flagged), proving the
// hardening actually closed both gaps rather than just moving the bug.
const redSnippet = `
class Bogus {
  async bogus() {
    await this.finishAlreadyMerged({ foo: 1 });
    return;
  }
  async splitAcrossLines() {
    const amResult =
      await this.finishAlreadyMerged({ foo: 1 });
    return amResult.merged;
  }
  async inlineCommentBetween() {
    return /* a harmless comment */ this.finishAlreadyMerged({ foo: 1 });
  }
  async destructureOmitsMerged() {
    const { reason } = await this.finishAlreadyMerged({ foo: 1 });
    return reason;
  }
  async thenDiscards() {
    this.finishAlreadyMerged({ foo: 1 }).then(() => {});
  }
}`;
{
  const redSource = ts.createSourceFile("red.ts", redSnippet, ts.ScriptTarget.Latest, true);
  const redCalls = findFinishAlreadyMergedCalls(redSource);
  check(`RED CONTROL: found exactly 5 synthetic call sites (found ${redCalls.length})`, redCalls.length === 5);
  const redVerdicts = redCalls.map((c) => classifyConsumption(redSource, c));
  check("RED CONTROL: the bare discarded statement is caught", redVerdicts[0]?.ok === false && redVerdicts[0]?.reason === "bare-discarded-statement");
  check("RED CONTROL (CR fix #1): a call split across lines is NOT a false RED — correctly classified consumed", redVerdicts[1]?.ok === true);
  check("RED CONTROL (CR fix #2): an inline block comment between `return` and the call does NOT flip the verdict", redVerdicts[2]?.ok === true);
  check("RED CONTROL: a destructure omitting `merged` is caught", redVerdicts[3]?.ok === false && redVerdicts[3]?.reason === "destructure-omits-merged");
  check("RED CONTROL: a `.then(() => {})` zero-param discard is caught", redVerdicts[4]?.ok === false && redVerdicts[4]?.reason === "then-discards-zero-param-callback");
}

// ── GREEN CONTROL — the same shapes real call sites in this codebase actually use, for symmetry (a
// detector that only ever reports "bad" was never shown it can also say "fine").
{
  const greenSnippet = `
  class Fine {
    async a() { return this.finishAlreadyMerged({}); }
    async b() { const r = await this.finishAlreadyMerged({}); if (r.merged === false) return r; }
    async c() { const { merged, reason } = await this.finishAlreadyMerged({}); return merged && reason; }
  }`;
  const greenSource = ts.createSourceFile("green.ts", greenSnippet, ts.ScriptTarget.Latest, true);
  const greenCalls = findFinishAlreadyMergedCalls(greenSource);
  check(`GREEN CONTROL: found exactly 3 synthetic call sites (found ${greenCalls.length})`, greenCalls.length === 3);
  const greenVerdicts = greenCalls.map((c) => classifyConsumption(greenSource, c));
  check("GREEN CONTROL: all three real-world-shaped call sites classify as consumed", greenVerdicts.every((v) => v.ok === true));
}

// ── THE REAL CHECK — service.ts itself.
check(`service.ts exists at the expected path (${path.relative(SRC_DIR, SERVICE_TS)})`, fs.existsSync(SERVICE_TS));
const srcText = fs.readFileSync(SERVICE_TS, "utf8");
const sourceFile = ts.createSourceFile(SERVICE_TS, srcText, ts.ScriptTarget.Latest, true);
const realCalls = findFinishAlreadyMergedCalls(sourceFile);
check(`at least 3 real this.finishAlreadyMerged(...) call sites found in service.ts (found ${realCalls.length})`, realCalls.length >= 3);
const violations = realCalls.map((c) => ({ call: c, verdict: classifyConsumption(sourceFile, c) })).filter((x) => !x.verdict.ok);
check(`every real call site in service.ts consumes its result (found ${violations.length} violation(s))`, violations.length === 0);
for (const v of violations) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(v.call.getStart(sourceFile));
  console.log(`  VIOLATION[${v.verdict.reason}]  service.ts:${line + 1}`);
}

// Repo-wide scope sanity (stated in the module header above): no OTHER file under packages/daemon/src
// calls or declares this method — a comment-stripped CODE-line scan is enough for this lower-stakes,
// purely defensive check (a comment MENTION of the bare name in prose, e.g. "finishAlreadyMerged's own
// doc", is expected and harmless and must not be flagged).
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}
function codeOnlyHasMention(filePath) {
  const state = { inBlock: false };
  const isCommentLine = (trimmed) => {
    if (state.inBlock) { if (trimmed.includes("*/")) state.inBlock = false; return true; }
    if (trimmed.startsWith("//")) return true;
    if (trimmed.startsWith("/*")) { if (!trimmed.includes("*/")) state.inBlock = true; return true; }
    if (trimmed.startsWith("*")) return true;
    return false;
  };
  const CODE_MENTION_RE = /\bfinishAlreadyMerged\s*\(/;
  for (const raw of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = raw.trim();
    if (isCommentLine(trimmed)) continue;
    if (CODE_MENTION_RE.test(raw.replace(/(?<!:)\/\/.*/, ""))) return true;
  }
  return false;
}
const otherFilesWithRealMention = walk(SRC_DIR, []).filter((f) => f !== SERVICE_TS && codeOnlyHasMention(f));
check(`no OTHER packages/daemon/src/**/*.ts file calls/declares \`finishAlreadyMerged\` in CODE (found: ${otherFilesWithRealMention.map((f) => path.relative(SRC_DIR, f)).join(", ") || "none"})`, otherFilesWithRealMention.length === 0);

console.log(failures === 0
  ? `\n✅ ALL PASS — every real \`this.finishAlreadyMerged(\` call site in service.ts (${realCalls.length} found) genuinely consumes its result (AST-verified, not merely text-adjacent); the RED/GREEN controls confirm the classifier discriminates correctly, including the two shapes a comment-only or line-split edit could previously flip.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
