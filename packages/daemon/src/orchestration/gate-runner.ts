import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import { GATE_SPILL_MAX_BYTES } from "./gate-spill.js";

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
 *  `error TSxxxx` typechecker diagnostics. `UNCAUGHT` ranks FIRST (highest priority) — `result()` (below)
 *  returns the highest-priority tier with any match. Retry eligibility is DELIBERATELY DECOUPLED from this
 *  priority: it reads {@link createFailingTestTracker.failTierResult}/`.failTierMatchCount` instead, never
 *  `result()`'s tier.
 *  @decision 0e5b2045 — retry eligibility must read failTierResult()/failTierMatchCount(), never result();
 *  diagnostic tier priority (UNCAUGHT first) must never drive it. */
/** The `FAIL`/`not ok` tier of {@link FAILING_TEST_PATTERNS}, named separately so `scanLine` (below) can
 *  identify a match against THIS specific tier by reference (`===`), independent of its array position. */
const FAIL_NOT_OK_TIER_RE = /^\s*(FAIL|✗|✖|not ok)\b.*/i;
const FAILING_TEST_PATTERNS: RegExp[] = [
  /\bUNCAUGHT\b.*/,
  FAIL_NOT_OK_TIER_RE,
  /AssertionError.*/,
  /error TS\d+:.*/,
];

/** Discards a bare `FAIL <token>` line (nothing else on it) whose token isn't a real file under
 *  `packages/daemon/test/` — catches a mocked gate verdict's `outputTail` leaking into the real stream via
 *  `test-daemon.mjs`'s own `FAILURES:` epilogue re-echo. A genuine per-file marker never has this bare shape.
 *  @decision 11737292 — discard a bare `FAIL <token>` line (nothing else on it) whose token isn't a real file
 *  under packages/daemon/test/; never extend this beyond that exact bare-token shape. */
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
 * The ONLY line shape {@link createFailingTestTracker.failTierResult}/`.failTierMatchCount` — and therefore
 * {@link identifyRetriableTestFile} — may ever count: `test-daemon.mjs`'s own `runLane` wrapper line,
 * verbatim, printed UNINDENTED exactly once per failing file. Anchored on BOTH (1) NO leading whitespace and
 * (2) a trailing `  (exit ` suffix — the two properties ONLY this wrapper line has; a `check()`-printed
 * per-assertion `FAIL` line (indented when re-echoed by the `FAILURES:` epilogue, or printed bare by a
 * reduced-path static guard) satisfies at most one, never both, so it can never be mistaken for a real
 * per-file wrapper line.
 * @decision 6c84b87b — never drop either anchor condition (no leading whitespace, trailing `(exit ` suffix);
 * either alone lets a FAILURES: epilogue echo or a bare guard's own check() failure masquerade as a real
 * per-file wrapper line.
 */
