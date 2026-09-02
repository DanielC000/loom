import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text scan below, no daemon/Db used
// STANDING GUARD (card 3c4a19cb) — makes card 0e5b2045's accepted design structural, not merely disciplined.
//
// THE BUG SHAPE: 0e5b2045 decoupled `failingTest` (the diagnostic-winning line `gateDetail`/nudges display)
// from `failTierTest` (the FAIL-tier-isolated line `identifyRetriableTestFile` — gate-runner.ts — actually
// reads to drive the merge gate's single-file retry). In REAL production code both are always computed
// together, from the SAME `createFailingTestTracker` on every settle (`runGateStep`'s `done()`/`onTimeout`
// in gate-runner.ts), and `done()`'s own `Omit<>` makes TypeScript enforce that every real `GateStepResult`/
// `GateSequentialResult` carries both keys. A hand-written test double that constructs a
// `GateSequentialResult`-shaped object literal and sets only `failingTest`/`failingTestCount` — because it
// was written or copy-pasted before the decoupling, or just misses the field — silently loses retry: `!
// failTierTest` short-circuits `identifyRetriableTestFile` to `undefined` with no signal anything is wrong.
// This bit TWICE, hours apart, both fixed by commit a995d7bc: `merge-gate-single-file-retry.mjs` (5
// fixtures, caught by the worker's own targeted run) and `merge-gate-opid-attribution.mjs` (caught only by
// the MERGE GATE itself, after a ~14.5-minute rejection — see this guard's own positive control below for
// the exact pre-fix literal reconstructed from that commit's parent).
//
// ✅ NOT A CORRECTION OF 0e5b2045's DESIGN. A fallback deriving `failTierTest` from a FAIL-shaped
// `failingTest` was proposed and REJECTED (duplicates the FAIL-shape regex `identifyRetriableTestFile`
// already owns, and trades a loud/greppable/deterministic gap for a quiet, data-dependent one). This guard
// adds NO production code and NO fallback — it only makes the ALREADY-ACCEPTED discipline
// (`grep -rln "failingTest" packages/daemon/test/*.mjs`, classify, run all) structural, per project memory
// `shipping-a-detector-is-not-someone-reading-it` (discipline alone measured 0-for-acted-on; a blocking
// guard is what actually gets read).
//
// DETECTION SHAPE — DELIBERATELY NARROW, gated on `failingTestCount:`, NOT on bare `failingTest:` —────────
// The obvious-looking rule ("`failingTest:` present ⇒ `failTierTest:` must be present too") over-fires on a
// wide, genuinely legitimate population that already exists in this corpus today:
//   - `gate-history.mjs`/`pending-gate-ops.mjs` — `db.appendEvent`/`db.settlePendingGateOp` DURABLE EVENT
//     PAYLOADS (`detail:`/`gateDetail:`), typed against the persisted `GateHistoryVerdictPayload` shape
//     (db.ts) which has NO `failTierTest` field AT ALL — it never reaches `identifyRetriableTestFile`.
//   - `gate-history.mjs`'s OWN `richFailGate`/`richCancelGate` `runGate` stubs, `gate-status.mjs`, and
//     `worker-run-gate.mjs` — real `GateSequentialResult`-shaped doubles, but ones that never claim a
//     precise failure COUNT (no `failingTestCount:` at all).
//   - `merge-gate-single-file-retry.mjs`'s own scenario (D) — `failingTest: "AssertionError: ..."` with NO
//     count at all, deliberately proving the "no identifiable file ⇒ no retry attempt" path.
// What every one of THOSE has in common, and what every REAL bug instance (both commit-a995d7bc fixture
// sites, reconstructed below) does NOT have in common: `identifyRetriableTestFile` gates retry on
// `failTierTestCount === 1` — a double that never sets `failingTestCount` at all can *never* have been
// trying to exercise "retry fires because the count is 1", so its missing `failTierTest` can never silently
// break anything. The moment a double DOES commit to a precise `failingTestCount:` — claiming to be a
// complete, countable `GateSequentialResult` account — it has entered exactly the shape the real bug lived
// in, and MUST also carry `failTierTest`/`failTierTestCount` (DoD-1's "and correspondingly for the …Count
// pair"). This is why the rule below triggers on `failingTestCount:`, not on bare `failingTest:` — the
// wider rule would have to re-litigate every file above one by one; this one needs zero of that.
//
// THE ONE FILE-LEVEL EXEMPTION THIS NARROWER RULE STILL CAN'T DERIVE STRUCTURALLY:
// `merge-gate-concurrency-verdict.mjs` sets `failingTestCount: 2` (twice) with NO `failTierTest` at all, and
// reaches `confirmWorkerMergeTracked` (the SAME merge-retry-eligible path the real bugs lived in) — so by
// the reasoning above it LOOKS like a violation. It isn't, for a reason no static scan can see: count `2`
// means `identifyRetriableTestFile`'s own `failTierTestCount !== 1` check refuses retry regardless of
// whether `failTierTest` is ALSO set — pairing this literal would change no observable behaviour anywhere.
// (Commit a995d7bc's OWN scenario (F), the collapsed-multi-failure case in `merge-gate-single-file-retry.
// mjs`, started in this exact unpaired `failingTestCount: 2`-no-`failTierTest` shape too — it got paired
// only because that commit was already rewriting every literal in that file for the OTHER 4, genuinely
// behavioural, sites, not because (F) itself was broken.) card 3c4a19cb's own DoD-2 enumerates this as a
// deliberate, already-reviewed exclusion — "if your rule fires on this file, the rule is wrong, not the
// file" — so it is a named, narrow, commented allowlist entry (EXEMPT_FILES below), not a structural rule.
// EXTENDING THIS ALLOWLIST: add a new entry ONLY for a file where a human has confirmed the count->refusal
// reasoning above genuinely applies — never to silence a fresh failure without reading it first.
//
// SCOPE: `packages/daemon/test/*.mjs` only (source text, never `dist/` — no build required to run this).
// Run: node packages/daemon/test/failing-test-tier-pairing-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = __dirname;
const SELF = path.basename(__filename);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// card 3c4a19cb DoD-2's own deliberate exclusion — see this file's header for the full reasoning (count > 1
// means retry is refused regardless of pairing, so pairing this specific literal is a no-op either way).
const EXEMPT_FILES = new Set(["merge-gate-concurrency-verdict.mjs"]);

