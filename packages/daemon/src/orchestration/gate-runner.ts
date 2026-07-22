import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";

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
  decidedAt?: number;
}

/** Real, NON-BLOCKING runner for one gate step (`spawn`, not `spawnSync` — see the note below). Same
 *  `shell:true` / per-step timeout as the old single-shot `spawnSync` call this replaces; UNLIKE that
 *  call (and unlike the old `stdio:"ignore"` version of this runner) it CAPTURES stdout+stderr into a
 *  bounded ring so a rejection can surface the REAL failure instead of an opaque "gate failed". Injectable
 *  so a hermetic test can prove step-by-step + short-circuit behavior without spawning real processes. */
export interface GateStepRunner {
  (command: string, cwd: string, timeoutMs: number, envOverride?: NodeJS.ProcessEnv, allowExtend?: boolean): Promise<GateStepResult>;
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
export const runGateStep: GateStepRunner = (command, cwd, timeoutMs, envOverride, allowExtend = true) => new Promise((resolve) => {
  // Bounded capture ring: keep roughly the last OUTPUT_TAIL_BYTES, dropping whole chunks off the front
  // as newer ones arrive. The final tail() slices to exactly the cap. Same shape as python/venv.ts's
  // runAsync — captured (not ignored) so a rejection can surface the actual gate output.
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Liveness stamp for the auto-extend decision below — updated on EVERY chunk regardless of the ring's
  // own eviction, so it stays accurate even once the ring has dropped early output. MONOTONIC
  // (performance.now(), not Date.now()/wall clock) to match the deadlines it's compared against
  // (setTimeout, also monotonic) — a backward wall-clock step (NTP) mid-gate can't flip the extend
  // decision (mirrors Loom's existing monotonic-clock preference for timing logic).
  let lastOutputAt = performance.now();
  const capture = (b: Buffer): void => {
    chunks.push(b);
    bytes += b.length;
    lastOutputAt = performance.now();
    while (bytes > OUTPUT_TAIL_BYTES && chunks.length > 1) bytes -= chunks.shift()!.length;
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
  // GIT_TERMINAL_PROMPT=0 — a gateCommand/deployCommand step may run `git push` (or any git op); without
  // this, an uncached-credential push blocks on an interactive prompt until the timeout SIGKILL instead
  // of failing fast (mirrors git/writer.ts and pty/host.ts's same guard). `envOverride` (card 7f96aa09)
  // lets a caller force additional vars onto just this step's own child — e.g. the worker self-gate pins
  // `LOOM_TEST_CONCURRENCY=2` here (card 68920f5b), matching the merge gate's own unpinned default lane
  // count, so the host-load budget is `maxConcurrentGates × 2` — the SAME bound the merge gate already
  // implies, not a new one — applied AFTER the base env so an override always wins.
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
  const done = (result: Omit<GateStepResult, "outputTail" | "decidedAt">) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve({ ...result, outputTail: tail(), decidedAt: performance.now() });
  };
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
    if (allowExtend && GATE_TIMEOUT_EXTEND_ENABLED && !extended && idleMs < GATE_EXTEND_IDLE_MS) {
      extended = true;
      timer = setTimeout(onTimeout, timeoutMs);
      return;
    }
    settled = true;
    const decidedAt = performance.now(); // captured BEFORE the async tree-kill below — see GateStepResult.decidedAt
    void killGateProcessTree(child).finally(() => {
      resolve({
        status: null,
        error: new Error(`gate step exceeded ${timeoutMs}ms${extended ? " (after one auto-extend)" : ""}`),
        signal: "SIGKILL", timedOut: true, outputTail: tail(), decidedAt,
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

/** What {@link runGateSequential} resolves. On a rejection, carries enough to make the failure
 *  diagnosable instead of opaque: which step failed, its exit code/signal/timeout, and its bounded
 *  output tail (a caller derives a coarse phase + a best-effort failing-test line from these). */
export interface GateSequentialResult {
  passed: boolean;
  failedStep?: string;
  failedStatus?: number | null;
  failedSignal?: NodeJS.Signals | null;
  failedTimedOut?: boolean;
  outputTail?: string;
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
 */
export async function runGateSequential(
  gate: string, cwd: string, timeoutMs: number, runStep: GateStepRunner = runGateStep, envOverride?: NodeJS.ProcessEnv,
  allowExtend?: boolean,
): Promise<GateSequentialResult> {
  for (const step of splitGateSteps(gate)) {
    const res = await runStep(step, cwd, timeoutMs, envOverride, allowExtend);
    const passed = res.status === 0 && !res.error;
    if (!passed) {
      return {
        passed: false, failedStep: step, failedStatus: res.status, failedSignal: res.signal ?? null,
        failedTimedOut: res.timedOut ?? false, outputTail: res.outputTail,
      };
    }
  }
  return { passed: true };
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
 * tail — scans for common cross-ecosystem failure markers (Loom's own `FAIL  <label>` convention, Jest/AVA/
 * tap-style `FAIL`/`not ok`/✗/✖ markers, thrown `AssertionError`s, and `error TSxxxx` typechecker
 * diagnostics) and returns the FIRST matching line, trimmed. Returns `undefined` when nothing recognizable
 * is found — this is a diagnostic aid, not a parser, so a silent miss just means the raw tail is still
 * surfaced on its own.
 */
export function extractFailingTest(outputTail: string): string | undefined {
  const lines = outputTail.split(/\r?\n/);
  const patterns = [
    /^\s*(FAIL|✗|✖|not ok)\b.*/i,
    /AssertionError.*/,
    /error TS\d+:.*/,
  ];
  for (const pattern of patterns) {
    const hit = lines.find((l) => pattern.test(l));
    if (hit) return hit.trim();
  }
  return undefined;
}
