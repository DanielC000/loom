import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";

/**
 * Split a `gateCommand` on its TOP-LEVEL `&&` joins (outside single/double quotes) into independent
 * steps — e.g. `pnpm lint && pnpm test && pnpm build` → `["pnpm lint", "pnpm test", "pnpm build"]`. A
 * gate with no `&&` returns a single-element array (the whole command), so callers need no special case.
 * `gateCommand` is HUMAN-set/trusted (see the trust-boundary note on its runner below), so this is a
 * simple quote-aware scanner, not a full shell parser.
 */
export function splitGateSteps(gate: string): string[] {
  const steps: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < gate.length; i++) {
    const ch = gate[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "&" && gate[i + 1] === "&") {
      steps.push(current.trim());
      current = "";
      i++; // consume both '&'
      continue;
    }
    current += ch;
  }
  steps.push(current.trim());
  return steps.filter((s) => s.length > 0);
}

/** Cap (bytes) on the captured stdout+stderr tail kept per gate step, for diagnostics on a rejection —
 *  a bounded ring, never the full log. Mirrors python/venv.ts's `OUTPUT_TAIL_BYTES`. */
const OUTPUT_TAIL_BYTES = 4096;

/** Failing-test/assertion marker patterns, shared by the LIVE per-step scanner (below) and the post-hoc
 *  {@link extractFailingTest} (kept for a caller holding only a raw string, e.g. a test double that bypasses
 *  the real runner). Recognizes cross-ecosystem failure markers: an uncaught-throw idiom (below), Loom's own
 *  `FAIL  <label>` convention, Jest/AVA/tap-style `FAIL`/`not ok`/✗/✖ markers, thrown `AssertionError`s, and
 *  `error TSxxxx` typechecker diagnostics.
 *
 *  Card 0e5b2045: the `UNCAUGHT` tier sits FIRST (highest priority), ABOVE `FAIL`/`not ok` — a deliberate
 *  priority decision, not an append. `result()` (below) returns the highest-priority tier with any match,
 *  so insertion position decides which line wins when a run prints both. A subset of this daemon's own
 *  test files report a genuine (non-`AssertionError`) thrown failure via `console.error("... UNCAUGHT ...")`
 *  — re-answer the live count yourself with `grep -rl UNCAUGHT packages/daemon/test/*.mjs` (an upper bound:
 *  a couple of hits are files that only mention the idiom in a comment or fixture, not files that use it for
 *  their own real failures) rather than trusting any number written here — card 63664129 measured ~12-14
 *  against this file's own stale "9", on 2026-09-04, and a hardcoded count is exactly the kind of thing that
 *  drifts silently on the next file added or removed. This daemon's own
 *  `test-daemon.mjs` `runLane` ALSO prints a `FAIL  <name>  (exit N)` wrapper line for every
 *  failing file, regardless of why it failed — a content-free summary (name + exit code only) that matched
 *  tier 0 and WON, in the incident that motivated this card, while the actual stack (only reachable via the
 *  `UNCAUGHT` line, printed later in the same stream, in `test-daemon.mjs`'s own end-of-run `FAILURES:`
 *  echo) matched no tier at all and was discarded. An explicit uncaught-exception marker names a real thrown
 *  error with a stack; a bare `FAIL`/`not ok` label is not reliably richer than that (this project's own
 *  convention proves it can be strictly poorer) — so when both are present, the uncaught-exception detail is
 *  the more useful line for a human diagnosing a rejection, and wins.
 *  ⚠️ DECOUPLED FROM RETRY ON PURPOSE (manager review, card 0e5b2045): {@link identifyRetriableTestFile}
 *  only recognizes a string shaped like `FAIL <name>` (its own bare-identifier regex) to drive the
 *  single-file merge retry — and `kickoff-real-spawn` (one of the `UNCAUGHT`-idiom files above) is this
 *  daemon's OWN measured source of both weaker-passes ever recorded, at roughly a 1-in-11 rate. Letting
 *  `result()`'s new UNCAUGHT-wins priority also decide retry eligibility would have turned every one of
 *  those self-healing retries into a hard merge rejection (~15 extra minutes each) as a SIDE EFFECT of a
 *  diagnostics fix — a real, recurring cost, and a policy change to fleet-wide merge-gate retry behavior
 *  that deserves its own deliberate decision, not an accidental one. So retry reads a SEPARATE accessor —
 *  {@link createFailingTestTracker.failTierResult}/`.failTierMatchCount` — independent of whichever tier
 *  `result()` picked for display. `result()`'s diagnostic value and identifyRetriableTestFile's retry
 *  target can now differ on the SAME run (by design) without either one losing information the other
 *  already had. **Card 6c84b87b:** these two accessors do NOT read this file's `FAILING_TEST_PATTERNS`
 *  tiers at all — see {@link HARNESS_FAIL_WRAPPER_RE}'s own doc for why the retry needs a narrower,
 *  differently-anchored match than the diagnostic tiers do. */
/** The `FAIL`/`not ok` tier of {@link FAILING_TEST_PATTERNS}, named separately so `scanLine` (below) can
 *  identify a match against THIS specific tier by reference (`===`), independent of its array position. */
const FAIL_NOT_OK_TIER_RE = /^\s*(FAIL|✗|✖|not ok)\b.*/i;
const FAILING_TEST_PATTERNS: RegExp[] = [
  /\bUNCAUGHT\b.*/,
  FAIL_NOT_OK_TIER_RE,
  /AssertionError.*/,
  /error TS\d+:.*/,
];

/**
 * Card 11737292 — a LIVE specimen (op `321a5e6b`'s `[loom:merge-rejected]` nudge) reported `failing: FAIL
 *  some_test.mjs` for a file that does not exist. Root cause: `gate-status.mjs`'s own tests inject a MOCK
 *  gate verdict (`outputTail: "FAIL  some_test.mjs"`) to exercise `sessions/service.ts`'s real
 *  `[gate opId=…] … passed=false …` diagnostic `console.log` — which dumps that mock's `outputTail`
 *  VERBATIM, unindented, as its own line. When `gate-status.mjs` itself later failed for an unrelated
 *  reason (an `exit timeout` in the specimen), `test-daemon.mjs`'s own `FAILURES:` epilogue re-echoed that
 *  captured line into the OUTER gate run's stream, where {@link createFailingTestTracker}'s `FAIL`/`not ok`
 *  tier matched it exactly like a real per-file marker.
 *
 *  A genuine per-file harness wrapper line always carries a trailing `(exit ` suffix
 *  ({@link HARNESS_FAIL_WRAPPER_RE}) and a `check()`-printed assertion line is always a multi-word prose
 *  label (see that helper's own convention, `gate-status.mjs`'s own `check` definition) — neither shape is
 *  a BARE single token. `FAIL  some_test.mjs` is: nothing follows the token, so this is the one shape that
 *  can never legitimately be either of those two real conventions. Cross-checking that token against the
 *  real filesystem (mirroring {@link identifyRetriableTestFile}'s own `fs.existsSync` gate, same fail-closed
 *  posture: a project without this daemon's own `packages/daemon/test/` layout skips the check entirely,
 *  same as that function's own no-op-elsewhere behavior) catches the exact specimen — `some_test.mjs` is a
 *  placeholder name that has never existed on disk — while leaving every genuine bare-name match (a real
 *  file, e.g. from a project that DOES use this convention) untouched. */
function isUnverifiableBareFailToken(line: string, cwd: string): boolean {
  const m = /^\s*(?:FAIL|✗|✖|not ok)\s+(\S+)\s*$/i.exec(line);
  if (!m) return false; // has prose/extra content beyond one token — not this shape, don't second-guess it
  const token = m[1]!;
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) return false; // never a path/shell metacharacter — not one of ours
  const testDir = path.join(cwd, "packages", "daemon", "test");
  if (!fs.existsSync(testDir)) return false; // not this project's own layout — nothing to verify against
  const candidate = path.join(testDir, token.endsWith(".mjs") ? token : `${token}.mjs`);
  return !fs.existsSync(candidate);
}

/**
 * Card 6c84b87b: the ONLY line shape {@link createFailingTestTracker.failTierResult}/`.failTierMatchCount`
 * — and therefore {@link identifyRetriableTestFile} — may ever count. This is `test-daemon.mjs`'s own
 * `runLane` wrapper line, verbatim: `` console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}  (exit
 * ${statusLabel})`) `` (packages/daemon/scripts/test-daemon.mjs) — printed UNINDENTED, exactly once per
 * failing file, the moment that file's own child process settles.
 *
 * 🔴🔴 THE BUG THIS REPLACES: `failTierResult`/`failTierMatchCount` used to read `FAILING_TEST_PATTERNS`'
 * own `FAIL`/not-ok tier — an UNANCHORED, case-insensitive pattern with a leading optional-whitespace run —
 * a pattern shared with the general-purpose diagnostic scan (`result()`/`matchCount()`, still below). Its
 * leading whitespace run was written
 * for THAT purpose (a diagnostic marker can legitimately arrive indented inside another tool's own
 * output), but it ALSO matches `test-daemon.mjs`'s own end-of-run `FAILURES:` epilogue — which re-echoes
 * EVERY failing file's full captured stdout/stderr, indented 6 spaces (`console.log(f.stdout…
 * .map((l) => \`      ${l}\`)…)`) — and 815-of-848 of this daemon's own test files fail an assertion via a
 * `check()` helper that itself prints an unindented `FAIL  <label>` line (e.g.
 * `packages/daemon/test/gate-history.mjs:60`). A file that fails ONE such assertion therefore emits TWO
 * FAIL-tier hits under the old unanchored pattern — the `runLane` wrapper AND its own later echoed
 * `check()` line — so `failTierMatchCount()` read `2`, `identifyRetriableTestFile` required exactly `1`,
 * and the retry was refused for every assertion failure. Only a file that died by THROWING (zero failed
 * `check()`s, so nothing for the epilogue to echo that also matches this tier) ever produced exactly `1`.
 *
 * THE FIX: anchor on BOTH ends of what the wrapper line alone has and nothing else in the stream can fake:
 * (1) NO leading whitespace — every line the `FAILURES:` epilogue echoes is indented (2 spaces for the
 * per-file `  - <name> (exit N): …` header, 6 spaces for the echoed body) — so the epilogue's own echo of a
 * file's `FAIL  <label>` line can never satisfy this pattern; and (2) the trailing `  (exit ` suffix —
 * `check()`'s own per-assertion `FAIL  <label>` print (see the file cited above) never carries it, since
 * only `runLane`'s own per-FILE wrapper knows an exit status at all. Condition (2) is what ALSO closes card
 * `2a79a74c` finding #4 (a reduced-path static guard, run bare via `node <path>` with no `runLane` wrapper
 * at all — see `git/worktrees.ts`'s `buildReducedGateCommand` — prints an unindented `FAIL  <label>` line
 * on its own failed `check()`, satisfying condition (1) alone; requiring condition (2) too means a guard's
 * own bare assertion failure can never be mistaken for a real per-file wrapper line, so it never produces a
 * retry candidate at all, related or not).
 */
