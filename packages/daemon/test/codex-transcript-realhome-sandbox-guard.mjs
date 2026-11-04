import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text/AST scan below, no Db used
// STANDING GUARD. AST scan (never regex) over the real test corpus, policing CODEX_HOME sandboxing for
// codex transcript/rollout-archive fixture writers — the hazard transcript-realhome-sandbox-guard.mjs
// (claude's own sibling) deliberately excludes. Shares AST machinery via `_realhome-sandbox-ast.mjs`.
//
// ORDERING RULE: a hit is safe iff a top-level `process.env.CODEX_HOME = <non-empty>` precedes the
// file's first dynamic `import("...dist/...")` call (and no static dist import exists anywhere, hoisted
// ones can't be preceded by anything) — conservative: `codexSessionsRoot()`/`codexRolloutArchiveRoot()`
// actually read `CODEX_HOME` fresh per call, but this stays correct even if that ever changes.
//
// HIT SET: `resolveTranscriptFile`/`transcriptExists`/`readTranscript`/`snapshotTranscript`/
// `findConversationIdForSpawn`/`snapshotExistingConversationIdsForSpawn`/
// `describeRolloutCandidatesForDiagnostic` (`pty/codex-transcript.ts`), `archiveOldCodexRollouts`/
// `restoreArchivedCodexRollout` (`pty/codex-rollout-archive.ts`). `readSessionMeta`/`parseTranscriptFile`
// take an explicit file path and never touch `codexSessionsRoot()` — excluded.
//
// DISAMBIGUATION (1): `resolveTranscriptFile`/`readTranscript`/`snapshotTranscript` collide with
// `sessions/transcript.ts`'s harness dispatcher — resolved by the LAST argument + a per-function
// min-argc (never a fixed index: `snapshotTranscript`'s harness sits at index 4, not 2).
// DISAMBIGUATION (2): `transcriptExists` ALSO collides with the `HarnessAdapter` interface method (no
// harness arg at all) — resolved by import SOURCE instead (claude-bound never a hit, codex-bound or
// unresolved always a hit).
//
// DISCLOSED BLIND SPOT: does not trace indirect reach via `PtyHost.spawn({harness:"codex"})` (card
// `7664f6b3` tracks closing it) — a file that spawns a codex pty without directly importing
// `codex-transcript.js` is invisible here even if it never sandboxes `CODEX_HOME`.
//
// @decision 7f2263fd — never disambiguate the harness arg by a fixed index; never allowlist a
// real-spawn file, or exempt the archive deps seam, without a reason recorded on this id.
import fs from "node:fs";
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

