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

/** Real, NON-BLOCKING runner for one gate step (`spawn`, not `spawnSync` — see the note below). Same
 *  `shell:true` / no-output-capture (`stdio:"ignore"`) / per-step timeout as the old single-shot
 *  `spawnSync` call this replaces. Injectable so a hermetic test can prove step-by-step + short-circuit
 *  behavior without spawning real processes. */
export interface GateStepRunner {
  (command: string, cwd: string, timeoutMs: number): Promise<{ status: number | null; error?: Error }>;
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
  const child = spawn(command, { cwd, shell: true, stdio: "ignore" });
  let settled = false;
  const done = (result: { status: number | null; error?: Error }) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve(result);
  };
  const timer = timeoutMs > 0
    ? setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } done({ status: null, error: new Error(`gate step exceeded ${timeoutMs}ms`) }); }, timeoutMs)
    : undefined;
  child.on("error", (e) => done({ status: null, error: e }));
  child.on("close", (code) => done({ status: code, error: undefined }));
});

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
): Promise<{ passed: boolean; failedStep?: string }> {
  for (const step of splitGateSteps(gate)) {
    const res = await runStep(step, cwd, timeoutMs);
    const passed = res.status === 0 && !res.error;
    if (!passed) return { passed: false, failedStep: step };
  }
  return { passed: true };
}
