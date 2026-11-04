import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text/AST scan below, no Db used
// STANDING GUARD (card 668bc52c). An AST scan over the REAL corpus (readdirSync — sees an uncommitted
// new file too, same reasoning as real-engine-spawn-opt-in-guard.mjs's own header), never a raw
// text/regex match — a regex can't tell a real `process.env.HOME = x` assignment apart from the SAME
// text sitting inside a comment or a string, and a naive "does the file sandbox HOME somewhere" check
// can't tell whether that sandbox actually runs BEFORE the dist import it needs to precede.
//
// WHAT COUNTS AS A HIT: a CallExpression reaching one of the four transcript-path functions
// `pty/claude-transcript.ts` exports — `engineTranscriptPath`/`resolveTranscriptFile`/
// `engineTranscriptExists`/`listAllTranscriptIds` — whether called as a bare identifier (including an
// ALIASED destructure, `{ engineTranscriptPath: etp }` then `etp(...)`) or as a NAMESPACE property
// access off a whole-module binding (`t.engineTranscriptPath(...)`). Resolution is lexically
// scope-aware (card ad3e193c triage item iv) — never a single whole-file last-seen-wins map, which can
// misattribute a call to a same-named binding declared in an unrelated, later-in-source scope —
// EXCLUDING two shapes that can share one of these names while reaching a DIFFERENT resolver than the
// one this guard polices:
//   - the binding is imported from `../dist/pty/codex-transcript.js` — that module's OWN
//     `resolveTranscriptFile` collides in NAME with claude's, but resolves under `realCodexHome()`
//     (its own doc comment: "rather than a second, independently-hardcoded os.homedir()" call that
//     could silently drift from it) — which STILL defaults to the real `os.homedir()/.codex` unless
//     `CODEX_HOME` is set, a real-homedir hazard of its own, just not THIS one: this guard is scoped to
//     claude's `~/.claude/projects` root and never claims codex can't also leak (see card `7f2263fd`,
//     deliberately out of this guard's scope);
//   - the CALL's third argument is the literal string `"codex"` — `sessions/transcript.ts`'s
//     harness-dispatching `resolveTranscriptFile`/`engineTranscriptExists` route a `"codex"` harness
//     argument to the codex resolver internally, so that specific call never reaches claude's path either.
// A file with a remaining hit is SAFE if EITHER:
//   (A) it carries a static or dynamic import of `withEngineTranscriptFixture` from
//       `./_transcript-fixture.mjs` — a SECOND, pre-existing, deliberate convention (card `99aedfa0`) for
//       this exact hazard: it still writes under the real homedir, but with teardown GUARANTEED (a
//       try/finally that THROWS if its own real-homedir dir survives teardown), not merely best-effort.
//       This marks the WHOLE FILE safe, same posture as the real-engine-spawn guard's own
//       `createSeamHost(` marker — a file using this helper is trusted not to ALSO leave some OTHER,
//       untracked real-homedir write lying around; or
//   (B) it is sandboxed: ALL of the following hold —
//       (1) it carries NO static `ImportDeclaration` whose module specifier contains "dist/" — a static
//           import is HOISTED (it always executes before every other top-level statement in the module,
//           regardless of where it sits in the source text), so if one exists, a HOME/USERPROFILE/
//           CLAUDE_CONFIG_DIR override written anywhere else in the file can never be guaranteed to
//           precede whatever the imported dist module graph does at its own load time. `claudeProjectsRoot()`
//           (`pty/claude-transcript.ts`) is a FUNCTION, read fresh per call via `claudeConfigHome()` (card
//           `a92a0913`) — it is NOT a module-level constant captured once at import — but this guard still
//           refuses a static import rather than trust every transitively-imported dist module to be
//           equally lazy; convert to a dynamic `await import()` placed after the sandbox instead. A
//           static import of a LOCAL HELPER module that itself statically imports dist is the SAME
//           hazard one level removed (triage item v) — that helper's own hoisted import still runs at
//           its own module-load time, before anything in THIS file's body, however correctly this
//           file's own sandbox is ordered; `findTransitiveStaticDistImport` reads the helper's own text
//           (one level deep) to catch it.
//       (2) it carries a `process.env.HOME = <non-empty>` assignment AND a `process.env.USERPROFILE =
//           <non-empty>` assignment (real `=` syntax, never `==`/`===`/a comment/a string) that are each
//           a genuinely TOP-LEVEL statement (never sitting inside a function body this guard has no way
//           to prove is ever actually CALLED — triage item iii) and BOTH appear, in source order,
//           strictly BEFORE the file's FIRST dynamic `import("...dist/...")` call — the only shape that
//           can actually precede a dist import's own load time.
//       (3) it ALSO carries a TOP-LEVEL `delete process.env.CLAUDE_CONFIG_DIR;` or a non-empty
//           `process.env.CLAUDE_CONFIG_DIR = <redirect>;` assignment, strictly before that SAME first
//           dynamic dist import — `claudeConfigHome()` (`pty/claude-config.ts`) reads `CLAUDE_CONFIG_DIR`
//           ahead of `os.homedir()` (card `a92a0913`), so a sandboxed HOME/USERPROFILE alone is not
//           enough: an ambient `CLAUDE_CONFIG_DIR` would still redirect every transcript-path read to the
//           real config dir.
//       A file with a transcript-fn hit but no dist import of EITHER kind in its own text is an
//           unrecognized shape and fails closed, same posture as `real-home-scope-guard.mjs`'s own
//           fail-closed branch.
// A hit failing any condition, and not itself in `NON_SANDBOXED_ALLOWLIST` below, FAILS. A separate
// STALE-ENTRY assertion fails loud if any allowlist entry does NOT itself carry a genuine, currently-
// unsafe hit — the same posture `real-engine-spawn-opt-in-guard.mjs`'s own stale-entry check and
// `role-surface-tools-named-in-doctrine.mjs`'s own ALLOWLIST check use: a stale entry is a silent future
// exemption the moment that file's own shape changes, not a narrowed allowlist.
//
// @decision 668bc52c — never widen this to a text/regex scan: a regex can't distinguish a real
// `process.env.HOME =` assignment from the same text in a comment/string/`==` comparison, and would
// both false-positive and false-negative on this exact corpus.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  parseSource, lineOf, resolveBinding, findStaticDistImports, findDynamicDistImports,
  isInsideFunctionLike, findTransitiveStaticDistImport,
} from "./_realhome-sandbox-ast.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const OWN_BASENAME = path.basename(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TRANSCRIPT_FN_NAMES = new Set([
  "engineTranscriptPath", "resolveTranscriptFile", "engineTranscriptExists", "listAllTranscriptIds",
]);

