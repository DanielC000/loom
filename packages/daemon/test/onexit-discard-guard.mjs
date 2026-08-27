import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source scan
// STANDING GUARD (card 82dc680f) — catches a fake-pty test double that DISCARDS its `onExit` callback,
// BY DEFAULT, independent of how the property is spelled. Filed because the SAME defect escaped THREE
// prior sweeps, each scoped one level too narrowly:
//   1. `ec7983c6` scoped by CLASS NAME (`class SeamHost`)              — missed `RecordingHost` (same shape, different name)
//   2. mgr #84's merge verification scoped by LITERAL STRING            — missed 50 files using the arrow-property spelling
//   3. `434a8ca8` scoped by hand-audited SHAPE, migrated the 50 found  — left "does idiom #4 exist" genuinely open
// See memory `discriminating-control-and-proof-beats-measurement`, `positive-control-your-searches-empty-is-not-evidence`,
// `two-states-one-signature-add-a-discriminator`.
//
// WHAT THIS IS: a static AST scan (via the `typescript` compiler API, already a real dependency of this
// package — no new dep) over `packages/daemon/test/*.mjs` source text — same walk+check+baseline shape as
// `codescape-privacy-guard.mjs`, NOT the runtime-unit-test-of-a-lint-function shape of `agent-prompt-lint.mjs`.
// It parses each file into an AST and matches on STRUCTURE (a function value bound to a property/method
// named `onExit`), not on literal text — so method shorthand, arrow property, assigned function
// expression, computed-string-key, and CLASS-FIELD (`onExit = () => {...}` / `onExit = function() {...}`,
// a `PropertyDeclaration` — a genuinely different AST node than the `PropertyAssignment`/`MethodDeclaration`
// an object-literal or class-METHOD spelling produces, and a real miss in an earlier draft of this file
// caught only by a manager review with its own positive control, not by this guard's own tests) spellings
// are ALL the same shape to this scanner. This is why it covers idiom #4 whenever it appears: a fourth
// spelling of "a function named onExit" collapses to the same AST shape as the others, unlike a regex
// which only matches spellings someone thought to write. The positive-control block below and the real
// scan both call the SAME traversal function (`scanSourceFile`) — a control that exercised a separate
// copy of the walk would certify nothing about what the real scan actually does; see FINDING 2 in the
// card's review history for why this is stated explicitly.
//
// THE DISCARD HEURISTIC: an `onExit` function is flagged if it declares ZERO parameters, or declares a
// first parameter that is NEVER referenced anywhere in its body — either way, it structurally cannot be
// captured or invoked, so `kill()` can never flip `alive` (the origin defect, `c54d1ea0`).
//
// THE SCOPING DISCRIMINATOR (the load-bearing, non-obvious part — read before touching this file): the
// property name `onExit` is NOT unique to a fake-pty handle in this codebase. `PtyHost`'s `events`
// constructor argument carries its OWN, unrelated `onExit(sessionId, exitCode)` — a session-lifecycle
// notification stub, legitimately a no-op in nearly every test (`{ onEngineSessionId(){}, onBusy(){},
// onContextStats(){}, onRateLimited(){}, onExit(){} }`). A name-only scan (this guard's own first draft)
// found 96 "hits" on the real corpus — almost all of them this events-bag, a textbook instance of project
// memory's "two states, one signature" trap. The fix: only scan an `onExit` member inside a container that
// is STRUCTURALLY a fake-pty HANDLE, identified by one of two signals, both MEASURED against the real
// corpus (2026-07-31), not assumed:
//   (a) a direct sibling `kill` member in the same object literal or class body — the shape
//       `_seam-host-fixture.mjs` ships (`pid/write/onData/onExit/kill/resize`). The events-bag never has
//       `kill`.
//   (b) a spread element that is EITHER (b1) a direct CALL to a method literally named `createPty` — e.g.
//       `{ ...super.createPty(opts), onExit: () => ({ dispose() {} }) }` — OR (b2) a spread of a plain
//       IDENTIFIER whose declaration, in the SAME enclosing function scope as the spread itself,
//       initialises from such a call — e.g. `const base = super.createPty(opts); return { ...base, onExit:
//       ... };`, the HOISTED spelling of the identical idiom (card `2876a4ef`, filed the same day this guard
//       first landed as `82dc680f`: (b) originally covered only (b1), and (b1) turned out to be the
//       MINORITY real-corpus spelling — (b2)'s hoisted form is the majority one, so the original header's
//       claim that (b) covered "the single most likely NEXT idiom" was true of the idiom but not of the
//       spelling actually in majority use). (b2) is a deliberate ONE-HOP, SAME-FUNCTION-SCOPE lookup — it
//       walks up to the nearest enclosing function-like node and looks for a `const`/`let` declaration of
//       that exact name initialised from a `.createPty(...)` call in THAT function's own body only (never
//       descending into a nested function, never reaching into an outer/enclosing scope) — a materially
//       narrower, closed-form check than the general data-flow tracing that blind spots #1-#3 below need
//       and that this guard deliberately declines. Requiring (b1)'s spread to be a `.createPty(...)` CALL
//       (not "any spread"), and (b2)'s identifier to resolve to one (not just any local var), is deliberate:
//       a broader "any spread"/"any identifier" rule was measured to false-positive on a hypothetical
//       `{ ...someDefaults, onExit() {} }` / `{ ...baseEvents, onExit() {} }` events-bag construction —
//       narrowing to the actual call shape (direct or one hop back) clears that case while still catching
//       the real risk. MEASURED counts, this corpus, 2026-07-31 (post-widening): 23 containers qualify via
//       (a) only, 26 via (b1) only, 44 via (b2) only (spanning 41 distinct files — a few files use it
//       twice) — 93 total handle-shaped surface across 656 scanned files, 0 false positives, 0 discard hits
//       (no (a)/(b) overlaps observed). None of the 93 today define an onExit that discards its callback —
//       (b) exists to catch the FIRST one that does, in EITHER spelling.
//
// WHAT THIS CANNOT SEE — stated plainly, per DoD-2, because a guard silently blind to a shape is the same
// failure one level up:
//   1. CROSS-STATEMENT assignment on a plain identifier: `f.onExit = (cb) => {...}; f.kill = () => {};`
//      written as separate statements rather than one literal. This scanner only looks at ONE container's
//      direct members; it does not merge assignments across statements. Proven blind by construction, not
//      asserted: this exact shape was tested against an early draft of this scanner and slipped through.
//      Closing it needs data-flow tracking (reassignment, conditionals, loops, indirection through a
//      helper) — an open-ended problem, not another spelling; not attempted here.
//   2. SHORTHAND property bound to a separately-declared identifier: `const onExit = () => {...}; const f
//      = { onExit, kill(){} };` — same class of gap as #1 (would need to trace the identifier back to its
//      declaration).
//   3. INDIRECTION through a callee: `onExit: cb => helper(cb)` where `helper` itself discards `cb`. This
//      scanner inspects only the immediate function value bound to `onExit`, never functions it calls —
//      real interprocedural analysis is out of scope for a static per-file scanner.
//   4. "STORED BUT NEVER INVOKED": `onExit(cb) { this._cb = cb; return { dispose() {} }; }` with `this._cb`
//      never actually called anywhere REFERENCES its parameter, so this heuristic clears it — while the
//      callback could still be effectively discarded if nothing ever reads `this._cb` back. This heuristic
//      proves "not OBVIOUSLY discarding" (the param is used for SOMETHING), not "provably correctly
//      wired" — a materially different, weaker claim, named here so a future reader doesn't over-trust a
//      green result on this specific shape.
//   5. A getter returning a function (`get onExit() { return fn; }`) or any other shape that doesn't put a
//      function value directly on the `onExit` key — not observed anywhere in this corpus and would also
//      break the real call site (`pty.onExit(cb)` calls the property directly, not `pty.onExit()(cb)`), so
//      not worth solving; noted for completeness only.
//
// EXEMPTIONS: none — no marker/comment escape hatch is needed. Unlike the sibling timing guard (which
// flags a SHAPE that is sometimes legitimately correct and needs a human judgment call to clear), this
// guard's discard heuristic already discriminates discarding from capturing by construction — every real
// `LOCAL OVERRIDE` file in this corpus (the ~17 that intentionally don't use the shared fixture) clears
// because its `onExit` genuinely references its callback, not because of an exemption comment. If a
// FUTURE legitimate case needs to bypass this guard, that is itself a signal to re-examine the heuristic,
// not to add a bypass — raise it rather than silencing this file.
//
// KNOWN_ONEXIT_DISCARD_DEBT is a PERMANENT BASELINE MECHANISM, not a countdown — same posture as
// `codescape-privacy-guard.mjs`'s `KNOWN_LEAKING_FILES` and `fixed-wait-negative-guard.mjs`'s
// `KNOWN_UNAUDITED_WAITS`. It is EMPTY today (2026-07-31) because this card was deliberately sequenced
// AFTER `434a8ca8` (the 50-file migration) landed clean on main — there is no known debt to baseline. Do
// NOT add an entry to "make a new finding pass" without first auditing that site; a baselined entry is
// accepted, unexamined-under-this-guard debt, never a clearance.
//
// Run: node packages/daemon/test/onexit-discard-guard.mjs (no build needed — pure source-text/AST scan)
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(__filename);
const SELF_BASENAME = path.basename(__filename);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Permanent baseline of (file, line-independent-key) entries accepted as pre-existing, unaudited debt.
// EMPTY today — see header. Keyed by (file, onExit-member's own source snippet) so a baseline entry (were
// one ever needed) survives line-shifting edits the way `fixed-wait-negative-guard.mjs`'s label-keyed
// baseline does; NOT by line number.
const KNOWN_ONEXIT_DISCARD_DEBT = new Map();