/**
 * Replaces every `//` line comment, `/* ... *\/` block comment, `'...'`/`"..."`/`\`...\`` string body, AND
 * `/.../flags` regex literal with blank characters of the SAME length (preserving newlines and overall
 * offsets), so later regex matching AND brace-balance counting against the result only ever see real,
 * executable code. This guard needs whole-file brace balance (unlike a call-scoped paren match), so a
 * regex literal's OWN `{`/`}`/quote characters — e.g. this very corpus's `/registerTool\(\s*["'\`]…/g` or
 * `/\$\{\s*process\.pid\s*\}/` — must never be miscounted as real braces or mistaken for a string
 * delimiter (a quote INSIDE a regex character class previously sent this scanner hunting for a closing
 * quote hundreds of lines away, corrupting the whole file's brace count — caught by this guard's own
 * corpus-wide dry run, not hypothesised). Regex-vs-division is disambiguated by the standard heuristic:
 * `/` starts a regex unless the last significant character emitted so far is one that can end a VALUE
 * (identifier/number char, `)`, `]`, `` ` ``, or a closing string/regex) — after any of those, `/` is a
 * binary division operator instead. Positions in the returned string line up 1:1 with the input, so
 * indices computed against it can be used to recover line numbers from the ORIGINAL text. (String/comment
 * handling mirrors deploy-staleness-fixture-guard.mjs's own `sanitize`; regex handling is new here.)
 */
function sanitize(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  let lastSig = ""; // last significant (non-whitespace) character emitted so far
  const VALUE_END_RE = /[A-Za-z0-9_$)\]`]/;
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
    if (c === "/" && !VALUE_END_RE.test(lastSig)) {
      // Candidate regex literal — scan for its closing (unescaped, outside a [...] class) "/" on the SAME
      // line (a JS regex literal can never contain a literal newline). If none is found, this "/" wasn't a
      // regex start after all (e.g. a stray division in a context this heuristic misjudged) — fall through
      // and treat it as an ordinary character so a real brace right after it is never eaten by mistake.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && text[j] !== "\n") {
        const rc = text[j];
        if (rc === "\\") { j += 2; continue; }
        if (rc === "[") { inClass = true; j++; continue; }
        if (rc === "]") { inClass = false; j++; continue; }
        if (rc === "/" && !inClass) { closed = true; j++; break; }
        j++;
      }
      if (closed) {
        while (j < n && /[a-zA-Z]/.test(text[j])) j++; // trailing flags (g/i/m/s/u/y)
        out += " ".repeat(j - i);
        i = j;
        lastSig = "`"; // a completed regex ends a value, same as a closing string quote for the next "/"
        continue;
      }
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
      lastSig = "`";
      continue;
    }
    out += c;
    if (c !== " " && c !== "\n" && c !== "\t" && c !== "\r") lastSig = c;
    i++;
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** Depth (relative to the START of `text`) IN EFFECT at each index — counts `{[(` as +1, `}])` as -1,
 *  clamped at 0 so a stray unmatched closer never drives it negative. Used to tell an object literal's OWN
 *  keys apart from a nested object/array's keys one level (or more) deeper. */