// Judgment-curated, one-line reason each, confirmed by reading the file (never copied from a prior
// memory note on trust — see this card's own worker_report). A file belongs here only if its real-home
// write is deliberate AND already carries its own enumerated cleanup; it is pre-existing debt this card
// was not asked to fix, not a shape this guard should treat as safe going forward.
const NON_SANDBOXED_ALLOWLIST = {
  // Every file card ad3e193c was dispatched to convert (the seven found BY THIS GUARD plus the three
  // known-debt files card 668bc52c itself allowlisted) is now sandboxed and removed from this list.
  "worktrees.mjs": "calls engineTranscriptPath(...) ONLY to compare two computed path STRINGS (a pure function of its cwd argument) — never writes a file via it, so there is nothing to sandbox against.",
  "_probe-paste-stranded-resume.mjs": "a REAL-CLAUDE STANDALONE PROBE (its own header: \"NOT hermetic CI — needs a logged-in claude\"), never run as part of the hermetic suite/guards — out of scope for this hermeticity convention by design.",
  // Card a92a0913 round 2: a deliberately DIFFERENT (per-scenario, not once-before-import) sandbox shape
  // — it tests CLAUDE_CONFIG_DIR itself, so each scenario sets HOME/USERPROFILE/CLAUDE_CONFIG_DIR freshly
  // right before its own engineTranscriptPath() call, never once at module top. Never touches the real
  // homedir (every scenario sandboxes before its own use), but this guard's ordering check can't express
  // a per-scenario pattern — see card a92a0913's own decision record and that file's own header comment.
  "claude-config-dir-shared-resolver.mjs": "sandboxes HOME/USERPROFILE/CLAUDE_CONFIG_DIR per-scenario (deliberately — it tests the CLAUDE_CONFIG_DIR override itself), always before that scenario's own use, never once before the module's top-level dist import.",
};

/** Every transcript-fn call-site hit in `sf`, as `{name, line}` — covers a bare-identifier call
 *  (`engineTranscriptPath(...)`, including an ALIASED destructure like `{ engineTranscriptPath: etp }`
 *  then `etp(...)` — card ad3e193c triage item i) and a NAMESPACE call (`t.engineTranscriptPath(...)`
 *  off a whole-module binding — triage item ii). Excludes a binding scope-resolved to
 *  codex-transcript.js, and a call whose third argument is the literal `"codex"` (see the header's
 *  "WHAT COUNTS AS A HIT" for why both are never a real-homedir reach). When a bare identifier's own
 *  name literally matches a TRANSCRIPT_FN_NAME but no import binding resolves at all (e.g. a same-named
 *  local helper with no traceable import), it still counts as a hit — fails CLOSED, never silently
 *  excluded just because resolution came up empty. */
