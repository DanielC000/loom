import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source scan
// STANDING GUARD (card 27383e5a) — catches a test-local `class X extends PtyHost` subclass with a
// hardcoded, fictional pid that does NOT override `reapExitedDescendants` (and, since card 2897acc4,
// `probeRootSurvival`) to a no-op.
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
// Card 2897acc4 widened the SAME hazard to a second seam: `PtyHost.verifyRootDeadOrForceKill` (called
// directly from `stop()`'s hard branch / `escalateGracefulStop`'s stage 3 / `stopCodex`'s mirrors, not
// only via `reapExitedDescendants`) also runs a real OS-wide enumeration, through `probeRootSurvival`.
// Overriding `reapExitedDescendants` alone does NOT cover this — it is a DIFFERENT method, reached from
// DIFFERENT call sites — so every subclass this guard already required a `reapExitedDescendants`
// override from now ALSO needs a `probeRootSurvival` override (`killRoot` is the companion kill seam, but
// `probeRootSurvival` alone — reporting "not alive" — already prevents `killRoot` from ever being
// reached, so it is the one load-bearing member this guard checks for).
//
// Card 2897acc4 (round 4, item 5) widened it a THIRD way: `createSeamHost(PtyHost)`'s own
// `reapExitedDescendants` override is a no-op by default, so a class extending it is normally exempt from
// everything above — EXCEPT when that class re-overrides `reapExitedDescendants` to bypass the seam's
// no-op and call the REAL (grandparent) method directly, via `PtyHost.prototype.reapExitedDescendants`
// (`.call`/`.apply`/any other reference — e.g. `pty-root-reap-call-site-wiring.mjs`'s `SpyHost`, which does
// this on purpose to prove production wiring). THAT real method calls the real `sweepOrphanedDescendants`
// (the OS-wide SIGKILL sweep), so any class reaching into it this way must ALSO override
// `sweepOrphanedDescendants` to a no-op — regardless of whether it extends bare `PtyHost` or
// `createSeamHost(PtyHost)`; this check runs on EVERY class in the corpus, not gated by heritage shape.
//
// Card 2897acc4 (round 5, item 1c) widened it a FOURTH way, closing a gap CR 9024d16b found this guard
// itself had: `verifyRootDeadOrForceKill`'s own post-kill `sweepOrphanedDescendants` call (round 4, item
// 4) is reachable WITHOUT ever touching `reapExitedDescendants` at all — a class that overrides
// `probeRootSurvival` or `killRoot` directly (to drive `verifyRootDeadOrForceKill` itself, as a hermetic
// identity test does) can reach a confirmed force-kill and its sweep purely through those two seams. So
// ANY class on one of the two known PtyHost-subclass heritage shapes (bare `PtyHost`, or
// `createSeamHost(PtyHost)`) that declares its own `probeRootSurvival` OR `killRoot` must now ALSO
// override `sweepOrphanedDescendants` — see {@link overridesVerifyOrKillSeam}'s own doc for the exact
// incident (`pty-root-reap-identity.mjs`'s `ControllableHost`) this closes.
//
// WHAT THIS IS: a static AST scan (via the `typescript` compiler API — same shape as
// `onexit-discard-guard.mjs`) over `packages/daemon/test/*.mjs` source text. It finds every class
// declaration/expression whose `extends` clause is the BARE identifier `PtyHost` (never
// `createSeamHost(PtyHost)` — a CallExpression heritage clause is structurally a different shape and is
// already safe, since `createSeamHost`'s returned class carries the override), and asserts that class
// also declares BOTH a `reapExitedDescendants` member AND a `probeRootSurvival` member (any spelling:
// method, arrow property, or function-expression property — matched the same way
// `onexit-discard-guard.mjs` matches `onExit`, since a future subclass could spell it any of those ways).
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
// KNOWN LIMITS (card 2897acc4, round 6, item 4) — this is a SYNTACTIC AST scan, not a semantic one; a
// future class can structurally evade every rule above without actually being safe. None of the shapes
// below occurs anywhere in today's corpus (round 5's own 57-file sweep found none), but the guard CANNOT
// see any of them, and a syntactic scan can never be made complete against this list by construction —
// do not try to extend the AST matching to chase it:
//   - an ALIASED import (`import { PtyHost as Base } from ...`) — `extendsBarePtyHost`/
//     `isKnownPtyHostHeritage` both match the literal identifier text `PtyHost` only.
//   - an indirection through a local binding (`const H = PtyHost; class Fake extends H { ... }`) — the
//     heritage clause is the identifier `H`, never `PtyHost` itself.
//   - a MIXIN (`class Fake extends Mixin(PtyHost) { ... }`) — only the two literal shapes `PtyHost` and
//     `createSeamHost(PtyHost)` are recognized; any other wrapping call is invisible to this scan.
//   - a non-`createSeamHost` FACTORY that returns an equivalent no-op-seamed subclass under a different
//     name — `isKnownPtyHostHeritage` hardcodes the one factory name this corpus actually uses.
//   - a NAMESPACE-qualified heritage (`class Fake extends PtyHostModule.PtyHost { ... }`) — the matcher
//     expects a bare `ts.isIdentifier`, never a property-access expression.
//   - INSTANCE stubbing by assignment (`host.sweepOrphanedDescendants = () => {};`, outside the class
//     body) rather than a class member — every check here only inspects `cls.members`.
//   - a DIRECT free-function call (`reapOrphanedDescendants(fakePid)` or
//     `PtyHost.prototype.verifyRootDeadOrForceKill.call(...)`) from ordinary test code with NO subclass
//     involved at all — there is no class declaration for this scan to even visit.
// A future round that wants to close these needs a STRUCTURAL RUNTIME tripwire (the lead is carding this
// separately, per this card's own kickoff) — e.g. asserting at the real enumeration/kill call sites that
// the pid is never one of a small set of disallowed sentinel values in a test process — not a wider AST
// pattern here; trying to make the syntactic scan "complete" is explicitly out of scope for this guard.
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

