/**
 * Time-bounded matching of OWNER-authored regexes against AGENT-controlled command text, for `ssh_exec`.
 *
 * The connection store only checks that an owner regex COMPILES, so a catastrophic-backtracking pattern
 * (`^(a+)+$`) is accepted and would pin the daemon's event loop if tested in-process. Every rule for one
 * call is therefore evaluated in ONE short-lived worker thread under ONE total budget, and the worker is
 * `terminate()`d on overrun — the caller then fails CLOSED (refuses the command). No new dependency, no
 * linear-time engine: this bounds the damage rather than changing the matching semantics.
 */
import { Worker } from "node:worker_threads";

/** Total matching budget for ALL rules of one call (the clock starts once the worker is online, so thread
 *  start-up latency under host load never spends it). */
export const SSH_REGEX_BUDGET_MS = 250;
/** Hard ceiling on worker start-up itself; past it the call fails closed as a timeout too. */
const WORKER_STARTUP_CEILING_MS = 5000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const out = [];
for (const p of workerData.patterns) {
  try { out.push(new RegExp(p).test(workerData.command)); } catch { out.push(null); }
}
parentPort.postMessage(out);
`;

/** Per-pattern result: true/false = matched or not, null = the pattern did not compile. */
export type BoundedRegexResult =
  | { ok: true; results: Array<boolean | null> }
  | { ok: false; reason: "timeout" | "error" | "busy" };

/** At most this many regex workers exist daemon-wide; further calls queue (the per-call budget only starts
 *  once a call is actually running), so parallel ssh_exec calls cannot spawn unbounded threads. */
export const SSH_REGEX_MAX_CONCURRENT_WORKERS = 2;
/**
 * Longest wait queue tolerated; a caller arriving past it is refused at once (fail closed, never queued).
 * 8 waiters on 2 workers is about 4 rounds of the 250 ms budget, so the worst benign wait stays near 1 s
 * instead of growing with an attacker's concurrency (measured unbounded: 38 waiters ⇒ 6.6 s for an
 * unrelated call).
 * @decision ede5177a — keep the queue bounded; never turn an over-cap caller into a waiter.
 */
export const SSH_REGEX_MAX_QUEUED_WAITERS = 8;
let activeWorkers = 0;
let peakWorkers = 0;
const waiters: Array<() => void> = [];

/** false = queue full, caller must refuse. */
async function acquireSlot(): Promise<boolean> {
  if (activeWorkers < SSH_REGEX_MAX_CONCURRENT_WORKERS) {
    activeWorkers++;
    peakWorkers = Math.max(peakWorkers, activeWorkers);
    return true;
  }
  if (waiters.length >= SSH_REGEX_MAX_QUEUED_WAITERS) return false;
  await new Promise<void>((resolve) => waiters.push(resolve)); // slot is handed over without a decrement
  return true;
}
function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next();
  else activeWorkers--;
}
/** Observability for tests: current/peak live workers and the number of queued callers. */
export function getSshRegexWorkerStats(): { active: number; peak: number; queued: number } {
  return { active: activeWorkers, peak: peakWorkers, queued: waiters.length };
}

/**
 * Most queued+active regex entries ONE connection may hold at once. The global queue cap bounds latency;
 * this bounds availability, so one connection with a ReDoS-prone owner regex cannot fill the shared queue
 * and starve every other connection. An over-cap call is refused as "busy", never queued.
 * @decision ede5177a — per-connection cap; refusals are not charged to the connection's command budget.
 */
export const SSH_REGEX_MAX_PER_CONNECTION = 5;
const perConnection = new Map<string, number>();

export async function testRegexesBounded(
  patterns: string[],
  command: string,
  budgetMs: number = SSH_REGEX_BUDGET_MS,
  connectionKey?: string,
): Promise<BoundedRegexResult> {
  if (patterns.length === 0) return { ok: true, results: [] };
  if (connectionKey !== undefined) {
    const held = perConnection.get(connectionKey) ?? 0;
    if (held >= SSH_REGEX_MAX_PER_CONNECTION) return { ok: false, reason: "busy" };
    perConnection.set(connectionKey, held + 1);
  }
  try {
    if (!(await acquireSlot())) return { ok: false, reason: "busy" };
    try {
      return await runRegexWorker(patterns, command, budgetMs);
    } finally {
      releaseSlot();
    }
  } finally {
    // exactly one decrement per increment, on every exit (ok, timeout, error, busy-after-increment)
    if (connectionKey !== undefined) {
      const left = (perConnection.get(connectionKey) ?? 1) - 1;
      if (left <= 0) perConnection.delete(connectionKey);
      else perConnection.set(connectionKey, left);
    }
  }
}

/** Observability for tests: number of queued+active regex entries the given connection currently holds. */
export function getSshRegexConnectionCount(connectionKey: string): number {
  return perConnection.get(connectionKey) ?? 0;
}

function runRegexWorker(patterns: string[], command: string, budgetMs: number): Promise<BoundedRegexResult> {
  return new Promise<BoundedRegexResult>((resolve) => {
    let settled = false;
    let worker: Worker;
    let budgetTimer: NodeJS.Timeout | undefined;
    const done = (r: BoundedRegexResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      if (budgetTimer) clearTimeout(budgetTimer);
      // terminate() is what actually stops a runaway regex. Resolve only once it has settled, so the
      // concurrency slot is not handed on while the old thread is still winding down.
      const stopped = worker ? worker.terminate().catch(() => 0) : Promise.resolve(0);
      void stopped.then(() => resolve(r));
    };
    const startupTimer = setTimeout(() => done({ ok: false, reason: "timeout" }), WORKER_STARTUP_CEILING_MS);
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { patterns, command } });
    } catch {
      clearTimeout(startupTimer);
      resolve({ ok: false, reason: "error" });
      return;
    }
    worker.once("online", () => {
      clearTimeout(startupTimer);
      budgetTimer = setTimeout(() => done({ ok: false, reason: "timeout" }), budgetMs);
    });
    worker.once("message", (results: unknown) => {
      if (Array.isArray(results) && results.length === patterns.length) done({ ok: true, results: results as Array<boolean | null> });
      else done({ ok: false, reason: "error" });
    });
    worker.once("error", () => done({ ok: false, reason: "error" }));
    worker.once("exit", () => done({ ok: false, reason: "error" }));
  });
}
