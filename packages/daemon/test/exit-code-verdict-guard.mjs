import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text scan below, no Db used
// STANDING GUARD (card 82bb198a, DoD-3) — the merge gate (scripts/test-daemon.mjs `runOne`) decides a
// hermetic test file's verdict PURELY from its child process's exit code (`ok: !timedOut && status === 0`,
// test-daemon.mjs:1020). A file whose failure-path assertions print `FAIL` but never actually change the
// process's exit code is reported PASS regardless — its assertions are decorative. This guard closes that
// hole at the gate: it fails the WHOLE gate if any real (hermetic) test file has no recognisable route to a
// non-zero exit on failure.
//
// ⭐ THE ONE CONFIRMED SPECIMEN (card 82bb198a): `merge-confirm-verdict-cache.mjs` printed real `FAIL` lines
// against deliberately-reverted source and still exited 0 — it had `check()`/`failures` bookkeeping but NO
// exit-code decision at all, so Node's default exit(0) applied unconditionally. Fixed in the same card by
// appending the corpus's own dominant idiom. This guard exists so that fix can never silently regress, and
// so no OTHER file in the corpus can carry the same defect (checked in DoD-1 for all 42 further suspects the
// card raised — every one already had a real mechanism the card's own static grep couldn't see: see below).
//
// ⚠️ WHY OPTION (b) — A STATIC SOURCE GUARD — NOT (a) A RUNNER-LEVEL OUTPUT-SCAN BACKSTOP (card 82bb198a
// DoD-3 named both as candidates and required the choice be argued):
// An output-scan backstop (option a) would fail a file whose STDOUT shows a failure marker even though it
// exited 0 — but this corpus contains guard SELF-TESTS that deliberately PRINT `FAIL`/failure-shaped text as
// their own positive control (this file's own controls below do exactly that). Card 2f0b2e57 is exactly this
// failure mode already on record here: an unanchored tier matched a PASSING assertion whose LABEL merely
// contained the tier's keyword.
// ✅ NOT JUST HYPOTHETICAL — EMPIRICALLY CONFIRMED against a REAL, currently-green file: running
// `merge-gate-single-file-retry.mjs` for real (exit 0, a genuine pass) and grepping its ACTUAL stdout for an
// anchored `/^FAIL  /m` pattern finds a real hit — `FAIL  alpha  (exit 1)FAIL  beta  (exit 1)`, a debug echo
// of a synthetic Buffer the file feeds to `createFailingTestTracker()` as its own mocked gate-output test
// fixture, unrelated to this file's own pass/fail. An option-(a) backstop using exactly this pattern would
// have failed the gate on this file TODAY, on a genuine, uncorrupted pass. `gate-status.mjs` carries the
// same shape (`outputTail: "FAIL  some_test.mjs"` as mocked verdict data). Reliably telling "a real failure
// line" apart from "mocked/positive-control failure-shaped text" needs real semantic parsing of a specific
// runner's PASS/FAIL line grammar — fragile, and a second copy of knowledge the runner itself already
// embodies structurally.
// A static guard sidesteps the whole class: it never looks at RUNTIME OUTPUT text at all, only at whether the
// SOURCE contains a recognised, real, non-zero-exit-on-failure MECHANISM. It is cheaper (one source scan,
// same cost class as this repo's other STATIC_GUARD_REPO_PATHS entries) and structurally immune to the
// output-scan trap. ⚠️ ITS OWN NAMED LIMITATION, stated rather than papered over (per DoD-3's own warning
// that a static guard "must not encode 'has process.exit' as the ONLY acceptable shape"): this guard checks
// for the PRESENCE of a recognised exit MECHANISM, never that the mechanism is wired to a genuine assertion
// count — a file could in principle hard-code `process.exitCode = 0;` unconditionally and still pass this
// guard. That is the same blind spot the card's own DoD-1 static grep had (a mechanical presence check, not
// a semantic one) — inherited deliberately rather than solved, since solving it needs the exact per-file
// judgement DoD-1 already did by hand and it does not generalise to a corpus-wide static rule.
//
// SCOPE: the SAME `hermetic` population `scripts/test-daemon.mjs`'s own `discoverHermeticTests` computes —
// reused directly (not re-walked) so this guard's population can never drift from what the gate actually
// runs. This is deliberately narrower than "every `.mjs` under test/": underscore-prefixed helpers, files
// under `fixtures/`/`census/` (EXCLUDED_DIR_NAMES), and files in `NOT_HERMETIC` (manual/e2e-only) never run
// through this gate's exit-code verdict at all, so policing their exit code would be scope creep, not safety.
//
// RECOGNISED MECHANISMS (any ONE present in a file's own CODE — comments excluded, see `stripComments`
// below — is sufficient; this is deliberately a set, not a single required shape, per DoD-3's own warning
// against false-positiving every legitimate `node:test`/throwing file):
//   1. `process.exit(` — the corpus's dominant idiom (`finishAndExit`/`failures` tail, ~750+ files).
//   2. `finishAndExit(` (the shared async wrapper from `_tmp-fixture.mjs`, card 995be21f) — it internally
//      calls `process.exit(code)` after real cleanup (see `_tmp-fixture.mjs:68-73`). Required ALONGSIDE an
//      import that actually names `_tmp-fixture.mjs`, so a hypothetical unrelated local function that merely
//      happens to share the name can't fool this guard.
//   3. `process.exitCode =` — the natural-drain mechanism a handful of files use instead (their own
//      `beforeExit` cleanup path in `_tmp-fixture.mjs`); sets the real exit code once the event loop drains,
//      same load-bearing guarantee, different timing.
//   4. `node:test` — the built-in test runner auto-derives the process exit code from assertion outcomes.
//   5. `node:assert` OR a bare `throw new` — an uncaught throw/rejection exits the process non-zero by
//      Node's own default behaviour; this is the SAME route the card's own DoD-1 static grep already
//      recognised as safe (its "2 throw on failure ⇒ NOT defective" files).
//
// ✅ POSITIVE CONTROL (run manually before trusting this guard's green — not part of this file's own
// execution): take any hermetic file using `process.exit(failures === 0 ? 0 : 1)`, delete that line with
// nothing replacing it (reproducing the EXACT shape of the original defect) → this guard must FAIL naming
// that file. Restore it → must PASS. Exercised for real below against the actual historical specimen.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverHermeticTests } from "../scripts/test-daemon.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = __dirname;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Same per-line comment classification discipline as harness-adapter-claude-literal-guard.mjs — a line
// inside a `/* ... */` block, or whose trimmed text starts with `//`/`*`, is excluded from the scan so a
// mechanism mentioned only in prose (e.g. this very file's own header, or a code example in a comment)
// can never satisfy the requirement.
function stripComments(source) {
  const state = { inBlock: false };
  const kept = [];
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (state.inBlock) {
      if (trimmed.includes("*/")) state.inBlock = false;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) state.inBlock = true;
      continue;
    }
    if (trimmed.startsWith("*")) continue; // JSDoc/block-comment continuation
    // Strip a TRAILING `//` comment on an otherwise-real code line, same `(?<!:)` URL-safe heuristic as
    // the claude-literal guard (avoids truncating at a URL's `://`).
    kept.push(raw.replace(/(?<!:)\/\/.*/, ""));
  }
  return kept.join("\n");
}