/** Required seam overrides — see header for why both are load-bearing (two different hazards, two
 *  different call-site sets). */
const REQUIRED_OVERRIDES = ["reapExitedDescendants", "probeRootSurvival"];

/** Does `cls` declare a member named `memberName`, in any of method / arrow-property /
 *  function-expression-property spelling (mirrors `onexit-discard-guard.mjs`'s member-shape coverage —
 *  it doesn't matter HOW it's spelled, only that the seam is overridden at all). */
function declaresOverride(cls, memberName) {
  for (const member of cls.members) {
    if (getKeyName(member) !== memberName) continue;
    if (ts.isMethodDeclaration(member)) return true;
    if (ts.isPropertyDeclaration(member) && member.initializer &&
        (ts.isFunctionExpression(member.initializer) || ts.isArrowFunction(member.initializer))) return true;
  }
  return false;
}

/** Which of {@link REQUIRED_OVERRIDES} this class is missing (empty array ⇒ fully compliant). */
function missingOverrides(cls) {
  return REQUIRED_OVERRIDES.filter((name) => !declaresOverride(cls, name));
}

/** Is this class's heritage clause the BARE identifier `PtyHost` (not `createSeamHost(PtyHost)` or any
 *  other call/member-expression wrapper, which is a structurally different, already-safe shape)? */
function extendsBarePtyHost(cls) {
  const heritage = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  const expr = heritage?.types?.[0]?.expression;
  return !!expr && ts.isIdentifier(expr) && expr.text === "PtyHost";
}

/** Does `node` match the property-access chain `<ident "PtyHost">.prototype.<memberName>` — e.g. the
 *  `PtyHost` in `PtyHost.prototype.reapExitedDescendants.call(this, ...)`? Matched structurally (any
 *  node in the AST), not just as a direct call target — "via .call or otherwise" per the round-4 ruling:
 *  the hazard is reaching the real method body AT ALL, not one particular invocation shape. */
function isPtyHostPrototypeMemberAccess(node, memberName) {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== memberName) return false;
  const proto = node.expression;
  return ts.isPropertyAccessExpression(proto) && proto.name.text === "prototype" &&
    ts.isIdentifier(proto.expression) && proto.expression.text === "PtyHost";
}

