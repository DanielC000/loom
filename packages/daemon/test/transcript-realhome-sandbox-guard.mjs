import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text/AST scan below, no Db used
// STANDING GUARD (card 668bc52c). An AST scan over the REAL corpus (readdirSync — sees an uncommitted
// new file too, same reasoning as real-engine-spawn-opt-in-guard.mjs's own header), never a raw
// text/regex match — a regex can't tell a real `process.env.HOME = x` assignment apart from the SAME
// text sitting inside a comment or a string, and a naive "does the file sandbox HOME somewhere" check
// can't tell whether that sandbox actually runs BEFORE the dist import it needs to precede.
//
// WHAT COUNTS AS A HIT: a CallExpression whose callee is a bare Identifier named
// `engineTranscriptPath`/`resolveTranscriptFile`/`engineTranscriptExists`/`listAllTranscriptIds` (the
// four transcript-path functions `pty/claude-transcript.ts` exports) — EXCLUDING two shapes that can
// share one of these names while reaching a DIFFERENT resolver than the one this guard polices:
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
//   (B) it is sandboxed: BOTH of the following hold —
//       (1) it carries NO static `ImportDeclaration` whose module specifier contains "dist/" — a static
//           import is HOISTED (it always executes before every other top-level statement in the module,
//           regardless of where it sits in the source text), so if one exists, a HOME/USERPROFILE
//           override written anywhere else in the file can never precede it. `CLAUDE_PROJECTS_ROOT`
//           (`pty/claude-transcript.ts`) is captured at MODULE LOAD time, and
//           `../dist/sessions/transcript.js` (the module every test imports this functionality from)
//           unconditionally imports `../dist/pty/claude-transcript.js` at ITS OWN top — so ANY static
//           import reaching dist, not only a direct import of claude-transcript.js, triggers the capture.
//       (2) it carries a `process.env.HOME = <non-empty>` assignment AND a `process.env.USERPROFILE =
//           <non-empty>` assignment (real `=` syntax, never `==`/`===`/a comment/a string) that BOTH
//           appear, in source order, strictly BEFORE the file's FIRST dynamic `import("...dist/...")`
//           call — the only shape that can actually precede a dist import's module-load-time read. A
//           file with a transcript-fn hit but no dist import of EITHER kind in its own text is an
//           unrecognized shape and fails closed, same posture as `real-home-scope-guard.mjs`'s own
//           fail-closed branch.
// A hit failing either condition, and not itself in `NON_SANDBOXED_ALLOWLIST` below, FAILS. A separate
// STALE-ENTRY assertion fails loud if any allowlist entry does NOT itself carry a genuine, currently-
// unsafe hit — the same posture `real-engine-spawn-opt-in-guard.mjs`'s own stale-entry check and
// `role-surface-tools-named-in-doctrine.mjs`'s own ALLOWLIST check use: a stale entry is a silent future
// exemption the moment that file's own shape changes, not a narrowed allowlist.
//
// @decision 668bc52c — never widen this to a text/regex scan: a regex can't distinguish a real
// `process.env.HOME =` assignment from the same text in a comment/string/`==` comparison, and would
// both false-positive and false-negative on this exact corpus.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
  "context-stats.mjs": "pre-existing real-home write with its own dedicated per-call cleanup (fs.rmSync(dir,...) in a finally block) — not sandboxed; out of card 668bc52c's scope.",
  "paste-placeholder-tripwire.mjs": "pre-existing real-home write with its own dedicated per-call cleanup (fs.rmSync(transcriptDir,...) in a finally block) — not sandboxed; out of card 668bc52c's scope.",
  "usage-limit-weekly-sentinel.mjs": "pre-existing real-home write with its own dedicated per-call cleanup (fs.rmSync(transcriptDir,...) in a finally block) — not sandboxed; out of card 668bc52c's scope.",
  // The next seven were found BY THIS GUARD (not in card 668bc52c's own named list) — real, pre-existing
  // real-home writes with best-effort (non-guaranteed) cleanup, each confirmed by reading the file, not
  // copied from any prior memory note on trust. Reported up as a discovery for a follow-up card; out of
  // THIS card's scope to fix.
  "assistant-role.mjs": "real-home write with its own best-effort per-case cleanup (fs.rmSync(transcriptDir,...), try/catch) — not sandboxed.",
  "context-exhaustion-tail-read.mjs": "real-home write with its own best-effort cleanup (fs.rmSync(path.dirname(file),...), try/catch) — not sandboxed.",
  "crash-orphaned-workers.mjs": "real-home write with its own best-effort cleanup (fs.rmSync(dir,...), try/catch) — not sandboxed.",
  "mainline-watch-boot-reader.mjs": "real-home write registered with the shared registerForCleanup() registry (best-effort, not a guaranteed-throw-on-survival check) — not sandboxed.",
  "no-commit-reviewer.mjs": "real-home write with its own best-effort cleanup (fs.rmSync(dir,...), try/catch) — not sandboxed.",
  "paste-length-loss.mjs": "real-home write with its own best-effort cleanup (fs.rmSync(transcriptDir,...)/(transcriptDir2,...), try/catch) — not sandboxed.",
  "restart-fleet.mjs": "real-home write with its own best-effort cleanup (fs.rmSync(dir,...), try/catch) — not sandboxed.",
  "worktrees.mjs": "calls engineTranscriptPath(...) ONLY to compare two computed path STRINGS (a pure function of its cwd argument) — never writes a file via it, so there is nothing to sandbox against.",
  "_probe-paste-stranded-resume.mjs": "a REAL-CLAUDE STANDALONE PROBE (its own header: \"NOT hermetic CI — needs a logged-in claude\"), never run as part of the hermetic suite/guards — out of scope for this hermeticity convention by design.",
  // Card a92a0913 round 2: a deliberately DIFFERENT (per-scenario, not once-before-import) sandbox shape
  // — it tests CLAUDE_CONFIG_DIR itself, so each scenario sets HOME/USERPROFILE/CLAUDE_CONFIG_DIR freshly
  // right before its own engineTranscriptPath() call, never once at module top. Never touches the real
  // homedir (every scenario sandboxes before its own use), but this guard's ordering check can't express
  // a per-scenario pattern — see card a92a0913's own decision record and that file's own header comment.
  "claude-config-dir-shared-resolver.mjs": "sandboxes HOME/USERPROFILE/CLAUDE_CONFIG_DIR per-scenario (deliberately — it tests the CLAUDE_CONFIG_DIR override itself), always before that scenario's own use, never once before the module's top-level dist import.",
};