function findTranscriptFnHits(sf) {
  const hits = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let matchedName = null;
      let source; // resolved module spec used for the codex exclusion, or undefined if unresolved
      if (ts.isIdentifier(callee)) {
        const decl = resolveBinding(callee, callee.text);
        if (decl && TRANSCRIPT_FN_NAMES.has(decl.realName)) {
          matchedName = decl.realName;
          source = decl.spec;
        } else if (!decl && TRANSCRIPT_FN_NAMES.has(callee.text)) {
          matchedName = callee.text; // unresolved — fail closed, source stays undefined (never codex-excluded)
        }
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && TRANSCRIPT_FN_NAMES.has(callee.name.text)) {
        matchedName = callee.name.text;
        source = resolveBinding(callee.expression, callee.expression.text)?.spec;
      }
      if (matchedName) {
        const isCodexBound = typeof source === "string" && source.includes("codex-transcript");
        const thirdArg = node.arguments[2];
        const isCodexCall = thirdArg && ts.isStringLiteralLike(thirdArg) && thirdArg.text === "codex";
        if (!isCodexBound && !isCodexCall) hits.push({ name: matchedName, line: lineOf(sf, node) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits;
}

/** Is `node` the AST shape `process.env.HOME` / `process.env.USERPROFILE`? Returns "HOME"/"USERPROFILE"/null. */
function processEnvHomeTarget(node) {
  if (!ts.isPropertyAccessExpression(node)) return null;
  if (node.name.text !== "HOME" && node.name.text !== "USERPROFILE") return null;
  const inner = node.expression;
  if (ts.isPropertyAccessExpression(inner) && inner.name.text === "env"
    && ts.isIdentifier(inner.expression) && inner.expression.text === "process") {
    return node.name.text;
  }
  return null;
}

/** Every TOP-LEVEL `process.env.HOME = <non-empty>` / `process.env.USERPROFILE = <non-empty>`
 *  assignment in `sf`, as `{ target: "HOME"|"USERPROFILE", line }` — real `=` syntax only, never
 *  `==`/`===`, never an empty-string RHS (a no-op override, same reasoning as the real-engine guard's
 *  own LOOM_CLAUDE_BIN check), and never one sitting inside a function body (triage item iii — see
 *  `isInsideFunctionLike`'s own doc). */
function findHomeOverrideAssignments(sf) {
  const hits = [];
  function visit(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = processEnvHomeTarget(node.left);
      if (target) {
        const rhs = node.right;
        const rhsIsEmptyString = ts.isStringLiteralLike(rhs) && rhs.text === "";
        if (!rhsIsEmptyString && !isInsideFunctionLike(node)) hits.push({ target, line: lineOf(sf, node) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits;
}

/** Is `node` the AST shape `process.env.CLAUDE_CONFIG_DIR`? */
function isProcessEnvConfigDir(node) {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "CLAUDE_CONFIG_DIR") return false;
  const inner = node.expression;
  return ts.isPropertyAccessExpression(inner) && inner.name.text === "env"
    && ts.isIdentifier(inner.expression) && inner.expression.text === "process";
}

/** Every TOP-LEVEL line in `sf` that either DELETES `process.env.CLAUDE_CONFIG_DIR` or ASSIGNS it a
 *  non-empty value (real `delete`/`=` syntax only) — never one sitting inside a function body (triage
 *  item iii, same reasoning as `findHomeOverrideAssignments`).
 *  @decision a92a0913 — HOME/USERPROFILE alone isn't enough; claudeConfigHome() reads this var first. */
function findConfigDirHandling(sf) {
  const hits = [];
  function visit(node) {
    if (ts.isDeleteExpression(node) && isProcessEnvConfigDir(node.expression) && !isInsideFunctionLike(node)) {
      hits.push({ line: lineOf(sf, node) });
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isProcessEnvConfigDir(node.left)) {
      const rhs = node.right;
      const rhsIsEmptyString = ts.isStringLiteralLike(rhs) && rhs.text === "";
      if (!rhsIsEmptyString && !isInsideFunctionLike(node)) hits.push({ line: lineOf(sf, node) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits;
}

/** Does `sf` import `withEngineTranscriptFixture` from `./_transcript-fixture.mjs`, in either a static
 *  or dynamic form? That shared helper (card 99aedfa0) writes under the real homedir too, but with
 *  teardown GUARANTEED (throws if its own dir survives) — see this guard's header, marker (A). */
function importsSharedFixtureHelper(sf) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
      && node.moduleSpecifier.text.endsWith("_transcript-fixture.mjs")
      && node.importClause && node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.some((el) => el.name.text === "withEngineTranscriptFixture")) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg) && arg.text.endsWith("_transcript-fixture.mjs")) {
        // Dynamic form: can't see the destructured name from the import call site alone — the caller's
        // own VariableDeclaration binding pattern is a separate node. Conservative: treat ANY dynamic
        // import of this module as carrying the marker (the module exports only this one function).
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

/** Cheap substring prefilter: none of the four TRANSCRIPT_FN_NAMES appears ANYWHERE in `text` (as plain
 *  text, before any parse) means there is no possible way a call to one of them — aliased, namespaced,
 *  or bare — could exist in this file, since even an ALIASED destructure (`{ engineTranscriptPath: etp
 *  }`) still carries the real name as literal text in its own import clause. Skips `parseSource` + the
 *  AST walk entirely for a file that can't possibly hit (perf: triage item, ~96% of this corpus). */
function mentionsAnyTranscriptFnName(text) {
  for (const name of TRANSCRIPT_FN_NAMES) if (text.includes(name)) return true;
  return false;
}

// The one-level-deep transitive static-dist-import check (card ad3e193c triage item v) is the shared
// {@link findTransitiveStaticDistImport} (`_realhome-sandbox-ast.mjs`) — this guard passes
// `_transcript-fixture.mjs` (marker A's own helper, already handled by `importsSharedFixtureHelper`
// above) as its exclude-list, since that helper's own static dist import is a KNOWN, already-handled
// hazard, not a NEW one this check should also flag.

/** Classifies one file's text: `{ hasHit, isSafe, code, reason }`. `reason` is a short diagnostic
 *  string, always set (even when safe), so a violation report can explain itself without re-deriving it.
 *  `code` is a STABLE, machine-checkable discriminant for WHY a hit is unsafe (or how it's safe) — see
 *  "Card a92a0913 round 3" below for why this exists: `reason` alone is free text, too loose to gate an
 *  allowlist exemption on "is this UNSAFE FOR THE SPECIFIC REASON THE ALLOWLIST ENTRY WAS WRITTEN FOR",
 *  as opposed to "is this unsafe for ANY reason at all". */
function classify(text, baseDir = TEST_DIR) {
  if (!mentionsAnyTranscriptFnName(text)) {
    return { hasHit: false, isSafe: true, code: "no-hit", reason: "no transcript-fn name present as text (prefilter)" };
  }
  const sf = parseSource(text);
  const fnHits = findTranscriptFnHits(sf);
  if (fnHits.length === 0) return { hasHit: false, isSafe: true, code: "no-hit", reason: "no transcript-fn call" };

  if (importsSharedFixtureHelper(sf)) {
    return { hasHit: true, isSafe: true, code: "safe-fixture-helper", reason: "uses the shared withEngineTranscriptFixture helper (marker A — guaranteed teardown)" };
  }

  const staticDist = findStaticDistImports(sf);
  if (staticDist.length > 0) {
    return {
      hasHit: true, isSafe: false, code: "static-import",
      reason: `static import of ${JSON.stringify(staticDist[0].spec)} at line ${staticDist[0].line} — ` +
        `hoisted, so no override in this file can ever precede it; convert to a dynamic await import() after the sandbox`,
    };
  }

  const transitive = findTransitiveStaticDistImport(sf, baseDir, ["_transcript-fixture.mjs"]);
  if (transitive) {
    return {
      hasHit: true, isSafe: false, code: "transitive-static-import",
      reason: `static import of local helper ${JSON.stringify(transitive.spec)} at line ${transitive.line} itself ` +
        `statically imports ${JSON.stringify(transitive.transitiveSpec)} — hoisted transitively, so no override in ` +
        `this file can ever precede it`,
    };
  }

  const dynamicDist = findDynamicDistImports(sf);
  if (dynamicDist.length === 0) {
    return { hasHit: true, isSafe: false, code: "unrecognized-shape", reason: "unrecognized shape: a transcript-fn call with no dist import of either kind in this file (fails closed)" };
  }
  const firstDynamicDistLine = Math.min(...dynamicDist.map((h) => h.line));

  const overrides = findHomeOverrideAssignments(sf);
  const homeLine = overrides.filter((o) => o.target === "HOME").map((o) => o.line);
  const userProfileLine = overrides.filter((o) => o.target === "USERPROFILE").map((o) => o.line);
  if (homeLine.length === 0 || userProfileLine.length === 0) {
    return { hasHit: true, isSafe: false, code: "missing-home-userprofile", reason: "missing a process.env.HOME and/or process.env.USERPROFILE override assignment" };
  }
  const homeOk = homeLine.some((l) => l < firstDynamicDistLine);
  const userProfileOk = userProfileLine.some((l) => l < firstDynamicDistLine);
  if (!homeOk || !userProfileOk) {
    return {
      hasHit: true, isSafe: false, code: "home-userprofile-ordering",
      reason: `HOME/USERPROFILE override does not precede the first dynamic dist import (line ${firstDynamicDistLine})`,
    };
  }

  // @decision a92a0913 — a HOME/USERPROFILE sandbox alone is not enough: claudeConfigHome() reads
  // CLAUDE_CONFIG_DIR ahead of os.homedir(), so an ambient value must ALSO be deleted or redirected.
  const configDirHandling = findConfigDirHandling(sf);
  if (!configDirHandling.some((h) => h.line < firstDynamicDistLine)) {
    return {
      hasHit: true, isSafe: false, code: "configdir-missing",
      reason: "HOME/USERPROFILE sandboxed, but no CLAUDE_CONFIG_DIR delete/redirect precedes the first dynamic dist import",
    };
  }
  return { hasHit: true, isSafe: true, code: "safe", reason: "sandboxed before the first dist import" };
}

// --- Sanity / positive+negative controls on the DETECTORS THEMSELVES ---

check(
  "sanity: a synthetic engineTranscriptPath( call IS detected",
  findTranscriptFnHits(parseSource('const f = engineTranscriptPath(cwd, id);')).length === 1,
);
check(
  "sanity: a synthetic resolveTranscriptFile( call IS detected",
  findTranscriptFnHits(parseSource('resolveTranscriptFile(cwd, id);')).length === 1,
);
check(
  "sanity: the same call-shape text INSIDE a template-literal string (data, not code) is NOT detected (negative control)",
  findTranscriptFnHits(parseSource('const snippet = `engineTranscriptPath(cwd, id)`;')).length === 0,
);
check(
  "sanity: the same shape inside a line COMMENT is NOT detected",
  findTranscriptFnHits(parseSource('// engineTranscriptPath(cwd, id) looks like a call here but is only a comment')).length === 0,
);
check(
  "sanity: a resolveTranscriptFile( call bound from codex-transcript.js is NOT a hit (negative control)",
  findTranscriptFnHits(parseSource(
    'const { resolveTranscriptFile } = await import("../dist/pty/codex-transcript.js");\nresolveTranscriptFile(cwd, id);',
  )).length === 0,
);
check(
  "sanity: the SAME name bound from sessions/transcript.js (claude-reachable) IS still a hit (proves the exclusion is source-scoped, not name-scoped)",
  findTranscriptFnHits(parseSource(
    'const { resolveTranscriptFile } = await import("../dist/sessions/transcript.js");\nresolveTranscriptFile(cwd, id);',
  )).length === 1,
);
check(
  'sanity: a call whose third argument is the literal "codex" is NOT a hit (negative control)',
  findTranscriptFnHits(parseSource(
    'const { resolveTranscriptFile } = await import("../dist/sessions/transcript.js");\nresolveTranscriptFile(cwd, id, "codex");',
  )).length === 0,
);
check(
  'sanity: the SAME call with NO third argument IS still a hit (proves the exclusion is literal-scoped, not blanket)',
  findTranscriptFnHits(parseSource(
    'const { resolveTranscriptFile } = await import("../dist/sessions/transcript.js");\nresolveTranscriptFile(cwd, id);',
  )).length === 1,
);
check(
  'sanity: the SAME call with a non-literal third argument (a variable) IS still a hit (fails closed, never assumed codex)',
  findTranscriptFnHits(parseSource(
    'const { resolveTranscriptFile } = await import("../dist/sessions/transcript.js");\nresolveTranscriptFile(cwd, id, harness);',
  )).length === 1,
);
check(
  "sanity: a static import of withEngineTranscriptFixture IS detected as marker A",
  importsSharedFixtureHelper(parseSource('import { withEngineTranscriptFixture } from "./_transcript-fixture.mjs";')),
);
check(
  "sanity: a dynamic import of _transcript-fixture.mjs IS detected as marker A",
  importsSharedFixtureHelper(parseSource('const { withEngineTranscriptFixture } = await import("./_transcript-fixture.mjs");')),
);
check(
  "sanity: a file with NO import of _transcript-fixture.mjs is NOT marked safe by marker A (negative control)",
  !importsSharedFixtureHelper(parseSource('import { x } from "./_tmp-fixture.mjs";')),
);
check(
  "sanity: a static dist import IS detected",
  findStaticDistImports(parseSource('import { x } from "../dist/sessions/transcript.js";')).length === 1,
);
check(
  "sanity: a static import of a NON-dist module is NOT detected",
  findStaticDistImports(parseSource('import { x } from "node:fs";')).length === 0,
);
check(
  "sanity: a dynamic dist import IS detected",
  findDynamicDistImports(parseSource('const { x } = await import("../dist/sessions/transcript.js");')).length === 1,
);
check(
  "sanity: a `process.env.HOME = sandboxHome;` assignment IS detected as a HOME override",
  findHomeOverrideAssignments(parseSource('process.env.HOME = sandboxHome;')).some((h) => h.target === "HOME"),
);
check(
  "ITEM: a `==` comparison against process.env.HOME is NOT a safe override (the old regex risk this AST avoids)",
  findHomeOverrideAssignments(parseSource('if (process.env.HOME == x) {}')).length === 0,
);
check(
  "ITEM: an EMPTY-STRING assignment to process.env.USERPROFILE is NOT a safe override (a no-op fallback)",
  findHomeOverrideAssignments(parseSource('process.env.USERPROFILE = "";')).length === 0,
);
check(
  "ITEM: a mention in a COMMENT (a HOME-override-looking assignment, textually) is NOT a safe override",
  findHomeOverrideAssignments(parseSource('// process.env.HOME = sandboxHome;')).length === 0,
);
check(
  "sanity: `delete process.env.CLAUDE_CONFIG_DIR;` IS detected as config-dir handling",
  findConfigDirHandling(parseSource('delete process.env.CLAUDE_CONFIG_DIR;')).length === 1,
);
check(
  "sanity: `process.env.CLAUDE_CONFIG_DIR = sandboxHome;` IS detected as config-dir handling",
  findConfigDirHandling(parseSource('process.env.CLAUDE_CONFIG_DIR = sandboxHome;')).length === 1,
);
check(
  "ITEM: an EMPTY-STRING assignment to CLAUDE_CONFIG_DIR is NOT a safe handling (a no-op fallback)",
  findConfigDirHandling(parseSource('process.env.CLAUDE_CONFIG_DIR = "";')).length === 0,
);
check(
  "ITEM: a `==` comparison against CLAUDE_CONFIG_DIR is NOT a safe handling",
  findConfigDirHandling(parseSource('if (process.env.CLAUDE_CONFIG_DIR == x) {}')).length === 0,
);
check(
  "ITEM: a mention in a COMMENT (a delete-looking statement, textually) is NOT a safe handling",
  findConfigDirHandling(parseSource('// delete process.env.CLAUDE_CONFIG_DIR;')).length === 0,
);
check(
  "ITEM: deleting a DIFFERENT env var is NOT mistaken for config-dir handling",
  findConfigDirHandling(parseSource('delete process.env.HOME;')).length === 0,
);

// --- Card ad3e193c triage: the five fail-open shapes closed this round, each RED-first ---

check(
  "RED PROOF (i): an ALIASED destructure call (`{ engineTranscriptPath: etp }` then `etp(...)`) IS still detected as a hit",
  findTranscriptFnHits(parseSource(
    'const { engineTranscriptPath: etp } = await import("../dist/sessions/transcript.js");\netp(cwd, id);',
  )).length === 1,
);
check(
  "sanity (i): the SAME aliased shape, bound from codex-transcript.js, is still excluded (codex-scoped, not this guard's hazard)",
  findTranscriptFnHits(parseSource(
    'const { resolveTranscriptFile: rtf } = await import("../dist/pty/codex-transcript.js");\nrtf(cwd, id);',
  )).length === 0,
);
check(
  "RED PROOF (ii): a NAMESPACE call (`const t = await import(...); t.engineTranscriptPath(...)`) IS detected as a hit",
  findTranscriptFnHits(parseSource(
    'const t = await import("../dist/sessions/transcript.js");\nt.engineTranscriptPath(cwd, id);',
  )).length === 1,
);
check(
  "sanity (ii): the SAME namespace shape, bound from codex-transcript.js, is still excluded",
  findTranscriptFnHits(parseSource(
    'const t = await import("../dist/pty/codex-transcript.js");\nt.resolveTranscriptFile(cwd, id);',
  )).length === 0,
);
check(
  "ITEM (iii): a HOME override sitting inside a function body is NOT a top-level override (never-called-function fail-open)",
  findHomeOverrideAssignments(parseSource('function neverCalled() { process.env.HOME = x; }')).length === 0,
);
check(
  "ITEM (iii): the SAME shape inside an ARROW function body is also NOT a top-level override",
  findHomeOverrideAssignments(parseSource('const neverCalled = () => { process.env.HOME = x; };')).length === 0,
);
check(
  "ITEM (iii): a CLAUDE_CONFIG_DIR delete sitting inside a function body is NOT a top-level handling either",
  findConfigDirHandling(parseSource('function neverCalled() { delete process.env.CLAUDE_CONFIG_DIR; }')).length === 0,
);
check(
  "sanity (iii): a genuinely TOP-LEVEL override (not inside any function) IS still detected",
  findHomeOverrideAssignments(parseSource('process.env.HOME = x;')).length === 1,
);
check(
  "RED PROOF (iii): a full fixture whose HOME/USERPROFILE override sits inside a NEVER-CALLED function is still flagged unsafe end to end",
  classify(
    'function neverCalled() {\n  process.env.HOME = sandboxHome;\n  process.env.USERPROFILE = sandboxHome;\n}\n' +
    'const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");\nengineTranscriptPath(cwd, id);',
  ).isSafe === false,
);
{
  // (iv) a LATER, BLOCK-SCOPED codex-bound re-declaration of the SAME local name must not retroactively
  // un-flag an EARLIER, module-scope claude-bound call — the old whole-file last-seen-wins map conflated
  // both call sites onto whichever declaration of "engineTranscriptPath" was visited LAST in the tree
  // walk (the block's own, later in source), silently excluding the real, module-scope claude hit too.
  const SHADOW_FIXTURE =
    'const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");\n' +
    'engineTranscriptPath(cwd, claudeId);\n' + // real, module-scope claude hit — must still fire
    '{\n' +
    '  const { engineTranscriptPath } = await import("../dist/pty/codex-transcript.js");\n' +
    '  engineTranscriptPath(cwd, codexId);\n' + // block-scoped codex binding — correctly excluded
    '}\n';
  const shadowHits = findTranscriptFnHits(parseSource(SHADOW_FIXTURE));
  check(
    "RED PROOF (iv): a later block-scoped codex re-declaration of the SAME name does not retroactively un-flag the earlier module-scope claude call",
    shadowHits.length === 1,
  );
  check("sanity (iv): the one surviving hit is the FIRST (module-scope, claude) call, not the block-scoped one",
    shadowHits[0]?.line === 2);
}
{
  // (v) a static import of a LOCAL HELPER that itself statically imports dist is a hoisted transitive
  // hazard this file's own correctly-placed, correctly-ordered sandbox can never precede.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trsg-transitive-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "_wraps-dist.mjs"),
      'import { engineTranscriptPath } from "../dist/sessions/transcript.js";\n' +
        'export function wrapped(cwd, id) { return engineTranscriptPath(cwd, id); }\n',
    );
    fs.writeFileSync(path.join(tmpDir, "_no-dist.mjs"), 'export function helperFn() { return 1; }\n');

    const UNSAFE_TRANSITIVE =
      'import { wrapped } from "./_wraps-dist.mjs";\n' + // this helper's OWN static dist import already ran
      'process.env.HOME = sandboxHome;\nprocess.env.USERPROFILE = sandboxHome;\ndelete process.env.CLAUDE_CONFIG_DIR;\n' +
      'const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");\n' +
      'engineTranscriptPath(cwd, id);\nwrapped(cwd, id);';
    check(
      "RED PROOF (v): a static import of a local helper that itself statically imports dist IS flagged unsafe, even though THIS file's own direct dynamic import is correctly sandboxed",
      classify(UNSAFE_TRANSITIVE, tmpDir).isSafe === false,
    );
    check("sanity (v): the REAL classify() codes it as transitive-static-import specifically",
      classify(UNSAFE_TRANSITIVE, tmpDir).code === "transitive-static-import");

    const SAFE_NONTRANSITIVE =
      'import { helperFn } from "./_no-dist.mjs";\n' +
      'process.env.HOME = sandboxHome;\nprocess.env.USERPROFILE = sandboxHome;\ndelete process.env.CLAUDE_CONFIG_DIR;\n' +
      'const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");\nengineTranscriptPath(cwd, id);';
    check(
      "GREEN (v): a static import of a local helper that does NOT itself import dist is not flagged by the transitive check",
      classify(SAFE_NONTRANSITIVE, tmpDir).isSafe === true,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
check(
  "sanity (v): a static import of ./_transcript-fixture.mjs ITSELF is excluded from the transitive check (it's marker A's own helper — that static dist import is a KNOWN, already-handled hazard, not a NEW one)",
  findTransitiveStaticDistImport(parseSource('import { withEngineTranscriptFixture } from "./_transcript-fixture.mjs";'), TEST_DIR, ["_transcript-fixture.mjs"]) === null,
);
check(
  "sanity: the text.includes() prefilter correctly finds NO hit for a file mentioning none of the four names",
  classify('console.log("nothing transcript-shaped here");').hasHit === false,
);
check(
  "sanity: the prefilter does not FALSE-NEGATIVE a real hit (still parses + detects when the name IS present)",
  classify('const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");\nengineTranscriptPath(cwd, id);').hasHit === true,
);

// --- RED PROOF (must be able to fail) before trusting a real-corpus zero ---

{
  const UNSAFE_NO_OVERRIDE = 'const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");\nengineTranscriptPath(cwd, id);';
  const UNSAFE_STATIC_IMPORT = 'import { engineTranscriptPath } from "../dist/sessions/transcript.js";\nengineTranscriptPath(cwd, id);';
  const UNSAFE_OVERRIDE_AFTER_IMPORT =
    'const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");\n' +
    'process.env.HOME = sandboxHome;\nprocess.env.USERPROFILE = sandboxHome;\nengineTranscriptPath(cwd, id);';
  const UNSAFE_ONLY_HOME_NOT_USERPROFILE =
    'process.env.HOME = sandboxHome;\nconst { engineTranscriptPath } = await import("../dist/sessions/transcript.js");\nengineTranscriptPath(cwd, id);';
  const UNSAFE_NO_CONFIGDIR_HANDLING =
    'process.env.HOME = sandboxHome;\nprocess.env.USERPROFILE = sandboxHome;\n' +
    'const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");\nengineTranscriptPath(cwd, id);';
  const UNSAFE_CONFIGDIR_HANDLED_AFTER_IMPORT =
    'process.env.HOME = sandboxHome;\nprocess.env.USERPROFILE = sandboxHome;\n' +
    'const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");\n' +
    'delete process.env.CLAUDE_CONFIG_DIR;\nengineTranscriptPath(cwd, id);';
  const SAFE_SANDBOXED_CONFIGDIR_DELETED =
    'process.env.HOME = sandboxHome;\nprocess.env.USERPROFILE = sandboxHome;\ndelete process.env.CLAUDE_CONFIG_DIR;\n' +
    'const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");\nengineTranscriptPath(cwd, id);';
  const SAFE_SANDBOXED_CONFIGDIR_REDIRECTED =
    'process.env.HOME = sandboxHome;\nprocess.env.USERPROFILE = sandboxHome;\nprocess.env.CLAUDE_CONFIG_DIR = sandboxHome;\n' +
    'const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");\nengineTranscriptPath(cwd, id);';
  const SAFE_NO_HIT = 'console.log("nothing to see here");';
  const SAFE_VIA_FIXTURE_HELPER =
    'import { withEngineTranscriptFixture } from "./_transcript-fixture.mjs";\n' +
    'import { engineTranscriptPath } from "../dist/sessions/transcript.js";\n' + // a static dist import too — must NOT matter under marker A
    'withEngineTranscriptFixture({}, (cwd) => { engineTranscriptPath(cwd, id); });';

  check("RED PROOF: no override at all IS flagged unsafe", classify(UNSAFE_NO_OVERRIDE).isSafe === false);
  check("RED PROOF: a static dist import IS flagged unsafe even with an override present elsewhere", classify(UNSAFE_STATIC_IMPORT).isSafe === false);
  check("RED PROOF: an override placed AFTER the dynamic import IS flagged unsafe (ordering)", classify(UNSAFE_OVERRIDE_AFTER_IMPORT).isSafe === false);
  check("RED PROOF: HOME overridden but USERPROFILE missing IS flagged unsafe", classify(UNSAFE_ONLY_HOME_NOT_USERPROFILE).isSafe === false);
  check("RED PROOF: HOME/USERPROFILE sandboxed but CLAUDE_CONFIG_DIR not handled IS flagged unsafe", classify(UNSAFE_NO_CONFIGDIR_HANDLING).isSafe === false);
  check("RED PROOF: CLAUDE_CONFIG_DIR handled only AFTER the dynamic import IS flagged unsafe (ordering)", classify(UNSAFE_CONFIGDIR_HANDLED_AFTER_IMPORT).isSafe === false);
  check("GREEN: HOME/USERPROFILE sandboxed + CLAUDE_CONFIG_DIR deleted, all before the dynamic import, is NOT flagged", classify(SAFE_SANDBOXED_CONFIGDIR_DELETED).isSafe === true);
  check("GREEN: HOME/USERPROFILE sandboxed + CLAUDE_CONFIG_DIR redirected into the sandbox, all before the dynamic import, is NOT flagged", classify(SAFE_SANDBOXED_CONFIGDIR_REDIRECTED).isSafe === true);
  check("GREEN: a file with no transcript-fn call at all is NOT flagged", classify(SAFE_NO_HIT).isSafe === true && classify(SAFE_NO_HIT).hasHit === false);
  check("GREEN: marker A (the shared fixture helper) is safe even with a static dist import present (it overrides the ordering check entirely)", classify(SAFE_VIA_FIXTURE_HELPER).isSafe === true);

  // POSITIVE CONTROL (card b777dccc, manager-requested): the exact `.code` discriminant, on the REAL,
  // unmutated classify() — the same function the `violations` filter further below calls, never a
  // re-implemented predicate — plus its inverse. `isSafe` alone (checked above) doesn't prove the SPECIFIC
  // reason is "configdir-missing" rather than some other unsafe code.
  check("POSITIVE CONTROL: the REAL classify() codes a HOME/USERPROFILE-sandboxed, CLAUDE_CONFIG_DIR-unhandled fixture as configdir-missing",
    classify(UNSAFE_NO_CONFIGDIR_HANDLING).code === "configdir-missing");
  check("INVERSE: the REAL classify() codes the SAME fixture plus a CLAUDE_CONFIG_DIR delete as safe",
    classify(SAFE_SANDBOXED_CONFIGDIR_DELETED).code === "safe");

  // MUTATION TEST (lesson 303: a check that can only ever pass is indistinguishable from a broken one).
  // Textually disables classify()'s OWN configdir-missing branch — never a re-implemented copy of its
  // logic — by mutating classify.toString()'s real source text and reconstructing it via `new Function`,
  // wired to the SAME helper closures classify() itself calls. Proves the positive control above is
  // load-bearing: if classify() regressed to never flag configdir-missing, this fixture would silently
  // stop being a violation.
  const CONFIGDIR_BRANCH_CONDITION = "if (!configDirHandling.some((h) => h.line < firstDynamicDistLine)) {";
  const classifySource = classify.toString();
  check("sanity: the CLAUDE_CONFIG_DIR branch condition text is present in classify()'s own source (so the mutation below targets something real, not a stale string)",
    classifySource.includes(CONFIGDIR_BRANCH_CONDITION));
  const mutatedSource = classifySource.replace(CONFIGDIR_BRANCH_CONDITION, "if (false) {");
  check("sanity: the mutation actually changed classify()'s source text", mutatedSource !== classifySource);
  const classifyMutant = new Function(
    "TEST_DIR", "mentionsAnyTranscriptFnName", "parseSource", "findTranscriptFnHits", "importsSharedFixtureHelper",
    "findStaticDistImports", "findTransitiveStaticDistImport", "findDynamicDistImports",
    "findHomeOverrideAssignments", "findConfigDirHandling",
    `return (${mutatedSource});`,
  )(TEST_DIR, mentionsAnyTranscriptFnName, parseSource, findTranscriptFnHits, importsSharedFixtureHelper, findStaticDistImports, findTransitiveStaticDistImport, findDynamicDistImports, findHomeOverrideAssignments, findConfigDirHandling);

  const mutantResult = classifyMutant(UNSAFE_NO_CONFIGDIR_HANDLING);
  check("RED PROOF: the mutant (configdir-missing branch disabled) no longer codes the bad fixture as configdir-missing — proves the mutation actually took",
    mutantResult.code !== "configdir-missing" && mutantResult.isSafe === true);

  const realClassification = classify(UNSAFE_NO_CONFIGDIR_HANDLING);
  const realWouldFlagAsViolation = realClassification.hasHit && !realClassification.isSafe;
  const mutantWouldFlagAsViolation = mutantResult.hasHit && !mutantResult.isSafe;
  check("RED PROOF: the REAL classify() flags this fixture as a violation (hasHit && !isSafe)", realWouldFlagAsViolation === true);
  check("RED PROOF: the guard goes RED under the mutation — the mutant wrongly calls the SAME fixture safe, where the real classify() flags it as a violation",
    mutantWouldFlagAsViolation === false);
}

// --- Population sanity + the real corpus ---

const realFiles = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs") && f !== OWN_BASENAME);
const basenameToText = {};
for (const f of realFiles) basenameToText[f] = fs.readFileSync(path.join(TEST_DIR, f), "utf8");

check(`sanity: the real corpus is non-trivially sized (found ${realFiles.length} files)`, realFiles.length > 100);

const realClassifications = {};
for (const [f, text] of Object.entries(basenameToText)) realClassifications[f] = classify(text);

const hitCount = Object.values(realClassifications).filter((c) => c.hasHit).length;
check(`sanity: at least one real file carries a transcript-fn hit (found ${hitCount})`, hitCount > 0);

// Card b777dccc: CONFIGDIR_NOT_HANDLED_ALLOWLIST (card a92a0913 round 2's discovery-exemption for the
// ~50 pre-existing fixtures this guard's CLAUDE_CONFIG_DIR widening surfaced) is GONE — every one of
// those files now carries the delete/redirect, so `classify()` itself (not an allowlist) is the only
// thing deciding safety. This also removes the round-3 CR-fixed defect class by construction: a
// code-gated exemption can't go stale or get bypassed if there's no exemption left to gate.
const violations = Object.entries(realClassifications)
  .filter(([f, c]) => c.hasHit && !c.isSafe
    && !Object.prototype.hasOwnProperty.call(NON_SANDBOXED_ALLOWLIST, f));
check(
  `every test file with a transcript-fn hit is sandboxed before its first dist import, or carries a reasoned NON_SANDBOXED_ALLOWLIST entry (found ${violations.length} violation(s))`,
  violations.length === 0,
);
for (const [f, c] of violations) console.log(`  VIOLATION  ${f} — ${c.reason}`);

// STALE-ENTRY: every allowlist entry must itself still be a genuine, currently-unsafe hit.
const staleEntries = Object.keys(NON_SANDBOXED_ALLOWLIST).filter((f) => {
  const c = realClassifications[f];
  return c === undefined || !c.hasHit || c.isSafe;
});
check(
  `every NON_SANDBOXED_ALLOWLIST entry is itself a genuine, currently-unsafe hit (found ${staleEntries.length} stale: ${JSON.stringify(staleEntries)})`,
  staleEntries.length === 0,
);

console.log(failures === 0
  ? "\n✅ ALL PASS — every test/*.mjs file calling a transcript-path function either sandboxes HOME, " +
    "USERPROFILE, AND CLAUDE_CONFIG_DIR before its first dynamic dist import (never behind a hoisted " +
    "static one), or carries a reasoned, non-stale NON_SANDBOXED_ALLOWLIST entry."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
