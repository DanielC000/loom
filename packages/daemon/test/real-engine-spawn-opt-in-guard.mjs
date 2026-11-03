import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text/AST scan below, no Db used
// STANDING GUARD (card dd6e713d). Two parts, both over the REAL corpus (readdirSync — sees an
// uncommitted new file too, same reasoning as codex-real-spawn-lock-membership-guard.mjs's own header):
//
// PART A — every basename in `REAL_ENGINE_SPAWN_BASENAMES` (`_real-engine-spawn-basenames.mjs`, the
// single source of truth) must have `import "./_real-engine-opt-in.mjs";` as its FIRST import line. A
// file that drops or reorders this import silently loses the structural refusal — this guard is what
// makes that fail LOUD at guard time instead of silently at the moment someone runs it by hand.
//
// PART B — a REVERSE sweep: every OTHER `.mjs` file directly under `packages/daemon/test/` (this guard's
// own basename, `_real-engine-opt-in.mjs`, `_real-engine-spawn-basenames.mjs`, and
// `_real-engine-spawn-guard-fixtures.mjs` excluded) is scanned — via the TypeScript compiler API, ONE
// shared parse per file, never a bare text/regex search (the "Do not" below names why) — for a
// real-engine spawn-call SHAPE:
//   - `<expr>.spawn(...)` (the shape `host.spawn(`/`pty.spawn(`/`this.pty.spawn(` all share);
//   - a DIRECT `<expr>.createPty(...)` / `<expr>.createCodexPty(...)` call — e.g. `host.createCodexPty(opts)`
//     against an unsubclassed PtyHost (engines actually launch there, pty/host.ts ~:6503/~:7227); a
//     `super.createPty(...)`/`super.createCodexPty(...)` call inside a delegating override is the SAME
//     reach, just through `super` instead of a variable;
//   - a bare `spawnPty(...)`/`spawnCp(...)` call.
// A file with such a hit is SAFE (no violation) only if the AST ALSO shows one of three markers — real
// SYNTAX, never a text/regex match over the whole file (a regex is unsound here: it accepts a mention in
// a comment/string, an `==`/`===` comparison, an empty-string fallback assignment, and a super-delegating
// override that still reaches the real engine):
//   (1) a CallExpression of `createSeamHost(...)` anywhere in the file — the shared fake-pty seam
//       (`_seam-host-fixture.mjs`) that overrides `createPty()` so a call through it never reaches
//       node-pty at all;
//   (2) an `=` assignment (never `==`/`===`) whose LHS resolves to `process.env.LOOM_CLAUDE_BIN` or
//       `process.env.LOOM_CODEX_BIN` and whose RHS is NOT an empty-string literal (an empty string falls
//       back to the real, PATH-resolved binary, so it is NOT safe) — the fixture-binary-substitution
//       technique `kickoff-real-spawn.mjs` established;
//   (3) a `createPty`/`createCodexPty` METHOD OVERRIDE on a class whose body does NOT itself call
//       `super.createPty(...)`/`super.createCodexPty(...)` — a method that delegates to `super` is NOT a
//       safe marker on its own, because (absent marker (1) or (2) on the same class) that `super` call IS
//       itself a spawn-call hit, reaching whatever the class's heritage actually resolves to. A class
//       whose heritage IS `createSeamHost(PtyHost)` is covered by marker (1) instead — found first, since
//       a heritage clause is visited before a class's own members.
// A spawn-call hit with NONE of the three markers, and not itself in `REAL_ENGINE_SPAWN_BASENAMES`, must
// carry a reasoned entry in `NON_ENGINE_ALLOWLIST` below (a one-line reason, same posture as every other
// judgment-curated allowlist in this suite) — otherwise it FAILS. A separate STALE-ENTRY assertion
// (below) fails loud if any `NON_ENGINE_ALLOWLIST` entry does NOT itself carry a genuine spawn-call hit
// with no safe marker — an entry that never matches anything is a silent future exemption the moment that
// file DOES gain a real spawn, not a narrowed allowlist.
//
// @decision dd6e713d — do not widen this AST scan to a broader text/regex pattern "to be safe": a naive
// `host\.spawn\(` text search false-positives on well over 200 files in this corpus (files calling it
// against a FAKED PtyHost) and has no notion of "inside a string/comment vs. real code" at all.
//
// MEMBERSHIP CRITERION for `REAL_ENGINE_SPAWN_BASENAMES` — stated ONCE, here (every other copy, including
// `_real-engine-opt-in.mjs`'s own header, is a pointer to this paragraph, never a restatement): judgment-
// curated by READING each file's own spawn call and binary resolution, never derived from a name pattern
// (`_probe-*`/`*real-spawn*` is NOT a reliable proxy either way, per that same "Do not"). A file belongs
// there only if it spawns against the REAL, un-overridden PtyHost with no fixture-binary substitution —
// i.e. none of the three safe markers above apply to it.
//
// ⚠️ KNOWN BLIND SPOTS — stated plainly, not chased with a broader pattern that risks new false positives
// on a guard every reduced gate runs:
//   - a renamed import (`import { spawn as foo } from "node-pty"` then `foo(...)`), an indirect call
//     through a variable holding the spawn function (`const fn = host.spawn; fn(...)`), a spawn reached
//     through a getter/proxy, or a dynamically constructed property name (`host["spawn"](...)`);
//   - a marker scoped to the WRONG harness — e.g. a `LOOM_CLAUDE_BIN` override sitting in a file whose
//     own real spawn is actually a `createCodexPty` call (or vice versa): this scan treats EITHER bin
//     override, or EITHER seam, as safe for the WHOLE file, never per-call-site;
//   - a `createSeamHost(` seam used for one host instance while a SECOND, genuinely real host is spawned
//     elsewhere in the same file — the seam call anywhere in the file marks the WHOLE file safe;
//   - a `createPty`/`createCodexPty` override whose `super` call is gated behind only ONE branch (e.g.
//     inside an `if`) — this is a single whole-method "does the body contain a call to `super.<name>`
//     anywhere" check, not a per-branch reachability analysis, so a branch-gated super call is still
//     detected (correctly treated as unsafe) even on a path that's never actually exercised — a false
//     positive, never a false negative, for this specific shape;
//   - a bare, un-renamed `spawn(...)`/`execFile("claude", ...)` from `node:child_process`, reached without
//     going through `PtyHost` at all;
//   - SessionService-mediated reach (`svc.startNew`/`spawnWorker` driving an unsubclassed `PtyHost`
//     internally) — this scan only sees a LITERAL call site in the test file's own text, not a spawn
//     reached transitively through a service method;
//   - the HTTP-driven `NOT_HERMETIC` family — guarded instead by `requireHermeticEnv({port:true})`, out of
//     scope for this structural refusal entirely.
// If a future file takes one of these shapes to reach a real engine spawn, this guard will not catch it
// silently — a real gap, not a theoretical one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
// Reads the list from the side-effect-free data module, NEVER from `_real-engine-opt-in.mjs` itself —
// importing that module (even for just the named export) runs its whole body, including the
// `process.exit(0)` opt-in check, which would make this guard refuse itself. See `_real-engine-opt-in.mjs`'s
// own header for why the split exists.
import { REAL_ENGINE_SPAWN_BASENAMES } from "./_real-engine-spawn-basenames.mjs";
import {
  BIN_ASSIGN_FIXTURE_TEXT,
  BIN_OVERRIDE_SPAWN_FIXTURE_TEXT,
  BIN_COMPARISON_EQ_FIXTURE_TEXT,
  BIN_COMPARISON_EQEQEQ_FIXTURE_TEXT,
  BIN_EMPTY_STRING_FIXTURE_TEXT,
  BIN_COMMENT_ONLY_MARKER_FIXTURE_TEXT,
} from "./_real-engine-spawn-guard-fixtures.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const OWN_BASENAME = path.basename(fileURLToPath(import.meta.url), ".mjs");
const OPT_IN_MODULE_BASENAME = "_real-engine-opt-in";
const BASENAMES_DATA_MODULE_BASENAME = "_real-engine-spawn-basenames";
const FIXTURES_DATA_MODULE_BASENAME = "_real-engine-spawn-guard-fixtures";
const REAL_ENGINE_SPAWN_SET = new Set(REAL_ENGINE_SPAWN_BASENAMES);
const EXPECTED_FIRST_IMPORT = 'import "./_real-engine-opt-in.mjs";';