export const HARNESS_FAIL_WRAPPER_RE = /^FAIL\s+\S+\s+\(exit /;

/**
 * Card 2a79a74c finding #5: matches `test-daemon.mjs`'s own structural `notExecuted` invariant failure —
 * `console.error(\`❌ test-daemon.mjs: ${notExecuted.length} discovered hermetic test file(s) were NOT
 * actually executed — naming them: ...\`)` followed by `process.exit(1)`, fired BEFORE the `FAILURES:`
 * epilogue ever runs (see that call site's own comment in `scripts/test-daemon.mjs`).
 *
 * ⚠️ THE RISK THIS EXISTS TO CLOSE: that early exit does NOT suppress `runLane`'s own per-file wrapper
 * line ({@link HARNESS_FAIL_WRAPPER_RE}) for whichever file(s) genuinely failed an assertion in the SAME
 * run — `runLane` prints its `FAIL  <name>  (exit N)` line THE MOMENT that file's own child process
 * settles, well before the later, separate `notExecuted` bookkeeping check even runs. So a run that BOTH
 * genuinely fails exactly one test AND, via an unrelated structural bug, silently never executes some
 * OTHER discovered file(s) still yields `failTierMatchCount() === 1` for the one genuine failure alone —
 * {@link identifyRetriableTestFile} would otherwise happily identify and retry that ONE file, and a pass
 * on the isolated `--only=<name>` retry would let the merge proceed while the structural "some selected
 * files never ran at all" defect is never re-observed (a single-file retry has no way to re-check it).
 * This regex is the caller's own signal to refuse that retry outright regardless of `failTierMatchCount`
 * — see {@link identifyRetriableTestFile}'s `harnessNotExecutedDetected` parameter.
 */
export const HARNESS_NOT_EXECUTED_RE = /^❌ test-daemon\.mjs: \d+ discovered hermetic test file\(s\) were NOT actually executed/;

/** Card 2f0b2e57 (two real merge-gate rejections, both from this daemon's OWN test suite): a line
 *  recording a PASSING assertion — this daemon's own `check()` convention, `PASS  <label>`, optionally
 *  indented — must never be mistaken for a failure, no matter what words the passing assertion's own
 *  LABEL happens to contain. `FAILING_TEST_PATTERNS`' `UNCAUGHT`/`AssertionError`/`error TS\d+` tiers are
 *  all UNANCHORED (they match the keyword ANYWHERE in a line, not just at its start) — a real specimen
 *  (op `5b2075db`) hit this exactly: `merge-gate-single-file-retry.mjs`'s own retry-decoupling assertion
 *  is LABELLED `"the retry call names flaky-j (from failTierTest), never anything derived from the
 *  UNCAUGHT diagnostic string"` — a line describing the UNCAUGHT idiom in prose, which PASSED, was
 *  reported as the failing test. Checked BEFORE any `FAILING_TEST_PATTERNS` tier is tried, so no tier —
 *  anchored or not, tier 0 or tier 3 — can ever win against a line that is itself a recorded PASS. The
 *  `FAIL`/`not ok` tier already can't match a PASS line on its own (it's anchored to the start of the
 *  line), but this guard makes the invariant FLAT and tier-independent rather than an accident of which
 *  tiers happen to be anchored today. Applied in `scanLine` before {@link HARNESS_FAIL_WRAPPER_RE} is
 *  tried too, for the same reason, even though a PASS line can never actually satisfy that pattern (it
 *  never starts with the literal word `FAIL`). */
const PASS_LINE_RE = /^\s*PASS\b/i;

/** Cap (bytes/UTF-16 code units) on `createFailingTestTracker`'s `carry` — the not-yet-newline-terminated
 *  remainder it holds between `feed()` calls. See that function's own doc for why this must be bounded. */
const FAILING_TEST_CARRY_CAP_BYTES = 8192;

/**
 * Card 55cba5c5: scans a step's stdout+stderr AS IT STREAMS for the LAST failing-test/assertion marker
 * line, independent of the bounded {@link OUTPUT_TAIL_BYTES} ring `runGateStep`'s `tail()` keeps for
 * display. A tail dominated by trailing warnings or a pnpm epilogue — the COMMON failure mode, not an edge
 * case — can truncate the actual failing-test line right out of the last N bytes of combined output;
 * scanning the FULL stream as it arrives means the failing test's identity survives that truncation.
 *
 * PRIORITY PRESERVED, PER TIER: tracks the LAST line matching EACH {@link FAILING_TEST_PATTERNS} entry
 * independently (one slot per pattern), then `result()` returns the highest-priority tier (lowest index)
 * that has ANY match — mirroring {@link extractFailingTest}'s own "first pattern with a hit wins" ordering
 * (a `FAIL`/`not ok` marker always wins over a bare `AssertionError` line, matching a runner's own PASS/
 * FAIL-by-name summary over an incidental thrown-error line) — while still preferring the LAST occurrence
 * *within* that winning tier, which is what actually survives truncation (a summary line near the end of
 * a long run, not necessarily the first thing printed).
 *
 * Deliberately keeps only one line per pattern (a handful of bytes total), never the whole output, so this
 * adds no meaningful memory over the existing ring. Uses a streaming `TextDecoder` (not a per-chunk
 * `Buffer#toString`) so a multi-byte UTF-8 character split across two chunks decodes correctly instead of
 * producing a mangled replacement character right at the boundary.
 *
 * CARRY IS BOUNDED, TWO LAYERS (Code Review, card 55cba5c5):
 *  1. **A bare `\r` is a line boundary too** — `split(/\r\n|\r|\n/)`, not the original `/\r?\n/`. A
 *     progress-bar/download-meter renderer (pnpm/npm/turbo all use one) rewrites its line in place via a
 *     bare `\r` with NO following `\n`; the original regex never splits on that, so a step dominated by
 *     that kind of output would never pop anything off `carry` — it would grow to hold the step's ENTIRE
 *     combined output in daemon memory, exactly the unbounded thing {@link OUTPUT_TAIL_BYTES}'s own ring
 *     exists to avoid. Treating `\r` as a real boundary flushes each progress frame through `scanLine`
 *     the moment it arrives (matching or not — most don't), so `carry` naturally stays small for this
 *     realistic case AND a marker written with a bare `\r` (not just `\n`) is still found immediately,
 *     regardless of how much unrelated progress-bar text follows it in the SAME feed() call — `lastByPattern`
 *     only ever holds one short line per tier, not the stream itself.
 *  2. **A hard cap on `carry` as the backstop** for the residual pathological case this splitting can't
 *     help — a single write with NO `\r` and NO `\n` anywhere (an arbitrarily long unbroken string). That
 *     can't be flushed early no matter how the splitting is done, so `carry` is capped to the last
 *     {@link FAILING_TEST_CARRY_CAP_BYTES} after every `feed()` regardless. A real failing-test marker
 *     line is never anywhere close to that size, so this never interferes with the marker this tracker
 *     exists to find in the realistic case — it only discards old content that was never going to match.
 *
 * Exported (unlike the rest of this module's internals) so a hermetic test can drive it directly with
 * synthetic bare-`\r`/no-delimiter chunks, mirroring how `runGateStep`/`splitGateSteps` are already
 * exported for the same reason.
 *
 * ⚠️ KNOWN LIMITATION, LEFT UNFIXED HERE (card 2f0b2e57, specimen 2 — a WEAKER hypothesis than the
 * PASS-line bug specimen 1 fixed above; not reconstructed from a raw stream, only observed as plausible):
 * this daemon's own `test-daemon.mjs` runs failing files through a concurrent multi-lane pool, and every
 * lane's output lands in the SAME combined stream this tracker scans. "The LAST line matching the winning
 * tier" therefore means "whichever lane's matching line was written last to the shared stream", not "the
 * line belonging to whichever file the run ultimately blames". When more than one file's own FAIL-tier
 * line is genuinely present, `failTierMatchCount() !== 1` already refuses the single-file MERGE RETRY on
 * that ambiguity ({@link identifyRetriableTestFile} below) — but `result()`/`failingTest` (the DIAGNOSTIC
 * field surfaced in `gateDetail`) carries no equivalent gate: it always returns *a* real matching line,
 * with no guarantee it's the one test-daemon.mjs's own end-of-run `FAILURES:` echo ultimately blames.
 * Fixing this for real needs test-daemon.mjs to tag each lane's own lines with an attributable marker (a
 * lane or file id) before they ever reach this scanner — a change to the test HARNESS, not this tracker,
 * and out of scope for this card.
 *
 * Card 11737292: `cwd` is OPTIONAL and purely a cross-check — see {@link isUnverifiableBareFailToken}'s own
 * doc for exactly what it guards against and why omitting it (every existing caller that doesn't have a
 * `cwd` handy, e.g. a hermetic test driving this scanner directly on synthetic input) is unaffected: the
 * check simply never runs, identical to today's behavior.
 */
export function createFailingTestTracker(cwd?: string): {
  feed(chunk: Buffer): void;
  result(): string | undefined;
  matchCount(): number;
  failTierResult(): string | undefined;
  failTierMatchCount(): number;
  harnessNotExecutedDetected(): boolean;
} {
  const decoder = new TextDecoder("utf-8");
  let carry = "";
  // Card [manager review, sibling p0 report on 344ce950]: `lastByPattern` alone (below) can only ever
  // report the LAST line that matched each tier — a run where MULTIPLE lines match the SAME tier silently
  // discards every one but the last. `countByPattern` is the fix's data source: incremented on EVERY match,
  // never reset, so `matchCount()` (below) can tell a caller "exactly one line matched" apart from "more
  // than one matched and only the last survived". PURELY DIAGNOSTIC now (card 6c84b87b): this pair backs
  // `result()`/`matchCount()` display only — a "LINE count" that can inflate on a SINGLE genuinely-failing
  // file (its own multiple echoed assertion lines can all match one tier), not a "FAILING FILE count".
  // {@link identifyRetriableTestFile}'s own multi-file ambiguity guard reads the SEPARATE
  // `lastHarnessWrapper`/`harnessWrapperCount` tracking below instead, which counts real per-file wrapper
  // lines and so doesn't conflate "many lines" with "many files" the way this pair structurally can.
  const lastByPattern: (string | undefined)[] = new Array(FAILING_TEST_PATTERNS.length).fill(undefined);
  const countByPattern: number[] = new Array(FAILING_TEST_PATTERNS.length).fill(0);
  // Card 6c84b87b: tracked SEPARATELY from lastByPattern/countByPattern above — see HARNESS_FAIL_WRAPPER_RE's
  // own doc for why the retry needs a narrower, differently-anchored match than the diagnostic tiers do.
  let lastHarnessWrapper: string | undefined;
  let harnessWrapperCount = 0;
  // Card 2a79a74c #5: tracked independently of the harness-wrapper/tier state above — see
  // HARNESS_NOT_EXECUTED_RE's own doc for why this needs its own flag rather than piggybacking on
  // failTierMatchCount (the two conditions are DELIBERATELY independent: a run can trip this, the FAIL
  // tier, both, or neither).
  let notExecutedSeen = false;
  // A carry flush (the final partial line, scanned once at `result()`/`matchCount()` time — see below) must
  // never run twice: `scanLine` mutates `countByPattern`, and `result()`/`matchCount()` can each be called
  // once per tracker instance in production (one per gate step) — but nothing prevents a caller invoking
  // both, and re-scanning the same carry line twice would silently inflate its tier's count.
  let carryFlushed = false;
  const scanLine = (line: string): void => {
    // Card 2f0b2e57: a recorded PASS is never a failure, whatever its label says — see PASS_LINE_RE's own
    // doc. Checked before any tier so no tier, anchored or not, can ever win against a PASS line.
    if (PASS_LINE_RE.test(line)) return;
    // Card 6c84b87b: checked independently of (not instead of) the FAILING_TEST_PATTERNS loop below — a
    // harness wrapper line already also satisfies FAILING_TEST_PATTERNS' own FAIL tier (used for `result()`/
    // `matchCount()` diagnostics), and both trackings must see it.
    if (HARNESS_FAIL_WRAPPER_RE.test(line)) { lastHarnessWrapper = line.trim(); harnessWrapperCount++; }
    if (HARNESS_NOT_EXECUTED_RE.test(line)) notExecutedSeen = true;
    for (let i = 0; i < FAILING_TEST_PATTERNS.length; i++) {
      const pattern = FAILING_TEST_PATTERNS[i]!;
      if (pattern.test(line)) {
        // Card 11737292: a bare `FAIL  <token>` line (nothing else on it) whose token doesn't correspond to
        // a real test file is exactly the shape a test's own mocked/dumped gate verdict produces when it
        // leaks into real stdout — see isUnverifiableBareFailToken's own doc. Discard rather than record: a
        // real per-file marker or check() line never has this shape, so this can never suppress a genuine
        // match, and letting this line match NO tier lets a genuine failure elsewhere still win.
        if (pattern === FAIL_NOT_OK_TIER_RE && cwd && isUnverifiableBareFailToken(line, cwd)) return;
        lastByPattern[i] = line.trim(); countByPattern[i] = (countByPattern[i] ?? 0) + 1; return;
      }
    }
  };
  const flushCarryOnce = (): void => {
    if (carryFlushed) return;
    carryFlushed = true;
    // A final partial line (no trailing newline/CR, e.g. the process exited mid-write) can still be the
    // failing marker itself — scan it too before resolving the winning tier.
    scanLine(carry);
  };
  return {
    feed(chunk: Buffer): void {
      const text = carry + decoder.decode(chunk, { stream: true });
      const lines = text.split(/\r\n|\r|\n/);
      carry = lines.pop() ?? "";
      if (carry.length > FAILING_TEST_CARRY_CAP_BYTES) carry = carry.slice(-FAILING_TEST_CARRY_CAP_BYTES);
      for (const line of lines) scanLine(line);
    },
    result(): string | undefined {
      flushCarryOnce();
      for (const m of lastByPattern) if (m) return m;
      return undefined;
    },
    /** How many lines matched the SAME tier {@link result} reports (i.e. the winning, highest-priority
     *  tier that has ANY match) — `0` when nothing matched at all (mirrors `result()`'s own `undefined`).
     *  PURELY DIAGNOSTIC alongside `result()` (card 0e5b2045 decoupled retry onto `failTierMatchCount()`
     *  below — this is no longer what {@link identifyRetriableTestFile} reads). Deliberately NOT deduped by
     *  exact line content: a tier that matched N times, even if some of those lines are textually
     *  identical, reports N. */
    matchCount(): number {
      flushCarryOnce();
      for (let i = 0; i < FAILING_TEST_PATTERNS.length; i++) if (lastByPattern[i]) return countByPattern[i] ?? 0;
      return 0;
    },
    /** Card 0e5b2045 (retargeted onto {@link HARNESS_FAIL_WRAPPER_RE} by card 6c84b87b): `test-daemon.mjs`'s
     *  own per-FILE `runLane` wrapper line, independent of whichever tier {@link result} picked for display —
     *  the single-file merge retry ({@link identifyRetriableTestFile}) reads THIS, never `result()`, so a
     *  higher-priority diagnostic tier (e.g. `UNCAUGHT`) winning `result()` never silently changes which
     *  failure the retry targets. ⚠️ NOT the same match set as `result()`'s own FAIL/not-ok tier — see
     *  `HARNESS_FAIL_WRAPPER_RE`'s own doc for exactly what distinguishes the two and why the difference is
     *  the fix, not a bug. `undefined` when no harness wrapper line was ever seen in this step's output at
     *  all — an honest miss, same discipline as `result()`. */
    failTierResult(): string | undefined {
      flushCarryOnce();
      return lastHarnessWrapper;
    },
    /** How many lines matched {@link HARNESS_FAIL_WRAPPER_RE} — the count {@link identifyRetriableTestFile}
     *  actually gates its `=== 1` check on. `0` when `failTierResult()` is `undefined`. Deliberately NOT
     *  deduped by exact line content, same as `matchCount()` — over-counting only ever SUPPRESSES a retry
     *  (the safe direction; see {@link identifyRetriableTestFile}'s own doc), never wrongly permits one. As
     *  of card 6c84b87b, `> 1` here means what it always should have: genuinely MULTIPLE distinct failing
     *  files each printed their own wrapper line in this run — not an assertion failure's own `check()`
     *  output getting counted a second time via `test-daemon.mjs`'s later `FAILURES:` echo of it. */
    failTierMatchCount(): number {
      flushCarryOnce();
      return harnessWrapperCount;
    },
    /** Card 2a79a74c #5: true iff a line matching {@link HARNESS_NOT_EXECUTED_RE} was seen anywhere in
     *  this step's output — `test-daemon.mjs`'s own structural "some selected file(s) were never
     *  executed" failure. {@link identifyRetriableTestFile} refuses to identify ANY retry candidate when
     *  this is true, regardless of `failTierMatchCount()` — see that regex's own doc for why a
     *  co-occurring genuine test failure's own wrapper line is not by itself a sufficient signal that
     *  this run is safe to retry piecemeal. */
    harnessNotExecutedDetected(): boolean {
      flushCarryOnce();
      return notExecutedSeen;
    },
  };
}

/** Marks the start of `test-daemon.mjs`'s own end-of-run failure echo (`console.log("FAILURES:")` —
 *  packages/daemon/scripts/test-daemon.mjs — followed by each failed file's name/exit-code line and its
 *  FULL captured stdout+stderr). Card 6ffee3e2: on a verbose suite (hundreds of `PASS` lines ahead of the
 *  first failure) `runGateStep`'s own {@link OUTPUT_TAIL_BYTES} TRAILING ring is structurally guaranteed to
 *  hold summary/pnpm-epilogue noise instead of the failure — measured specimen (op `a2679c1f`): the
 *  block's header + per-file name/exit-code line survived into a 4KB trailing tail, but the per-file BODY
 *  (the actual assertion) — echoed immediately after that line, before the pnpm wrapper's own epilogue —
 *  was exactly what got pushed out. Anchoring on this marker and keeping bytes FORWARD from it
 *  (front-anchored, not trailing) recovers that body regardless of how much output preceded it. */
const FAILURE_BLOCK_START_RE = /^FAILURES:\s*$/;

/** Cap (bytes) on the front-anchored FAILURES:-block capture below — generous enough to hold a real
 *  per-file diagnostic (name + exit code + the full stdout/stderr a failing file printed) without
 *  retaining the whole stream. Deliberately a SEPARATE constant from {@link OUTPUT_TAIL_BYTES}: that one
 *  bounds a TRAILING ring (evicts old bytes as new ones arrive); this one bounds a FRONT-anchored capture
 *  (stops accepting new bytes once full) — the two answer different questions and must not be conflated. */
const FAILURE_BLOCK_CAP_BYTES = 16_384;

/**
 * Card 6ffee3e2: streams a step's stdout+stderr for `test-daemon.mjs`'s own `FAILURES:` marker (see
 * {@link FAILURE_BLOCK_START_RE}) and, once seen, captures bytes FORWARD from it (front-anchored),
 * bounded to {@link FAILURE_BLOCK_CAP_BYTES} — the OPPOSITE eviction direction from `runGateStep`'s own
 * trailing {@link OUTPUT_TAIL_BYTES} ring, which is exactly why that ring alone can lose this content (see
 * the marker's own doc). Mirrors {@link createFailingTestTracker}'s streaming/carry-cap shape (same
 * TextDecoder + `\r\n|\r|\n` line-boundary splitting, same {@link FAILING_TEST_CARRY_CAP_BYTES} bound on
 * the not-yet-terminated remainder) rather than inventing a second convention. `result()` returns
 * `undefined` when the marker was never seen — an honest miss (the gate command isn't `test-daemon.mjs`,
 * or the run never reached its own end-of-suite echo), never a guess.
 */
export function createFailureBlockTracker(): { feed(chunk: Buffer): void; result(): string | undefined } {
  const decoder = new TextDecoder("utf-8");
  let carry = "";
  let triggered = false;
  let buf = "";
  let capped = false;
  const appendLine = (line: string): void => {
    if (capped) return;
    buf += (buf ? "\n" : "") + line;
    if (buf.length >= FAILURE_BLOCK_CAP_BYTES) { buf = buf.slice(0, FAILURE_BLOCK_CAP_BYTES); capped = true; }
  };
  return {
    feed(chunk: Buffer): void {
      if (capped) return;
      const text = carry + decoder.decode(chunk, { stream: true });
      const lines = text.split(/\r\n|\r|\n/);
      carry = lines.pop() ?? "";
      if (carry.length > FAILING_TEST_CARRY_CAP_BYTES) carry = carry.slice(-FAILING_TEST_CARRY_CAP_BYTES);
      for (const line of lines) {
        if (!triggered) {
          if (!FAILURE_BLOCK_START_RE.test(line)) continue;
          triggered = true;
        }
        appendLine(line);
        if (capped) return;
      }
    },
    result(): string | undefined {
      if (!triggered && FAILURE_BLOCK_START_RE.test(carry)) triggered = true;
      if (!triggered) return undefined;
      if (!capped) appendLine(carry);
      return buf.length ? buf : undefined;
    },
  };
}

/** Idle-liveness threshold for the ONE-TIME auto-extend (card 24642c3d, see {@link runGateStep}): if the
 *  child has produced any stdout/stderr byte within this many ms of the timeout firing, it's still
 *  actively working, not stalled — worth one more full `timeoutMs` window instead of an immediate kill.
 *  The default sits comfortably below BOTH a genuinely hung individual test's own inner self-timeout
 *  (Loom's `test:daemon` bounds each of its 130+ hermetic files at 120s and reports a hang as its own
 *  `FAIL` line well before this threshold could even matter) AND the typical gap between consecutive
 *  PASS/FAIL lines in a healthy-but-slow full run under heavy fleet contention — so the common "just
 *  needs more wall-clock" case reliably reads as live and gets the extension, while a truly silent/wedged
 *  process does not. Env-overridable for a test to drive it near-zero instead of waiting out real minutes. */
export const GATE_EXTEND_IDLE_MS = Number(process.env.LOOM_GATE_EXTEND_IDLE_MS) || 60_000;

/** Master on/off for the auto-extend-once behavior. Default ON; env-overridable so a test/op can force
 *  deterministic immediate-kill-at-first-deadline behavior (the same `!== "0"` env-boolean shape the
 *  merge gate's own retry policy uses — see @loom/shared's GateRetryConfig/`resolveConfig`). */
export const GATE_TIMEOUT_EXTEND_ENABLED = process.env.LOOM_GATE_TIMEOUT_EXTEND_ENABLED !== "0";

/**
 * Liveness hooks an external caller — {@link GateSemaphore}'s registry, so `gate_status`/`gate_queue` can
 * expose `idleMs`/`extended` — can pass into {@link runGateStep}/{@link runGateSequential} to MIRROR this
 * runner's own internal liveness tracking. Deliberately a mirror, never a second independently-computed
 * clock: elapsed time alone cannot tell "working hard" from "hung" (see `GATE_EXTEND_IDLE_MS`'s own doc),
 * so any external idle signal must be the SAME `lastOutputAt`/`extended` state this file already tracks
 * for its own auto-extend decision, not a divergent second measurement. All optional/no-ops when omitted,
 * so every existing `GateStepRunner` caller (a hermetic test double, or a production call site that
 * hasn't been updated) is unaffected.
 */
export interface GateLivenessHooks {
  /** Fired once at the very start of a step, before ITS OWN `lastOutputAt`/`extended` state initializes —
   *  lets a caller reset its mirrored idle clock/extended flag to match this fresh step (the auto-extend
   *  is scoped PER STEP, not per whole gate run — see `extended`'s own doc below). */
  onStepStart?: () => void;
  /** Fired on every stdout/stderr chunk this step captures — the exact same event that updates this
   *  runner's own `lastOutputAt`, so a caller's mirrored idle clock advances in lockstep rather than
   *  drifting from a separately-timed poll. */
  onOutput?: () => void;
  /** Fired the one time (per step) this runner auto-extends the step's timeout because the child was
   *  still producing output — mirrors {@link GateStepResult}'s own `extended`-gated-once semantics (see
   *  `runGateStep`'s `onTimeout`). */
  onExtend?: () => void;
}

/** One gate step's outcome: exit code, spawn error (if any), the signal that killed it (if any — e.g. an
 *  OOM SIGKILL, or our own timeout-kill), whether OUR timeout bound was what killed it, and the bounded
 *  combined stdout+stderr tail. `signal`/`timedOut` are captured (not yet acted on) so a later change
 *  (card bcba83a1) can classify an OOM/SIGKILL kill distinctly from a genuine non-zero exit.
 *  `decidedAt` (card 9f3164b8) is `performance.now()` at the instant the outcome was DECIDED — i.e. when
 *  the close/error event fired, or when the timeout branch chose to kill rather than extend — BEFORE any
 *  async teardown (the timeout path's `killGateProcessTree`, a real OS-process wait that can itself run
 *  hundreds of ms under host contention). A caller measuring step latency against `decidedAt` gets the
 *  time the DECISION took, uncontaminated by teardown cost that isn't part of what's being measured; a
 *  caller that wants total wall time including teardown still has that in its own measurement of when the
 *  promise resolved. Purely additive/diagnostic — never read by any decision in this file. */
export interface GateStepResult {
  status: number | null;
  error?: Error;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  outputTail?: string;
  /** Best-effort failing-test/assertion line, scanned LIVE across the full stream (see
   *  {@link createFailingTestTracker}) — unlike `outputTail`, never truncated to the last
   *  {@link OUTPUT_TAIL_BYTES}. `undefined` when nothing recognizable was found (an honest miss, never a
   *  guess — see {@link extractFailingTest}'s own doc).
   *
   *  ⚠️ **STRUCTURALLY ONE LINE — this is a constraint on every test's failure OUTPUT, not just on this
   *  field.** `createFailingTestTracker` deliberately keeps only the single winning line per tier (its own
   *  doc: "never the whole output"), so a test whose decisive diagnostic genuinely spans multiple lines (a
   *  timeline, a stack, a stdout/stderr dump) has that content EITHER cut down to its first matching line,
   *  OR — for a failure shape that matches none of {@link FAILING_TEST_PATTERNS} at all (e.g. a plain
   *  `throw new Error(multiLineMessage)` with no `AssertionError`/`UNCAUGHT`/`FAIL`/`error TS` marker
   *  text) — this field is `undefined` ENTIRELY, not a truncated fragment. Card 63664129 confirmed both
   *  shapes exist in this suite today: the `commitAll` test helper (`test/_git-commit.mjs`) throws a
   *  3-line message on failure that matches no tier here (`failingTest` is always `undefined` for it), and
   *  the `console.error(`... UNCAUGHT — ${err.stack}`)` idiom used by several test files has a multi-line
   *  `.stack` of which only line 1 is ever kept.
   *
   *  ➡️ **The recovery path for either shape is `outputTail`, NOT this field** — specifically its
   *  front-anchored `FAILURES:`-block capture (see {@link createFailureBlockTracker}), which echoes a
   *  failing `test:daemon` file's FULL captured stdout/stderr (test-daemon.mjs's own epilogue never
   *  truncates per file) up to a 16KB budget. A test author whose assertion failure isn't legible from
   *  `failingTest` alone should read `outputTail` before assuming the diagnostic was lost — it usually
   *  wasn't. Two known, unproven-either-way gaps in that recovery path, tracked as card `87cdb15f` (gap 1
   *  = its DoD-1, gap 2 = its DoD-2 — don't re-derive by hand): (1) several failing files in the SAME
   *  run share that one 16KB budget, so an earlier file's echo can starve a later file's own diagnostic;
   *  (2) if the run never reaches its own `FAILURES:` epilogue at all (e.g. the step times out first —
   *  card `9966c52d` records exactly this shape for `kickoff-real-spawn`), there is no fallback recovery
   *  for a multi-line diagnostic — only whatever single line (or nothing, for the `commitAll` shape)
   *  `failingTest` itself already holds. */
  failingTest?: string;
  /** How many lines matched the SAME tier `failingTest` was drawn from (see
   *  {@link createFailingTestTracker.matchCount}) — `undefined` iff `failingTest` is `undefined` (nothing
   *  matched at all). `1` means `failingTest` is a COMPLETE account of the failure; `>1` means it is only
   *  the LAST of several matching lines and the others (e.g. other genuinely failing test files) are not
   *  named anywhere in this result — a caller must never treat `failingTest` as "the only failure" without
   *  checking this is exactly `1` first. */
  failingTestCount?: number;
  /** Card 0e5b2045: the FAIL/not-ok tier's OWN line (see {@link createFailingTestTracker.failTierResult}),
   *  independent of whichever tier `failingTest` above was drawn from — {@link identifyRetriableTestFile}
   *  reads THIS field, never `failingTest`, so a higher-priority diagnostic tier (e.g. an `UNCAUGHT` idiom)
   *  winning `failingTest` never silently changes which failure the single-file merge retry targets.
   *  `undefined` when no FAIL/not-ok-shaped line was seen in this step's output at all. */
  failTierTest?: string;
  /** See {@link createFailingTestTracker.failTierMatchCount} — forwarded alongside `failTierTest`, the
   *  count {@link identifyRetriableTestFile} actually gates its `=== 1` check on. `undefined` iff
   *  `failTierTest` is `undefined`. */
  failTierTestCount?: number;
  /** See {@link createFailingTestTracker.harnessNotExecutedDetected} — forwarded verbatim. `undefined`/
   *  `false` on every ordinary run; `true` only when `test-daemon.mjs`'s own structural `notExecuted`
   *  invariant line was seen in this step's output. {@link identifyRetriableTestFile} reads this to
   *  refuse a single-file retry outright — see `HARNESS_NOT_EXECUTED_RE`'s own doc for why. */
  harnessNotExecutedDetected?: boolean;
  decidedAt?: number;
  /** Card 8d585277: true ONLY when this step's settle followed a `cancelSignal` abort AND the step's own
   *  `close`/`error` event actually fired afterward (i.e. the kill was VERIFIED, not merely issued — see
   *  {@link runGateStep}'s `cancelling` doc). A cancel whose kill is never confirmed leaves this step
   *  unresolved rather than settling with `cancelled:false` — so this field is never a false negative for
   *  "was a cancel attempted", only ever absent when none was. Distinct from `timedOut` on purpose: a
   *  caller must never fold a cancellation into the ordinary kill/timeout classification (that would read
   *  as a real gate failure to a worker/manager who did nothing wrong). */
  cancelled?: boolean;
}

/** Real, NON-BLOCKING runner for one gate step (`spawn`, not `spawnSync` — see the note below). Same
 *  `shell:true` / per-step timeout as the old single-shot `spawnSync` call this replaces; UNLIKE that
 *  call (and unlike the old `stdio:"ignore"` version of this runner) it CAPTURES stdout+stderr into a
 *  bounded ring so a rejection can surface the REAL failure instead of an opaque "gate failed". Injectable
 *  so a hermetic test can prove step-by-step + short-circuit behavior without spawning real processes. */
export interface GateStepRunner {
  (command: string, cwd: string, timeoutMs: number, envOverride?: NodeJS.ProcessEnv, allowExtend?: boolean, cancelSignal?: AbortSignal, hooks?: GateLivenessHooks): Promise<GateStepResult>;
}

/**
 * ⚠️ LOAD-BEARING: this MUST be async `spawn`, never `spawnSync`. `spawnSync` blocks the ENTIRE daemon
 * event loop for the step's whole duration — every HTTP/MCP request, every timer (including
 * PendingOpRegistry's `attach()` sync-wait-budget race in pending-ops.ts) freezes right along with it.
 * A worker_merge_confirm call would then NEVER get a chance to degrade to a pending handle before a slow
 * gate finishes — it would just block for the gate's FULL duration regardless, silently defeating card
 * fb8df559 Part 1's entire client-timeout-resilience fix. `spawn` keeps the event loop free to service
 * other work (and let the sync-wait budget's timer actually fire) while the OS process runs in the
 * background.
 */
export const runGateStep: GateStepRunner = (command, cwd, timeoutMs, envOverride, allowExtend = true, cancelSignal, hooks) => new Promise((resolve) => {
  // Bounded capture ring: keep roughly the last OUTPUT_TAIL_BYTES, dropping whole chunks off the front
  // as newer ones arrive. The final tail() slices to exactly the cap. Same shape as python/venv.ts's
  // runAsync — captured (not ignored) so a rejection can surface the actual gate output.
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Card 6ffee3e2 (Code Review, merge-gate-retry.mjs case (E)): CUMULATIVE, never decremented — unlike
  // `bytes` above (the ring's CURRENT tracked size, which DOES shrink on eviction), this is the ONLY way
  // to tell "the ring's current small size is because the whole run was small" apart from "...because a
  // much bigger run got evicted down to the cap" — both leave `bytes` looking identical. `resolveOutputTail`
  // below reads this to decide whether `tail()` is genuinely the COMPLETE output (nothing lost — safe to
  // use as-is) or has been truncated (content-selection needed instead).
  let totalBytesSeen = 0;
  // Liveness stamp for the auto-extend decision below — updated on EVERY chunk regardless of the ring's
  // own eviction, so it stays accurate even once the ring has dropped early output. MONOTONIC
  // (performance.now(), not Date.now()/wall clock) to match the deadlines it's compared against
  // (setTimeout, also monotonic) — a backward wall-clock step (NTP) mid-gate can't flip the extend
  // decision (mirrors Loom's existing monotonic-clock preference for timing logic).
  let lastOutputAt = performance.now();
  // `hooks.onStepStart` mirrors this fresh step's own initialization (lastOutputAt/extended, both reset
  // right here) into an external caller's own idle clock — see GateLivenessHooks' doc.
  hooks?.onStepStart?.();
  // Card 55cba5c5: scans the FULL stream for the failing-test marker, independent of the ring's own
  // OUTPUT_TAIL_BYTES eviction above — see createFailingTestTracker's doc for why the ring alone isn't
  // enough (a tail dominated by trailing warnings/a pnpm epilogue truncates the marker right out of it).
  const failingTestTracker = createFailingTestTracker(cwd);
  // Card 6ffee3e2: independent front-anchored capture of test-daemon.mjs's own FAILURES: block — see
  // createFailureBlockTracker's own doc for why this recovers content the trailing ring above cannot.
  const failureBlockTracker = createFailureBlockTracker();
  const capture = (b: Buffer): void => {
    chunks.push(b);
    bytes += b.length;
    totalBytesSeen += b.length;
    lastOutputAt = performance.now();
    hooks?.onOutput?.();
    while (bytes > OUTPUT_TAIL_BYTES && chunks.length > 1) bytes -= chunks.shift()!.length;
    failingTestTracker.feed(b);
    failureBlockTracker.feed(b);
  };
  const tail = (): string => {
    const s = Buffer.concat(chunks).toString("utf-8").trim();
    if (s.length <= OUTPUT_TAIL_BYTES) return s;
    let start = s.length - OUTPUT_TAIL_BYTES;
    // Card 78a16dc5: a plain UTF-16 code-unit slice can split a surrogate pair (a non-BMP character, e.g.
    // an emoji in a test name/assertion/diff) exactly at the boundary, leaving a LONE low surrogate at the
    // very start of the tail — the downstream `[loom:*]` gate-failure nudge (kind:"warning") sanitizes that
    // away, but it's cheap and more correct to never produce it here in the first place. Nudge the start
    // forward by one code unit when it would land mid-pair.
    const atBoundary = s.charCodeAt(start);
    if (atBoundary >= 0xdc00 && atBoundary <= 0xdfff) start += 1;
    return s.slice(start);
  };
  /** Card 6ffee3e2 DoD 1/3: the RETAINED+REPORTED bytes for a FAILING step, selected by CONTENT rather
   *  than position — never a change to pass/fail determination (that's decided entirely by `result.status`/
   *  `error`/`timedOut` upstream of this call, untouched here).
   *
   *  ⚠️ CORRECTED (Code Review, merge-gate-retry.mjs case (E) — a real regression a first version of this
   *  fix shipped): content-selection is a REPLACEMENT for `tail()`, so it only fires when `tail()` is
   *  actually LOSSY — i.e. `totalBytesSeen` exceeds {@link OUTPUT_TAIL_BYTES}, meaning the ring genuinely
   *  evicted something. When the WHOLE step's output fits inside the cap, `tail()` IS the complete output
   *  (nothing was ever truncated) — falling back to it loses nothing and invents nothing, which is exactly
   *  what DoD-3 asks for ("never an arbitrary TRUNCATED chunk"), not "never the raw tail, period". The
   *  first version always preferred content-selection on any failure, which broke a real, common case: a
   *  short gate command (not `test-daemon.mjs`) whose failure line survives ANSI color codes wrapped around
   *  it (`\x1b[31mFAIL widget.spec.js\x1b[0m`) — {@link createFailingTestTracker}'s FAIL-tier pattern
   *  requires the line to START with `FAIL` (after optional whitespace), so the leading escape sequence
   *  defeats that match and the tracker falls through to a LOWER-priority tier (e.g. a same-run
   *  `AssertionError` line) that doesn't name the test — content-selection silently produced WORSE output
   *  than the untruncated raw tail it replaced. Bounding this to the genuinely-lossy case removes that
   *  regression without reopening the original bug: a verbose ~700-file suite still exceeds the cap by a
   *  wide margin, so it always takes the content-selected branch below, unchanged from before this fix.
   *
   *  Priority once content-selection DOES apply: (1) the front-anchored FAILURES: block, when
   *  `test-daemon.mjs`'s own marker was seen — the richest available diagnostic, a real per-file assertion
   *  body, not just a name; (2) the single best failing-test/assertion LINE `createFailingTestTracker`
   *  already scans for (content-selected, just not a whole block) — the fallback for a gate command that
   *  isn't `test-daemon.mjs`, or a genuine failure whose runner never reaches its own end-of-suite echo
   *  (e.g. a build/lint step); (3) an EXPLICIT honest-miss string, never a silent fall-through to a
   *  positional chunk that's already known to be missing content (DoD-3). The PASSING path is untouched —
   *  see card 4c5bf820's own doc on `tail()`'s continued green-path use above. */
  const resolveOutputTail = (): string =>
    totalBytesSeen <= OUTPUT_TAIL_BYTES
      ? tail()
      : (failureBlockTracker.result() ?? failingTestTracker.result() ?? "no failure line matched");
  // GIT_TERMINAL_PROMPT=0 — a gateCommand/deployCommand step may run `git push` (or any git op); without
  // this, an uncached-credential push blocks on an interactive prompt until the timeout SIGKILL instead
  // of failing fast (mirrors git/writer.ts and pty/host.ts's same guard). `envOverride` (card 7f96aa09)
  // lets a caller force additional vars onto just this step's own child — e.g. the worker self-gate pins
  // `LOOM_GATE_TEST_CONCURRENCY=3` here (card 68920f5b, renamed by ba3c9580, raised 2->3 by 2ff32b5c),
  // matching the merge gate's own unpinned default lane count, so the host-load budget is
  // `maxConcurrentGates × 3` — the SAME bound the merge gate already implies, not a new one — applied
  // AFTER the base env so an override always wins.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...envOverride };
  // `detached` on POSIX makes `child.pid` the process GROUP id (the shell calls setsid) — killGateProcessTree
  // below needs that to reach the whole tree, not just this one shell. Harmless on win32 (its tree-kill goes
  // through `taskkill /T`, which doesn't care about this flag).
  const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env, detached: process.platform !== "win32" });
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let settled = false;
  let extended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // CANCELLATION (card 8d585277): `cancelling` records that a `cancelSignal` abort fired — set the
  // instant it does, but NOT itself a settle. The ONLY things that ever settle this promise are (a) the
  // child's own real `close`/`error` event, or (b) the pre-existing `onTimeout` bound below — both
  // already wired regardless of cancellation. This is deliberate: a kill signal being ISSUED is not proof
  // the tree actually died (documented precedent elsewhere in this codebase — a timeout can settle
  // without its process tree dying), so a cancel must never fabricate a settle on unverified death. Once
  // one of those two real events does fire, `done()` below tags the result `cancelled:true` — that tag IS
  // the verification: it can only ever be attached to a genuinely observed close/error, never to the bare
  // act of asking for one.
  let cancelling = false;
  const done = (result: Omit<GateStepResult, "outputTail" | "failingTest" | "failingTestCount" | "failTierTest" | "failTierTestCount" | "harnessNotExecutedDetected" | "decidedAt">) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    const failingTest = failingTestTracker.result();
    const failTierTest = failingTestTracker.failTierResult();
    const harnessNotExecutedDetected = failingTestTracker.harnessNotExecutedDetected();
    // Card 6ffee3e2: content-selected retention only for a GENUINE failure, matching this step's own
    // pass/fail determination (`result.status`/`error`) — never for a cancel (a killed-mid-run step has no
    // "failure" to select content for; it keeps the plain positional tail, unchanged from before this card).
    // `onTimeout` below (Code Review) applies this SAME `!cancelling` carve-out to its own settle path —
    // see its comment for why the two must agree regardless of which one verifies the child's death.
    const isGenuineFailure = !cancelling && (!!result.error || result.status !== 0);
    resolve({
      ...result, ...(cancelling ? { cancelled: true } : {}),
      outputTail: isGenuineFailure ? resolveOutputTail() : tail(),
      failingTest, failingTestCount: failingTest ? failingTestTracker.matchCount() : undefined,
      failTierTest, failTierTestCount: failTierTest ? failingTestTracker.failTierMatchCount() : undefined,
      harnessNotExecutedDetected,
      decidedAt: performance.now(),
    });
  };
  const onCancel = () => {
    if (settled || cancelling) return;
    cancelling = true;
    // A SINGLE kill attempt — never retried in a loop (a retry loop over a hung removal has previously
    // leaked libuv threadpool threads and wedged this daemon; see the killGateProcessTree call below,
    // shared verbatim with the timeout path). If the tree doesn't actually die, nothing here forces a
    // settle: `timer` (this step's own `timeoutMs` bound, untouched by this branch) remains the only other
    // path that can ever resolve this promise — the slot this run holds stays held for as long as that
    // takes, rather than being freed over work that may still be running.
    void killGateProcessTree(child);
  };
  if (cancelSignal) {
    if (cancelSignal.aborted) onCancel();
    else cancelSignal.addEventListener("abort", onCancel, { once: true });
  }
  // ONE-TIME AUTO-EXTEND (card 24642c3d — the false-fail-under-fleet-load fix): fires when `timeoutMs` is
  // hit. If the child has been idle (no stdout/stderr byte) for less than GATE_EXTEND_IDLE_MS, it's still
  // actively working, not stalled — give it ONE more full `timeoutMs` window instead of killing it right
  // as a healthy-but-slow run (e.g. a 130+-file suite under heavy fleet contention) might be about to
  // finish. This is SAFE regardless of what the output actually SAYS: extension never manufactures a
  // pass — the eventual `passed:true` still requires the child's own real exit code 0 via the `close`
  // handler below, same as always. Worst case on a truly wedged-but-still-writing process is one extra
  // bounded `timeoutMs` before it's still correctly killed and reported `timedOut:true` — never a false
  // pass, never a missed genuine failure. A silent/stalled process (idle beyond the threshold) gets no
  // extension and is killed exactly as before. `allowExtend:false` (used by the merge gate's own existing
  // retry-once-on-timeout, so the two "one more chance" mechanisms don't compound into an excessive
  // worst-case wall-clock) and `GATE_TIMEOUT_EXTEND_ENABLED=0` both skip straight to the kill, byte-
  // identical to pre-24642c3d behavior.
  const onTimeout = () => {
    // Claim resolution IMMEDIATELY, synchronously — BEFORE the async tree-kill below — so the child's own
    // `close` event (which the forced kill is about to trigger) can never race past this and misreport
    // `timedOut:false`. Every later close/error is a no-op once `settled` is true.
    if (settled) return;
    const idleMs = performance.now() - lastOutputAt;
    const canExtend = allowExtend && GATE_TIMEOUT_EXTEND_ENABLED;
    if (canExtend && !extended && idleMs < GATE_EXTEND_IDLE_MS) {
      extended = true;
      hooks?.onExtend?.();
      timer = setTimeout(onTimeout, timeoutMs);
      return;
    }
    settled = true;
    const decidedAt = performance.now(); // captured BEFORE the async tree-kill below — see GateStepResult.decidedAt
    // Card d04f9c76: a BARE "exceeded ...ms" message is ambiguous between two cases with OPPOSITE
    // remedies — extend refused because the child was idle ≥ GATE_EXTEND_IDLE_MS (something STALLED) vs.
    // extend never available at all (`allowExtend:false`, e.g. the merge gate's own retry-after-timeout
    // call, or GATE_TIMEOUT_EXTEND_ENABLED=0 — says nothing about stalling either way). State WHICH one
    // fired so a reader doesn't need a source read to make that fork. `extended` (one was already granted;
    // this is the second/final deadline) still wins first, unchanged from before this card.
    const extendNote = extended
      ? " (after one auto-extend)"
      : canExtend
        ? ` (no extend: idle ${Math.round(idleMs)}ms ≥ ${GATE_EXTEND_IDLE_MS}ms threshold — stalled)`
        : " (no extend: extend unavailable for this run)";
    const timeoutFailingTest = failingTestTracker.result();
    const timeoutFailTierTest = failingTestTracker.failTierResult();
    const timeoutHarnessNotExecutedDetected = failingTestTracker.harnessNotExecutedDetected();
    void killGateProcessTree(child).finally(() => {
      resolve({
        status: null,
        error: new Error(`gate step exceeded ${timeoutMs}ms${extendNote}`),
        signal: "SIGKILL", timedOut: true,
        // Card 8d585277: if a cancel was ALSO requested and never verified before this timeout backstop
        // finally fired, tag it cancelled too — a caller checking `cancelled` must see it even when the
        // eventual settle came from the timeout path rather than a fresh close/error after the kill.
        ...(cancelling ? { cancelled: true } : {}),
        // Card 6ffee3e2 (Code Review): a timeout that settles via THIS path is always a genuine failure to
        // report EXCEPT when `cancelling` is also true — the SAME `!cancelling` carve-out `done()` applies
        // above, extended here on purpose rather than left as an asymmetry. Why the two settle paths must
        // agree: `cancelling` records INTENT (a `cancelSignal` abort was requested), not WHICH mechanism
        // eventually verifies the child died — a killed process can be confirmed dead either by its own
        // `close` event (routed through `done()`) or, if that kill hasn't taken effect by the time this
        // step's own `timeoutMs` bound also expires, by this backstop instead. Both are the SAME cancelled
        // step, discovered by two different clocks; which one wins the race is timing, not semantics, so
        // the retained output must not depend on it. A killed-mid-run step has no failure to select
        // content for either way — it was deliberately terminated, not naturally failing — so it keeps the
        // plain positional tail here too, matching `done()` exactly.
        outputTail: cancelling ? tail() : resolveOutputTail(), failingTest: timeoutFailingTest, failingTestCount: timeoutFailingTest ? failingTestTracker.matchCount() : undefined,
        failTierTest: timeoutFailTierTest, failTierTestCount: timeoutFailTierTest ? failingTestTracker.failTierMatchCount() : undefined,
        harnessNotExecutedDetected: timeoutHarnessNotExecutedDetected,
        decidedAt,
      });
    });
  };
  timer = timeoutMs > 0 ? setTimeout(onTimeout, timeoutMs) : undefined;
  child.on("error", (e) => done({ status: null, error: e, signal: null, timedOut: false }));
  child.on("close", (code, signal) => done({ status: code, error: undefined, signal, timedOut: false }));
});