function computeDepthArray(text) {
  const depths = new Array(text.length);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    depths[i] = depth;
    const c = text[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth = Math.max(0, depth - 1);
  }
  return depths;
}

/** Matches every `{`/`}` in `sanitized` into an open-index -> close-index map. FAILS CLOSED: an extra `}`
 *  with nothing open, or text ending with braces still open, returns `{ ok: false }` rather than a partial
 *  map — a caller must never treat that as "no violations found" (DoD-4). */
function matchBraces(sanitized) {
  const stack = [];
  const matchOpenToClose = new Map();
  for (let i = 0; i < sanitized.length; i++) {
    const c = sanitized[i];
    if (c === "{") stack.push(i);
    else if (c === "}") {
      const open = stack.pop();
      if (open === undefined) return { ok: false, reason: `unmatched "}" at offset ${i}` };
      matchOpenToClose.set(open, i);
    }
  }
  if (stack.length) return { ok: false, reason: `${stack.length} unclosed "{" (never matched by a "}")` };
  return { ok: true, matchOpenToClose };
}

/** For each index in `matchIndices`, the index of the NEAREST currently-open `{` at that point in
 *  `sanitized` (or `null` if none) — i.e. the innermost object literal a `failingTestCount:` match sits
 *  directly inside. A bare "identifier:" only ever occurs directly inside an object literal in this corpus
 *  (never inside a bare block), so this innermost brace IS the object literal to check. */
function enclosingBraceMap(sanitized, matchIndices) {
  const wanted = new Set(matchIndices);
  const result = new Map();
  const stack = [];
  for (let i = 0; i < sanitized.length; i++) {
    if (wanted.has(i)) result.set(i, stack.length ? stack[stack.length - 1] : null);
    const c = sanitized[i];
    if (c === "{") stack.push(i);
    else if (c === "}") stack.pop();
  }
  return result;
}

const FAILING_TEST_COUNT_RE = /(?<![\w$])failingTestCount(?![\w$])\s*:/g;
const OWN_KEY_RE = /(?<![\w$])([A-Za-z_$][\w$]*)(?![\w$])\s*:/g;

/**
 * Classifies one file's RAW text: every object literal that sets `failingTestCount:` as one of its OWN
 * (not nested-deeper) keys must ALSO set `failTierTest:` and `failTierTestCount:` as own keys — unless
 * `fileName` is in `EXEMPT_FILES` (see this file's header for why that one file is different). Returns
 * `{ violations, parseError }`; `parseError` non-null means FAIL CLOSED (DoD-4) — never read `violations`
 * as "clean" when `parseError` is set.
 */
function classify(rawText, fileName) {
  const sanitized = sanitize(rawText);
  const braceResult = matchBraces(sanitized);
  if (!braceResult.ok) return { violations: [], parseError: braceResult.reason };

  const matchIndices = [];
  let m;
  FAILING_TEST_COUNT_RE.lastIndex = 0;
  while ((m = FAILING_TEST_COUNT_RE.exec(sanitized))) matchIndices.push(m.index);
  if (matchIndices.length === 0) return { violations: [], parseError: null };

  const enclosing = enclosingBraceMap(sanitized, matchIndices);
  const exempt = !!fileName && EXEMPT_FILES.has(fileName);
  const violations = [];
  const seenSpans = new Set();

  for (const idx of matchIndices) {
    const openIdx = enclosing.get(idx);
    if (openIdx == null) {
      // A `failingTestCount:`-shaped match with no enclosing object literal at all — genuinely shouldn't
      // happen for a real key, but fail closed rather than silently ignore it (DoD-4).
      violations.push({ line: lineOf(rawText, idx), reason: "failingTestCount: has no enclosing object literal (unparseable)" });
      continue;
    }
    if (seenSpans.has(openIdx)) continue; // 2+ matches in the same literal (shouldn't happen) — one report
    seenSpans.add(openIdx);
    if (exempt) continue;

    const closeIdx = braceResult.matchOpenToClose.get(openIdx);
    const inner = sanitized.slice(openIdx + 1, closeIdx);
    const innerDepths = computeDepthArray(inner);
    const ownKeys = new Set();
    OWN_KEY_RE.lastIndex = 0;
    let km;
    while ((km = OWN_KEY_RE.exec(inner))) {
      if (innerDepths[km.index] === 0) ownKeys.add(km[1]);
    }
    const hasFailTierTest = ownKeys.has("failTierTest");
    const hasFailTierTestCount = ownKeys.has("failTierTestCount");
    if (!hasFailTierTest || !hasFailTierTestCount) {
      const missing = !hasFailTierTest && !hasFailTierTestCount
        ? "failTierTest: and failTierTestCount:"
        : !hasFailTierTest ? "failTierTest:" : "failTierTestCount:";
      violations.push({ line: lineOf(rawText, idx), reason: `sets failingTestCount: but not ${missing}` });
    }
  }
  return { violations, parseError: null };
}