const PROCESS_EXIT_RE = /\bprocess\.exit\s*\(/;
const FINISH_AND_EXIT_CALL_RE = /\bfinishAndExit\s*\(/;
const TMP_FIXTURE_IMPORT_RE = /from\s+["'][^"']*_tmp-fixture\.mjs["']/;
const EXIT_CODE_ASSIGN_RE = /\bprocess\.exitCode\s*=/;
const NODE_TEST_RE = /from\s+["']node:test["']|require\(\s*["']node:test["']\s*\)/;
const NODE_ASSERT_RE = /from\s+["']node:assert(?:\/strict)?["']|require\(\s*["']node:assert(?:\/strict)?["']\s*\)/;
const THROW_NEW_RE = /\bthrow\s+new\b/;

// Pure classifier — exported so it can be driven directly against synthetic strings (the controls below)
// without needing a real file on disk, same discipline as the claude-literal guard's regex-level sanity
// checks. `code` should already be comment-stripped.
export function classifyExitMechanism(code) {
  const reasons = [];
  if (PROCESS_EXIT_RE.test(code)) reasons.push("process.exit(");
  if (FINISH_AND_EXIT_CALL_RE.test(code) && TMP_FIXTURE_IMPORT_RE.test(code)) reasons.push("finishAndExit( + _tmp-fixture.mjs import");
  if (EXIT_CODE_ASSIGN_RE.test(code)) reasons.push("process.exitCode =");
  if (NODE_TEST_RE.test(code)) reasons.push("node:test");
  if (NODE_ASSERT_RE.test(code)) reasons.push("node:assert");
  if (THROW_NEW_RE.test(code)) reasons.push("throw new");
  return { safe: reasons.length > 0, reasons };
}

// ── Regex-level sanity: each recognised mechanism must independently fire on a synthetic line that
// contains ONLY that mechanism — proves the classifier isn't accidentally safe-by-default (i.e. `safe`
// coming back true for a reason OTHER than the one being tested).
check("sanity: recognises process.exit(", classifyExitMechanism("process.exit(failures === 0 ? 0 : 1);").safe);
check("sanity: recognises finishAndExit( ONLY when paired with a _tmp-fixture.mjs import",
  classifyExitMechanism('import { finishAndExit } from "./_tmp-fixture.mjs";\nawait finishAndExit(1);').safe);
check("sanity: does NOT recognise a bare finishAndExit( call with no _tmp-fixture.mjs import (guards against a same-named local function)",
  !classifyExitMechanism("await finishAndExit(1);").safe);
check("sanity: recognises process.exitCode =", classifyExitMechanism("process.exitCode = failures === 0 ? 0 : 1;").safe);
check("sanity: recognises a node:test import", classifyExitMechanism('import { test } from "node:test";').safe);
check("sanity: recognises a node:assert import", classifyExitMechanism('import assert from "node:assert";').safe);
check("sanity: recognises a bare throw new", classifyExitMechanism('if (!cond) throw new Error("bad");').safe);
// Negative control (the polarity this whole guard exists to get right): a file with real check()/failures
// bookkeeping and NONE of the six mechanisms must be flagged UNSAFE — this is the literal shape of the
// confirmed defect (merge-confirm-verdict-cache.mjs before its fix).
check("sanity: a file with check()/failures bookkeeping and NO exit mechanism is classified UNSAFE",
  !classifyExitMechanism('let failures = 0;\nconst check = (l, c) => { if (!c) failures++; };\ncheck("x", false);\nconsole.log(failures === 0 ? "PASS" : "FAIL");').safe);
// Comment-exclusion control: a mechanism mentioned ONLY in a comment must not count.
check("sanity: a process.exit( mentioned only in a comment is NOT recognised",
  !classifyExitMechanism(stripComments("// this file should probably call process.exit(1) one day\nconsole.log('todo');")).safe);

// ── Real historical specimen control, run against the ACTUAL current (fixed) file: strip the fix back off
// and confirm the guard would have caught the real, shipped defect — not a synthetic stand-in for it.
{
  const fixedPath = path.join(TEST_DIR, "merge-confirm-verdict-cache.mjs");
  const fixedSource = fs.readFileSync(fixedPath, "utf8");
  const FIX_MARKER = "// Card 82bb198a:";
  const markerIdx = fixedSource.indexOf(FIX_MARKER);
  check("historical control: the fix marker is present in the current (fixed) file", markerIdx !== -1);
  const preFixSource = markerIdx === -1 ? fixedSource : fixedSource.slice(0, markerIdx);
  check("historical control: the CURRENT (fixed) file IS recognised as safe",
    classifyExitMechanism(stripComments(fixedSource)).safe);
  check("historical control: the PRE-FIX content (fix stripped back off) is classified UNSAFE — this guard would have caught the real, shipped defect",
    !classifyExitMechanism(stripComments(preFixSource)).safe);
}

// ── The real, corpus-wide enforcement scan — the SAME population the gate itself runs, reused directly
// rather than re-walked, so this guard's scope can never drift from what actually executes.
const { hermetic } = discoverHermeticTests(TEST_DIR);
check(`the real hermetic population was opened (found ${hermetic.length} test file(s))`, hermetic.length > 0);

const violations = [];
for (const name of hermetic) {
  const file = path.join(TEST_DIR, `${name}.mjs`);
  const source = fs.readFileSync(file, "utf8");
  const { safe, reasons } = classifyExitMechanism(stripComments(source));
  if (!safe) violations.push(name);
  void reasons; // not printed per-file on the pass path — only violations are worth a human's attention
}

check(`every hermetic test file has a recognised non-zero-exit-on-failure mechanism (found ${violations.length} without one)`, violations.length === 0);
for (const v of violations) console.log(`  VIOLATION  ${v}.mjs — no process.exit(/finishAndExit(/process.exitCode=/node:test/node:assert/throw-new mechanism found in its own code`);

console.log(failures === 0
  ? `\n✅ ALL PASS — every one of the ${hermetic.length} hermetic daemon test files has a recognised route to a non-zero exit on failure, so the gate's exit-code-only verdict (test-daemon.mjs \`runOne\`) can never silently report PASS for a file whose assertions actually failed. Card 82bb198a's confirmed specimen (merge-confirm-verdict-cache.mjs) is fixed and this guard's own historical control proves it would have caught that exact defect before it shipped.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