// Card a92a0913 round 2: this card's own assigned scope widened this guard's required-override check to
// ALSO demand a CLAUDE_CONFIG_DIR delete/redirect (claudeConfigHome() reads it ahead of os.homedir(), so
// a sandboxed HOME/USERPROFILE alone is not enough). That widening discovered a REAL, pre-existing gap in
// every file below — each already sandboxes HOME/USERPROFILE correctly (confirmed structurally by this
// guard's own classify(), not guesswork) but was written before this card and never needed to also handle
// CLAUDE_CONFIG_DIR. Fixing 50 files is out of THIS card's assigned scope (its own body named only the 4
// 668bc52c/dacc6d9e already touched) — reported up via worker_report on card a92a0913 for a follow-up
// card; this is the guard's OWN discovery-exemption mechanism (same shape as NON_SANDBOXED_ALLOWLIST's own
// "found by this guard" entries above), never a silent debt-baseline.
const CONFIGDIR_NOT_HANDLED_ALLOWLIST = new Set([
  "agent-runs-hardening.mjs", "agent-runs-spend.mjs", "assistant-mode-pin.mjs", "audit-surface.mjs",
  "browser-testing-spawn.mjs", "codescape-lifecycle-hooks.mjs", "codex-fleet-switch-guard.mjs",
  "companion-codex-restricted-tools-refusal.mjs", "companion-live-upgrade.mjs", "companion-memory-recall.mjs",
  "companion-transcript-read.mjs", "companion-upgrade-carry-opposite-sites.mjs", "context-watcher-sampler-cascade.mjs",
  "document-conversion-spawn.mjs", "forced-plain-persisted.mjs", "fork-allow-baseline.mjs", "fork-cwd-missing-guard.mjs",
  "kickoff-confirm-boot-rearm.mjs", "kickoff-giveup-exhausted.mjs", "manager-kickoff-giveup-dropped.mjs",
  "merge-spawn-ownership-attach.mjs", "mid-turn-context-sampler.mjs", "platform-transcript.mjs",
  "platform-ungated-minting.mjs", "project-memory-cross-session.mjs", "project-memory-resume-pool-dedup.mjs",
  "pty-giveup-transcript-corroboration.mjs", "recycle-harness-reresolve.mjs", "recycle-refuses-fleet-writes.mjs",
  "respawn-profile-attrs.mjs", "restricted-tools-spawn.mjs", "resume-already-live-guard.mjs",
  "resume-fork-plain-role-not-widened.mjs", "resume-mode-cycles.mjs", "resume-permission-pin-agent-missing.mjs",
  "session-resume-prespawn-throw-marks-exited.mjs", "session-resume-prespawn-throw-preserves-recycled-from.mjs",
  "session-resume-prespawn-throw-restores-archive-state.mjs", "skills-subset-spawn.mjs",
  "transcript-fallback-cache-coherence.mjs", "transcript-root-deny-spawn-paths.mjs", "transcript-turns-spill.mjs",
  "usage-sampler.mjs", "user-audit-surface.mjs", "worker-idle-mid-first-turn.mjs",
  "worker-idle-spawn-broken-contradiction.mjs", "worker-mode-default.mjs", "worker-report-recovery.mjs",
  "worker-revive.mjs", "worker-transcript-paging.mjs",
]);

