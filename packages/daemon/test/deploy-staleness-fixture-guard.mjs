import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text scan below, no daemon/Db used
// STANDING GUARD (card e211ec89) — closes the CLASS behind a reproduced merge-gate failure, not just the
// six instances card 062fa934 fixed.
//
// THE INCIDENT THIS GENERALISES, reproduced (not hypothesised) on 062fa934's own branch: `resumeFleetOnBoot`
// gates its post-`daemon_restart` "your merged code is now LIVE" wording on `deploySignatureMismatch`, which
// it gets from `currentDeployStaleness()` (served-status.ts) whenever a caller omits the `deployStaleness`
// test seam. On a clean checkout after a plain `pnpm build` that happens to be a turbo CACHE HIT:
//   pnpm build → "Cached: N cached, N total"        ← daemon build was a turbo CACHE HIT
//     ⇒ write-build-info.mjs never ran
//     ⇒ dist/build-info.json REPLAYED the previous commit's sha
//     ⇒ currentDeployStaleness() returns deploySignatureMismatch:true
//     ⇒ every unfixtured `includes("now LIVE")` assertion downstream of resumeFleetOnBoot dies
// — six assertions across four test files went deterministically RED this way (isolated by the Code
// Reviewer: deleting dist/build-info.json flips deploySignatureMismatch back to false and all four pass).
// This is the exact `aad5fff3` turbo cache-replay footgun CLAUDE.md already documents; the detector
// detected itself into a red gate. 062fa934 fixed those six call sites and hoisted the shared
// `_deploy-staleness-fixture.mjs` fixture (CLEAN_STALENESS / MISMATCH_STALENESS) — that is the FIX, not the
// CLASS. The next test that drives `resumeFleetOnBoot` and forgets the fixture reintroduces it silently,
// and the failure surfaces ONLY on the merge gate, ONLY when the build happens to cache-hit — an
// intermittent, shared-gate cost paid by every project on this daemon, not just this one.
//
// WHAT IS AND ISN'T IN SCOPE — read this before "fixing" a false positive:
// `currentDeployStaleness()` (served-status.ts) is the ONE function that bakes a real, cache-replay-prone
// `processBuiltSha` (captured once at module load — see served-status.ts's own doc). Its sibling
// `computeDeployStaleness()` (deploy-staleness.ts) is SAFE to call directly with no override: omitting the
// 6th/7th positional arg leaves `processBuiltSha:null`, and `deploySignatureMismatch` can only ever be
// `true` when `processBuiltSha` is truthy (deploy-staleness.ts:555) — so a bare `computeDeployStaleness()`
// call can never reproduce this incident, whether called directly (test/deploy-staleness.mjs's whole
// suite; served-status.mjs's own real-tree build-clock probe) or via `manager-prompt.ts`'s
// `composeManagerStartupPrompt`, whose own `stalenessOverride ?? computeDeployStaleness()` fallback is a
// SEPARATE, already-scoped-OUT finding from this same review (permanently `deploySignatureMismatch:false`
// today — see card e211ec89's body). Guarding those would be exactly the "guard every ambient read in the
// corpus" widening this card explicitly forbids. Likewise, `buildServedStatus()` (served-status.ts) has NO
// override seam at all — it IS the real "what is this daemon actually serving" signal by design (its own
// doc), and its two deliberate real-tree tests (served-status.mjs, served-status-process-sha.mjs) never
// assert on `deploySignatureMismatch` or any wording derived from it, so they carry none of this incident's
// risk — this guard does not flag `buildServedStatus()` calls for exactly that reason.
//
// DETECTION SHAPE, CHOSEN DELIBERATELY (the reviewer suggested the guard, not the mechanism): a STATIC
// SOURCE-TEXT SCAN of `packages/daemon/test/*.mjs`, not a runtime trap in `currentDeployStaleness()` itself
// (e.g. throw when LOOM_TEST=1 unless explicitly opted in). Rejected the runtime trap because it requires
// touching PRODUCTION code (served-status.ts) to grow test-only conditional behaviour, and because the
// population here is fully enumerable from source text: every path that can reach the real
// `currentDeployStaleness()` unfixtured is either (a) a call to a named consumer with an optional
// fixture-shaped param (today: `resumeFleetOnBoot`'s `opts.deployStaleness`), found by matching that call
// and checking its own argument list, or (b) a direct import/call of `currentDeployStaleness` itself, which
// has no override at all and is therefore ALWAYS a violation wherever it appears as real code. Both are
// exact, precedented (same shape as `real-home-scope-guard.mjs`'s "every read resolves to an allowed
// shape"), and need zero production-code footprint or build step.
//
// EXTENDING THIS GUARD: if a FUTURE consumer of `currentDeployStaleness()` grows its own optional
// fixture-shaped override (the same pattern `resumeFleetOnBoot`'s `deployStaleness` and
// `composeManagerStartupPrompt`'s `stalenessOverride` already use), add `{ fn, requiredArg }` to
// CHECKED_CALLS below — do not widen check (2) to catch it structurally; a human choosing that entry is the
// point (mirrors `real-home-scope-guard.mjs`'s own ALLOWLIST-is-basename-level reasoning).
//
// SCOPE: `packages/daemon/test/*.mjs` only (source text, never `dist/` — no build required to run this).
// Run: node packages/daemon/test/deploy-staleness-fixture-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = __dirname;
const SELF = path.basename(__filename);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Every named consumer of currentDeployStaleness() that carries its own optional fixture-shaped override —
// see "EXTENDING THIS GUARD" above for how to grow this when a new one is added.
const CHECKED_CALLS = [{ fn: "resumeFleetOnBoot", requiredArg: "deployStaleness" }];