// =====================================================================================================
// (A) POSITIVE CONTROL — proves the classifier actually fires, against a real reconstructed pre-fix
// literal AND known-good/known-exempt/known-unparseable snippets, before trusting a clean corpus scan
// below (DoD-3: this guard's property is satisfied EVERYWHERE today, so a clean scan alone is exactly
// what a BROKEN matcher would also return — memory `positive-control-your-searches-empty-is-not-evidence`).
// =====================================================================================================
{
  // Reconstructed from commit a995d7bc's PARENT (`git show a995d7bc^:packages/daemon/test/
  // merge-gate-opid-attribution.mjs` vs the commit's own diff) — the card cites SHAs `29d68f81`/`08f477c7`
  // that do not exist in this repo's history (re-derived per this guard's own worker's standing
  // instruction to never trust a card's cited coordinate); a995d7bc IS the real fix commit, verified via
  // `git log --follow` on this exact file. THE PRE-FIX LITERAL, verbatim:
  const PRE_FIX_OPID_ATTRIBUTION = 'if (attempt === 1) return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL  flaky-one", failingTestCount: 1 };';
  const bad = classify(PRE_FIX_OPID_ATTRIBUTION, "merge-gate-opid-attribution.mjs");
  check("(A) RED PROOF: the REAL pre-fix (commit a995d7bc's parent) literal — failingTestCount:1 with no failTierTest — IS flagged", bad.parseError === null && bad.violations.length === 1);

  // THE FIX (same commit, same file, current shape): failTierTest/failTierTestCount added alongside.
  const POST_FIX_OPID_ATTRIBUTION = 'if (attempt === 1) return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL  flaky-one", failingTestCount: 1, failTierTest: "FAIL  flaky-one", failTierTestCount: 1 };';
  const good = classify(POST_FIX_OPID_ATTRIBUTION, "merge-gate-opid-attribution.mjs");
  check("(A) GREEN: the SAME literal with failTierTest/failTierTestCount added is NOT flagged", good.parseError === null && good.violations.length === 0);

  // Legitimate exclusion #1 (DoD-2): a bare `failingTest:` with NO count at all — merge-gate-single-file-
  // retry.mjs's own scenario (D), and gate-history.mjs's richFailGate/richCancelGate stubs — never claims a
  // precise count, so it can never have been relying on failTierTestCount === 1 to retry.
  const BARE_NO_COUNT = 'const richFailGate = async () => ({ passed: false, failedStep: "pnpm test", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "FAIL  real_path_test.mjs", failingTest: "real_path_test.mjs", steps: [] });';
  const bareGood = classify(BARE_NO_COUNT, "gate-history.mjs");
  check("(A) GREEN: a bare failingTest: with no failingTestCount: at all is NOT flagged (never claims a precise, retry-eligible count)", bareGood.parseError === null && bareGood.violations.length === 0);

  // Legitimate exclusion #2 (DoD-2): a durable event `detail:`/`gateDetail:` payload — same key name,
  // different (persisted) type, never reaches identifyRetriableTestFile.
  const EVENT_PAYLOAD = 'db.appendEvent({ id: "e1", kind: "worker_gate", detail: { passed: false, durationMs: 9999, gateCap: 1, concurrentGates: 0, concurrentGatesMax: 0, failingTest: "some.mjs" } });';
  const eventGood = classify(EVENT_PAYLOAD, "gate-history.mjs");
  check("(A) GREEN: a durable db.appendEvent detail payload with no count is NOT flagged", eventGood.parseError === null && eventGood.violations.length === 0);

  // Legitimate exclusion #3 (DoD-2): the ONE file-level exemption — failingTestCount: 2 with no
  // failTierTest, but ONLY when the file name matches the allowlisted, human-reviewed exception.
  const CONCURRENCY_SHAPE = 'const fakeGateFail = async (gate) => ({ passed: false, failedStep: gate, failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "FAIL some_test.mjs", failingTest: "some_test.mjs", failingTestCount: 2 });';
  const exemptGood = classify(CONCURRENCY_SHAPE, "merge-gate-concurrency-verdict.mjs");
  check("(A) GREEN: failingTestCount:2 with no failTierTest IS exempted, but ONLY for merge-gate-concurrency-verdict.mjs by name", exemptGood.parseError === null && exemptGood.violations.length === 0);
  // ⚠️ PRECISION CHECK: the SAME literal under a DIFFERENT (non-exempt) file name must still be flagged —
  // proves the allowlist is scoped to the one named file, not a blanket "count > 1 is always fine" rule
  // (commit a995d7bc's own scenario (F) started in exactly this shape and WAS a real violation).
  const notExempt = classify(CONCURRENCY_SHAPE, "some-other-file.mjs");
  check("(A) RED PROOF: the SAME failingTestCount:2-no-failTierTest shape under a NON-exempt file name IS flagged (the exemption is per-file, not per-shape)", notExempt.parseError === null && notExempt.violations.length === 1);

  // A comment merely mentioning "failingTestCount:" in prose must never be treated as a real key.
  const PROSE_MENTION = '// a real gateDetail always carries failingTestCount: alongside failingTest, never one without the other';
  const prose = classify(PROSE_MENTION, "some-file.mjs");
  check("(A) GREEN: a `//` comment merely mentioning \"failingTestCount:\" in prose is NOT treated as a real key", prose.parseError === null && prose.violations.length === 0);

  // Fail-closed (DoD-4): unbalanced braces around a real failingTestCount: match must report a parse
  // error, never silently report "0 violations" (which would be indistinguishable from a clean file).
  const UNBALANCED = 'if (x) return { passed: false, failingTest: "a", failingTestCount: 1 ;'; // missing a closing "}"
  const unbalanced = classify(UNBALANCED, "some-file.mjs");
  check("(A) FAIL-CLOSED PROOF: unbalanced braces around a real match report a parseError, never a silent pass", unbalanced.parseError !== null);
}