/** Parse `text` into a TS SourceFile. */
function parseSource(text) {
  return ts.createSourceFile("x.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Every local binding name -> module specifier it was imported from, covering both a static named
 *  import (`import { X } from "spec"`) and the dynamic destructure shape every hermetic test in this
 *  corpus actually uses (`const { X } = await import("spec")`, or the unawaited `import("spec")` form).
 *  An identifier bound more than once (shadowed/reassigned) keeps its LAST-seen source — rare enough in
 *  this corpus that a more careful scope analysis isn't warranted. */
function findImportBindingSources(sf) {
  const bindings = new Map();
  function importCallSpec(node) {
    if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
    const arg = node.arguments[0];
    return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
      && node.importClause && node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const spec of node.importClause.namedBindings.elements) {
        bindings.set(spec.name.text, node.moduleSpecifier.text);
      }
    }
    if (ts.isVariableDeclaration(node) && node.name && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const init = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
      const spec = importCallSpec(init);
      if (spec) {
        for (const el of node.name.elements) {
          if (ts.isIdentifier(el.name)) bindings.set(el.name.text, spec);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return bindings;
}

/** Every transcript-fn call-site hit in `sf`, as `{name, line}` — excluding a binding sourced from
 *  codex-transcript.js, and excluding a call whose third argument is the literal `"codex"` (see the
 *  header's "WHAT COUNTS AS A HIT" for why both are never a real-homedir reach). */
function findTranscriptFnHits(sf) {
  const bindings = findImportBindingSources(sf);
  const hits = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && TRANSCRIPT_FN_NAMES.has(node.expression.text)) {
      const source = bindings.get(node.expression.text);
      const isCodexBound = typeof source === "string" && source.includes("codex-transcript");
      const thirdArg = node.arguments[2];
      const isCodexCall = thirdArg && ts.isStringLiteralLike(thirdArg) && thirdArg.text === "codex";
      if (!isCodexBound && !isCodexCall) hits.push({ name: node.expression.text, line: lineOf(sf, node) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits;
}

/** Every static `import ... from "<spec>"` whose spec contains "dist/", as `{spec, line}`. */
function findStaticDistImports(sf) {
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
function findDynamicDistImports(sf) {
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

/** Every `process.env.HOME = <non-empty>` / `process.env.USERPROFILE = <non-empty>` assignment in `sf`,
 *  as `{ target: "HOME"|"USERPROFILE", line }` — real `=` syntax only, never `==`/`===`, and never an
 *  empty-string RHS (which would be a no-op override, same reasoning as the real-engine guard's own
 *  LOOM_CLAUDE_BIN check). */
function findHomeOverrideAssignments(sf) {
  const hits = [];
  function visit(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = processEnvHomeTarget(node.left);
      if (target) {
        const rhs = node.right;
        const rhsIsEmptyString = ts.isStringLiteralLike(rhs) && rhs.text === "";
        if (!rhsIsEmptyString) hits.push({ target, line: lineOf(sf, node) });
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

/** Every line in `sf` that either DELETES `process.env.CLAUDE_CONFIG_DIR` or ASSIGNS it a non-empty
 *  value (real `delete`/`=` syntax only).
 *  @decision a92a0913 — HOME/USERPROFILE alone isn't enough; claudeConfigHome() reads this var first. */
function findConfigDirHandling(sf) {
  const hits = [];
  function visit(node) {
    if (ts.isDeleteExpression(node) && isProcessEnvConfigDir(node.expression)) {
      hits.push({ line: lineOf(sf, node) });
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isProcessEnvConfigDir(node.left)) {
      const rhs = node.right;
      const rhsIsEmptyString = ts.isStringLiteralLike(rhs) && rhs.text === "";
      if (!rhsIsEmptyString) hits.push({ line: lineOf(sf, node) });
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

/** Classifies one file's text: `{ hasHit, isSafe, code, reason }`. `reason` is a short diagnostic
 *  string, always set (even when safe), so a violation report can explain itself without re-deriving it.
 *  `code` is a STABLE, machine-checkable discriminant for WHY a hit is unsafe (or how it's safe) — see
 *  "Card a92a0913 round 3" below for why this exists: `reason` alone is free text, too loose to gate an
 *  allowlist exemption on "is this UNSAFE FOR THE SPECIFIC REASON THE ALLOWLIST ENTRY WAS WRITTEN FOR",
 *  as opposed to "is this unsafe for ANY reason at all". */
function classify(text) {
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

// Card a92a0913 round 3 (MAJOR CR fix): CONFIGDIR_NOT_HANDLED_ALLOWLIST exempts a file ONLY when its
// CURRENT failure code is EXACTLY "configdir-missing" — the one, specific reason every entry's own
// comment above documents it for. A bare `!CONFIGDIR_NOT_HANDLED_ALLOWLIST.has(f)` (the pre-fix shape)
// exempted a listed file from EVERY classify() failure, of any code, which let a REGRESSION in an
// allowlisted file (e.g. a HOME/USERPROFILE sandbox that stopped preceding the dist import) pass
// silently as long as the filename matched — proven by the reviewer: prepending a static dist import to
// an allowlisted file (flipping its code to "static-import") left this guard green pre-fix. Gating on
// the code means the allowlist can ONLY ever suppress the one narrow, already-reasoned defect class;
// any OTHER regression in that same file still surfaces as a violation below.
const violations = Object.entries(realClassifications)
  .filter(([f, c]) => c.hasHit && !c.isSafe
    && !Object.prototype.hasOwnProperty.call(NON_SANDBOXED_ALLOWLIST, f)
    && !(CONFIGDIR_NOT_HANDLED_ALLOWLIST.has(f) && c.code === "configdir-missing"));
check(
  `every test file with a transcript-fn hit is sandboxed before its first dist import, or carries a reasoned NON_SANDBOXED_ALLOWLIST entry, or fails with EXACTLY the configdir-missing code a CONFIGDIR_NOT_HANDLED_ALLOWLIST entry names (found ${violations.length} violation(s))`,
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

// STALE-ENTRY (CONFIGDIR_NOT_HANDLED_ALLOWLIST): same posture — an entry that's since been fixed (or
// renamed/removed) is a silent future exemption for whatever else lands under that basename next. Also
// stale (round 3 widening) if the file's CURRENT failure code is no longer "configdir-missing" — e.g. it
// regressed to a DIFFERENT, unreasoned defect class, which this allowlist must never silently cover.
const staleConfigDirEntries = [...CONFIGDIR_NOT_HANDLED_ALLOWLIST].filter((f) => {
  const c = realClassifications[f];
  return c === undefined || !c.hasHit || c.isSafe || c.code !== "configdir-missing";
});
check(
  `every CONFIGDIR_NOT_HANDLED_ALLOWLIST entry currently fails with EXACTLY the configdir-missing code and nothing else (found ${staleConfigDirEntries.length} stale: ${JSON.stringify(staleConfigDirEntries)})`,
  staleConfigDirEntries.length === 0,
);

// --- RED PROOF (round 3, card a92a0913 item 1): the reviewer's own mutant, replayed against the REAL
// corpus text — a HOME/USERPROFILE regression in a CONFIGDIR_NOT_HANDLED_ALLOWLIST-listed file must now
// fail the violations filter, where the pre-fix (bare `!ALLOWLIST.has(f)`) exemption let it through. This
// never touches the real file on disk — it mutates the TEXT this guard already read into memory.
{
  const MUTANT_TARGET = "usage-sampler.mjs";
  check(`sanity: ${MUTANT_TARGET} is actually in CONFIGDIR_NOT_HANDLED_ALLOWLIST (so this proof targets a real exemption, not a made-up name)`,
    CONFIGDIR_NOT_HANDLED_ALLOWLIST.has(MUTANT_TARGET));
  const originalText = basenameToText[MUTANT_TARGET];
  check(`sanity: ${MUTANT_TARGET} exists in the real corpus and currently classifies configdir-missing`,
    typeof originalText === "string" && classify(originalText).code === "configdir-missing");

  // The reviewer's exact mutant: prepend a hoisted static dist import, which freezes CLAUDE_PROJECTS_ROOT
  // before ANY override in the file can run — a genuine, different-in-kind regression from "configdir
  // not handled", flipping the code to "static-import".
  const mutatedText = 'import "../dist/sessions/transcript.js";\n' + originalText;
  const mutatedClassification = classify(mutatedText);
  check(`RED PROOF: the mutant flips ${MUTANT_TARGET}'s code away from configdir-missing (found ${JSON.stringify(mutatedClassification.code)})`,
    mutatedClassification.hasHit && !mutatedClassification.isSafe && mutatedClassification.code !== "configdir-missing");

  // Replay both the OLD (pre-fix, bare) and NEW (fixed, code-gated) violations-filter predicates against
  // this one mutated entry, to show the fix is what changes the outcome — not an unrelated difference.
  const oldExemptionWouldPass = CONFIGDIR_NOT_HANDLED_ALLOWLIST.has(MUTANT_TARGET); // bare !ALLOWLIST.has(f) ⇒ exempted whenever this is true, regardless of code
  const c = mutatedClassification;
  const newViolationPredicate = c.hasHit && !c.isSafe
    && !Object.prototype.hasOwnProperty.call(NON_SANDBOXED_ALLOWLIST, MUTANT_TARGET)
    && !(CONFIGDIR_NOT_HANDLED_ALLOWLIST.has(MUTANT_TARGET) && c.code === "configdir-missing");
  check("RED PROOF: the PRE-FIX exemption shape would have silently passed this mutant (reproduces the reviewer's rc=0 finding)",
    oldExemptionWouldPass === true);
  check("RED PROOF: the FIXED (code-gated) violations predicate now flags this mutant as a real violation",
    newViolationPredicate === true);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every test/*.mjs file calling a transcript-path function either sandboxes HOME and " +
    "USERPROFILE before its first dynamic dist import (never behind a hoisted static one), or carries a " +
    "reasoned, non-stale NON_SANDBOXED_ALLOWLIST entry, or fails with exactly the one specific reason code " +
    "a CONFIGDIR_NOT_HANDLED_ALLOWLIST entry names."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