/**
 * Force-kill a gate step's process TREE, not just the shell `spawn` returned as `child`. Root cause of
 * card 3564fd1e (the 2026-07-21 fleet-wide gate death spiral): `shell:true` makes `child` a `cmd.exe`
 * (win32) or `sh`/`bash` (posix) whose DESCENDANTS — e.g. `pnpm` → `vitest` → a forked test-worker pool —
 * a plain `child.kill()` never reaches. A gate timeout used to kill only that shell, leaving its
 * grandchildren running immortally; repeated timeouts/retries against the same hanging test each leaked
 * another survivor, and by the time enough had accumulated the host itself saturated, starving every
 * OTHER project's gate into timing out too.
 *  - win32: `taskkill /pid <child.pid> /T /F` kills the whole subtree rooted at the shell.
 *  - posix: the step is spawned with `detached:true` above, making `child.pid` the process GROUP id —
 *    `process.kill(-pid, "SIGKILL")` signals the whole group, not just the shell. A plain
 *    `process.kill(pid, "SIGKILL")` here would reproduce the SAME leak on posix. This is a DELIBERATE
 *    choice, not the accidental gap `killProcessById` (pty/host.ts) has on ITS posix branch — that
 *    function is fine for its own use (a worktree-path reap), where a survivor left behind is caught by
 *    the NEXT sweep regardless of which single pid was targeted; a gate timeout has no such backstop
 *    inside this file — only the caller's own worktree-path sweep (see sessions/service.ts) does, and
 *    only as a belt-and-suspenders catch for whatever already detached before THIS kill lands.
 * Resolves once the kill has been ISSUED (awaits the win32 `taskkill` helper's own exit, so a caller can
 * treat the tree as gone once this settles) — best-effort: an already-exited pid is a silent no-op.
 */
function killGateProcessTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid == null) { resolve(); return; }
    if (process.platform === "win32") {
      const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      tk.on("close", () => resolve());
      tk.on("error", () => resolve());
      return;
    }
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    resolve();
  });
}

/** Card a2873f7e: one step's WALL-CLOCK duration — `decidedAt` (see {@link GateStepResult.decidedAt}) minus
 *  the `performance.now()` captured immediately before {@link runGateSequential} invoked `runStep` for it.
 *  Computed for EVERY step that actually spawned, on BOTH the green and rejected path (a step that never
 *  spawned — e.g. a step after the one that failed, or one skipped by an early cancel — has no entry at
 *  all, never a fabricated one). `durationMs` is `null`, never `0`, when it can't be derived (a step whose
 *  `GateStepResult` never got a `decidedAt` — should not happen in practice, but this is the honest-null
 *  discipline the rest of this file already follows for `failingTest`). PURELY DIAGNOSTIC: nothing in this
 *  file or its callers may branch, assert, or retry on this value — see {@link formatGateStepsDiagnostic}'s
 *  doc for why. */
export interface GateStepDuration {
  step: string;
  durationMs: number | null;
  status: number | null;
}

/** What {@link runGateSequential} resolves. On a rejection, carries enough to make the failure
 *  diagnosable instead of opaque: which step failed, its exit code/signal/timeout, and its bounded
 *  output tail (a caller derives a coarse phase + a best-effort failing-test line from these).
 *  Card 4c5bf820: `outputTail` is NOT failure-only — the GREEN path also sets it, to the LAST step's own
 *  bounded tail (same {@link OUTPUT_TAIL_BYTES} ring as a rejection uses, nothing new invented). Before
 *  this card the green return (`{passed:true, steps}`) discarded it entirely, even though every step's
 *  `GateStepResult` always computes one — a passing gate had NOTHING retained for a caller to inspect
 *  after the fact. */