export const HARNESS_FAIL_WRAPPER_RE = /^FAIL\s+\S+\s+\(exit /;

/**
 * Matches `test-daemon.mjs`'s own structural `notExecuted` invariant failure (some discovered hermetic
 * test file(s) never actually executed) — a signal {@link identifyRetriableTestFiles} refuses the retry
 * on outright, regardless of `failTierMatchCount`, because a co-occurring genuine failure's own wrapper
 * line survives this early exit untouched and would otherwise mask it.
 * @decision 2a79a74c — a match here is a hard refusal for the retry, regardless of failTierMatchCount; a clean
 * count says nothing about files that never ran at all.
 */
export const HARNESS_NOT_EXECUTED_RE = /^❌ test-daemon\.mjs: \d+ discovered hermetic test file\(s\) were NOT actually executed/;

/** A line recording a PASSING assertion — this daemon's own `check()` convention, `PASS  <label>`,
 *  optionally indented — must never be mistaken for a failure, whatever words its own LABEL contains.
 *  Checked BEFORE any `FAILING_TEST_PATTERNS` tier (all unanchored, so a passing label's prose can
 *  otherwise match one) and before {@link HARNESS_FAIL_WRAPPER_RE}.
 *  @decision 2f0b2e57 — check this before any FAILING_TEST_PATTERNS tier, unconditionally; a passing
 *  assertion's own LABEL can contain a failure keyword and must still lose to PASS. */
const PASS_LINE_RE = /^\s*PASS\b/i;

/** Cap (bytes/UTF-16 code units) on `createFailingTestTracker`'s `carry` — the not-yet-newline-terminated
 *  remainder it holds between `feed()` calls. See that function's own doc for why this must be bounded. */
const FAILING_TEST_CARRY_CAP_BYTES = 8192;

/**
 * Scans a step's stdout+stderr AS IT STREAMS for the LAST failing-test/assertion marker line, independent
 * of the bounded {@link OUTPUT_TAIL_BYTES} ring `runGateStep`'s `tail()` keeps for display — a tail
 * dominated by trailing warnings/a pnpm epilogue can truncate the actual failing-test line out of it.
 * Tracks the LAST line matching EACH {@link FAILING_TEST_PATTERNS} tier independently; `result()` returns
 * the highest-priority tier with any match (never the whole output — a handful of bytes total). `carry`
 * (the not-yet-terminated remainder between `feed()` calls) is BOUNDED two ways — do not regress either:
 * a bare `\r` counts as a line boundary (not just `\n`), and `carry` is hard-capped at
 * {@link FAILING_TEST_CARRY_CAP_BYTES} regardless — see the decision record for why both are load-bearing.
 * `cwd` is optional and purely a cross-check for {@link isUnverifiableBareFailToken}; omitting it is a
 * no-op, not a behavior change.
 * @decision 55cba5c5 — never revert the line-split regex to /\r?\n/ (misses bare-\r progress-bar output, reopens
 * unbounded carry growth); never remove the FAILING_TEST_CARRY_CAP_BYTES hard cap.
 * @decision 2f0b2e57 — result()/failingTest names a matching LINE only, never an attributed FAILING FILE under
 * multi-lane concurrency; it can belong to the wrong lane (known limitation, specimen 2).
 */
export function createFailingTestTracker(cwd?: string): {
  feed(chunk: Buffer): void;
  result(): string | undefined;
  matchCount(): number;
  failTierResult(): string | undefined;
  failTierMatchCount(): number;
  failTierAllResults(): string[];
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
  // Card 67030bb9: EVERY line matching HARNESS_FAIL_WRAPPER_RE, in the order seen — `lastHarnessWrapper`
  // above can only ever report the LAST one, which is what made a multi-file failure structurally
  // unidentifiable-by-name (only the count was visible, never which N files). {@link
  // identifyRetriableTestFiles} reads this array (via `failTierAllResults()` below) to name every
  // candidate file for a bounded multi-file retry. Length always equals `harnessWrapperCount` by
  // construction (both incremented at the same call site, below) — never independently drifted.
  const allHarnessWrapperLines: string[] = [];
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
    if (HARNESS_FAIL_WRAPPER_RE.test(line)) { lastHarnessWrapper = line.trim(); harnessWrapperCount++; allHarnessWrapperLines.push(lastHarnessWrapper); }
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
    /** Card 67030bb9: every {@link HARNESS_FAIL_WRAPPER_RE} match, in the order seen — the array
     *  `failTierMatchCount()`'s count already describes, finally made nameable. `.length` always equals
     *  `failTierMatchCount()`; this exists only because that count alone can't say WHICH N files failed.
     *  Feeds {@link identifyRetriableTestFiles}'s bounded multi-file retry. */
    failTierAllResults(): string[] {
      flushCarryOnce();
      return allHarnessWrapperLines;
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
  /** Card a16c580b: absolute path to this step's FULL captured stdout+stderr, when a caller passed
   *  `spillFile` to {@link runGateStep} AND at least one byte was actually captured — `undefined` when no
   *  `spillFile` was given, or the step produced no output at all (nothing to spill). Unlike `outputTail`,
   *  this is never truncated on its own account — see `GATE_SPILL_MAX_BYTES`'s own doc for the (much
   *  larger, disk-usage-only) ceiling it can still hit on a pathological run. */
  outputFile?: string;
  /** Best-effort failing-test/assertion line, scanned LIVE across the full stream (see
   *  {@link createFailingTestTracker}) — unlike `outputTail`, never truncated to the last
   *  {@link OUTPUT_TAIL_BYTES}. `undefined` when nothing recognizable was found (an honest miss, never a
   *  guess — see {@link extractFailingTest}'s own doc). STRUCTURALLY ONE LINE (or `undefined` entirely for
   *  an unmatched multi-line shape) — `outputTail`'s front-anchored `FAILURES:`-block capture is the
   *  recovery path, not this field, and it has two known gaps — see the decision record.
   *  @decision 87cdb15f — `failingTest === undefined` is not "no diagnostic" — read `outputTail` first; its
   *  FAILURES: recovery can still starve under a shared budget or have no fallback on a step timeout. */
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
  /** Card 67030bb9: see {@link createFailingTestTracker.failTierAllResults} — every {@link
   *  HARNESS_FAIL_WRAPPER_RE} line seen in this step, in order, `.length === failTierTestCount`.
   *  {@link identifyRetriableTestFiles} reads THIS (never `failTierTest` alone) to name every candidate
   *  file for a bounded multi-file retry — `failTierTest` alone can only ever name the LAST one.
   *  `undefined` iff `failTierTest` is `undefined` (mirrors that field's own own-miss discipline). */
  failTierAll?: string[];
  /** See {@link createFailingTestTracker.harnessNotExecutedDetected} — forwarded verbatim. `undefined`/
   *  `false` on every ordinary run; `true` only when `test-daemon.mjs`'s own structural `notExecuted`
   *  invariant line was seen in this step's output. {@link identifyRetriableTestFiles} reads this to
   *  refuse the retry outright — see `HARNESS_NOT_EXECUTED_RE`'s own doc for why. */
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
  (command: string, cwd: string, timeoutMs: number, envOverride?: NodeJS.ProcessEnv, allowExtend?: boolean, cancelSignal?: AbortSignal, hooks?: GateLivenessHooks, spillFile?: string): Promise<GateStepResult>;
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
export const runGateStep: GateStepRunner = (command, cwd, timeoutMs, envOverride, allowExtend = true, cancelSignal, hooks, spillFile) => new Promise((resolve) => {
  // Card a16c580b: FULL-OUTPUT spill, independent of the bounded ring below — appended to synchronously as
  // each chunk arrives (never buffered — see GATE_SPILL_MAX_BYTES's own doc for why this can't just widen
  // the ring instead), so a settled op's complete stdout+stderr is recoverable by opId even once
  // `outputTail` has truncated it. `undefined` `spillFile` (the common case for a caller that never opted
  // in) makes every line below a no-op — byte-identical to pre-card behavior.
  let spilledBytes = 0;
  let spillCapped = false;
  let spilledAny = false;
  const spill = (b: Buffer): void => {
    if (!spillFile || spillCapped) return;
    try {
      if (spilledBytes === 0) fs.mkdirSync(path.dirname(spillFile), { recursive: true });
      if (spilledBytes + b.length > GATE_SPILL_MAX_BYTES) {
        const room = GATE_SPILL_MAX_BYTES - spilledBytes;
        if (room > 0) fs.appendFileSync(spillFile, b.subarray(0, room));
        fs.appendFileSync(spillFile, `\n... [gate-output spill capped at ${GATE_SPILL_MAX_BYTES} bytes — output continues beyond this point] ...\n`);
        spillCapped = true;
        spilledAny = true;
        return;
      }
      fs.appendFileSync(spillFile, b);
      spilledBytes += b.length;
      spilledAny = true;
    } catch (err) {
      // Best-effort: a disk-write failure here must never break gate execution — the bounded ring/tail
      // stays the fallback diagnostic exactly as before this card.
      console.warn(`[gate-runner] full-output spill write failed (continuing): ${(err as Error).message}`);
      spillCapped = true; // stop retrying a broken sink on every subsequent chunk
    }
  };
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
    spill(b);
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
  /** The RETAINED+REPORTED bytes for a FAILING step, selected by CONTENT rather than position — never a
   *  change to pass/fail determination (decided entirely upstream by `result.status`/`error`/`timedOut`).
   *  Fires ONLY when `tail()` is actually lossy (`totalBytesSeen > `{@link OUTPUT_TAIL_BYTES}`) — see the
   *  decision record for the regression this guards against. Priority once it applies: (1) the
   *  front-anchored FAILURES: block; (2) the single best failing-test line; (3) an explicit honest-miss
   *  string — never a silent positional chunk. PASSING path is untouched (`tail()`).
   *  @decision 6ffee3e2 — content-selection only fires when totalBytesSeen > OUTPUT_TAIL_BYTES (tail() is
   *  genuinely lossy); unconditional selection loses a short command's ANSI-wrapped FAIL line to a
   *  lower-priority tier. */
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
  const done = (result: Omit<GateStepResult, "outputTail" | "failingTest" | "failingTestCount" | "failTierTest" | "failTierTestCount" | "failTierAll" | "harnessNotExecutedDetected" | "decidedAt">) => {
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
      ...(spilledAny ? { outputFile: spillFile } : {}),
      failingTest, failingTestCount: failingTest ? failingTestTracker.matchCount() : undefined,
      failTierTest, failTierTestCount: failTierTest ? failingTestTracker.failTierMatchCount() : undefined,
      failTierAll: failTierTest ? failingTestTracker.failTierAllResults() : undefined,
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
        ...(spilledAny ? { outputFile: spillFile } : {}),
        failTierTest: timeoutFailTierTest, failTierTestCount: timeoutFailTierTest ? failingTestTracker.failTierMatchCount() : undefined,
        failTierAll: timeoutFailTierTest ? failingTestTracker.failTierAllResults() : undefined,
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
 * Force-kill a gate step's process TREE, not just the shell `spawn` returned as `child` — `shell:true`
 * makes `child` a `cmd.exe`/`sh`/`bash` whose DESCENDANTS (e.g. `pnpm` → `vitest` → forked test workers) a
 * plain `child.kill()` never reaches. win32: `taskkill /pid <child.pid> /T /F` kills the whole subtree.
 * posix: spawned `detached:true` above so `child.pid` is the process GROUP id — `process.kill(-pid,
 * "SIGKILL")` signals the whole group; a plain `process.kill(pid, ...)` would leak on posix too.
 * Resolves once the kill has been ISSUED; best-effort — an already-exited pid is a silent no-op.
 * @decision 3564fd1e — never kill only the shell (descendants survive and accumulate, eventually saturating the
 * host); on posix this must be `process.kill(-pid, "SIGKILL")` against the process GROUP id, never a plain pid
 * signal.
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
  /** Card a16c580b: see {@link GateStepResult.outputFile} — forwarded from whichever step actually wrote
   *  one (every step of one `runGateSequential` call shares the SAME `spillFile`, appended to in execution
   *  order, so this is simply "was anything ever spilled for this run" regardless of which step did it).
   *  `undefined` under the identical "nothing to report" conditions as `outputFile` itself (no `spillFile`
   *  given, or zero bytes captured across every step that ran). */
  outputFile?: string;
  /** See {@link GateStepResult.failingTest} — forwarded verbatim from the failing step's own result, so a
   *  caller no longer has to re-derive it (truncation-prone) from `outputTail` itself. */
  failingTest?: string;
  /** See {@link GateStepResult.failingTestCount} — forwarded verbatim alongside `failingTest`. A caller
   *  MUST check this is exactly `1` before treating `failingTest` as a complete account of what failed. */
  failingTestCount?: number;
  /** See {@link GateStepResult.failTierTest} — forwarded verbatim from the failing step's own result.
   *  {@link identifyRetriableTestFiles} reads {@link failTierAll} below, never `failingTest` above. */
  failTierTest?: string;
  /** See {@link GateStepResult.failTierTestCount} — forwarded verbatim alongside `failTierTest`. */
  failTierTestCount?: number;
  /** See {@link GateStepResult.failTierAll} — forwarded verbatim alongside `failTierTest`. */
  failTierAll?: string[];
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
 * How close a step's `durationMs` came to consuming its own `gateCommandTimeoutMs` budget — a
 * WARN-BEFORE-BREACH signal, distinct from `gateExtended`/`anyExtended`, which only tells you a run
 * ALREADY breached it. `fraction` is ALWAYS `durationMs / gateCommandTimeoutMs` — the RAW configured
 * value, the SMALLER HARD retry ceiling (a post-timeout retry gets no auto-extend), never the ~2× first-
 * attempt-with-extension allowance; a `fraction` over `1.0` means a retry of this step would have no
 * reprieve even though this run passed. Never compare these numbers against each other or an "expected"
 * range for any other purpose — see {@link formatGateStepsDiagnostic}'s own doc.
 * @decision 3407caad — fraction is durationMs/gateCommandTimeoutMs (the smaller hard retry ceiling, never the
 * ~2x first-attempt-with-extension allowance); never anchor 0.85 on a peer project's own reading or unify it
 * with Gates.tsx's LONG_RUN_WARN_FRACTION.
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
  allowExtend?: boolean, cancelSignal?: AbortSignal, hooks?: GateLivenessHooks, spillFile?: string,
): Promise<GateSequentialResult> {
  // Card a2873f7e: per-step {step, durationMs, status} accumulated as each step settles — forwarded
  // verbatim on EVERY return below (green or rejected), same shape either way.
  const steps: GateStepDuration[] = [];
  // Card 4c5bf820: the LAST step's own bounded tail, carried forward so the green return below can report
  // it too — every rejection return already forwards `res.outputTail` from the step that failed; a passing
  // run has no "failed step" to hang it off, so the last step actually run is the honest equivalent.
  let lastOutputTail: string | undefined;
  // Card a16c580b: mirrors `lastOutputTail` immediately above — every step shares the SAME `spillFile`
  // (appended to in execution order), so this is just "did any step ever actually spill".
  let lastOutputFile: string | undefined;
  for (const step of splitGateSteps(gate)) {
    // Card 8d585277: checked BEFORE spawning each step too — a cancel arriving in the gap BETWEEN two
    // steps (this run has already settled one step and hasn't started the next) must not spawn a step
    // that was never going to be waited for.
    if (cancelSignal?.aborted) return { passed: false, cancelled: true, failedStep: step, steps };
    const startedAt = performance.now();
    const res = await runStep(step, cwd, timeoutMs, envOverride, allowExtend, cancelSignal, hooks, spillFile);
    const durationMs = res.decidedAt != null ? res.decidedAt - startedAt : null;
    steps.push({ step, durationMs, status: res.status });
    lastOutputTail = res.outputTail;
    if (res.outputFile) lastOutputFile = res.outputFile;
    if (res.cancelled) {
      return {
        passed: false, cancelled: true, failedStep: step, failedStatus: res.status, failedSignal: res.signal ?? null,
        failedTimedOut: false, outputTail: res.outputTail, ...(res.outputFile ? { outputFile: res.outputFile } : {}),
        failingTest: res.failingTest, failingTestCount: res.failingTestCount,
        failTierTest: res.failTierTest, failTierTestCount: res.failTierTestCount, failTierAll: res.failTierAll,
        harnessNotExecutedDetected: res.harnessNotExecutedDetected, steps,
      };
    }
    const passed = res.status === 0 && !res.error;
    if (!passed) {
      return {
        passed: false, failedStep: step, failedStatus: res.status, failedSignal: res.signal ?? null,
        failedTimedOut: res.timedOut ?? false, outputTail: res.outputTail, ...(res.outputFile ? { outputFile: res.outputFile } : {}),
        failingTest: res.failingTest, failingTestCount: res.failingTestCount,
        failTierTest: res.failTierTest, failTierTestCount: res.failTierTestCount, failTierAll: res.failTierAll,
        harnessNotExecutedDetected: res.harnessNotExecutedDetected, steps,
      };
    }
  }
  return { passed: true, steps, outputTail: lastOutputTail, ...(lastOutputFile ? { outputFile: lastOutputFile } : {}) };
}

/**
 * The discriminator for a resumed gate: given the FULL command actually executed (`effectiveGate`, never
 * the raw configured `gateCommand`) and how many steps a result already accounts for, returns every step
 * not yet run, in order. Pure step-string arithmetic — never inspects *why* a step failed or whether a
 * retry is eligible; a caller calls this only after {@link classifyGateFailure}/
 * {@link identifyRetriableTestFiles} have already said "yes, proceed."
 * @decision 7ad12202 — never report a gate passed:true after a rescued single-file retry without first checking
 * this — steps after the original failure may never have run at all.
 */
export function remainingGateSteps(effectiveGate: string, stepsAlreadyRun: number): string[] {
  return splitGateSteps(effectiveGate).slice(stepsAlreadyRun);
}

/**
 * Folds a RESUMED run's result (re-invoking {@link runGateSequential}/`runGateStep` against just the
 * {@link remainingGateSteps} suffix, as its own separately-admitted gate call) back into the ORIGINAL
 * result. `steps` is NEVER taken from either side alone — `original.steps` concatenated with
 * `resumed.steps` is what makes the merged `steps[]` equal EVERY step `effectiveGate` names. Every OTHER
 * field is NOT simply "whichever side is newest": on `resumed.passed === true` keeps `original`'s own
 * diagnostic fields (load-bearing for {@link isTimeoutKillEntry}, which can only ever match ATTEMPT 1's
 * tail); on `resumed.passed === false` (or cancelled), `resumed`'s own fields win outright. Never invents
 * a verdict, and must never be looped — a caller resumes once. See the decision record for the full
 * two-branch reasoning and the Code Review finding that motivated it.
 * @decision 7ad12202 — on resumed.passed===true keep original's diagnostic fields (or isTimeoutKillEntry stops
 * matching attempt 1's tail); never loop this — a caller resumes once.
 */
export function mergeResumedGateResult(original: GateSequentialResult, resumed: GateSequentialResult): GateSequentialResult {
  const steps = [...original.steps, ...resumed.steps];
  if (resumed.passed) return { ...original, passed: true, steps };
  return { ...resumed, steps };
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
 * Classify a failed gate step so the merge gate can tell a transient external kill from a genuine
 * test/build failure — see the decision record for why this exists.
 *  - **"kill"** — an external signal terminated the step and OUR OWN {@link runGateStep} timeout bound
 *    was NOT the cause (`failedTimedOut` false, `failedSignal` set) — the shape of an OOM-killer/cgroup/
 *    resource-limit kill. Retry-eligible.
 *  - **"timeout"** — OUR OWN `gateTimeoutMs` bound killed the step (`failedTimedOut` true; `runGateStep`
 *    always pairs this with `signal:"SIGKILL"`, but the CAUSE is our own bound, not an external kill — a
 *    separate bucket because a retry here may just re-time-out under the same load; see the merge-gate
 *    retry call site's guardrail). Retry-eligible, but deliberately so.
 *  - **"genuine"** — a clean non-zero exit (or a spawn error) with no signal and no timeout: a real
 *    test/build failure. NEVER retried — retrying would waste cycles and could mask a flaky-passing test.
 * @decision bcba83a1 — never fold "kill"/"timeout" back into a flat failure (that taught managers to bypass the
 * gate with --no-verify); never retry a "genuine" classification.
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

/** Card 67030bb9: the cap on how many distinct failing files {@link identifyRetriableTestFiles} will ever
 *  bundle into one retry. STATED AS A JUDGEMENT CALL, NOT A DERIVED BOUND (manager review, card 67030bb9)
 *  — an earlier draft of this card justified 3 as "mirrors `LOOM_GATE_TEST_CONCURRENCY`'s own default pool
 *  size"; that was DROPPED on manager review because a lane-pool size and a masking-risk bound are
 *  unrelated quantities, and a borrowed number that reads as derived is worse than an honest arbitrary one.
 *  3 is picked because both real multi-file specimens this card measured (`07520fa5` 2 files, `cfc2cd56`
 *  3 files) fit inside it, and because {@link formatWeakerPassWarning}'s own per-file naming needs to stay
 *  legible to a manager reading a merge-done nudge for a small set — nothing more principled than that. */
export const MULTI_FILE_RETRY_MAX = 3;

/** {@link identifyRetriableTestFiles}'s why-declined vocabulary (card 67030bb9) — persisted by callers
 *  alongside `retriedFile`/`retryPassed` so a rejection like gate `1af9138e` (a clean, single-file,
 *  retriable-SHAPED failure that still recorded `retriedFile:null`) is explainable AFTER THE FACT from
 *  `gate_history` instead of needing a fresh live repro to diagnose — which is genuinely all the store
 *  allowed before this card, since neither `failTierTestCount` nor `harnessNotExecutedDetected` was ever
 *  persisted anywhere. Covers only what happens INSIDE this function — a caller that never even calls it
 *  (e.g. its OWN `classifyGateFailure(gateResult) === "genuine"` gate already failed) records its own,
 *  separate reason instead; see confirmWorkerMerge's/the batch `runGate`'s own call sites. */
export type RetryDeclineReason =
  | "no-fail-tier-match"
  | "count-mismatch"
  | "over-cap"
  | "harness-not-executed"
  | "unparseable-name"
  | "file-not-found"
  | "duplicate-name";

/** {@link identifyRetriableTestFiles}'s full result — a caller must handle both arms explicitly (never a
 *  single `undefined` check) so the decline reason can never be silently discarded at the one place it's
 *  actually known. `command` (on the eligible arm) is the ready-to-run re-invocation — `--only=a,b,c` for
 *  N>1, `--only=a` for N=1, test-daemon.mjs's own existing `--only=` flag already accepts either shape
 *  (card 6185fbfc). `names` are in the order their own FAIL lines appeared, for the `retriedFile` record —
 *  joined with `,`, always losslessly reversible via `.split(",")` since the identifier guard below makes
 *  a `,`-containing name structurally impossible. */
export type RetryIdentification =
  | { eligible: true; names: string[]; command: string }
  | { eligible: false; declineReason: RetryDeclineReason };

/**
 * Given a gate run's own {@link GateStepResult.failTierAll}/{@link GateSequentialResult.failTierAll} —
 * every {@link HARNESS_FAIL_WRAPPER_RE} line the live scan saw, in order — and the gate's `cwd`, identify
 * UP TO `maxFiles` distinct test files this daemon's own hermetic suite can re-run TOGETHER in isolation
 * via its existing `--only=<name>[,<name>...]` flag, so a merge gate can retry a small failing SET instead
 * of the whole suite before declaring a rejection. `failTierTestCount` stays REQUIRED (not optional) for
 * the fail-closed reason detailed in the decision record. Refuses outright, regardless of count, whenever
 * `harnessNotExecutedDetected` is true.
 * @decision 67030bb9 — one name failing the filesystem check declines the WHOLE set, never a partial candidate;
 * never widen past the bare `FAIL <name>` convention or add a second parser.
 * @decision 0e5b2045 — must read failTierAll/failTierTestCount here, never failingTest/failingTestCount — a
 * higher-priority diagnostic tier (e.g. UNCAUGHT) would otherwise silently suppress a real retry.
 * @decision 2a79a74c — never skip the harnessNotExecutedDetected check because the fail-tier count looks clean;
 * refuse the retry outright when it's true, regardless of count.
 */
export function identifyRetriableTestFiles(
  failTierAll: string[] | undefined,
  cwd: string,
  failTierTestCount: number | undefined,
  harnessNotExecutedDetected: boolean,
  maxFiles: number = MULTI_FILE_RETRY_MAX,
): RetryIdentification {
  if (!failTierAll || failTierAll.length === 0) return { eligible: false, declineReason: "no-fail-tier-match" };
  // Belt-and-suspenders, not a second source of truth: failTierAll.length and failTierTestCount are
  // incremented at the SAME call site in createFailingTestTracker and must already agree by construction —
  // a caller/test-double that passes a mismatched pair has a bug upstream, and this refuses rather than
  // guessing which of the two values to trust.
  if (failTierTestCount !== failTierAll.length) return { eligible: false, declineReason: "count-mismatch" };
  if (failTierAll.length > maxFiles) return { eligible: false, declineReason: "over-cap" };
  if (harnessNotExecutedDetected) return { eligible: false, declineReason: "harness-not-executed" };
  const scriptFile = path.join(cwd, "packages", "daemon", "scripts", "test-daemon.mjs");
  if (!fs.existsSync(scriptFile)) return { eligible: false, declineReason: "file-not-found" };
  const testDir = path.join(cwd, "packages", "daemon", "test");
  const names: string[] = [];
  for (const line of failTierAll) {
    const m = /^FAIL\s+(\S+)/.exec(line);
    if (!m) return { eligible: false, declineReason: "unparseable-name" };
    const name = m[1]!;
    // A bare identifier only — never a path separator or shell metacharacter — before this ever reaches a
    // shell command string. This daemon's own FAIL line never names anything else; a token shaped
    // differently can't be one of ours regardless of what the file-existence check below would say.
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return { eligible: false, declineReason: "unparseable-name" };
    if (!fs.existsSync(path.join(testDir, `${name}.mjs`))) return { eligible: false, declineReason: "file-not-found" };
    names.push(name);
  }
  // Card 67030bb9: a duplicate name would mean the SAME file printed its own wrapper line twice in one
  // step's output — shouldn't happen under test-daemon.mjs's one-line-per-file convention, but nothing
  // structurally guarantees it can't (e.g. a future harness change); fail closed rather than silently
  // retrying fewer distinct files than the count implied.
  if (new Set(names).size !== names.length) return { eligible: false, declineReason: "duplicate-name" };
  return { eligible: true, names, command: `node packages/daemon/scripts/test-daemon.mjs --only=${names.join(",")}` };
}

/**
 * Card 9966c52d: `retriedFile`'s attempt-1 `outputTail` sometimes shows the file was KILLED ON A TIMEOUT
 * (`test-daemon.mjs`'s own `(exit timeout (...))` classification for that file's `FAILURES:` entry), not
 * failed by an assertion — measured directly on two specimens (`kickoff-real-spawn`, `batch-merge`), both
 * with every visible assertion `PASS` and the process killed on a clock. The generic wording below is
 * WRONG for that case: nothing about a timeout kill indicates order-dependence/cross-test-pollution.
 *
 * Anchored on the RETRIED FILE'S OWN line — `- <retriedFile> (exit timeout` — never a bare "exit timeout"
 * mention anywhere in the tail (e.g. inside a DIFFERENT file's own echoed stdout/stderr), so a match can
 * only mean test-daemon.mjs itself classified THIS file's exit as a timeout, not merely that the word
 * appears somewhere in a ~4-16KB tail. Fail-safe by construction, per this card's own §NON-NEGOTIABLE:
 * `outputTail` missing, or present but not containing this exact shape for this file, both return `false`
 * — never inferred from an absent match, only asserted from a positive one.
 */
function isTimeoutKillEntry(retriedFile: string, outputTail: string | undefined): boolean {
  if (!outputTail) return false;
  const escaped = retriedFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\n)\\s*-\\s+${escaped}\\s+\\(exit timeout\\b`);
  return re.test(outputTail);
}

/**
 * The ONE place the "⚠ WEAKER PASS" wording is authored — reused by BOTH the live `[loom:merge-done]`
 * nudge and the pull-based `gate_status(opId)` settled-record read, so the two surfaces can never drift
 * into two different tellings of the same fact. Never call this when no retry fired. `outputTail` and
 * `batchBranchCount` are both OPTIONAL/additive; see {@link formatRetryAlsoFailedWarning} for the sibling
 * FAILED-retry case — this signature is deliberately NOT a `passed` boolean on that function instead (a
 * defaultable/forgettable boolean previously produced a false claim with no compiler catch).
 * @decision 6dcb9cd3 — never inline a second copy of this wording elsewhere (both the nudge and gate_status
 * must call this one formatter); never add a `passed` boolean here — use the sibling
 * formatRetryAlsoFailedWarning instead.
 */
export function formatWeakerPassWarning(retriedFile: string, outputTail?: string, batchBranchCount?: number): string {
  const names = retriedFile.split(",");
  const single = names.length === 1;
  const allTimeoutKills = names.every((n) => isTimeoutKillEntry(n, outputTail));
  const batchClause = batchBranchCount !== undefined
    ? ` This retry was for a BATCH of ${batchBranchCount} branch(es) — ALL ${batchBranchCount} land on the strength of this ONE retry, not just the retried file(s).`
    : "";
  if (allTimeoutKills) {
    const killedClause = single ? `killed '${names[0]}'` : `killed ${names.length} files (${names.join(", ")})`;
    const retryClause = single ? "retrying it in isolation once" : "retrying all of them together in ONE isolated retry";
    return `⚠ WEAKER PASS: the first gate attempt ${killedClause} on a timeout, not an assertion failure — passed only after ${retryClause}. This is NOT evidence of an order-dependent/cross-test-pollution bug. The cause of the timeout is not established by this signal alone — read the retained gate output before attributing it.${batchClause}`;
  }
  const retryClause = single ? `retrying '${names[0]}' in isolation once` : `retrying ${names.length} files together in ONE isolated retry ('${names.join("', '")}')`;
  return `⚠ WEAKER PASS: the first gate attempt failed; passed only after ${retryClause}. An order-dependent/cross-test-pollution bug can pass alone and fail in the full suite — treat this differently from an ordinary clean pass.${batchClause}`;
}

/**
 * The SIBLING of {@link formatWeakerPassWarning} for a retry that ALSO failed — a separate, distinctly-
 * named function rather than a `passed` argument on it (see that function's own doc). The
 * "NOT an order-dependent/cross-test-pollution bug" claim is scoped by `names.length` below: for N>1 a
 * failure only rules out pollution from the REST of the suite, never pollution AMONG the retried files
 * themselves (they run concurrently by default). The `allTimeoutKills`/{@link isTimeoutKillEntry} caveat
 * applies here exactly as on the pass side.
 * @decision 9bdc8ea5 — never fold this into formatWeakerPassWarning via a `passed` boolean; for N>1 never claim
 * "not an order-dependent bug" unqualified — it only rules out pollution from the rest of the suite, not among
 * the retried files themselves.
 */
export function formatRetryAlsoFailedWarning(retriedFile: string, outputTail?: string, batchBranchCount?: number): string {
  const names = retriedFile.split(",");
  const single = names.length === 1;
  const allTimeoutKills = names.every((n) => isTimeoutKillEntry(n, outputTail));
  const batchClause = batchBranchCount !== undefined
    ? ` This retry was the batch's last chance for ${batchBranchCount} branch(es) — NONE of them landed; all ${batchBranchCount} fall back to individual gating.`
    : "";
  if (allTimeoutKills) {
    const killedClause = single ? `killed '${names[0]}' again` : `killed ${names.length} files (${names.join(", ")}) again`;
    return `⚠ RETRY ALSO FAILED: both the first gate attempt and the retry ${killedClause} on a timeout, not an assertion failure. This may be host contention under load rather than a reproducing bug — the cause is not established by this signal alone; read the retained gate output before attributing it.${batchClause}`;
  }
  const retryClause = single ? `retrying '${names[0]}' in isolation once` : `retrying ${names.length} files together in ONE isolated retry ('${names.join("', '")}')`;
  const poolClause = single
    ? "it is NOT an order-dependent/cross-test-pollution bug"
    : `it rules out pollution from the REST of the suite, but NOT pollution AMONG the ${names.length} retried files themselves — by default they ran concurrently in one pool, not isolated from each other (test-daemon.mjs's sequential isolation phase is opt-in, off unless LOOM_GATE_ISOLATED_REAL_SPAWN_PHASE=1)`;
  return `⚠ RETRY ALSO FAILED: the first gate attempt failed, and ${retryClause} failed too. This means the failure reproduces in isolation — ${poolClause}.${batchClause}`;
}

/**
 * The THIRD case neither {@link formatWeakerPassWarning} nor {@link formatRetryAlsoFailedWarning} can
 * honestly render — the isolated single-file retry genuinely PASSED, but the gate is still REJECTED
 * because {@link mergeResumedGateResult}'s own resume then failed for real. A caller must dispatch on the
 * GATE's real outcome first, THEN on `retryPassed` only to pick between the sibling formatter and this
 * one. Deliberately takes NO `outputTail` — see the decision record for why.
 * @decision 7ad12202 — deliberately takes no outputTail: isTimeoutKillEntry classifies retriedFile's OWN
 * failure, not the actionable question once a later step is what actually rejected the gate.
 */
export function formatRetryRescuedButGateRejectedWarning(retriedFile: string, batchBranchCount?: number): string {
  const names = retriedFile.split(",");
  const single = names.length === 1;
  const rescueClause = single ? `retrying '${names[0]}' in isolation passed` : `retrying ${names.length} files together in ONE isolated retry ('${names.join("', '")}') passed`;
  const batchClause = batchBranchCount !== undefined
    ? ` This retry was for a BATCH of ${batchBranchCount} branch(es) — NONE of them landed; all ${batchBranchCount} fall back to individual gating.`
    : "";
  return `⚠ RESCUED, THEN REJECTED: the first gate attempt's own failure was rescued — ${rescueClause} — but the gate is REJECTED anyway: a step the original run's own '&&' chain never reached was resumed afterward and failed for real. This is a genuine rejection, never a masked pass.${batchClause}`;
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

/** The subset of `EmitCompareGateResult` (git/worktrees.ts) {@link formatReducedGateWarning} needs — named
 *  locally rather than importing that type, so this file (spawn/process-timing plumbing) doesn't pick up a
 *  dependency on the git layer for a six-field shape. */
export interface ReducedGateWarningInput {
  identicalFileCount: number;
  changedTestFiles: string[];
  notHermeticExcluded: string[];
  inertPathsSkipped: string[];
  changedAssetPaths: string[];
  /** Card abaaf16e: mirrors `changedAssetPaths` above — REQUIRED, not optional, on the same "a caller can't
   *  silently drop it" reasoning Code Review gave for `buildReducedGateCommand`'s own 3rd param (see that
   *  function's own doc). Drives the `changedTsScannerClause` below: when non-empty, `buildReducedGateCommand`
   *  folded `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` into the actual gate that ran, so the warning text MUST say so —
   *  omitting it left the warning claiming "static guards only" on a run that also ran ten runtime tests
   *  (record d422e279's exact defect class, caught by Code Review on card abaaf16e itself). */
  changedTsPaths: string[];
  /** Card f862f9c5: mirrors `changedTsPaths` immediately above, for the SEPARATE `changedScriptFiles`
   *  trigger — drives `changedScriptScannerClause` below on its own condition, independent of
   *  `changedTsPaths`. */
  changedScriptFiles: string[];
}

/**
 * The SHARED builder for the "merge gate reduced: ..." warning a reduced merge surfaces — extracted
 * because the solo and batch call sites had grown two hand-written copies that had ALREADY diverged (see
 * decision record). Two surfacing obligations are load-bearing for BOTH callers: a NOT_HERMETIC-excluded
 * file must be NAMED in `notHermeticExcluded`, not just counted (card 17cd1f30); a skipped-as-inert path
 * must be NAMED in `inertPathsSkipped` too (card 8ee4f11e) — a bare count of either leaves a reader unable
 * to tell WHICH file went unaccounted for.
 * @decision d422e279 — never hand-author a second copy of this text at either call site; never report
 * notHermeticExcluded/inertPathsSkipped as a bare count — name every excluded/skipped file, or a reader can't
 * tell which went unrun.
 */
export function formatReducedGateWarning(
  result: ReducedGateWarningInput, assetReadingTestCount: number, changedTsScannerTestCount: number,
  changedScriptScannerTestCount: number, batchLandedCount?: number,
): string {
  const compiledClause = result.identicalFileCount > 0
    ? `${result.identicalFileCount} file(s) proven transpile/parse-identical (card 2154b6ad, 82662e98)`
    : "no compiled .ts or scripts/** file changed in this diff — transpile-identity check not applicable (card cf4aa7d1)";
  const isolationCaveat = result.changedTestFiles.length
    ? ` ⚠️ ${result.changedTestFiles.length === 1 ? "this changed test file was" : `these ${result.changedTestFiles.length} changed test files were`} run in ISOLATION (\`test:daemon --only=\`); if ${result.changedTestFiles.length === 1 ? "its" : "their"} defect class is order-dependent (passes standalone, fails only in the full suite), this green is not evidence either way${batchLandedCount !== undefined ? ` for ANY of this batch's ${batchLandedCount} landed branch(es)` : ""} (card cf4aa7d1).`
    : "";
  const assetClause = result.changedAssetPaths.length
    ? `; ${result.changedAssetPaths.length} asset path(s) changed under packages/daemon/assets/** (${result.changedAssetPaths.join(", ")}) — ran the ${assetReadingTestCount} certified asset-reading test(s) too (card 3fbd95e0)`
    : "";
  // Card abaaf16e (Code Review MAJOR): a compiled .ts change in this diff means buildReducedGateCommand
  // ALSO folded CHANGED_TS_TEXT_SCANNER_REPO_PATHS into what actually ran — the "ran build + static guards only"
  // clause below is false for this run unless this clause says so too. A COUNT, not the changed .ts paths
  // themselves — mirrors assetReadingTestCount's own reasoning (this function stays redaction-agnostic; the
  // caller decides what's safe to surface, this file just formats a number).
  const changedTsScannerClause = result.changedTsPaths.length
    ? `; a compiled .ts changed — also ran the ${changedTsScannerTestCount} compiled-source/dist text-scanner test(s) (cards abaaf16e, fab07aba)`
    : "";
  // Card f862f9c5: mirrors changedTsScannerClause immediately above, on the SEPARATE changedScriptFiles
  // trigger — a scripts/**-only diff (changedTsPaths empty) must still say so, or the warning claims
  // "static guards only" on a run that also ran the scripts-text-scanner test(s), the same defect class
  // record d422e279 already closed for the .ts case.
  const changedScriptScannerClause = result.changedScriptFiles.length
    ? `; a packages/daemon/scripts/** file changed — also ran the ${changedScriptScannerTestCount} scripts-text-scanner test(s) (card f862f9c5)`
    : "";
  const subject = batchLandedCount !== undefined ? `batch merge gate reduced across ${batchLandedCount} landed branch(es)` : "merge gate reduced";
  return `${subject}: ${compiledClause} — ran build + static guards only${result.changedTestFiles.length ? ` + ${result.changedTestFiles.length} changed test file(s)` : ""}, skipped the full daemon test suite${result.notHermeticExcluded.length ? `; NOT gated (NOT_HERMETIC, same as the full suite): ${result.notHermeticExcluded.join(", ")}` : ""}${result.inertPathsSkipped.length ? `; also skipped as proven inert (docs/, card db9b0130): ${result.inertPathsSkipped.join(", ")}` : ""}${assetClause}${changedTsScannerClause}${changedScriptScannerClause}${isolationCaveat}`;
}