// Names with NO claude-side equivalent at all (no sessions/transcript.ts dispatcher entry, no
// HarnessAdapter interface method of the same name) — ANY call is always a hit, no disambiguation needed.
const CODEX_ONLY_FN_NAMES = new Set([
  "findConversationIdForSpawn", "snapshotExistingConversationIdsForSpawn",
  "describeRolloutCandidatesForDiagnostic", "archiveOldCodexRollouts", "restoreArchivedCodexRollout",
]);
// Names codex-transcript.ts shares with sessions/transcript.ts's harness-agnostic DISPATCHER (verified by
// reading sessions/transcript.ts: resolveTranscriptFile/readTranscript/snapshotTranscript each take an
// OPTIONAL trailing `harness` param and route through transcriptOpsFor(harness)) — a hit ONLY when bound
// from codex-transcript.js directly, OR when bound from elsewhere (or unresolved) AND the call's LAST
// argument is not a string literal other than "codex" (fails closed on a non-literal or an unresolved
// binding). Argument count WITHOUT the harness param: resolveTranscriptFile/readTranscript(cwd,
// engineSessionId, harness?) vs snapshotTranscript(cwd, engineSessionId, projectId, sessionId, harness?) —
// the harness param sits at a DIFFERENT index for the latter, which is exactly why this guard checks
// argument COUNT + the LAST argument generically rather than a fixed index.
const CODEX_DISPATCH_SHARED_FN_NAMES = new Set(["resolveTranscriptFile", "readTranscript", "snapshotTranscript"]);
const DISPATCH_HARNESS_MIN_ARGC = { resolveTranscriptFile: 2, readTranscript: 2, snapshotTranscript: 4 };
// `transcriptExists` has NO sessions/transcript.ts dispatcher entry (that module's own harness-dispatched
// equivalent is named `engineTranscriptExists` — a DIFFERENT name, no collision there) — but it IS ALSO a
// `HarnessAdapter` interface method (`pty/adapter.ts`) implemented identically-signatured (2 args, no
// harness param at all) by BOTH `claudeAdapter.transcriptExists` and codex's own adapter, so arg-count
// can never disambiguate it (both call shapes are always exactly 2 args) — only the bound SOURCE can:
// claude-transcript.js/claude-adapter.js never a hit, codex-transcript.js always a hit, anything else
// (including an unresolved binding, or a codex-adapter.js binding, if one exists) fails closed as a hit.
const CODEX_SOURCE_DISAMBIGUATED_FN_NAMES = new Set(["transcriptExists"]);
const ALL_CODEX_FN_NAMES = new Set([
  ...CODEX_ONLY_FN_NAMES, ...CODEX_DISPATCH_SHARED_FN_NAMES, ...CODEX_SOURCE_DISAMBIGUATED_FN_NAMES,
]);
const CLAUDE_SOURCE_MARKERS = ["claude-transcript", "claude-adapter"];

// Judgment-curated, one-line reason each, confirmed by reading the file. A file belongs here only if its
// real-home touch is deliberate AND already carries its own reasoning/cleanup — never a shape this guard
// should treat as safe going forward.
const NON_SANDBOXED_ALLOWLIST = {
  "codex-transcript-real-spawn.mjs": "a REAL-CODEX real-spawn test (its own header: needs the REAL, installed, authenticated codex CLI; skips gracefully when unavailable) — deliberately never sets CODEX_HOME, since codex-doctrine.ts's own doc establishes a per-worker CODEX_HOME override is empirically broken (auth lives under the real one), so this file MUST use the real ~/.codex to capture a real conversation id at all. Out of scope for this hermeticity convention by design, same posture as _probe-paste-stranded-resume.mjs on the claude guard. READ-ONLY per standing constraint — never run.",
  "codex-rollout-archive-restore-real-spawn.mjs": "a REAL-CODEX real-spawn test, opt-in only (LOOM_RUN_CODEX_RESTORE_REAL_SPAWN=1), skipped by default. Its own header: deliberately NEVER sets CODEX_HOME for the same auth reason as above — LOOM_HOME alone scopes codexRolloutArchiveRoot() to a disposable scratch tree, while the live sessions/ root stays the real ~/.codex (required for a real `codex resume <uuid>` to find anything). It never calls the production archiveOldCodexRollouts() sweep against the real tree (that would archive unrelated real conversations); it moves only its OWN created rollout file by hand, with a finally-block manual restore as a belt-and-suspenders safety net. READ-ONLY per standing constraint — never run.",
  "codex-doctrine-real-spawn.mjs": "a REAL-CODEX real-spawn test — its own header: uses the SAME proven-reliable recipe codex-transcript-real-spawn.mjs already uses (role:undefined + a real gateway, one real model turn) to confirm a real codex process actually reads its injected AGENTS.md doctrine. Reads back the transcript via readTranscript(cwd, capturedEngineId, \"codex\") — genuinely needs the real ~/.codex for a real captured engine session id to resolve against, same auth reason as its two siblings above (never sets CODEX_HOME). Found by THIS GUARD, not by the card's own initial corpus grep (which only searched for direct codex-transcript.js/codex-rollout-archive.js imports) — this file reaches codex's path indirectly via sessions/transcript.ts's harness dispatch instead. READ-ONLY per standing constraint — never run.",
};