export interface GateSequentialResult {
  passed: boolean;
  failedStep?: string;
  failedStatus?: number | null;
  failedSignal?: NodeJS.Signals | null;
  failedTimedOut?: boolean;
  outputTail?: string;
  /** See {@link GateStepResult.failingTest} — forwarded verbatim from the failing step's own result, so a
   *  caller no longer has to re-derive it (truncation-prone) from `outputTail` itself. */
  failingTest?: string;
  /** See {@link GateStepResult.failingTestCount} — forwarded verbatim alongside `failingTest`. A caller
   *  MUST check this is exactly `1` before treating `failingTest` as a complete account of what failed. */
  failingTestCount?: number;
  /** See {@link GateStepResult.failTierTest} — forwarded verbatim from the failing step's own result.
   *  {@link identifyRetriableTestFile} reads THIS field, never `failingTest` above. */
  failTierTest?: string;
  /** See {@link GateStepResult.failTierTestCount} — forwarded verbatim alongside `failTierTest`. */
  failTierTestCount?: number;
  /** See {@link GateStepResult.harnessNotExecutedDetected} — forwarded verbatim from the failing step's
   *  own result. */
  harnessNotExecutedDetected?: boolean;
  /** Card 8d585277: forwarded from the cancelled step's own VERIFIED {@link GateStepResult.cancelled} — a
   *  distinct "no verdict" outcome a caller must never fold into `passed:false`'s ordinary failure
   *  handling (no retry, no failure classification, no "gate failed" nudge). */
  cancelled?: boolean;
  /** Card a2873f7e: per-step `{step, durationMs, status}` for every step that actually spawned — the SAME
   *  shape on the green path and every rejection path (cancelled, failed, timed out), so a caller can
   *  compare a step's duration ACROSS outcomes ("this step took 40s green and 11 min red") instead of only
   *  ever seeing it on one side. Empty (`[]`), never absent, when no step spawned at all (e.g. a cancel
   *  observed before the first step). This value was already computed for the internal auto-extend
   *  decision and thrown away before this card — it is now forwarded, not newly derived. */
  steps: GateStepDuration[];
}