// =====================================================================================================
// (B) THE REAL BACKSTOP — every test/*.mjs file in this corpus, scanned live off disk.
// =====================================================================================================
{
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs") && f !== SELF);
  check(`sanity: the test/ corpus walk found a non-trivial population (found ${files.length} .mjs file(s))`, files.length > 500);

  let totalCountMatches = 0;
  const violations = [];
  const parseErrors = [];

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
    } catch (err) {
      // Fail closed (DoD-4): an unreadable file is a FAILURE to report, never a silent skip.
      parseErrors.push({ file, reason: `unreadable: ${err?.message ?? String(err)}` });
      continue;
    }
    const sanitized = sanitize(text);
    FAILING_TEST_COUNT_RE.lastIndex = 0;
    let cm;
    while ((cm = FAILING_TEST_COUNT_RE.exec(sanitized))) totalCountMatches++;
    const { violations: v, parseError } = classify(text, file);
    if (parseError) { parseErrors.push({ file, reason: parseError }); continue; }
    for (const one of v) violations.push({ file, ...one });
  }

  check(`sanity: real failingTestCount: sites actually exist in this corpus (found ${totalCountMatches}) — proves the pattern isn't vacuously narrow`, totalCountMatches > 0);

  if (parseErrors.length) {
    for (const p of parseErrors) console.log(`  PARSE-ERROR  ${p.file}  — ${p.reason}`);
  }
  check(`every scanned file parses cleanly (fail-closed: found ${parseErrors.length} parse error(s))`, parseErrors.length === 0);

  if (violations.length) {
    for (const v of violations) console.log(`  UNPAIRED  ${v.file}:${v.line}  — ${v.reason}`);
  }
  check(
    `every failingTestCount: site in the corpus also sets failTierTest:/failTierTestCount: (found ${violations.length} violation(s) across ${totalCountMatches} failingTestCount: site(s), excluding the ${EXEMPT_FILES.size} named exemption(s))`,
    violations.length === 0,
  );
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the classifier fires on the real reconstructed pre-fix literal and on the same exempt shape under a non-exempt name, ignores prose/no-count/event-payload/exempt shapes, fails closed on unbalanced braces, and the real test/ corpus currently has zero unpaired failingTestCount: sites."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