/** Does `cls`'s own member bodies contain a reference to `PtyHost.prototype.reapExitedDescendants`
 *  ANYWHERE (never descending into a nested class) — i.e. does this class bypass whatever no-op its own
 *  heritage (bare `PtyHost` or `createSeamHost(PtyHost)`) provides and reach the REAL method, which calls
 *  the real `sweepOrphanedDescendants` (the OS-wide SIGKILL sweep)? */
function callsRealReapExitedDescendants(cls) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node !== cls) return;
    if (isPtyHostPrototypeMemberAccess(node, "reapExitedDescendants")) { found = true; return; }
    ts.forEachChild(node, visit);
  };
  for (const member of cls.members) visit(member);
  return found;
}

/** Round 5 (item 1c) — is `cls`'s heritage one of the two shapes every real file in this corpus uses to
 *  become a PtyHost subclass: the bare identifier `PtyHost`, or `createSeamHost(PtyHost)`? Scopes the
 *  member-name rule below to genuine PtyHost subclasses, so an unrelated class that merely happens to
 *  declare a same-named method is never a false positive. */
function isKnownPtyHostHeritage(cls) {
  if (extendsBarePtyHost(cls)) return true;
  const heritage = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  const expr = heritage?.types?.[0]?.expression;
  return !!expr && ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "createSeamHost" &&
    expr.arguments.length > 0 && ts.isIdentifier(expr.arguments[0]) && expr.arguments[0].text === "PtyHost";
}

/**
 * Round 5 (item 1c) — does a known-PtyHost-heritage `cls` (see {@link isKnownPtyHostHeritage}) declare
 * its OWN `probeRootSurvival` or `killRoot` member (any spelling)? Either one alone already lets
 * `verifyRootDeadOrForceKill` reach a confirmed force-kill and its own post-kill `sweepOrphanedDescendants`
 * call (round 4, item 4) — a DIFFERENT call path than `reapExitedDescendants`, reached WITHOUT ever going
 * through it. The exact gap this closes: CR 9024d16b found `pty-root-reap-identity.mjs`'s own
 * `ControllableHost` overrode both of these per-scenario (to drive `verifyRootDeadOrForceKill` directly)
 * without overriding `sweepOrphanedDescendants`, so every run of that file's own kill-confirmed scenarios
 * executed the REAL OS-wide sweep against a fabricated pid — and the guard below, as it stood then, could
 * not see it (neither required-override rule covers a class that never touches `reapExitedDescendants`).
 */
function overridesVerifyOrKillSeam(cls) {
  return isKnownPtyHostHeritage(cls) && (declaresOverride(cls, "probeRootSurvival") || declaresOverride(cls, "killRoot"));
}

/**
 * THE ONE traversal — scan a parsed `SourceFile` for an `extends PtyHost` subclass missing its required
 * override, OR any class (heritage-shape-independent) that EITHER reaches `PtyHost.prototype.
 * reapExitedDescendants` directly, OR declares its own `probeRootSurvival`/`killRoot` override, without
 * also overriding `sweepOrphanedDescendants` (round 5, item 1c — see {@link overridesVerifyOrKillSeam}'s
 * own doc for why the latter is an independent hazard, not a rephrasing of the former). One hit per
 * class, `missing` naming every override it still lacks across all three rules. Both `scanFile` (real
 * files) and `scanSnippet` (synthetic positive-control text, below) call THIS function, so a control
 * exercises the exact same code path the real scan runs.
 */