// ---------------------------------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------------------------------

/** Extract a member's key name, including a computed string-literal key (`['onExit']: fn`). */
function getKeyName(member) {
  const key = member.name;
  if (!key) return null;
  if (ts.isIdentifier(key) || ts.isStringLiteral(key)) return key.text ?? key.escapedText?.toString();
  if (ts.isComputedPropertyName(key) && ts.isStringLiteral(key.expression)) return key.expression.text;
  return null;
}

/** Direct (non-recursive) members of an object literal or a class body. */
function directMembers(container) {
  if (ts.isObjectLiteralExpression(container)) return container.properties;
  if (ts.isClassDeclaration(container) || ts.isClassExpression(container)) return container.members;
  return [];
}

/** The function value a member binds, across method-shorthand / arrow-property / function-expression-property /
 *  class-field spellings. A class field (`onExit = () => {...}`) is a `PropertyDeclaration` — a DIFFERENT node
 *  kind than the `PropertyAssignment` an object-literal property produces — so it needs its own branch; treating
 *  "object property" and "class field" as the same shape here was the exact gap a manager review caught. */
function memberFunctionValue(member) {
  if (ts.isPropertyAssignment(member) && (ts.isFunctionExpression(member.initializer) || ts.isArrowFunction(member.initializer))) {
    return member.initializer;
  }
  if (ts.isMethodDeclaration(member)) return member;
  if (ts.isPropertyDeclaration(member) && member.initializer && (ts.isFunctionExpression(member.initializer) || ts.isArrowFunction(member.initializer))) {
    return member.initializer;
  }
  return null;
}