// Judgment-curated, one-line reason each — see each file's own header for the full disclosure this
// summarizes. Pruned (Round 2, Code Review) from an earlier 20-entry version: every OTHER entry either
// carried no spawn-call hit at all under this guard's detectors (dead — see the STALE-ENTRY assertion
// below, which now catches that shape loud) or was already a `REAL_ENGINE_SPAWN_BASENAMES` member, which
// `findUnlistedEngineSpawnCandidates` excludes before this allowlist is ever consulted (redundant).
const NON_ENGINE_ALLOWLIST = {
  "pty-root-reap-posix-lstart-real-spawn": "spawns a throwaway `node -e` process via node:child_process.spawn(process.execPath, ...) — never claude/codex.",
  "pty-root-reap-win32-ticks-real-spawn": "spawns cmd.exe directly via node-pty — never claude/codex.",
  "guard-child-process-wrap-fidelity": "spawns a throwaway `node -e` process (process.execPath) via spawnPty, to test the test-registry pid-wrap fidelity — never claude/codex.",
  "emfile-enfile-spawn-survival": "mocks node:child_process's own ChildProcess.spawn()/._handle.spawn to test EMFILE/ENFILE fd-exhaustion handling against git/bounded.ts — never a real OS spawn of git, let alone claude/codex.",
};

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