// The one function with NO override at all — any real-code reference to it is unconditionally a violation.
const UNFIXTURABLE_NAME = "currentDeployStaleness";

/**
 * Replaces every `//` line comment, `/* ... *\/` block comment, and `'...'`/`"..."`/`\`...\`` string body
 * with blank characters of the SAME length (preserving newlines and overall offsets), so later regex
 * matching against the result only ever sees real, executable code — a prose mention in a doc comment
 * (this file's own header is full of them) or a string literal can never masquerade as a real call or
 * reference. Positions in the returned string line up 1:1 with the input, so indices computed against it
 * can be used to recover line numbers from the ORIGINAL text.
 */
function sanitize(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : "";
    if (c === "/" && c2 === "/") {
      while (i < n && text[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  "; i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { out += text[i] === "\n" ? "\n" : " "; i++; }
      if (i < n) { out += "  "; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " "; i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\" && i + 1 < n) {
          out += text[i] === "\n" ? "\n" : " ";
          out += text[i + 1] === "\n" ? "\n" : " ";
          i += 2;
          continue;
        }
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) { out += " "; i++; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * Finds every real-code call to `fnName(...)` in `sanitized`, handling multi-line argument lists (e.g.
 * restart-fleet.mjs's (8i)/(8ii)/(8iii) calls, whose `deployStaleness:` sits several lines below the open
 * paren) via balanced-paren depth counting over the ALREADY-SANITIZED text — so a paren inside a comment or
 * string can never be miscounted, because sanitize() already blanked it. An unbalanced call (parse fails
 * closed, never silently skipped) is returned with `unbalanced:true` rather than dropped.
 */
function findCalls(sanitized, fnName) {
  const calls = [];
  const re = new RegExp(`\\b${fnName}\\s*\\(`, "g");
  let m;
  while ((m = re.exec(sanitized))) {
    const openIdx = m.index + m[0].length - 1;
    let depth = 1;
    let j = openIdx + 1;
    while (j < sanitized.length && depth > 0) {
      if (sanitized[j] === "(") depth++;
      else if (sanitized[j] === ")") depth--;
      j++;
    }
    const unbalanced = depth !== 0;
    calls.push({ start: m.index, end: j, argsText: sanitized.slice(openIdx + 1, unbalanced ? j : j - 1), unbalanced });
    re.lastIndex = unbalanced ? sanitized.length : j;
  }
  return calls;
}

/** Classifies one file's text against both checks. Returns `{ callViolations, directRefViolations }`. */
function classify(rawText) {
  const sanitized = sanitize(rawText);
  const callViolations = [];
  for (const { fn, requiredArg } of CHECKED_CALLS) {
    for (const call of findCalls(sanitized, fn)) {
      const reqRe = new RegExp(`\\b${requiredArg}\\b`);
      if (call.unbalanced) {
        callViolations.push({ line: lineOf(rawText, call.start), fn, reason: "unrecognized shape (unbalanced parens — fails closed)" });
      } else if (!reqRe.test(call.argsText)) {
        callViolations.push({ line: lineOf(rawText, call.start), fn, reason: `no "${requiredArg}" in its own argument list` });
      }
    }
  }
  const directRefViolations = [];
  const cdsRe = new RegExp(`\\b${UNFIXTURABLE_NAME}\\b`, "g");
  let cm;
  while ((cm = cdsRe.exec(sanitized))) {
    directRefViolations.push({ line: lineOf(rawText, cm.index) });
  }
  return { callViolations, directRefViolations };
}

// =====================================================================================================
// (A) POSITIVE CONTROL — proves the classifier actually fires, against known-bad AND known-good snippets,
// before trusting a clean corpus scan below (DoD-2: this guard asserts an ABSENCE, so a clean scan is
// exactly what a broken pattern would also return).
// =====================================================================================================
{
  const BAD_SINGLE_LINE = 'sessions.resumeFleetOnBoot(intent, { resumeOne: () => true });';
  const GOOD_SINGLE_LINE = 'sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });';
  const GOOD_MULTI_LINE = [
    "sessions8i.resumeFleetOnBoot(",
    '  { reason: "deploy", managerSessionId: d1.mgr, requestedAt: now, resume: [',
    '    { sessionId: d1.mgr, role: "manager", parentSessionId: null },',
    "  ] },",
    "  { resumeOne: (sid) => sid !== d1.dead, deployStaleness: CLEAN_STALENESS },",
    ");",
  ].join("\n");
  const PROSE_MENTION_ONLY = "// RESUME-ON-BOOT — resumeFleetOnBoot() re-resumes every captured session (injecting nothing)";
  const BAD_DIRECT_REF = [
    'const { currentDeployStaleness } = await import("../dist/served-status.js");',
    "const result = currentDeployStaleness();",
  ].join("\n");
  const PROSE_MENTION_CDS_ONLY = "// resumeFleetOnBoot now reads a live currentDeployStaleness() unless a test supplies a fixture";

  const bad = classify(BAD_SINGLE_LINE);
  check("(A) RED PROOF: an unfixtured single-line resumeFleetOnBoot(...) call IS flagged", bad.callViolations.length === 1);

  const good = classify(GOOD_SINGLE_LINE);
  check("(A) GREEN: the SAME call with deployStaleness: added is NOT flagged", good.callViolations.length === 0);

  const goodMulti = classify(GOOD_MULTI_LINE);
  check("(A) GREEN: a MULTI-LINE call whose deployStaleness: sits several lines below the open paren is correctly matched (balanced-paren scan, not single-line regex)", goodMulti.callViolations.length === 0);

  const prose = classify(PROSE_MENTION_ONLY);
  check("(A) GREEN: a `//` comment merely mentioning \"resumeFleetOnBoot()\" in prose is NOT treated as a real call", prose.callViolations.length === 0);

  const cdsBad = classify(BAD_DIRECT_REF);
  check("(A) RED PROOF: a direct import+call of currentDeployStaleness() IS flagged (it has no override at all)", cdsBad.directRefViolations.length === 2); // the import binding + the call, both real-code references

  const cdsProse = classify(PROSE_MENTION_CDS_ONLY);
  check("(A) GREEN: a comment merely mentioning \"currentDeployStaleness()\" in prose is NOT flagged", cdsProse.directRefViolations.length === 0);
}

// =====================================================================================================
// (B) THE REAL BACKSTOP — every test/*.mjs file in this corpus, scanned live off disk.
// =====================================================================================================
{
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs") && f !== SELF);
  check(`sanity: the test/ corpus walk found a non-trivial population (found ${files.length} .mjs file(s))`, files.length > 100);

  let totalCallsSeen = 0;
  const callViolations = [];
  const directRefViolations = [];

  for (const file of files) {
    const text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
    const sanitized = sanitize(text);
    const { callViolations: cv, directRefViolations: dv } = classify(text);
    totalCallsSeen += findCalls(sanitized, "resumeFleetOnBoot").length;
    for (const v of cv) callViolations.push({ file, ...v });
    for (const v of dv) directRefViolations.push({ file, ...v });
  }

  check(`sanity: real resumeFleetOnBoot(...) call sites actually exist in this corpus (found ${totalCallsSeen}) — proves the pattern isn't vacuously narrow`, totalCallsSeen > 0);

  if (callViolations.length) {
    for (const v of callViolations) console.log(`  UNFIXTURED-CALL  ${v.file}:${v.line}  ${v.fn}(...) — ${v.reason}`);
  }
  check(
    `every ${CHECKED_CALLS.map((c) => c.fn).join("/")} (...) call in the corpus supplies its required fixture argument (found ${callViolations.length} violation(s) across ${totalCallsSeen} call site(s))`,
    callViolations.length === 0,
  );

  if (directRefViolations.length) {
    for (const v of directRefViolations) console.log(`  UNFIXTURABLE-REF  ${v.file}:${v.line}  — direct reference to ${UNFIXTURABLE_NAME}(), which has no override at all`);
  }
  check(
    `no test file directly references ${UNFIXTURABLE_NAME} (found ${directRefViolations.length})`,
    directRefViolations.length === 0,
  );
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the classifier fires on a deliberately-unfixtured call (single- and multi-line) and on a direct currentDeployStaleness() reference, ignores prose mentions, and the real test/ corpus currently has zero of either violation."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
