import { spawn } from "node:child_process";

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

/** One gate step's outcome: exit code, spawn error (if any), the signal that killed it (if any — e.g. an
 *  OOM SIGKILL, or our own timeout-kill), whether OUR timeout bound was what killed it, and the bounded
 *  combined stdout+stderr tail. `signal`/`timedOut` are captured (not yet acted on) so a later change
 *  (card bcba83a1) can classify an OOM/SIGKILL kill distinctly from a genuine non-zero exit. */
export interface GateStepResult {
  status: number | null;
  error?: Error;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  outputTail?: string;
}

/** Real, NON-BLOCKING runner for one gate step (`spawn`, not `spawnSync` — see the note below). Same
 *  `shell:true` / per-step timeout as the old single-shot `spawnSync` call this replaces; UNLIKE that
 *  call (and unlike the old `stdio:"ignore"` version of this runner) it CAPTURES stdout+stderr into a
 *  bounded ring so a rejection can surface the REAL failure instead of an opaque "gate failed". Injectable
 *  so a hermetic test can prove step-by-step + short-circuit behavior without spawning real processes. */
export interface GateStepRunner {
  (command: string, cwd: string, timeoutMs: number): Promise<GateStepResult>;
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
const runGateStep: GateStepRunner = (command, cwd, timeoutMs) => new Promise((resolve) => {
  // Bounded capture ring: keep roughly the last OUTPUT_TAIL_BYTES, dropping whole chunks off the front
  // as newer ones arrive. The final tail() slices to exactly the cap. Same shape as python/venv.ts's
  // runAsync — captured (not ignored) so a rejection can surface the actual gate output.
  const chunks: Buffer[] = [];
  let bytes = 0;
  const capture = (b: Buffer): void => {
    chunks.push(b);
    bytes += b.length;
    while (bytes > OUTPUT_TAIL_BYTES && chunks.length > 1) bytes -= chunks.shift()!.length;
  };
  const tail = (): string => {
    const s = Buffer.concat(chunks).toString("utf-8").trim();
    return s.length > OUTPUT_TAIL_BYTES ? s.slice(-OUTPUT_TAIL_BYTES) : s;
  };
  const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let settled = false;
  const done = (result: Omit<GateStepResult, "outputTail">) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve({ ...result, outputTail: tail() });
  };
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        done({ status: null, error: new Error(`gate step exceeded ${timeoutMs}ms`), signal: "SIGKILL", timedOut: true });
      }, timeoutMs)
    : undefined;
  child.on("error", (e) => done({ status: null, error: e, signal: null, timedOut: false }));
  child.on("close", (code, signal) => done({ status: code, error: undefined, signal, timedOut: false }));
});

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
 */
export async function runGateSequential(
  gate: string, cwd: string, timeoutMs: number, runStep: GateStepRunner = runGateStep,
): Promise<GateSequentialResult> {
  for (const step of splitGateSteps(gate)) {
    const res = await runStep(step, cwd, timeoutMs);
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