/** Whether identifier `name` is referenced anywhere within `body` (a Block or a concise arrow expression body). */
function identifierUsedInBody(body, name) {
  if (!body) return false;
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) { found = true; return; }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

function firstParamName(fn) {
  const p = fn.parameters[0];
  return p && ts.isIdentifier(p.name) ? p.name.text : null;
}

/** Is `expr` itself a CALL to a method literally named `createPty`? */
function isCreatePtyCall(expr) {
  return ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "createPty";
}

function isFunctionLikeScope(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** The nearest enclosing function-like node, walking up `.parent` (set because `createSourceFile` is
 *  called with `setParentNodes: true`). Null at module top level. */
function enclosingFunctionScope(node) {
  let cur = node.parent;
  while (cur) {
    if (isFunctionLikeScope(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** Does `scope` itself declare `const/let NAME = <expr>.createPty(...)`? Only descends into `scope`'s
 *  OWN body — deliberately does not follow into a nested function-like node, so this stays a one-hop,
 *  same-function-scope lookup rather than the general data-flow tracing DoD-1 rules out of scope. */
function scopeDeclaresCreatePtyIdentifier(scope, name) {
  let found = false;
  const visit = (node) => {
    if (found || (isFunctionLikeScope(node) && node !== scope)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      if (node.initializer && isCreatePtyCall(node.initializer)) found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/** A spread element whose expression is a CALL to a method literally named `createPty` (§(b), original
 *  signal), OR a spread of a plain IDENTIFIER whose declaration, in the SAME enclosing function scope as
 *  the spread itself, initialises from such a call (§(b) widened — the hoisted-local-variable spelling of
 *  the exact same idiom, e.g. `const base = super.createPty(opts); return { ...base, onExit: ... };`). One
 *  hop, one scope — NOT a general reachability trace back through arbitrary reassignment/indirection. */
function isCreatePtySpread(member) {
  if (!ts.isSpreadAssignment(member)) return false;
  const expr = member.expression;
  if (isCreatePtyCall(expr)) return true;
  if (ts.isIdentifier(expr)) {
    const scope = enclosingFunctionScope(member);
    if (scope && scopeDeclaresCreatePtyIdentifier(scope, expr.text)) return true;
  }
  return false;
}

/** Does this container look like a fake-pty HANDLE (vs. e.g. the unrelated PtyHost `events` bag)? See header. */
function isHandleShapedContainer(members) {
  return members.some((m) => getKeyName(m) === "kill") || members.some(isCreatePtySpread);
}

/**
 * THE ONE traversal — scan a parsed `SourceFile` for onExit-discarding members inside a handle-shaped
 * container. Both `scanFile` (real files, adds file/line/snippet) and `scanSnippet` (synthetic positive-
 * control text, below) call THIS function — detection and traversal exist exactly once. A control that
 * exercised a separate copy of this walk would certify a second implementation, not the one the real scan
 * runs; see the header note on FINDING 2.
 */
function scanSourceFile(sf) {
  const hits = [];

  const visitContainer = (container) => {
    const members = directMembers(container);
    if (!isHandleShapedContainer(members)) return;
    for (const m of members) {
      if (getKeyName(m) !== "onExit") continue;
      const fn = memberFunctionValue(m);
      if (!fn) continue;
      const line = sf.getLineAndCharacterOfPosition(m.getStart(sf)).line + 1;
      const snippet = m.getText(sf).slice(0, 120);
      if (fn.parameters.length === 0) {
        hits.push({ line, snippet, reason: "declares zero parameters — cannot receive a callback at all" });
        continue;
      }
      const p0 = firstParamName(fn);
      if (p0 === null) {
        hits.push({ line, snippet, reason: "destructured first parameter (conservative flag — cannot verify usage by name)" });
      } else if (!identifierUsedInBody(fn.body, p0)) {
        hits.push({ line, snippet, reason: `parameter '${p0}' is never referenced in the function body` });
      }
    }
  };

  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) visitContainer(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Scan one real file on disk, via `scanSourceFile`. */
function scanFile(file) {
  const full = path.join(TEST_DIR, file);
  const text = fs.readFileSync(full, "utf8");
  const sf = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return scanSourceFile(sf).map((h) => ({ file, ...h }));
}

// =====================================================================================================
// POSITIVE CONTROL — prove the scanner can actually catch every known idiom (RED), and a NOVEL one this
// codebase has never written (RED), before trusting a "clean" result on the real corpus (GREEN) below.
// Uses in-memory synthetic source text — no temp files needed, since the scanner operates on source text.
// =====================================================================================================

/** Scan a synthetic source SNIPPET (not a real file) through `scanSourceFile` — the SAME traversal the
 *  real scan below uses, not a re-implementation of it (see the header note on FINDING 2). */
function scanSnippet(text) {
  const sf = ts.createSourceFile("synthetic.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return scanSourceFile(sf);
}

{
  // --- RED: the three idioms named in the card's escape ladder, plus a genuinely NOVEL fourth this
  // codebase has never written (proves DoD-1's "how does it behave when idiom #4 appears", not just that
  // today's three known spellings are hard-coded in). ---
  check(
    "[falsification] catches idiom 1 — method-shorthand onExit, zero params",
    scanSnippet(`const f = { pid:1, onExit() { return { dispose(){} }; }, kill(){} };`).length > 0
  );
  check(
    "[falsification] catches idiom 2 — arrow-property onExit, zero params",
    scanSnippet(`const f = { pid:1, onExit: () => ({ dispose(){} }), kill(){} };`).length > 0
  );
  check(
    "[falsification] catches idiom 3 — assigned function-expression onExit, zero params",
    scanSnippet(`const f = { pid:1, onExit: function() { return { dispose(){} }; }, kill(){} };`).length > 0
  );
  check(
    "[falsification] catches a NOVEL idiom-4 never written in this codebase — class method, param declared but unused",
    scanSnippet(`class Fake extends Base { onExit(cb) { return { dispose(){} }; } kill(){} }`).length > 0
  );
  check(
    "[falsification] catches the widened spread-of-createPty form with zero-param onExit (the most likely REAL next idiom — see header §(b))",
    scanSnippet(`class S extends Base { createPty(opts) { return { ...super.createPty(opts), onExit: () => ({ dispose(){} }) }; } }`).length > 0
  );
  check(
    "[falsification] catches the HOISTED spelling of the SAME idiom — a same-scope local var initialised from createPty(...), then spread (the majority real-corpus form, discriminating-pair proof: card 2876a4ef)",
    scanSnippet(`class S extends Base { createPty(opts) { const base = super.createPty(opts); return { ...base, onExit: () => ({ dispose(){} }) }; } }`).length > 0
  );
  check(
    "[falsification] catches a CLASS-FIELD arrow onExit, zero params (PropertyDeclaration — a real miss found by manager review, not a hypothetical)",
    scanSnippet(`class Fake extends Base { onExit = () => ({ dispose(){} }); kill(){} }`).length > 0
  );
  check(
    "[falsification] catches a CLASS-FIELD function-expression onExit, zero params",
    scanSnippet(`class Fake extends Base { onExit = function() { return { dispose(){} }; }; kill(){} }`).length > 0
  );

  // --- GREEN: legitimate capture forms must clear, including the trickiest real one in this corpus
  // (profile-spawn.mjs: a conditional, immediate cb() call paired with a genuinely no-op kill()) and the
  // widened spread form's legitimate capture variant. ---
  check(
    "[falsification] clears a legitimate method-shorthand capture (references cb)",
    scanSnippet(`const f = { pid:1, onExit(cb) { this._cb = cb; return { dispose(){} }; }, kill(){ this._cb?.(); } };`).length === 0
  );
  check(
    "[falsification] clears a legitimate conditional-immediate-call capture with a no-op kill (profile-spawn.mjs's real shape)",
    scanSnippet(`const f = { pid:1, onExit(cb) { if (x) cb({exitCode:1}); return {dispose(){}}; }, kill(){} };`).length === 0
  );
  check(
    "[falsification] clears the widened spread-of-createPty form when onExit legitimately captures cb",
    scanSnippet(`class S extends Base { createPty(opts) { return { ...super.createPty(opts), onExit(cb) { this._cb = cb; return {dispose(){}}; } }; } }`).length === 0
  );
  check(
    "[falsification] clears the HOISTED spelling when onExit legitimately captures cb",
    scanSnippet(`class S extends Base { createPty(opts) { const base = super.createPty(opts); return { ...base, onExit(cb) { this._cb = cb; return {dispose(){}}; } }; } }`).length === 0
  );
  check(
    "[falsification] clears a legitimate CLASS-FIELD arrow capture (references cb)",
    scanSnippet(`class Fake extends Base { onExit = (cb) => { this._cb = cb; return { dispose(){} }; }; kill(){ this._cb?.(); } }`).length === 0
  );

  // --- THE DISCRIMINATOR ITSELF: prove it tells the fake-pty handle apart from the unrelated PtyHost
  // `events` bag, rather than merely firing on the name "onExit" (the trap that produced 96 false
  // positives on the real corpus during this guard's design — see header). ---
  check(
    "[discriminator] does NOT flag the PtyHost events-bag onExit (no kill sibling, no createPty spread) even with zero params",
    scanSnippet(`const events = { onEngineSessionId(){}, onBusy(){}, onContextStats(){}, onRateLimited(){}, onExit(){} };`).length === 0
  );
  check(
    "[discriminator] does NOT flag a hypothetical events-bag built via spread of a non-createPty call",
    scanSnippet(`const events = { ...factory.createFoo(), onExit(){} };`).length === 0
  );
  check(
    "[discriminator] does NOT flag a hypothetical events-bag built via spread of a plain identifier (no call at all)",
    scanSnippet(`const events = { ...baseEvents, onExit(){} };`).length === 0
  );
  check(
    "[discriminator] widened signal (b) still does NOT flag a same-scope local var initialised from a NON-createPty call, spread with zero-param onExit",
    scanSnippet(`function make() { const base = factory.createFoo(); return { ...base, onExit(){} }; }`).length === 0
  );
  check(
    "[discriminator] widened signal (b) does NOT reach OUTSIDE the enclosing function scope — a module-top-level var initialised from createPty(...) but spread inside an UNRELATED function is still not treated as a handle (one-hop same-scope only, not general data-flow — DoD-1)",
    scanSnippet(`const outer = something.createPty(opts); function unrelated() { return { ...outer, onExit(){} }; }`).length === 0
  );
}

// =====================================================================================================
// THE REAL SCAN — every packages/daemon/test/*.mjs file (excluding this guard's own source).
// =====================================================================================================

const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs") && f !== SELF_BASENAME);
// Card 6e9a9209 (census 46d6fdb7, class B): `newViolations.length === 0` below passes VACUOUSLY if this
// traversal opens zero files — the positive-control block above proves the SCANNER works, but never
// proves the REAL corpus was actually reached. Scan-level population control, not a hardcoded floor:
// `files.length > 0` only ever grows as test files are added.
check(`the real corpus scan opened at least one test/*.mjs file (found ${files.length})`, files.length > 0);

const newViolations = [];
for (const file of files) {
  for (const hit of scanFile(file)) {
    const key = `${hit.file}::${hit.snippet}`;
    if (KNOWN_ONEXIT_DISCARD_DEBT.has(key)) continue; // baselined debt, not clearance — see header
    newViolations.push(hit);
  }
}

check(`no onExit-discarding fake-pty handle outside the baseline (found ${newViolations.length}, scanned ${files.length} files)`, newViolations.length === 0);
for (const v of newViolations) {
  console.log(`  DISCARD  ${v.file}:${v.line}  ${v.reason}`);
  console.log(`           ${v.snippet}`);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — no onExit-discarding fake-pty handle found (any spelling), and the discriminator correctly ignores the unrelated PtyHost events-bag onExit. See this file's header for the FIVE stated blind spots — this is not a completed census of every possible discard shape."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
