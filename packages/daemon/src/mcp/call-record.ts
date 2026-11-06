import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Per-call MCP latency + outcome class, recorded where the ANSWERING router's tool handler runs.
 *
 * @decision 8ef582d0 — identity/shape only: never arguments, results or error text in the store or any log
 * line; read only via the human loopback REST route, never an agent tool.
 *
 * Recorded fields: session id, router, tool name, start, duration, outcome class and a bounded `errClass`
 * label (the log-content ruling is the one the inbound `[mcp]` census already follows).
 *
 * `instrumentServer` wraps `server.registerTool` once per router `buildServer`; the registration
 * (name, config/description/inputSchema/annotations) is passed through untouched, only the callback is
 * wrapped. The stamp is two clock reads and one bounded array push; it never blocks and never throws into
 * the call path. Rows are flushed in batches off the call path.
 *
 * ⚠️ `outcome:"refused"` means exactly "the tool returned a top-level `{error}` envelope". Today that
 * includes some GENUINE errors that happen to be reported via the same envelope (a failed lookup, a
 * validation failure), not only deliberate guard refusals — do not read it as "the policy said no".
 * `outcome:"error"` means the handler threw or returned `isError:true`. SDK-level failures that never reach
 * a handler (input-schema rejection, unknown tool) have no transport hook here and are NOT recorded.
 */

export type McpCallOutcome = "ok" | "refused" | "error";
/** Bounded label vocabulary — never free text. */
export type McpErrClass = "envelope" | "throw" | "is-error";

export interface McpCallRecord {
  sessionId: string;
  router: string;
  tool: string;
  startedAt: number;
  durationMs: number;
  outcome: McpCallOutcome;
  errClass: McpErrClass | null;
}

/** Max rows held in memory between flushes; beyond it new records are dropped and counted. */
export const MCP_CALL_BUFFER_MAX = 2000;
/** Newest rows kept per session in the store. */
export const MCP_CALL_PER_SESSION_CAP = 500;
/** Rows older than this are pruned. */
export const MCP_CALL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 2000;
const PRUNE_EVERY_FLUSHES = 1800; // ~hourly at the flush cadence

// `{"error":` at the start of the first text block, tolerating leading whitespace. Only a 64-char prefix is
// ever examined, so the check stays O(1) regardless of result size and needs no JSON.parse.
const ERROR_ENVELOPE_PREFIX = /^\s*\{\s*"error"\s*:/;

/** Classify a tool handler's RETURN value. Never throws; anything unrecognised is "ok". */
export function classifyToolResult(result: unknown): { outcome: McpCallOutcome; errClass: McpErrClass | null } {
  try {
    if (result === null || typeof result !== "object") return { outcome: "ok", errClass: null };
    const r = result as { isError?: unknown; content?: unknown };
    if (r.isError === true) return { outcome: "error", errClass: "is-error" };
    if (Array.isArray(r.content)) {
      const first = r.content[0] as { type?: unknown; text?: unknown } | undefined;
      if (first && first.type === "text" && typeof first.text === "string" && ERROR_ENVELOPE_PREFIX.test(first.text.slice(0, 64))) {
        return { outcome: "refused", errClass: "envelope" };
      }
    }
  } catch { /* classification must never break the call */ }
  return { outcome: "ok", errClass: null };
}

// --- recorder (module singleton, so no router constructor / GatewayDeps change) ---
let buffer: McpCallRecord[] = [];
let writer: ((rows: McpCallRecord[]) => void) | null = null;
let pruner: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let dropped = 0;
let writeFailures = 0;
let flushCount = 0;

/** Record one finished call. O(1); a no-op until the recorder is started; never throws. */
export function recordMcpCall(rec: McpCallRecord): void {
  if (!writer) return;
  if (buffer.length >= MCP_CALL_BUFFER_MAX) { dropped++; return; }
  buffer.push(rec);
}

/** Best-effort synchronous flush. A write failure is swallowed, counted, and the batch discarded. */
export function flushMcpCalls(): void {
  if (!writer || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try { writer(batch); } catch { writeFailures++; }
}

export function mcpCallStats(): { dropped: number; writeFailures: number; buffered: number } {
  return { dropped, writeFailures, buffered: buffer.length };
}

/** Start flushing to `write`. `prune` (optional) runs once now and then ~hourly. Returns a stop that flushes. */
export function startMcpCallRecorder(write: (rows: McpCallRecord[]) => void, prune?: () => void): { stop: () => void } {
  stopMcpCallRecorder();
  writer = write;
  pruner = prune ?? null;
  const runPrune = (): void => { try { pruner?.(); } catch { writeFailures++; } };
  runPrune();
  timer = setInterval(() => {
    flushMcpCalls();
    if (++flushCount % PRUNE_EVERY_FLUSHES === 0) runPrune();
  }, FLUSH_INTERVAL_MS);
  timer.unref?.();
  return { stop: stopMcpCallRecorder };
}

/** Final best-effort flush, then detach. Safe to call repeatedly. */
export function stopMcpCallRecorder(): void {
  if (timer) { clearInterval(timer); timer = null; }
  flushMcpCalls();
  writer = null;
  pruner = null;
  buffer = [];
  dropped = 0;
  writeFailures = 0;
  flushCount = 0;
}

/**
 * Wrap every tool the router registers on `server` so its handler is timed and its outcome classified.
 * Call once, right after `new McpServer(...)`, before any registration. The registration args pass through
 * UNCHANGED; only the callback is wrapped.
 */
export function instrumentServer(server: McpServer, ctx: { router: string; sessionId: string | undefined }): void {
  const s = server as unknown as { registerTool: (name: string, config: unknown, cb: (...a: unknown[]) => unknown) => unknown };
  const orig = s.registerTool.bind(server);
  s.registerTool = (name: string, config: unknown, cb: (...a: unknown[]) => unknown) => {
    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      const startedAt = Date.now();
      const t0 = performance.now();
      let outcome: McpCallOutcome = "ok";
      let errClass: McpErrClass | null = null;
      try {
        const result = await cb(...args);
        ({ outcome, errClass } = classifyToolResult(result));
        return result;
      } catch (e) {
        outcome = "error"; errClass = "throw";
        throw e;
      } finally {
        try {
          if (ctx.sessionId !== undefined) recordMcpCall({ sessionId: ctx.sessionId, router: ctx.router, tool: name, startedAt, durationMs: performance.now() - t0, outcome, errClass });
        } catch { /* recording must never reach the call path */ }
      }
    };
    return orig(name, config, wrapped);
  };
}