function scanSourceFile(sf) {
  const hits = [];
  const visit = (node) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const missing = new Set();
      if (extendsBarePtyHost(node)) {
        for (const m of missingOverrides(node)) missing.add(m);
      }
      const reachesSweepHazard = callsRealReapExitedDescendants(node) || overridesVerifyOrKillSeam(node);
      if (reachesSweepHazard && !declaresOverride(node, "sweepOrphanedDescendants")) missing.add("sweepOrphanedDescendants");
      if (missing.size > 0) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const name = node.name?.text ?? "<anonymous>";
        hits.push({ line, name, missing: [...missing] });
      }
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
    "[falsification] a class with ONLY reapExitedDescendants (missing probeRootSurvival) is still flagged, naming the missing one",
    (() => {
      const hits = scanSnippet(`class Fake extends PtyHost { reapExitedDescendants(_rootPid) {} createPty() { return { pid: 4242 }; } }`);
      return hits.length === 1 && hits[0].missing.length === 1 && hits[0].missing[0] === "probeRootSurvival";
    })()
  );
  check(
    "[falsification] a class with ONLY probeRootSurvival (missing reapExitedDescendants, AND — round 5, item 1c — missing sweepOrphanedDescendants too, since it declares probeRootSurvival) is flagged for BOTH",
    (() => {
      const hits = scanSnippet(`class Fake extends PtyHost { async probeRootSurvival(_p, _s) { return { foundAlive: false }; } createPty() { return { pid: 4242 }; } }`);
      return hits.length === 1 && hits[0].missing.length === 2 &&
        hits[0].missing.includes("reapExitedDescendants") && hits[0].missing.includes("sweepOrphanedDescendants");
    })()
  );

  check(
    "[negative control] clears a class extends PtyHost that DOES override all THREE seams (method) — round 5 widened this from two to three",
    scanSnippet(`class Fake extends PtyHost { reapExitedDescendants(_rootPid) {} async probeRootSurvival(_p, _s) { return { foundAlive: false }; } sweepOrphanedDescendants(_rootPid) {} createPty() { return { pid: 4242 }; } }`).length === 0
  );
  check(
    "[negative control] clears the arrow-property spelling of all three overrides",
    scanSnippet(`class Fake extends PtyHost { reapExitedDescendants = (_rootPid) => {}; probeRootSurvival = async (_p, _s) => ({ foundAlive: false }); sweepOrphanedDescendants = (_rootPid) => {}; createPty() { return { pid: 4242 }; } }`).length === 0
  );
  check(
    "[negative control] clears the function-expression-property spelling of all three overrides",
    scanSnippet(`class Fake extends PtyHost { reapExitedDescendants = function (_rootPid) {}; probeRootSurvival = async function (_p, _s) { return { foundAlive: false }; }; sweepOrphanedDescendants = function (_rootPid) {}; createPty() { return { pid: 4242 }; } }`).length === 0
  );

  // Round 5 (item 1c) — the NEW rule on its own: a class overriding probeRootSurvival OR killRoot (never
  // touching reapExitedDescendants at all — the exact ControllableHost shape this round fixes) must still
  // override sweepOrphanedDescendants, on EITHER known PtyHost heritage shape.
  check(
    "[falsification, round 5 item 1c] extends PtyHost (bare), overrides ONLY killRoot, no reapExitedDescendants/probeRootSurvival/sweepOrphanedDescendants at all — flagged for all three",
    (() => {
      const hits = scanSnippet(`class Fake extends PtyHost { killRoot(_pid) {} }`);
      return hits.length === 1 && hits[0].missing.length === 3 &&
        ["reapExitedDescendants", "probeRootSurvival", "sweepOrphanedDescendants"].every((m) => hits[0].missing.includes(m));
    })()
  );
  check(
    "[falsification, round 5 item 1c] extends createSeamHost(PtyHost) — the ControllableHost shape itself — overrides probeRootSurvival + killRoot, reapExitedDescendants no-op'd, NO sweepOrphanedDescendants — flagged",
    (() => {
      const hits = scanSnippet(`class Fake extends createSeamHost(PtyHost) { reapExitedDescendants() {} async probeRootSurvival(_p, _s) { return { foundAlive: false }; } killRoot(_pid) {} }`);
      return hits.length === 1 && hits[0].missing.length === 1 && hits[0].missing[0] === "sweepOrphanedDescendants";
    })()
  );
  check(
    "[negative control, round 5 item 1c] the SAME shape, but WITH sweepOrphanedDescendants overridden too — CLEARED",
    scanSnippet(`class Fake extends createSeamHost(PtyHost) { reapExitedDescendants() {} async probeRootSurvival(_p, _s) { return { foundAlive: false }; } killRoot(_pid) {} sweepOrphanedDescendants(_rootPid) {} }`).length === 0
  );
  check(
    "[discriminator, round 5 item 1c] a class with NEITHER known PtyHost heritage shape, that merely happens to declare a same-named `probeRootSurvival` method, is NOT flagged by this rule",
    scanSnippet(`class Fake extends SomethingUnrelated { probeRootSurvival() { return 1; } }`).length === 0
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

  // Round 4 (item 5): calling the REAL PtyHost.prototype.reapExitedDescendants without also overriding
  // sweepOrphanedDescendants, across every heritage shape this applies to.
  check(
    "[falsification] extends createSeamHost(PtyHost), bypasses the no-op via PtyHost.prototype.reapExitedDescendants.call(...), NO sweepOrphanedDescendants override — FLAGGED",
    (() => {
      const hits = scanSnippet(`class Fake extends createSeamHost(PtyHost) { reapExitedDescendants(rootPid, sessionId, liveRef) { PtyHost.prototype.reapExitedDescendants.call(this, rootPid, sessionId, liveRef); } }`);
      return hits.length === 1 && hits[0].missing.length === 1 && hits[0].missing[0] === "sweepOrphanedDescendants";
    })()
  );
  check(
    "[falsification] the SAME hazard on a BARE `extends PtyHost` class is ALSO flagged for sweepOrphanedDescendants (in addition to the bare-heritage check)",
    (() => {
      const hits = scanSnippet(`class Fake extends PtyHost { reapExitedDescendants(rootPid, sessionId, liveRef) { PtyHost.prototype.reapExitedDescendants.call(this, rootPid, sessionId, liveRef); } async probeRootSurvival(_p, _s) { return { foundAlive: false }; } }`);
      return hits.some((h) => h.missing.includes("sweepOrphanedDescendants"));
    })()
  );
  check(
    "[falsification] catches the reference even via .apply (not just .call) — ANY reference, per the round-4 ruling",
    (() => {
      const hits = scanSnippet(`class Fake extends createSeamHost(PtyHost) { reapExitedDescendants(rootPid, sessionId, liveRef) { PtyHost.prototype.reapExitedDescendants.apply(this, [rootPid, sessionId, liveRef]); } }`);
      return hits.length === 1 && hits[0].missing[0] === "sweepOrphanedDescendants";
    })()
  );
  check(
    "[negative control] extends createSeamHost(PtyHost), bypasses the no-op, but DOES override sweepOrphanedDescendants too — CLEARED (the real pty-root-reap-call-site-wiring.mjs SpyHost shape)",
    scanSnippet(`class Fake extends createSeamHost(PtyHost) { sweepOrphanedDescendants(_rootPid) {} reapExitedDescendants(rootPid, sessionId, liveRef) { PtyHost.prototype.reapExitedDescendants.call(this, rootPid, sessionId, liveRef); } }`).length === 0
  );
  check(
    "[discriminator] a class with NO reference to PtyHost.prototype.reapExitedDescendants at all is untouched by this check",
    scanSnippet(`class Fake extends createSeamHost(PtyHost) { createPty(opts) { return super.createPty(opts); } }`).length === 0
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

check(`every "extends PtyHost" subclass outside the exemption list overrides both ${REQUIRED_OVERRIDES.join("+")}, AND every class reaching PtyHost.prototype.reapExitedDescendants directly also overrides sweepOrphanedDescendants (found ${newViolations.length} violation(s), scanned ${files.length} files, ${EXEMPT_FILES.size} exempt)`, newViolations.length === 0);
for (const v of newViolations) {
  console.log(`  MISSING OVERRIDE(S) [${v.missing.join(", ")}]  ${v.file}:${v.line}  class ${v.name}`);
}

console.log(failures === 0
  ? `\n✅ ALL PASS — every test-local \`extends PtyHost\` subclass (outside the documented exemption list) overrides ${REQUIRED_OVERRIDES.join(" and ")}, and every class reaching the real reapExitedDescendants also overrides sweepOrphanedDescendants.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