/** Parse `text` into a TS SourceFile. */
function parseSource(text) {
  return ts.createSourceFile("x.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

/** Accepts either raw text (parses it) or an already-parsed SourceFile (uses it directly) — lets a caller
 *  that's about to run BOTH detectors over the same file (findUnlistedEngineSpawnCandidates,
 *  findStaleAllowlistEntries) parse once and hand the same SourceFile to each, instead of re-parsing. */
function asSourceFile(textOrSf) {
  return typeof textOrSf === "string" ? parseSource(textOrSf) : textOrSf;
}

/** Every real-engine spawn-call-SHAPE hit in `textOrSf`, as `{kind, line}` — AST-based, so a hit inside a
 *  string/template literal or a comment is never counted (see "WHY AN AST SCAN" in the decision record). */
function findSpawnCallHits(textOrSf) {
  const sf = asSourceFile(textOrSf);
  const hits = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === "spawn") {
          hits.push({ kind: "propertySpawn", line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
        } else if (callee.name.text === "createPty" || callee.name.text === "createCodexPty") {
          // Covers a DIRECT call on an unsubclassed PtyHost instance (`host.createPty(opts)`) and a
          // super-delegating override's own `super.createPty(opts)` call alike — both reach the real
          // engine the same way, just through a different expression. Whether that reach is actually
          // safe is decided by findSafeMarker's methodOverride check below, not here.
          hits.push({ kind: "directCreatePty", line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
        }
      } else if (ts.isIdentifier(callee) && (callee.text === "spawnPty" || callee.text === "spawnCp")) {
        hits.push({ kind: "bareSpawn", line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits;
}

/** Is `node` the AST shape `process.env.LOOM_CLAUDE_BIN` / `process.env.LOOM_CODEX_BIN`? */
function isProcessEnvBinTarget(node) {
  if (!ts.isPropertyAccessExpression(node)) return false;
  if (node.name.text !== "LOOM_CLAUDE_BIN" && node.name.text !== "LOOM_CODEX_BIN") return false;
  const inner = node.expression;
  return ts.isPropertyAccessExpression(inner) && inner.name.text === "env"
    && ts.isIdentifier(inner.expression) && inner.expression.text === "process";
}

/** Does `methodNode`'s own body contain a call to `super.<methodName>(...)` anywhere? */
function methodBodyCallsSuper(methodNode, methodName) {
  let callsSuper = false;
  function visit(node) {
    if (callsSuper) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.SuperKeyword
        && callee.name.text === methodName) {
        callsSuper = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  if (methodNode.body) visit(methodNode.body);
  return callsSuper;
}

/** Which of the three safe markers (see header) does `textOrSf` carry, if any? A single AST traversal in
 *  source order — whichever marker's own node appears FIRST wins. The return value is only used for
 *  diagnostics, never branched on beyond truthy/falsy. */
function findSafeMarker(textOrSf) {
  const sf = asSourceFile(textOrSf);
  let found = null;
  function visit(node) {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createSeamHost") {
      found = "createSeamHost";
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && isProcessEnvBinTarget(node.left)) {
      const rhs = node.right;
      const rhsIsEmptyString = ts.isStringLiteralLike(rhs) && rhs.text === "";
      if (!rhsIsEmptyString) {
        found = "binOverride";
        return;
      }
    }
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)
      && (node.name.text === "createPty" || node.name.text === "createCodexPty")
      && !methodBodyCallsSuper(node, node.name.text)) {
      found = "methodOverride";
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

/** PART B's actual classifier: given {basename: text} entries (never including a REAL_ENGINE_SPAWN_SET
 *  member or OWN_BASENAME/OPT_IN_MODULE_BASENAME/BASENAMES_DATA_MODULE_BASENAME/
 *  FIXTURES_DATA_MODULE_BASENAME — those are excluded by the caller, not here, so this stays a pure
 *  function of its inputs for the RED/GREEN proofs below), which basenames have a spawn-call hit, carry
 *  none of the three safe markers, and are NOT in `allowlist`? Parses each file's text exactly once and
 *  shares that SourceFile between both detector calls. */
function findUnlistedEngineSpawnCandidates(basenameToText, allowlist) {
  const violations = [];
  for (const [basename, text] of Object.entries(basenameToText)) {
    const sf = parseSource(text);
    if (findSpawnCallHits(sf).length === 0) continue;
    if (findSafeMarker(sf)) continue;
    if (Object.prototype.hasOwnProperty.call(allowlist, basename)) continue;
    violations.push(basename);
  }
  return violations;
}

/** STALE-ENTRY classifier: which basenames in `allowlist` do NOT carry a genuine spawn-call hit with no
 *  safe marker, against `basenameToText`? A stale entry (no hit, or a hit that's already covered by a
 *  real safe marker) is dead weight today and a silent future exemption the moment that file DOES gain an
 *  unsafe real-engine spawn — this must fail loud, the same posture as
 *  role-surface-tools-named-in-doctrine.mjs's own ALLOWLIST check. */
function findStaleAllowlistEntries(basenameToText, allowlist) {
  const stale = [];
  for (const basename of Object.keys(allowlist)) {
    const text = basenameToText[basename];
    if (text === undefined) { stale.push(`${basename} (no such file)`); continue; }
    const sf = parseSource(text);
    const hasHit = findSpawnCallHits(sf).length > 0;
    const hasMarker = !!findSafeMarker(sf);
    if (!hasHit || hasMarker) stale.push(`${basename} (hasHit=${hasHit}, hasMarker=${hasMarker})`);
  }
  return stale;
}

/** PART A's classifier: is `./_real-engine-opt-in.mjs` the FIRST import statement in `text`? */
function firstImportIsOptIn(text) {
  const firstImportLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("import "));
  return firstImportLine === EXPECTED_FIRST_IMPORT;
}

// --- Sanity / positive+negative controls on the DETECTORS THEMSELVES, before trusting them against real files ---

check(
  "sanity: a synthetic host.spawn( call IS detected (positive control)",
  findSpawnCallHits('const host = new PtyHost(e); host.spawn({ sessionId: "x" });').length === 1,
);
check(
  "sanity: a synthetic this.pty.spawn( call IS detected",
  findSpawnCallHits('class S { f() { this.pty.spawn(x); } }').length === 1,
);
check(
  "sanity: a synthetic bare spawnPty(...) call IS detected",
  findSpawnCallHits('const child = spawnPty("cmd.exe", [], {});').length === 1,
);
check(
  "sanity: a synthetic DIRECT host.createCodexPty(opts) call IS detected (item 2: the pty-codex-spawn-env.mjs gap)",
  findSpawnCallHits('const host = new PtyHost(e); host.createCodexPty(opts);').length === 1,
);
check(
  "sanity: a synthetic DIRECT host.createPty(opts) call IS detected",
  findSpawnCallHits('const host = new PtyHost(e); host.createPty(opts);').length === 1,
);
check(
  "sanity: a synthetic super.createPty(opts) call (inside an override) IS detected as the SAME shape",
  findSpawnCallHits('class F extends PtyHost { createPty(o) { return super.createPty(o); } }').length === 1,
);
check(
  "sanity: the SAME call-shape text INSIDE a template-literal string (data, not code) is NOT detected (negative control — this is the exact false-positive a text/regex search produces)",
  findSpawnCallHits('const snippet = `class S { f() { this.pty.spawn(x); } }`;').length === 0,
);
check(
  "sanity: the same shape inside a line COMMENT is NOT detected",
  findSpawnCallHits('// host.spawn( looks like a call here but it is only a comment').length === 0,
);
check(
  "sanity: createSeamHost( marks a file SAFE (positive control)",
  findSafeMarker('const host = new (createSeamHost(PtyHost))(e);') === "createSeamHost",
);
check(
  "sanity: a local createCodexPty override with NO super call marks a file SAFE",
  findSafeMarker('class FakeCodexHost extends PtyHost { createCodexPty(opts) { return fake; } }') === "methodOverride",
);
check(
  "sanity: a LOOM_CLAUDE_BIN assignment marks a file SAFE (AST-based — item 3)",
  findSafeMarker(BIN_ASSIGN_FIXTURE_TEXT) === "binOverride",
);
check(
  "sanity: plain source with none of the three markers is NOT marked safe (negative control)",
  findSafeMarker('const host = new PtyHost(events); host.spawn(opts);') === null,
);
// --- item 3 regressions: the three regex-era false-positive shapes the AST rewrite fixes ---
check(
  "ITEM 3: a `==` comparison against LOOM_CLAUDE_BIN is NOT a safe marker (the old regex matched this — it is not an assignment)",
  findSafeMarker(BIN_COMPARISON_EQ_FIXTURE_TEXT) === null,
);
check(
  "ITEM 3: a `===` comparison against LOOM_CODEX_BIN is NOT a safe marker",
  findSafeMarker(BIN_COMPARISON_EQEQEQ_FIXTURE_TEXT) === null,
);
check(
  "ITEM 3: an EMPTY-STRING assignment to LOOM_CLAUDE_BIN is NOT a safe marker (falls back to the real binary)",
  findSafeMarker(BIN_EMPTY_STRING_FIXTURE_TEXT) === null,
);
check(
  "ITEM 3 / DoD case (c): a mention in a COMMENT (a LOOM_CLAUDE_BIN-looking assignment, textually) is NOT a safe marker (the old regex matched this too — it is not real code)",
  findSafeMarker(BIN_COMMENT_ONLY_MARKER_FIXTURE_TEXT) === null,
);
check(
  "ITEM 3 / DoD case (d): a super-DELEGATING createPty override (extends PtyHost directly, no other marker) is NOT a safe marker — it still reaches the real engine via super",
  findSafeMarker('class F extends PtyHost { createPty(o) { return super.createPty(o); } }') === null,
);
check(
  "ITEM 3: a super-delegating override on `extends createSeamHost(PtyHost)` IS still safe — the heritage clause's createSeamHost( call is the marker, found before the method body",
  findSafeMarker('class F extends createSeamHost(PtyHost) { createPty(o) { return super.createPty(o); } }') === "createSeamHost",
);

// --- PART B: RED PROOF (must be able to fail) before trusting a real-corpus zero ---

{
  const syntheticCorpus = {
    "totally-synthetic-unlisted-bare-spawn-fixture": 'const host = new PtyHost(e); host.spawn({ sessionId: "x" });',
    "totally-synthetic-seam-fixture": 'class S extends createSeamHost(PtyHost) {} const host = new S(e); host.spawn(x);',
    "totally-synthetic-bin-override-fixture": BIN_OVERRIDE_SPAWN_FIXTURE_TEXT,
    "totally-synthetic-allowlisted-fixture": 'const child = spawnCp(process.execPath, ["-e", "x"], {});',
    "totally-synthetic-no-spawn-fixture": 'console.log("nothing to see here");',
    // DoD case (b): a throwaway unlisted fixture calling host.createPty(opts), no marker — must be flagged.
    "totally-synthetic-direct-createPty-fixture": 'const host = new PtyHost(e); host.createPty(opts);',
    // DoD case (c): the ONLY "marker" is a comment — must be flagged (comments are not AST nodes).
    "totally-synthetic-comment-only-marker-fixture": BIN_COMMENT_ONLY_MARKER_FIXTURE_TEXT,
    // DoD case (d): a super-delegating override, no other marker — must be flagged.
    "totally-synthetic-super-delegating-override-fixture": 'class F extends PtyHost { createPty(o) { return super.createPty(o); } }',
    // GREEN companion to (d): the SAME override shape, but genuinely non-delegating (no super call) — must NOT be flagged.
    "totally-synthetic-non-delegating-override-fixture": 'class F extends PtyHost { createPty(o) { return { pid: 1 }; } } const host = new F(e); host.createPty(o);',
  };
  const syntheticAllowlist = { "totally-synthetic-allowlisted-fixture": "test-only allowlist entry for this RED proof" };
  const violations = findUnlistedEngineSpawnCandidates(syntheticCorpus, syntheticAllowlist);
  check(
    "RED PROOF: an unlisted, unsafe, unallowlisted bare spawn call IS flagged",
    violations.includes("totally-synthetic-unlisted-bare-spawn-fixture"),
  );
  check("GREEN: a createSeamHost-marked fixture is NOT flagged", !violations.includes("totally-synthetic-seam-fixture"));
  check("GREEN: a LOOM_CLAUDE_BIN-override fixture is NOT flagged", !violations.includes("totally-synthetic-bin-override-fixture"));
  check("GREEN: an explicitly-allowlisted fixture is NOT flagged even though it has a real spawn-call hit", !violations.includes("totally-synthetic-allowlisted-fixture"));
  check("GREEN: a fixture with no spawn call at all is NOT flagged", !violations.includes("totally-synthetic-no-spawn-fixture"));
  check("DoD (b) RED PROOF: a direct host.createPty(opts) call with no marker IS flagged", violations.includes("totally-synthetic-direct-createPty-fixture"));
  check("DoD (c) RED PROOF: a comment-only 'marker' does NOT suppress the flag", violations.includes("totally-synthetic-comment-only-marker-fixture"));
  check("DoD (d) RED PROOF: a super-delegating override with no other marker IS flagged", violations.includes("totally-synthetic-super-delegating-override-fixture"));
  check("DoD (d) GREEN companion: a genuinely non-delegating override is NOT flagged", !violations.includes("totally-synthetic-non-delegating-override-fixture"));
  check("RED PROOF's violation count is exactly 4, not vacuously low or over-broad", violations.length === 4);
}

// --- STALE-ENTRY: RED PROOF over a synthetic allowlist (DoD case (a)) ---

{
  const staleSyntheticCorpus = {
    // A genuine, unsafe spawn — a VALID allowlist target.
    "totally-synthetic-valid-allowlist-target": 'const host = new PtyHost(e); host.spawn(x);',
    // A file with NO spawn call at all — listing it is a dead/stale entry.
    "totally-synthetic-dead-allowlist-target-no-hit": 'console.log("nothing to spawn here");',
    // A file whose spawn call IS already covered by a real safe marker — listing it is redundant/stale.
    "totally-synthetic-redundant-allowlist-target-has-marker": BIN_OVERRIDE_SPAWN_FIXTURE_TEXT,
  };
  const staleEntries = findStaleAllowlistEntries(staleSyntheticCorpus, {
    "totally-synthetic-valid-allowlist-target": "ok",
    "totally-synthetic-dead-allowlist-target-no-hit": "stale — DoD case (a)",
    "totally-synthetic-redundant-allowlist-target-has-marker": "stale — already marker-covered",
  });
  check(
    "DoD (a) RED PROOF: a dead allowlist entry (no spawn-call hit at all) IS caught by the STALE-ENTRY check",
    staleEntries.some((s) => s.startsWith("totally-synthetic-dead-allowlist-target-no-hit")),
  );
  check(
    "STALE-ENTRY: a redundant entry (hit exists but already marker-covered) IS ALSO caught",
    staleEntries.some((s) => s.startsWith("totally-synthetic-redundant-allowlist-target-has-marker")),
  );
  check(
    "STALE-ENTRY: a genuinely valid allowlist entry (hit, no marker) is NOT flagged stale",
    !staleEntries.some((s) => s.startsWith("totally-synthetic-valid-allowlist-target")),
  );
  check("STALE-ENTRY synthetic violation count is exactly 2", staleEntries.length === 2);
}

// --- PART A: RED PROOF ---

check(
  "RED PROOF: the opt-in import present but NOT first is correctly rejected",
  !firstImportIsOptIn('import "./_guard.mjs";\nimport "./_real-engine-opt-in.mjs";\n'),
);
check(
  "RED PROOF: the opt-in import missing entirely is correctly rejected",
  !firstImportIsOptIn('import "./_guard.mjs";\nimport fs from "node:fs";\n'),
);
check(
  "GREEN: the opt-in import present AND first is correctly accepted, even with leading comments",
  firstImportIsOptIn('// a header comment\n// another line\nimport "./_real-engine-opt-in.mjs";\nimport "./_guard.mjs";\n'),
);

// --- Population sanity ---

check(`sanity: REAL_ENGINE_SPAWN_BASENAMES is non-empty (found ${REAL_ENGINE_SPAWN_BASENAMES.length})`, REAL_ENGINE_SPAWN_BASENAMES.length > 0);

// --- The real assertions, over the real corpus (readdirSync — sees an uncommitted new file too) ---

const realFiles = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs"));
const basenameToText = {};
for (const f of realFiles) {
  const basename = f.slice(0, -".mjs".length);
  if (basename === OWN_BASENAME || basename === OPT_IN_MODULE_BASENAME || basename === BASENAMES_DATA_MODULE_BASENAME
    || basename === FIXTURES_DATA_MODULE_BASENAME) continue;
  basenameToText[basename] = fs.readFileSync(path.join(TEST_DIR, f), "utf8");
}

// PART A over the real corpus.
const missingBasenames = REAL_ENGINE_SPAWN_BASENAMES.filter((b) => !(b in basenameToText));
check(
  `sanity: every REAL_ENGINE_SPAWN_BASENAMES entry exists as a real file (missing: ${JSON.stringify(missingBasenames)})`,
  missingBasenames.length === 0,
);
const partAViolations = REAL_ENGINE_SPAWN_BASENAMES.filter((b) => basenameToText[b] !== undefined && !firstImportIsOptIn(basenameToText[b]));
check(
  `PART A: every REAL_ENGINE_SPAWN_BASENAMES file imports ./_real-engine-opt-in.mjs as its FIRST import (found ${partAViolations.length} violation(s): ${JSON.stringify(partAViolations)})`,
  partAViolations.length === 0,
);

// PART B over the real corpus — excludes REAL_ENGINE_SPAWN_SET members (Part A already covers those).
const partBCorpus = {};
for (const [basename, text] of Object.entries(basenameToText)) {
  if (REAL_ENGINE_SPAWN_SET.has(basename)) continue;
  partBCorpus[basename] = text;
}
const partBViolations = findUnlistedEngineSpawnCandidates(partBCorpus, NON_ENGINE_ALLOWLIST);
check(
  `PART B: every OTHER test file with a real-engine spawn-call shape carries a safe marker or a reasoned NON_ENGINE_ALLOWLIST entry (found ${partBViolations.length} violation(s): ${JSON.stringify(partBViolations)})`,
  partBViolations.length === 0,
);

// STALE-ENTRY over the REAL NON_ENGINE_ALLOWLIST (never the synthetic one above) — basenameToText already
// excludes REAL_ENGINE_SPAWN_SET members (via basenameToText itself, not partBCorpus) is NOT required here:
// every NON_ENGINE_ALLOWLIST basename is, by construction, a non-REAL_ENGINE_SPAWN_SET file, so reading
// straight from basenameToText is correct and avoids yet another corpus copy.
const staleRealEntries = findStaleAllowlistEntries(basenameToText, NON_ENGINE_ALLOWLIST);
check(
  `STALE-ENTRY: every NON_ENGINE_ALLOWLIST entry carries a genuine spawn-call hit with no safe marker (found ${staleRealEntries.length} stale: ${JSON.stringify(staleRealEntries)})`,
  staleRealEntries.length === 0,
);

console.log(failures === 0
  ? "\n✅ ALL PASS — the spawn-call and safe-marker detectors are proven both ways on synthetic fixtures (a real call-shape is caught, the identical text inside a string/comment is not; each of the three safe markers suppresses a hit on its own merits, never on a comment, a comparison, an empty-string fallback, or a super-delegating override; an allowlisted hit is suppressed), both classifiers are RED-PROVEN against synthetic reproductions with an exact violation count, the STALE-ENTRY check is RED-PROVEN against a synthetic dead/redundant allowlist, and against the REAL corpus: every REAL_ENGINE_SPAWN_BASENAMES file imports the opt-in module first, every other file with a real-engine spawn-call shape is either safely marked or carries a reasoned allowlist entry, and every allowlist entry is itself genuinely needed."
  : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
