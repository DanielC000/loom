// A codex session's Loom MCP calls, read from the daemon's per-call record (GET /api/sessions/:id/mcp-calls,
// table mcp_call_log, card 8ef582d0) instead of the transcript. Codex transcripts carry no tool-call lines
// (daemon pty/codex-transcript.ts keeps messages only), so the record is the one source that has them.
// Pure functions, pinned by test/mcp-call-record.mjs.
//
// @decision d4d3481e — the record holds identity and shape only (router, tool, start, duration, outcome
// class), never arguments or answers, and has no turns. Map what it carries and leave the rest absent;
// never invent args, an answer, a turn number or a cause for a recorded call.
import type { McpCall, McpOutcome, McpSentence } from "./mcpActivity";
import { sentenceOf, subsystemOf } from "./mcpActivity";

/** One row as the route serves it (daemon db.ts listMcpCalls), newest first. */
export interface McpCallRecordRow {
  id: number;
  router: string;
  tool: string;
  startedAt: number;
  durationMs: number | null;
  outcome: string;
  errClass: string | null;
  attribution?: string | null;
  agentId?: string | null;
  agentType?: string | null;
}

export interface McpCallRecordPage { calls: McpCallRecordRow[]; dropped: number; writeFailures: number }

/** Rows the strip asks for: the store keeps the newest 500 per session (MCP_CALL_PER_SESSION_CAP). */
export const MCP_RECORD_LIMIT = 500;

/** Which source a session's strip reads. Only codex reads the record; every other harness the transcript. */
export type McpSource = "transcript" | "record";
export const mcpSourceFor = (harness: string | null | undefined): McpSource => (harness === "codex" ? "record" : "transcript");

const OUTCOMES: ReadonlySet<string> = new Set(["ok", "refused", "error"]);

/**
 * Record rows to McpCalls, oldest first. Every call sits in turn 0 (the record has no turns), with no tag,
 * no args and no answer. A recorded call has always finished, so none is pending. An outcome outside the
 * record's vocabulary reads ok, as the daemon's own classifier treats anything unrecognised.
 */
export function recordToMcpCalls(rows: readonly McpCallRecordRow[]): McpCall[] {
  return [...rows]
    .sort((a, b) => a.id - b.id)
    .map((r, i): McpCall => ({
      seq: i + 1,
      tag: null,
      turn: 0,
      router: r.router,
      tool: r.tool,
      args: {},
      outcome: (OUTCOMES.has(r.outcome) ? r.outcome : "ok") as McpOutcome,
      result: null,
      subsystem: subsystemOf(r.tool),
      at: typeof r.startedAt === "number" && Number.isFinite(r.startedAt) && r.startedAt > 0 ? new Date(r.startedAt).toISOString() : null,
      ms: typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs >= 0 ? r.durationMs : null,
    }));
}

/** A lead that stops on a preposition is waiting for an object the record does not carry. */
const DANGLING = /\b(?:for|onto|to|on|of|in)$/;

/**
 * The sentence for a recorded call: the transcript sentence with no object. Where that leaves the lead
 * hanging ("Looked up decisions for"), it reads as the bare tool name instead ("Ran decisions_for").
 */
export function recordSentenceOf(call: McpCall): McpSentence {
  const s = sentenceOf(call);
  if (s.object || s.tail || !DANGLING.test(s.lead)) return s;
  const failed = call.outcome === "error" || call.outcome === "refused";
  return { lead: failed ? "Tried to run" : "Ran", object: call.tool, tail: "" };
}

export const RECORD_DURATION_HINT = "Measured by Loom's router: the tool handler's own time, from start to return.";
export const RECORD_REFUSED_HINT = "The tool returned an error envelope (a top-level error field). Some of these are real errors, not only refusals.";
export const RECORD_SPAN_HINT = "Time from the first recorded call's start to the last one's return.";
export const RECORD_NOT_KEPT = "Arguments and answer aren't recorded for codex calls.";
export const RECORD_GROUP_LABEL = "All calls · codex records no turns";

/**
 * The record query's options. Disabled for every non-codex session, so a claude session never fetches
 * the record; its strip keeps reading the shared transcript query alone.
 */
export function mcpRecordQuery(
  sessionId: string,
  harness: string | null | undefined,
  fetchCalls: (sessionId: string, signal?: AbortSignal) => Promise<McpCallRecordPage>,
  refetchInterval: number | false,
) {
  return {
    queryKey: ["mcp-calls", sessionId] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetchCalls(sessionId, signal),
    enabled: mcpSourceFor(harness) === "record",
    refetchInterval,
  };
}