/** Every codex-transcript-fn call-site hit in `sf`, as `{name, line}` — covers a bare-identifier call
 *  (including an ALIASED destructure) and a NAMESPACE call off a whole-module binding, lexically
 *  scope-aware (never a whole-file last-seen-wins map). See this file's header for the full
 *  name-collision disambiguation. When a bare identifier's own name literally matches a known fn name
 *  but no import binding resolves at all, it still counts as a hit — fails CLOSED. */
function findCodexFnHits(sf) {
  const hits = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let matchedName = null;
      let source; // resolved module spec, or undefined if unresolved
      if (ts.isIdentifier(callee)) {
        const decl = resolveBinding(callee, callee.text);
        if (decl && ALL_CODEX_FN_NAMES.has(decl.realName)) {
          matchedName = decl.realName;
          source = decl.spec;
        } else if (!decl && ALL_CODEX_FN_NAMES.has(callee.text)) {
          matchedName = callee.text; // unresolved — fail closed
        }
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && ALL_CODEX_FN_NAMES.has(callee.name.text)) {
        matchedName = callee.name.text;
        source = resolveBinding(callee.expression, callee.expression.text)?.spec;
      }
      if (matchedName) {
        const isCodexModuleBound = typeof source === "string" && source.includes("codex-transcript");
        let isHit = true;
        if (CODEX_DISPATCH_SHARED_FN_NAMES.has(matchedName) && !isCodexModuleBound) {
          // Bound (or unresolved) from something other than codex-transcript.js directly. The optional
          // trailing `harness` param sits at a DIFFERENT index per function (see DISPATCH_HARNESS_MIN_ARGC
          // above), so a call made with exactly that many args OMITS harness entirely —
          // `transcriptOpsFor(undefined)` defaults to claude, never codex, so this is deliberately NOT a
          // hit. A call with MORE args than that floor is passing harness explicitly: a non-hit only when
          // it's a literal other than "codex"; a non-literal or missing-but-expected last arg fails closed
          // (still a hit).
          const minArgcWithoutHarness = DISPATCH_HARNESS_MIN_ARGC[matchedName];
          if (node.arguments.length <= minArgcWithoutHarness) {
            isHit = false;
          } else {
            const lastArg = node.arguments[node.arguments.length - 1];
            if (lastArg && ts.isStringLiteralLike(lastArg) && lastArg.text !== "codex") isHit = false;
          }
        } else if (CODEX_SOURCE_DISAMBIGUATED_FN_NAMES.has(matchedName) && !isCodexModuleBound) {
          // No dispatcher signature to read a harness arg from at all (both claudeAdapter's and codex's
          // own implementation take an identical, harness-less argument list) — SOURCE alone decides:
          // bound from claude-transcript.js/claude-adapter.js is never a hit; anything else (unresolved,
          // or a codex-adapter.js binding) fails closed as a hit.
          const isClaudeBound = typeof source === "string" && CLAUDE_SOURCE_MARKERS.some((m) => source.includes(m));
          if (isClaudeBound) isHit = false;
        }
        if (isHit) hits.push({ name: matchedName, line: lineOf(sf, node) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits;
}

/** Every TOP-LEVEL `process.env.CODEX_HOME = <non-empty>` assignment in `sf`, as `{line}` — real `=`
 *  syntax only, never `==`/`===`, never an empty-string RHS, and never one sitting inside a function
 *  body this guard has no way to prove is ever actually called. */
function findCodexHomeOverrideAssignments(sf) {
  const hits = [];
  function visit(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      const isCodexHomeTarget = ts.isPropertyAccessExpression(left) && left.name.text === "CODEX_HOME"
        && ts.isPropertyAccessExpression(left.expression) && left.expression.name.text === "env"
        && ts.isIdentifier(left.expression.expression) && left.expression.expression.text === "process";
      if (isCodexHomeTarget) {
        const rhs = node.right;
        const rhsIsEmptyString = ts.isStringLiteralLike(rhs) && rhs.text === "";
        if (!rhsIsEmptyString && !isInsideFunctionLike(node)) hits.push({ line: lineOf(sf, node) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits;
}

/** Cheap substring prefilter: none of the codex fn names appears ANYWHERE in `text` (as plain text,
 *  before any parse) means there is no possible way a call to one of them — aliased, namespaced, or
 *  bare — could exist in this file. Skips `parseSource` + the AST walk entirely for a file that can't
 *  possibly hit. */
function mentionsAnyCodexFnName(text) {
  for (const name of ALL_CODEX_FN_NAMES) if (text.includes(name)) return true;
  return false;
}

/** Classifies one file's text: `{ hasHit, isSafe, code, reason }` — same shape as the claude guard's own
 *  classify() (`transcript-realhome-sandbox-guard.mjs`), deliberately simpler (no marker-A fixture-helper
 *  convention, no CLAUDE_CONFIG_DIR rung — see this file's header for why neither applies to codex). */
function classify(text, baseDir = TEST_DIR) {
  if (!mentionsAnyCodexFnName(text)) {
    return { hasHit: false, isSafe: true, code: "no-hit", reason: "no codex transcript/rollout-archive fn name present as text (prefilter)" };
  }
  const sf = parseSource(text);
  const fnHits = findCodexFnHits(sf);
  if (fnHits.length === 0) return { hasHit: false, isSafe: true, code: "no-hit", reason: "no codex transcript/rollout-archive fn call" };

  const staticDist = findStaticDistImports(sf);
  if (staticDist.length > 0) {
    return {
      hasHit: true, isSafe: false, code: "static-import",
      reason: `static import of ${JSON.stringify(staticDist[0].spec)} at line ${staticDist[0].line} — ` +
        `hoisted, so no CODEX_HOME override in this file can ever precede it; convert to a dynamic await import() after the sandbox`,
    };
  }

  // `_transcript-fixture.mjs` (claude's own marker-A helper, same file the claude guard exempts) is
  // EXCLUDED from this transitive scan on the same ground that guard uses it as a whole-file-safe
  // marker: read directly, its own `withEngineTranscriptFixture` writes ONLY under the real
  // ~/.claude/projects — it never touches codexSessionsRoot()/CODEX_HOME at all, so loading it (and its
  // own static dist import) early can never affect THIS guard's own concern.
  const transitive = findTransitiveStaticDistImport(sf, baseDir, ["_transcript-fixture.mjs"]);
  if (transitive) {
    return {
      hasHit: true, isSafe: false, code: "transitive-static-import",
      reason: `static import of local helper ${JSON.stringify(transitive.spec)} at line ${transitive.line} itself ` +
        `statically imports ${JSON.stringify(transitive.transitiveSpec)} — hoisted transitively, so no CODEX_HOME ` +
        `override in this file can ever precede it`,
    };
  }

  const dynamicDist = findDynamicDistImports(sf);
  if (dynamicDist.length === 0) {
    return { hasHit: true, isSafe: false, code: "unrecognized-shape", reason: "unrecognized shape: a codex transcript/rollout-archive fn call with no dist import of either kind in this file (fails closed)" };
  }
  const firstDynamicDistLine = Math.min(...dynamicDist.map((h) => h.line));

  const overrides = findCodexHomeOverrideAssignments(sf);
  const ok = overrides.some((o) => o.line < firstDynamicDistLine);
  if (!ok) {
    const code = overrides.length === 0 ? "missing-codex-home" : "codex-home-ordering";
    const reason = overrides.length === 0
      ? "missing a process.env.CODEX_HOME override assignment"
      : `CODEX_HOME override does not precede the first dynamic dist import (line ${firstDynamicDistLine})`;
    return { hasHit: true, isSafe: false, code, reason };
  }
  return { hasHit: true, isSafe: true, code: "safe", reason: "sandboxed before the first dist import" };
}

// --- Sanity / positive+negative controls on the DETECTORS THEMSELVES ---

check(
  "sanity: a synthetic resolveTranscriptFile( call bound from codex-transcript.js IS detected",
  findCodexFnHits(parseSource(
    'const { resolveTranscriptFile } = await import("../dist/pty/codex-transcript.js");\nresolveTranscriptFile(cwd, id);',
  )).length === 1,
);
check(
  "sanity: a synthetic findConversationIdForSpawn( call IS detected",
  findCodexFnHits(parseSource(
    'const { findConversationIdForSpawn } = await import("../dist/pty/codex-transcript.js");\nfindConversationIdForSpawn(cwd, sinceMs);',
  )).length === 1,
);
check(
  "sanity: a synthetic archiveOldCodexRollouts( call IS detected",
  findCodexFnHits(parseSource(
    'const { archiveOldCodexRollouts } = await import("../dist/pty/codex-rollout-archive.js");\narchiveOldCodexRollouts();',
  )).length === 1,
);
check(
  "sanity: the same call-shape text INSIDE a template-literal string (data, not code) is NOT detected (negative control)",
  findCodexFnHits(parseSource('const snippet = `findConversationIdForSpawn(cwd, sinceMs)`;')).length === 0,
);
check(
  "sanity: the same shape inside a line COMMENT is NOT detected",
  findCodexFnHits(parseSource('// findConversationIdForSpawn(cwd, sinceMs) looks like a call here but is only a comment')).length === 0,
);
check(
  "sanity: readSessionMeta is NOT a hit — explicit-path fn, never touches codexSessionsRoot (negative control, excluded by name entirely)",
  findCodexFnHits(parseSource(
    'const { readSessionMeta } = await import("../dist/pty/codex-transcript.js");\nreadSessionMeta(file);',
  )).length === 0,
);
check(
  "sanity: parseTranscriptFile is NOT a hit — explicit-path fn (negative control, excluded by name entirely)",
  findCodexFnHits(parseSource(
    'const { parseTranscriptFile } = await import("../dist/pty/codex-transcript.js");\nparseTranscriptFile(file);',
  )).length === 0,
);

// --- NAME-COLLISION DISAMBIGUATION: resolveTranscriptFile/readTranscript/snapshotTranscript vs
//     sessions/transcript.ts's harness-agnostic dispatcher, by LAST argument (not a fixed index) ---

check(
  'sanity: resolveTranscriptFile bound from sessions/transcript.js with LAST arg literal "codex" IS a hit',
  findCodexFnHits(parseSource(
    'const { resolveTranscriptFile } = await import("../dist/sessions/transcript.js");\nresolveTranscriptFile(cwd, id, "codex");',
  )).length === 1,
);
check(
  'sanity: resolveTranscriptFile bound from sessions/transcript.js with LAST arg literal "claude" is NOT a hit (negative control)',
  findCodexFnHits(parseSource(
    'const { resolveTranscriptFile } = await import("../dist/sessions/transcript.js");\nresolveTranscriptFile(cwd, id, "claude");',
  )).length === 0,
);
check(
  "sanity: resolveTranscriptFile bound from sessions/transcript.js with NO harness arg (defaults to claude) is NOT a hit",
  findCodexFnHits(parseSource(
    'const { resolveTranscriptFile } = await import("../dist/sessions/transcript.js");\nresolveTranscriptFile(cwd, id);',
  )).length === 0,
);
check(
  "sanity: resolveTranscriptFile bound from sessions/transcript.js with a NON-LITERAL last arg (a variable) IS still a hit (fails closed, never assumed non-codex)",
  findCodexFnHits(parseSource(
    'const { resolveTranscriptFile } = await import("../dist/sessions/transcript.js");\nresolveTranscriptFile(cwd, id, harness);',
  )).length === 1,
);
check(
  'sanity: a DIFFERENT-INDEX harness arg (snapshotTranscript, 5th/last position, NOT 3rd) bound from sessions/transcript.js with "codex" IS a hit — proves this guard checks the LAST arg generically, not a hardcoded index',
  findCodexFnHits(parseSource(
    'const { snapshotTranscript } = await import("../dist/sessions/transcript.js");\nsnapshotTranscript(cwd, id, projectId, sessionId, "codex");',
  )).length === 1,
);
check(
  'sanity: the SAME snapshotTranscript call with LAST arg "claude" is NOT a hit (proves the 5th-position check, not a stale 3rd-position one, decides this)',
  findCodexFnHits(parseSource(
    'const { snapshotTranscript } = await import("../dist/sessions/transcript.js");\nsnapshotTranscript(cwd, id, projectId, sessionId, "claude");',
  )).length === 0,
);
check(
  'sanity: resolveTranscriptFile bound DIRECTLY from codex-transcript.js is a hit even with a "claude"-shaped trailing literal — codex-transcript.ts\'s own export takes no harness param at all, so source-boundness wins over any argument shape',
  findCodexFnHits(parseSource(
    'const { resolveTranscriptFile } = await import("../dist/pty/codex-transcript.js");\nresolveTranscriptFile(cwd, id, "claude");',
  )).length === 1,
);

// --- NAME COLLISION: `transcriptExists` is ALSO a HarnessAdapter interface method implemented
//     identically-signatured (2 args, no harness) by claudeAdapter — arg-count can't disambiguate it the
//     way it does for resolveTranscriptFile/readTranscript/snapshotTranscript, so SOURCE alone decides
//     (card 7f2263fd round 2, found by this guard's own real-corpus run against
//     harness-adapter-conformance.mjs/harness-adapter-delegates.mjs) ---

check(
  "RED PROOF: transcriptExists(...) bound from codex-transcript.js directly IS a hit",
  findCodexFnHits(parseSource(
    'const { transcriptExists } = await import("../dist/pty/codex-transcript.js");\ntranscriptExists(cwd, id);',
  )).length === 1,
);
check(
  "RED PROOF: claudeAdapter.transcriptExists(...) (claude-adapter.js-bound, 2-arg, no harness to inspect) is NOT a hit — the exact false-positive this guard's own real-corpus run surfaced",
  findCodexFnHits(parseSource(
    'const { claudeAdapter } = await import("../dist/pty/claude-adapter.js");\nclaudeAdapter.transcriptExists(cwd, id);',
  )).length === 0,
);
check(
  "sanity: a bare transcriptExists(...) bound from claude-transcript.js directly is also NOT a hit (the other claude-bound source marker)",
  findCodexFnHits(parseSource(
    'const { transcriptExists } = await import("../dist/pty/claude-transcript.js");\ntranscriptExists(cwd, id);',
  )).length === 0,
);
check(
  "sanity: an UNRESOLVED transcriptExists(...) binding still fails closed as a hit",
  findCodexFnHits(parseSource('transcriptExists(cwd, id);')).length === 1,
);

// --- RED PROOF (must be able to fail) before trusting a real-corpus zero ---

{
  const UNSAFE_NO_OVERRIDE = 'const { findConversationIdForSpawn } = await import("../dist/pty/codex-transcript.js");\nfindConversationIdForSpawn(cwd, sinceMs);';
  const UNSAFE_STATIC_IMPORT = 'import { findConversationIdForSpawn } from "../dist/pty/codex-transcript.js";\nfindConversationIdForSpawn(cwd, sinceMs);';
  const UNSAFE_OVERRIDE_AFTER_IMPORT =
    'const { findConversationIdForSpawn } = await import("../dist/pty/codex-transcript.js");\n' +
    'process.env.CODEX_HOME = sandboxHome;\nfindConversationIdForSpawn(cwd, sinceMs);';
  const UNSAFE_EMPTY_STRING_OVERRIDE =
    'process.env.CODEX_HOME = "";\n' +
    'const { findConversationIdForSpawn } = await import("../dist/pty/codex-transcript.js");\nfindConversationIdForSpawn(cwd, sinceMs);';
  const SAFE_SANDBOXED =
    'process.env.CODEX_HOME = sandboxHome;\n' +
    'const { findConversationIdForSpawn } = await import("../dist/pty/codex-transcript.js");\nfindConversationIdForSpawn(cwd, sinceMs);';
  const SAFE_NO_HIT = 'console.log("nothing to see here");';

  check("RED PROOF: no override at all IS flagged unsafe", classify(UNSAFE_NO_OVERRIDE).isSafe === false);
  check("RED PROOF: a static dist import IS flagged unsafe even with an override present elsewhere", classify(UNSAFE_STATIC_IMPORT).isSafe === false);
  check("RED PROOF: an override placed AFTER the dynamic import IS flagged unsafe (ordering)", classify(UNSAFE_OVERRIDE_AFTER_IMPORT).isSafe === false);
  check("RED PROOF: an empty-string override (a no-op) IS flagged unsafe", classify(UNSAFE_EMPTY_STRING_OVERRIDE).isSafe === false);
  check("GREEN: CODEX_HOME sandboxed before the dynamic import is NOT flagged", classify(SAFE_SANDBOXED).isSafe === true);
  check("GREEN: a file with no codex fn call at all is NOT flagged", classify(SAFE_NO_HIT).isSafe === true && classify(SAFE_NO_HIT).hasHit === false);

  check("POSITIVE CONTROL: the REAL classify() codes a no-override fixture as missing-codex-home",
    classify(UNSAFE_NO_OVERRIDE).code === "missing-codex-home");
  check("INVERSE: the REAL classify() codes the SAME fixture plus a leading CODEX_HOME override as safe",
    classify(SAFE_SANDBOXED).code === "safe");

  // MUTATION TEST (lesson 303: a check that can only ever pass is indistinguishable from a broken one).
  // Textually disables classify()'s OWN "is the override present and correctly ordered" gate via
  // `new Function` on its real source text, wired to the SAME helper closures classify() itself calls —
  // proves the positive control above is load-bearing: if classify() regressed to never flag a missing
  // (or mis-ordered) override, this fixture would silently stop being a violation.
  const OVERRIDE_GATE_CONDITION = "if (!ok) {";
  const classifySource = classify.toString();
  check("sanity: the override-gate condition text is present in classify()'s own source (so the mutation below targets something real, not a stale string)",
    classifySource.includes(OVERRIDE_GATE_CONDITION));
  const mutatedSource = classifySource.replace(OVERRIDE_GATE_CONDITION, "if (false) {");
  check("sanity: the mutation actually changed classify()'s source text", mutatedSource !== classifySource);
  const classifyMutant = new Function(
    "TEST_DIR", "mentionsAnyCodexFnName", "parseSource", "findCodexFnHits",
    "findStaticDistImports", "findTransitiveStaticDistImport", "findDynamicDistImports",
    "findCodexHomeOverrideAssignments",
    `return (${mutatedSource});`,
  )(TEST_DIR, mentionsAnyCodexFnName, parseSource, findCodexFnHits, findStaticDistImports, findTransitiveStaticDistImport, findDynamicDistImports, findCodexHomeOverrideAssignments);

  const mutantResult = classifyMutant(UNSAFE_NO_OVERRIDE);
  check("RED PROOF: the mutant (missing-codex-home branch disabled) no longer codes the bad fixture as missing-codex-home — proves the mutation actually took",
    mutantResult.code !== "missing-codex-home" && mutantResult.isSafe === true);

  const realClassification = classify(UNSAFE_NO_OVERRIDE);
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
check(`sanity: at least one real file carries a codex transcript/rollout-archive fn hit (found ${hitCount})`, hitCount > 0);

const violations = Object.entries(realClassifications)
  .filter(([f, c]) => c.hasHit && !c.isSafe
    && !Object.prototype.hasOwnProperty.call(NON_SANDBOXED_ALLOWLIST, f));
check(
  `every test file with a codex transcript/rollout-archive fn hit is sandboxed before its first dist import, or carries a reasoned NON_SANDBOXED_ALLOWLIST entry (found ${violations.length} violation(s))`,
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
  ? "\n✅ ALL PASS — every test/*.mjs file calling a codex transcript/rollout-archive fn either sandboxes " +
    "CODEX_HOME before its first dynamic dist import (never behind a hoisted static one), or carries a " +
    "reasoned, non-stale NON_SANDBOXED_ALLOWLIST entry."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