/** Format one {@link GateStepDuration.durationMs} as `<m>m<s>s` (or bare `<s>s` under a minute) —
 *  `"n/a"` for `null`, never a fabricated `0s`. Exported (card 4c5bf820) so the worker self-gate's own
 *  `[loom:gate-done]` PASS nudge can format its total `durationMs` the SAME way the per-step diagnostic
 *  line already does, instead of inventing a second duration-formatting convention. */
export function formatStepDurationMs(ms: number | null): string {
  if (ms == null) return "n/a";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

/**
 * Card a2873f7e: render a gate's {@link GateSequentialResult.steps} as ONE human-readable line, self-
 * labelled diagnostic-only IN THE TEXT ITSELF — not just a code comment — because this string is what a
 * reader sees later, out of context, with no access to the reasoning that produced it. `undefined` for an
 * empty step list (nothing to show) so a caller can omit the line entirely rather than print a vacuous one.
 *
 * ⛔ NEVER compare the numbers this renders against a threshold, "expected" range, or each other to decide
 * anything — see this card's own doc: a duration is a load-variable constant (measured solo-vs-in-suite
 * stretch on this repo: 2.15×) that FAILS TOWARD THE UNOBSERVED DIRECTION (a suite that silently skips
 * work finishes EARLY, which reads as good news, not a warning). This is a prompt to look, never evidence
 * on its own — the real guard is the harness asserting it executed something (card b122c7d4).
 */
export function formatGateStepsDiagnostic(steps: GateStepDuration[]): string | undefined {
  if (steps.length === 0) return undefined;
  return `steps (diagnostic only — not a pass/fail signal): ${steps.map((s) => `${s.step} ${formatStepDurationMs(s.durationMs)}`).join(" · ")}`;
}

/**
 * Card 3407caad: how close a step's `durationMs` came to consuming its own `gateCommandTimeoutMs`
 * budget — a WARN-BEFORE-BREACH signal, distinct from `gateExtended`/`anyExtended` (card 9f6598dd),
 * which only ever tells you a run ALREADY breached it (consumed its one-time auto-extend). This fires
 * earlier: a step can be well on its way to needing that extend, or to a hard timeout on a project with
 * `gateRetry` disabled, while still comfortably PASSING today — the whole point per the card's DoD is a
 * signal visible on a passing run, not just a failing one.
 *
 * ⛔⛔ WHICH CEILING THIS IS A FRACTION OF (manager review, card 3407caad — folded in, not a restart):
 * there are TWO different ceilings a step can be measured against, and they differ by ~2×:
 *   - a FIRST attempt's EFFECTIVE ceiling, once its one-time output-gated auto-extend is counted, is
 *     `gateCommandTimeoutMs` PLUS one more full `timeoutMs` window (`GATE_EXTEND_IDLE_MS`'s own doc) —
 *     roughly 2× `gateCommandTimeoutMs`, while the step keeps producing output.
 *   - a RETRY after a timeout runs `allowExtend:false` (card 24642c3d, deliberate — stacking two "one
 *     more chance" mechanisms would push the worst case to ~4×) — a HARD `gateCommandTimeoutMs`, no net.
 * This function's `fraction` is ALWAYS `durationMs / gateCommandTimeoutMs` — the RAW configured value,
 * i.e. the SMALLER, HARD retry ceiling, never the ~2× first-attempt-with-extension allowance. That is
 * the ceiling that actually bites: a step comfortably inside its first attempt's effective budget (it
 * extended once and still passed) can be structurally doomed on a retry, which gets no such net — so
 * `fraction` reads as "how close to the ceiling a RETRY would enforce", not "how close to what THIS run
 * was actually allowed". A `fraction` over `1.0` means exactly that: this step already needed more than
 * the hard ceiling to finish (it survived only because it was a first attempt and got the one-time
 * extend) — worth surfacing even though the run passed, because a subsequent retry of the SAME step
 * would have no such reprieve. Every caller-facing rendering of `fraction`/`nearBudget` (nudge text, tool
 * descriptions) must name this ceiling explicitly — "of budget" alone is genuinely ambiguous between two
 * numbers that differ by ~2×, and removing that ambiguity is the whole point of the signal.
 *
 * COMPOSES WITH, DOES NOT DUPLICATE, card 73a847f5: that card already skips a doomed retry (a timeout
 * that already consumed its auto-extend "reports budget-exceeded" and never re-runs, because a hard-
 * bounded rerun provably cannot pass) — but it fires AT THE MOMENT OF FAILURE, after the fact. This
 * signal is the pre-emptive counterpart: it fires WHILE THE GATE IS STILL GREEN, before there is
 * anything to skip a retry for.
 *
 * ⚠️ NOT the same comparison {@link formatGateStepsDiagnostic}'s own doc warns never to make. That
 * warning is about NOT inferring correctness/thoroughness from a step's absolute duration (a
 * silently-skipped step finishes EARLY, which is load-variable noise, not a signal). This function never
 * looks at that axis at all — it compares a step's duration against the fixed, absolute
 * `gateCommandTimeoutMs` ceiling every project already enforces, which is an operational capacity
 * question ("how much of the allotted runway is left"), not a correctness one. The two are orthogonal;
 * this does not license comparing {@link formatGateStepsDiagnostic}'s own numbers against each other or
 * an "expected" range for any OTHER purpose.
 *
 * THE THRESHOLD (`GATE_PROXIMITY_THRESHOLD`) — stamped number · condition · population · instrument ·
 * as-of, TWO INDEPENDENT SYSTEMS, deliberately NOT averaged or compared against each other (different
 * suites, different budgets, no transfer function — only the SHAPE below is meant to transfer):
 *   - Loom's own gate, a REAL measured WORST-STEP reading (manager review, card 3407caad, 2026-08-04 —
 *     supersedes an earlier revision of this doc that called the worst-step axis unmeasured on this
 *     repo): merge op `4e7e4123` (card `23471268`) settled with steps `pnpm build 3s · pnpm --filter
 *     @loom/daemon test:daemon 18m14s`. NUMBER: the worst step (the test step) ≈1,094s against the
 *     per-step 1,800,000ms `gateCommandTimeoutMs` ⇒ ~61%. CONDITION: a real merge gate, Windows host,
 *     daemon gate cap 2. POPULATION: 650 hermetic daemon test files, runner pool size 2 — ⚠️ the field
 *     that matters most here, since it MOVES (grows) over time with zero change to this threshold, which
 *     is the whole reason the threshold needs headroom rather than tracking today's number exactly.
 *     INSTRUMENT: the settled `gate_status` record + the `[loom:merge-done]` steps line, as read and
 *     reported by the manager (a worker-scoped `gate_status` call cannot see another session's op, so
 *     this reading could not be independently re-verified from this session) — that steps line is
 *     SECOND-ROUNDED; do NOT difference it against a separately-read ms-precise `totalDurationMs`, which
 *     measures the WHOLE OP (worktree prep + union-merge + gate + squash), not this one step — two
 *     different instruments measuring different things, never subtract one from the other. AS-OF:
 *     2026-08-04. This single reading (n=1) sits inside the ~47%-63% WHOLE-GATE band this doc previously
 *     cited from the card's own kickoff (build+test end-to-end, ~14-19 real minutes) — because `pnpm
 *     build` is only ~3s here, whole-gate (~1,097s) and worst-step (~1,094s) differ by ~0.3% on THIS
 *     project, so that earlier whole-gate figure was, in substance, already close to the worst-step axis.
 *     That coincidence is project-specific, not structural — a project whose build step is heavier would
 *     see the two axes diverge for real — so this reading is recorded as its own real,
 *     separately-instrumented data point rather than treated as proof the two axes are interchangeable in
 *     general.
 *   - A peer project's own gate: 60.4% · 65.4% · 73.1% · 76.6% of its configured 700,000ms
 *     `gateCommandTimeoutMs` — its OWN test STEP measured against its OWN budget (n=4 healthy runs), per
 *     manager review on this same card, 2026-08-04.
 * ⇒ BOTH systems independently sit in a HIGH band (Loom ~61%, the peer up to 76.6%) as their NORMAL,
 * HEALTHY state — that STRUCTURAL convergence, never either system's MAGNITUDE, is what does real work
 * here: it argues a single GLOBAL constant is the wrong SHAPE in the first place, because two real systems
 * already show meaningfully different healthy-state ceilings, so a threshold tuned close to either one's
 * own steady state would fire on ROUTINE healthy runs on THAT system. ⛔ This structural point does NOT
 * license using the peer's 76.6% as a magnitude 0.85 itself must clear — a DIFFERENT budget (700,000ms vs.
 * Loom's own 1,800,000ms), a different suite, a different host, no transfer function, exactly as the
 * no-averaging/no-comparison rule above already says; anchoring a Loom constant on another system's own
 * number would be the exact thing that rule forbids, caught in manager review on this same card,
 * 2026-08-04 (see [[the-qualifier-dies-in-the-summary-label]] in project memory for the general pattern:
 * a rule stated correctly can still die three paragraphs later, in the sentence that actually gets acted
 * on). **0.85 is anchored SOLELY on Loom's OWN measured worst-step reading above (~61%) — ~24 points of
 * headroom, comfortably quiet through Loom's own healthy runs.** The peer's numbers are kept, stamped and
 * attributed, purely as the SECOND independent system that makes the STRUCTURAL argument (a per-project
 * override may eventually be warranted) more than a one-system anecdote — not as evidence for 0.85's own
 * value. On top of Loom's own measured margin, the true margin is worse than that single reading alone
 * suggests: (a) a sibling project's suite can run real-ingest tests against Loom's own live corpus, so ITS
 * margin erodes as this repo grows with zero change to its own code, and (b) worker doctrine defaults a
 * worker's OWN DoD self-check to running tests directly rather than through `run_gate`, so up to
 * `maxConcurrentWorkers` semaphore-INVISIBLE test lanes can be competing with an admitted gate at the same
 * moment, invisible to the reading above. Both push real-world contention higher than what a single
 * admitted-gate reading can ever show — so a threshold "tuned" tighter against only what's currently
 * visible would UNDERSTATE true risk, not overstate it — while still leaving real warning room before the
 * HARD retry ceiling this fraction is measured against (see the ceiling doc above).
 * ⚠️ LIMITATION, NAMED RATHER THAN SILENTLY ACCEPTED: this is currently ONE GLOBAL constant, not a
 * per-project config value. Loom's own POPULATION (650 test files) is exactly the kind of number that
 * grows over time and erodes this margin with zero code change on either side — a project whose own
 * worst-step ceiling runs hotter than either system measured here (or whose build step is heavy enough
 * that whole-gate and worst-step meaningfully diverge, unlike the ~0.3% coincidence on Loom today) could
 * need a project-specific override this card does not build.
 */
export const GATE_PROXIMITY_THRESHOLD = 0.85;

/** {@link describeGateProximity}'s result — `undefined` at the CALL SITE (never constructed here) means
 *  "nothing to report" (no gate spawned: a gateless project, or a reused self-check — the same
 *  "undefined ≠ false" discipline `gateExtended` already follows, see its own doc). Once a real gate DID
 *  spawn, this is always populated (never itself `undefined`) — `nearBudget:false` is the honest "ran,
 *  checked, comfortably under budget" answer, not an omission. */
export interface GateProximity {
  /** `true` only when `fraction >= GATE_PROXIMITY_THRESHOLD` for the worst (highest-fraction) step. */
  nearBudget: boolean;
  /** The step whose `durationMs` came closest to `gateCommandTimeoutMs`, by fraction — present alongside
   *  `nearBudget:false` too, so a caller can see how close the closest step actually came. */
  step: string;
  /** `durationMs / gateCommandTimeoutMs` for `step`, rounded to 2 decimals, measured against the RAW
   *  configured `gateCommandTimeoutMs` — the HARD ceiling a post-timeout retry gets NO auto-extend
   *  against (card 24642c3d), never the ~2× effective ceiling a FIRST attempt's one-time auto-extend can
   *  reach (see {@link describeGateProximity}'s own doc, "WHICH CEILING" section). Can exceed `1` — that
   *  means this step already needed more than the hard ceiling to finish (it survived only because it
   *  was a first attempt and consumed its one-time extend); a retry of the same step would have no such
   *  net. */
  fraction: number;
}

/**
 * Card 3407caad: the worst (highest-fraction) step's proximity to `gateCommandTimeoutMs`, across a real
 * gate run's `steps`. `undefined` when `steps` is `undefined`/empty (no gate spawned) OR when every step's
 * `durationMs` is `null` (no timed step to compare — should not happen in practice, but this stays an
 * honest-null rather than a fabricated `nearBudget:false`) — see {@link GateProximity}'s own doc for why
 * that distinction matters to a caller. `gateTimeoutMs` is the SAME raw, per-step HARD ceiling every step
 * in `steps` was actually run against (each gate step gets the full budget, never a divided share — see
 * `runGateSequential`'s own doc) — see this function's own "WHICH CEILING" doc above for why the HARD
 * ceiling, not a first attempt's ~2× effective one, is the correct denominator — so one shared
 * denominator is correct for every entry.
 */
export function describeGateProximity(steps: GateStepDuration[] | undefined, gateTimeoutMs: number): GateProximity | undefined {
  if (!steps || steps.length === 0) return undefined;
  let worstStep: string | undefined;
  let worstFraction = -1;
  for (const s of steps) {
    if (s.durationMs == null) continue;
    const fraction = s.durationMs / gateTimeoutMs;
    if (fraction > worstFraction) { worstFraction = fraction; worstStep = s.step; }
  }
  if (worstStep == null) return undefined;
  return { nearBudget: worstFraction >= GATE_PROXIMITY_THRESHOLD, step: worstStep, fraction: Math.round(worstFraction * 100) / 100 };
}

/**
 * Run a (possibly `&&`-chained) `gateCommand` as SEPARATE sequential child processes instead of one
 * `&&`-chained shell invocation — so memory frees BETWEEN steps (a shared footprint across
 * lint+test+build was OOM-killing a worker's gate, exit 137). Preserves `&&` short-circuit semantics
 * exactly: the first non-zero (or spawn-error) step stops the run and fails the gate; a gate with no
 * `&&` behaves exactly as the old single-`spawnSync` call did. Each step gets the SAME per-project
 * `gateTimeoutMs` budget (not a divided share) — a heavy step (e.g. a build) needs its own full window.
 * `envOverride` (card 7f96aa09) is forwarded to every step's own `runStep` call, additive to whatever env
 * that runner already sets (see `runGateStep`'s own doc) — trailing so existing 4-arg callers (incl. the
 * `gate-runner-sequential.mjs` unit test, which injects its own `runStep`) are unaffected. `allowExtend`
 * (card 24642c3d, default `true` when omitted — matches `runGateStep`'s own default) is forwarded the
 * same way, trailing again so existing 5-arg callers are unaffected; pass `false` to disable the
 * one-time auto-extend for this whole run (e.g. the merge gate's own retry-after-timeout call).
 * `hooks` ({@link GateLivenessHooks}) is forwarded to EVERY step's own `runStep` call, unchanged — trailing
 * again so existing 7-arg callers are unaffected; lets an external registry (GateSemaphore) mirror this
 * run's live idle/extend state without this function needing to know anything about that registry.
 */
export async function runGateSequential(
  gate: string, cwd: string, timeoutMs: number, runStep: GateStepRunner = runGateStep, envOverride?: NodeJS.ProcessEnv,
  allowExtend?: boolean, cancelSignal?: AbortSignal, hooks?: GateLivenessHooks,
): Promise<GateSequentialResult> {
  // Card a2873f7e: per-step {step, durationMs, status} accumulated as each step settles — forwarded
  // verbatim on EVERY return below (green or rejected), same shape either way.
  const steps: GateStepDuration[] = [];
  // Card 4c5bf820: the LAST step's own bounded tail, carried forward so the green return below can report
  // it too — every rejection return already forwards `res.outputTail` from the step that failed; a passing
  // run has no "failed step" to hang it off, so the last step actually run is the honest equivalent.
  let lastOutputTail: string | undefined;
  for (const step of splitGateSteps(gate)) {
    // Card 8d585277: checked BEFORE spawning each step too — a cancel arriving in the gap BETWEEN two
    // steps (this run has already settled one step and hasn't started the next) must not spawn a step
    // that was never going to be waited for.
    if (cancelSignal?.aborted) return { passed: false, cancelled: true, failedStep: step, steps };
    const startedAt = performance.now();
    const res = await runStep(step, cwd, timeoutMs, envOverride, allowExtend, cancelSignal, hooks);
    const durationMs = res.decidedAt != null ? res.decidedAt - startedAt : null;
    steps.push({ step, durationMs, status: res.status });
    lastOutputTail = res.outputTail;
    if (res.cancelled) {
      return {
        passed: false, cancelled: true, failedStep: step, failedStatus: res.status, failedSignal: res.signal ?? null,
        failedTimedOut: false, outputTail: res.outputTail, failingTest: res.failingTest, failingTestCount: res.failingTestCount,
        failTierTest: res.failTierTest, failTierTestCount: res.failTierTestCount,
        harnessNotExecutedDetected: res.harnessNotExecutedDetected, steps,
      };
    }
    const passed = res.status === 0 && !res.error;
    if (!passed) {
      return {
        passed: false, failedStep: step, failedStatus: res.status, failedSignal: res.signal ?? null,
        failedTimedOut: res.timedOut ?? false, outputTail: res.outputTail, failingTest: res.failingTest, failingTestCount: res.failingTestCount,
        failTierTest: res.failTierTest, failTierTestCount: res.failTierTestCount,
        harnessNotExecutedDetected: res.harnessNotExecutedDetected, steps,
      };
    }
  }
  return { passed: true, steps, outputTail: lastOutputTail };
}

/**
 * Sweep G3: whether the merge gate auto-retries ONCE on a transient-kill classification (see {@link
 * classifyGateFailure}) before reporting a rejection, and the settle delay before that retry, are NO
 * LONGER module-load constants here — they're promoted to a LIVE-resolvable daemon-global config
 * (`OrchestrationConfig.gateRetry`, @loom/shared's `resolveConfig`/`GateRetryConfig`), resolved fresh at
 * the SAME call sites that already read `orchestration.maxConcurrentGates` (SessionService's
 * `confirmWorkerMerge`), and threaded into the retry call as a parameter rather than read here. The
 * `LOOM_GATE_RETRY_ENABLED`/`LOOM_GATE_RETRY_SETTLE_MS` env vars still work exactly as before — they're
 * now read as a lower-priority layer inside `resolveConfig` (override ?? env ?? default) instead of at
 * this module's first import, so a change to either env var takes effect on the very next gate retry
 * without needing gate-runner.js to be re-imported.
 */

/** After this many CONSECUTIVE `timedOut` gate results on the SAME branch AT THE SAME commit, the service
 *  layer (SessionService's `gateTimeoutStreak`) stops auto-spawning the gate for that branch and reports a
 *  distinct "likely hanging test" failure instead of retrying forever — part of card 3564fd1e's fix (a
 *  genuinely wedged test can never pass no matter how many times it's re-run, and every re-run risks
 *  leaking another process-tree survivor even with {@link runGateStep}'s tree-kill above). Env-overridable
 *  for a test, mirroring the merge-gate retry policy's own env layer (see the note above). The breaker
 *  clears itself once the branch's worktree HEAD advances past the commit it tripped on — see
 *  SessionService's `checkGateTimeoutBreaker`. */
export const GATE_TIMEOUT_BREAKER_THRESHOLD = Number(process.env.LOOM_GATE_TIMEOUT_BREAKER_THRESHOLD) || 3;

/** {@link classifyGateFailure}'s three buckets. "kill" and "timeout" are both retry-ELIGIBLE (the merge
 *  gate auto-retries once); "genuine" never is. */
export type GateFailureClass = "genuine" | "kill" | "timeout";

/**
 * Classify a failed gate step so the merge gate can tell a transient external kill (an OOM-killer/
 * resource-limit SIGKILL under memory pressure) from a genuine test/build failure (card bcba83a1) — the
 * merge gate used to surface BOTH as the same flat "build gate failed", so managers learned the gate
 * "lies" under load and hand-rolled an unsafe `--no-verify` squash to route around it.
 *  - **"kill"** — an external signal terminated the step and OUR OWN {@link runGateStep} timeout bound
 *    was NOT the cause (`failedTimedOut` false, `failedSignal` set) — the shape of an OOM-killer/cgroup/
 *    resource-limit kill. Retry-eligible.
 *  - **"timeout"** — OUR OWN `gateTimeoutMs` bound killed the step (`failedTimedOut` true; `runGateStep`
 *    always pairs this with `signal:"SIGKILL"`, but the CAUSE is our own bound, not an external kill — a
 *    separate bucket because a retry here may just re-time-out under the same load; see the merge-gate
 *    retry call site's guardrail). Retry-eligible, but deliberately so.
 *  - **"genuine"** — a clean non-zero exit (or a spawn error) with no signal and no timeout: a real
 *    test/build failure. NEVER retried — retrying would waste cycles and could mask a flaky-passing test.
 */
export function classifyGateFailure(
  result: Pick<GateSequentialResult, "failedSignal" | "failedTimedOut">,
): GateFailureClass {
  if (result.failedTimedOut) return "timeout";
  if (result.failedSignal) return "kill";
  return "genuine";
}

/** Best-effort classification of which build/DoD phase a failing gate step belongs to, derived from the
 *  step's own command text — `undefined` when it doesn't obviously name one (an arbitrary custom script).
 *  Checked in this order (typecheck/test are more specific substrings that a generic "build" step's
 *  command wouldn't otherwise contain). */
export function classifyGatePhase(step: string | undefined): "typecheck" | "test" | "build" | undefined {
  if (!step) return undefined;
  if (/\btsc\b|typecheck|type-check/i.test(step)) return "typecheck";
  if (/\btest|jest|vitest|mocha|pytest/i.test(step)) return "test";
  if (/\bbuild\b/i.test(step)) return "build";
  return undefined;
}

/**
 * Best-effort extraction of the first failing-test name/assertion line from a gate step's captured output
 * tail — a FALLBACK for a caller holding only a raw string (e.g. an injected test double that bypasses the
 * real `runGateStep`/`runGateSequential`, or `outputTail` from a caller that never ran the live scan). A
 * real gate run should prefer {@link GateSequentialResult.failingTest} (populated by the LIVE
 * {@link createFailingTestTracker} scan, which is NOT subject to this tail's own truncation) over calling
 * this at all. Scans for the same cross-ecosystem failure markers as that live scan (an uncaught-throw
 * `UNCAUGHT` idiom, Loom's own `FAIL  <label>` convention, Jest/AVA/tap-style `FAIL`/`not ok`/✗/✖ markers,
 * thrown `AssertionError`s, and `error TSxxxx` typechecker diagnostics) and returns the FIRST matching line,
 * trimmed. A line recording a PASS ({@link PASS_LINE_RE}) is skipped entirely before any pattern is tried —
 * same flat invariant as {@link createFailingTestTracker}'s own `scanLine` (card 2f0b2e57), so this
 * fallback can't repeat the bug the live scan was fixed for just because it re-derives from a raw string
 * instead of the tracker. Returns `undefined`
 * when nothing recognizable is found — this is a diagnostic aid, not a parser, so a silent miss just means
 * the raw tail is still surfaced on its own.
 */
export function extractFailingTest(outputTail: string): string | undefined {
  const lines = outputTail.split(/\r?\n/).filter((l) => !PASS_LINE_RE.test(l));
  const patterns = FAILING_TEST_PATTERNS;
  for (const pattern of patterns) {
    const hit = lines.find((l) => pattern.test(l));
    if (hit) return hit.trim();
  }
  return undefined;
}

/** {@link identifyRetriableTestFile}'s result — `command` is the ready-to-run single-file re-invocation,
 *  `name` is the bare test name (for the `retriedFile` record). */
export interface RetriableTestFile {
  name: string;
  command: string;
}

/**
 * Card 344ce950: given a gate run's own {@link GateStepResult.failTierTest}/{@link
 * GateSequentialResult.failTierTest} marker and the gate's `cwd`, identify a SINGLE test file this
 * daemon's own hermetic suite (`packages/daemon/scripts/test-daemon.mjs`) can re-run in ISOLATION via its
 * existing `--only=<name>` selection flag (card 6185fbfc — the same flag `test-daemon-cli-args.mjs`/
 * `test-daemon-gate-timing-sigkill.mjs` already drive directly), so a merge gate can retry ONE failing
 * file instead of the whole ~650-file suite before declaring a rejection.
 *
 * ⚠️ Card 0e5b2045 — TAKES `failTierTest`/`failTierTestCount`, NOT `failingTest`/`failingTestCount`. The
 * two diverge on purpose: `failingTest` is whichever tier's line is most diagnostically useful (as of card
 * 0e5b2045, an `UNCAUGHT`-idiom line outranks a bare `FAIL <name>` summary there), but THIS function can
 * only ever parse the FAIL/not-ok tier's own bare-identifier shape — so it reads the tier-isolated
 * `failTierTest`/`failTierTestCount` accessors ({@link createFailingTestTracker.failTierResult}/
 * `.failTierMatchCount`) instead, independent of whichever tier won `result()` for display. Passing
 * `failingTest`/`failingTestCount` here would be silently wrong on any run where a higher-priority
 * diagnostic tier also matched: the retry would appear to "stop firing" for reasons unrelated to whether a
 * retriable FAIL line actually exists.
 *
 * DELIBERATELY NARROW AND FAIL-CLOSED: this recognizes ONLY this daemon's own `FAIL  <name>` convention
 * (a bare identifier — letters/digits/hyphen/underscore, no path, no extension — see test-daemon.mjs's own
 * `runLane`: `console.log(\`${result.ok ? "PASS" : "FAIL"}  ${result.name}...\`)`), never the sibling
 * Jest/AVA/tap/`AssertionError`/`error TSxxxx`/`UNCAUGHT` shapes {@link FAILING_TEST_PATTERNS} also
 * recognizes, and NEVER via a second parser on `failTierTest` beyond this one bare-name regex — the caller
 * must pass the SAME `failTierTest` the live {@link createFailingTestTracker} scan already extracted, not
 * re-derive one. A candidate name is confirmed against the REAL filesystem (`fs.existsSync`) before ever
 * being reported identifiable — never a regex-only guess — so a name that merely LOOKS like one of ours
 * but doesn't correspond to a real file, or a gate run on a project that doesn't have this suite at this
 * path at all, returns `undefined` (the caller's cue to reject exactly as today — no behavior change on
 * that path).
 *
 * ⚠️ MANAGER REVIEW (sibling p0 report on card 344ce950) — REQUIRES `failTierTestCount === 1`: this
 * daemon's own test runner has NO fail-fast (`test-daemon.mjs`'s `Promise.all` over lanes; `failed` is an
 * ARRAY) — a single run can genuinely fail on MULTIPLE files. `createFailingTestTracker` keeps only the
 * LAST matching line per tier, so `failTierTest` alone cannot tell "the only failure" apart from "the last
 * of several, with the others never named anywhere in this result". Retrying and passing that ONE file
 * would silently let a merge through while an untouched OTHER failure sits in the same run — exactly the
 * order-dependent/cross-test-pollution class this card's own §4 already warned a single-file retry can
 * mask, now via a second, distinct route (a second FILE instead of a second RUN). `failTierTestCount` is
 * REQUIRED (not optional) specifically so a caller can't forget to pass it — any value other than exactly
 * `1` (including `undefined`, e.g. a test double/legacy shape that never supplies one) fails closed,
 * mirroring this function's existing "ambiguity ⇒ not identifiable" posture.
 *
 * 🔴 CORRECTED (card 6c84b87b — the prior wording here asserted a FALSE PREMISE holding up a correct
 * conclusion; see this repo's own "a comment is a claim" rule): this used to claim over-counting was
 * merely "a test's own output prints an incidental FAIL-shaped line" and that under-counting was
 * "structurally unlikely" thanks to `runLane`'s one-line-per-file convention. That ignored
 * `test-daemon.mjs`'s OWN later `FAILURES:` epilogue, which re-echoes every failing file's FULL captured
 * stdout/stderr — including that file's own `check()`-printed `FAIL <label>` lines — so over-counting was
 * not incidental, it was GUARANTEED for any file that fails by a normal assertion (815-of-848 files use
 * that `check()` convention) rather than by throwing. `failTierTest`/`failTierTestCount` are now sourced
 * from {@link createFailingTestTracker.failTierResult}/`.failTierMatchCount`, which count ONLY
 * {@link HARNESS_FAIL_WRAPPER_RE}'s own line shape — see that constant's doc for exactly what it excludes
 * (the epilogue's own indented echo) and why. Under that anchoring, over-counting (`> 1`) now means what it
 * always should have: genuinely multiple distinct failing files, each producing their own real wrapper
 * line — the correct case to fail closed on — never an assertion failure's own output being counted twice.
 *
 * 🎯 CARD 2a79a74c FINDING #5 — DECISION: this retry REFUSES outright (returns `undefined`) whenever
 * `harnessNotExecutedDetected` is true, REGARDLESS of `failTierTestCount === 1` — see
 * `HARNESS_NOT_EXECUTED_RE`'s own doc for the exact masking mechanism this closes (a co-occurring genuine
 * failure's own wrapper line survives test-daemon.mjs's early `notExecuted` exit untouched, so
 * `failTierTestCount` alone cannot see that OTHER discovered files were structurally never run at all).
 * `harnessNotExecutedDetected` is REQUIRED (not optional), same posture as `failTierTestCount` above and
 * for the identical reason: a caller/test-double that doesn't supply it must fail closed to "not detected"
 * (`false`/`undefined`), never silently skip the check.
 * ⚠️ THE TRADEOFF BEING BOUGHT HERE, STATED (the card's DoD asked for this explicitly — either remedy was
 * acceptable): this is remedy (b), NOT remedy (a). `test-daemon.mjs`'s early `process.exit(1)` on the
 * `notExecuted` invariant still fires BEFORE its own `FAILURES:` echo — a genuine co-occurring test
 * failure's full stdout/stderr detail is still absent from attempt 1's raw output on this rare path, so a
 * human reading that log alone gets a weaker diagnostic than the ordinary failure path. What this DOES
 * buy: the retry can never silently merge a run that both failed a real test AND lost track of whether
 * every selected file even ran — the gate simply stays rejected (exactly like today, pre-single-file-retry)
 * whenever this invariant trips, so the structural defect is never masked by a lucky isolated re-pass.
 */
export function identifyRetriableTestFile(failTierTest: string | undefined, cwd: string, failTierTestCount: number | undefined, harnessNotExecutedDetected: boolean): RetriableTestFile | undefined {
  if (!failTierTest) return undefined;
  if (failTierTestCount !== 1) return undefined;
  if (harnessNotExecutedDetected) return undefined;
  const m = /^FAIL\s+(\S+)/.exec(failTierTest);
  if (!m) return undefined;
  const name = m[1]!;
  // A bare identifier only — never a path separator or shell metacharacter — before this ever reaches a
  // shell command string. This daemon's own FAIL line never names anything else; a token shaped
  // differently can't be one of ours regardless of what the file-existence check below would say.
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return undefined;
  const scriptFile = path.join(cwd, "packages", "daemon", "scripts", "test-daemon.mjs");
  const testFile = path.join(cwd, "packages", "daemon", "test", `${name}.mjs`);
  if (!fs.existsSync(scriptFile) || !fs.existsSync(testFile)) return undefined;
  return { name, command: `node packages/daemon/scripts/test-daemon.mjs --only=${name}` };
}

/**
 * Card 6dcb9cd3: the ONE place the "⚠ WEAKER PASS" wording is authored — reused by BOTH the live
 * `[loom:merge-done]` nudge (`confirmWorkerMergeTracked`'s onSettle, sessions/service.ts) and the pull-based
 * `gate_status(opId)` settled-record read (`retryWarning`, same file). Before this card the nudge had its
 * own inline template literal and `gate_status` had no warning at all — a manager who missed the nudge and
 * polled `gate_status` instead saw `outcome:"pass"` next to a `steps[]` entry with a real failure and
 * nothing explaining it (the card's own measured finding, op `3954a69f`). A single formatter means the two
 * surfaces can never drift into two different tellings of the identical fact — exactly the two-hand-
 * maintained-copies drift card `6dcb9cd3`'s own DoD-2 calls out by name.
 *
 * Takes the bare `retriedFile` name (never call this when no retry fired — both call sites gate on a
 * truthy `retriedFile` first, so this never has to branch on "was there a retry"). Returns the warning text
 * WITHOUT a leading space or the `⚠` glyph's own leading space — callers that inline this into a larger
 * nudge string prepend their own separator, mirroring {@link formatGateStepsDiagnostic}'s own convention.
 */
export function formatWeakerPassWarning(retriedFile: string): string {
  return `⚠ WEAKER PASS: the first gate attempt failed; passed only after retrying '${retriedFile}' in isolation once. An order-dependent/cross-test-pollution bug can pass alone and fail in the full suite — treat this differently from an ordinary clean pass.`;
}

/**
 * Card 39da2570: the sibling of {@link formatWeakerPassWarning}, for the OTHER retry that can produce a
 * `merged:true` merge verdict — the TRANSIENT-KILL AUTO-RETRY (card bcba83a1, a "kill"/"timeout"
 * classification only, mutually exclusive with the single-file retry per attempt). No filename to name
 * (this retry re-runs the WHOLE gate, not one file), so unlike `formatWeakerPassWarning` this takes no
 * argument — call it only when `ConfirmMergeResult.transientRetried` is truthy, the same discipline that
 * function's own callers already follow for `retriedFile`. Same no-leading-space convention as that
 * sibling and {@link formatGateStepsDiagnostic}.
 */
export function formatTransientRetryWarning(): string {
  return "⚠ WEAKER PASS: the first gate attempt was killed/timed out; passed only after one automatic full-suite retry (card bcba83a1). The concurrency triple beside this note describes the RETRY's own (later) admission, not attempt 1's — treat this differently from an ordinary clean pass.";
}
