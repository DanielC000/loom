// A session's calls into Loom's own MCP routers, parsed back out of the text GET
// /api/sessions/:id/transcript already serves (daemon `pty/claude-transcript.ts` `extractText`):
//   [tool] {<tag>} mcp__loom-<router>__<tool>(<JSON args>)   and   -> tool result {<tag>} (error): <body>
// Pure functions of the transcript, pinned by test/mcp-activity.mjs.
//
// @decision a9a7140c — never show a call time or duration: the transcript carries neither. `ok` /
// `error` (the transport's isError) / `pending` (no result yet) are facts; `refused` is a labelled
// heuristic read from the result body (classifyResult, card 825e38da), never a fact.
import type { TranscriptTurn } from "./api";

export type McpSubsystem = "board" | "fleet" | "gate" | "memory" | "inbox" | "self";
export type McpOutcome = "ok" | "refused" | "error" | "pending";

export interface McpLink { kind: "card" | "worker" | "gate" | "note" | "request"; id: string }

export interface McpCall {
  /** Position in the session, 1-based. Stable for a given transcript prefix, so it doubles as a key. */
  seq: number;
  /** The engine's call/result correlation tag (last 8 chars of the tool_use id), or null when absent. */
  tag: string | null;
  /** Agent turn: the count of user-role turns (human or Loom-injected) seen before this call. */
  turn: number;
  router: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: McpOutcome;
  /** The result body as the transcript holds it (already capped at 2 KB by the daemon), or null. */
  result: string | null;
  subsystem: McpSubsystem;
}

export interface McpTurn { turn: number; calls: McpCall[] }

const CALL_LINE = /^\[tool\](?: \{([^}]*)\})? mcp__loom-([a-z0-9-]+)__([A-Za-z0-9_]+)\((.*)\)$/;
const RESULT_HEAD = /^-> tool result(?: \{([^}]*)\})?( \(error\))?(?:: ([\s\S]*))?$/;

/** Parse every Loom MCP call out of a transcript, oldest first, each paired with its result. */
export function parseMcpCalls(turns: readonly TranscriptTurn[]): McpCall[] {
  const calls: McpCall[] = [];
  const openByTag = new Map<string, McpCall>();
  let turn = 0;
  for (const t of turns) {
    if (t.role === "user") { turn++; continue; }
    if (t.role === "assistant") {
      for (const line of t.text.split("\n")) {
        const m = CALL_LINE.exec(line);
        if (!m) continue;
        // The daemon writes the args with JSON.stringify, so a line that does not parse is prose that
        // happens to look like a call marker, not a call.
        let args: unknown;
        try { args = JSON.parse(m[4]!); } catch { continue; }
        const tool = m[3]!;
        const call: McpCall = {
          seq: calls.length + 1,
          tag: m[1] || null,
          turn,
          router: `loom-${m[2]}`,
          tool,
          args: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
          outcome: "pending",
          result: null,
          subsystem: subsystemOf(tool),
        };
        calls.push(call);
        if (call.tag) openByTag.set(call.tag, call);
      }
      continue;
    }
    if (t.role === "tool_result") {
      for (const seg of splitResults(t.text)) {
        const call = seg.tag ? openByTag.get(seg.tag) : undefined;
        if (!call) continue; // a non-Loom tool's result, or an untagged one we cannot pair
        openByTag.delete(seg.tag!);
        call.outcome = classifyResult(seg.body, seg.error);
        call.result = seg.body;
      }
    }
  }
  return calls;
}

// ── Refused: a heuristic over the result body ───────────────────────────────────────────────────
// Many Loom refusals (concurrency cap, stale memory baseVersion, guard refusals) come back as a
// SUCCESSFUL result whose body is `{"error": …}`. Only isError is a transport fact, so "refused" is a
// guess from the body and the UI labels it as one (REFUSED_HINT).

/** The daemon's cap marker on a tool result body (pty/claude-transcript.ts, TOOL_RESULT_BODY_CAP). */
const TRUNCATED_TAIL = /\.\.\. \[\+\d+ chars truncated\]$/;

export const REFUSED_HINT = "A guess, not a fact: the call succeeded, but its answer carried a top-level error field.";
export const UNCLASSIFIED_HINT = "Answer cut at 2 KB, so it could not be read for an error field. Shown as ok.";

/**
 * A result's outcome. isError → "error" (the transport said so). Otherwise "refused" only when the
 * WHOLE body parses as a JSON object with a non-null top-level `error`; anything else (an array, a
 * string, plain text, a body cut at the cap) stays "ok".
 */
export function classifyResult(body: string | null, isError: boolean): McpOutcome {
  if (isError) return "error";
  if (body == null) return "ok";
  let v: unknown;
  try { v = JSON.parse(body); } catch { return "ok"; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return "ok";
  const err = (v as Record<string, unknown>).error;
  return err != null && err !== false ? "refused" : "ok";
}

/** An ok call whose body was cut at the cap: we could not look for an error field, so it is a guess too. */
export const isUnclassified = (call: McpCall): boolean =>
  call.outcome === "ok" && call.result != null && TRUNCATED_TAIL.test(call.result);

/** One tool_result turn can hold several results; each starts on its own "-> tool result" line. */
function splitResults(text: string): Array<{ tag: string | null; error: boolean; body: string }> {
  const out: Array<{ tag: string | null; error: boolean; lines: string[] }> = [];
  for (const line of text.split("\n")) {
    const m = line.startsWith("-> tool result") ? RESULT_HEAD.exec(line) : null;
    if (m) out.push({ tag: m[1] || null, error: !!m[2], lines: m[3] != null ? [m[3]] : [] });
    else if (out.length) out[out.length - 1]!.lines.push(line);
  }
  return out.map((r) => ({ tag: r.tag, error: r.error, body: r.lines.join("\n") }));
}

/** Calls grouped by agent turn, newest turn first, newest call first within a turn. */
export function groupByTurn(calls: readonly McpCall[]): McpTurn[] {
  const byTurn = new Map<number, McpCall[]>();
  for (const c of calls) {
    const list = byTurn.get(c.turn);
    if (list) list.push(c); else byTurn.set(c.turn, [c]);
  }
  return [...byTurn.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([turn, cs]) => ({ turn, calls: [...cs].reverse() }));
}

// ── Where a call went ───────────────────────────────────────────────────────────────────────────
export const SUBSYSTEMS: ReadonlyArray<{ key: McpSubsystem; label: string }> = [
  { key: "board", label: "Board" },
  { key: "fleet", label: "Fleet" },
  { key: "gate", label: "Gate" },
  { key: "memory", label: "Memory" },
  { key: "inbox", label: "Inbox" },
  { key: "self", label: "Self" },
];

export function subsystemOf(tool: string): McpSubsystem {
  if (tool.startsWith("tasks_")) return "board";
  if (tool === "worker_merge" || tool === "worker_merge_confirm" || tool === "merge_batch"
    || tool.startsWith("gate_") || tool === "run_gate") return "gate";
  if (tool.startsWith("worker_")) return "fleet";
  if (tool.startsWith("memory_") || tool === "decisions_for") return "memory";
  if (tool === "question_ask" || tool.startsWith("task_request")) return "inbox";
  return "self";
}

// ── What a call touched ─────────────────────────────────────────────────────────────────────────
const LINK_KEYS: ReadonlyArray<[string, McpLink["kind"]]> = [
  ["id", "card"], ["taskId", "card"], ["toTaskId", "card"], ["parentId", "card"],
  ["sessionId", "worker"], ["workerId", "worker"],
  ["opId", "gate"],
  ["key", "note"],
  ["requestId", "request"],
];

/** Ids a call names in its arguments: the cards, workers, gate ops, notes and requests it touched. */
export function linksOf(call: McpCall): McpLink[] {
  const out: McpLink[] = [];
  const seen = new Set<string>();
  for (const [k, kind] of LINK_KEYS) {
    const v = call.args[k];
    if (typeof v !== "string" || !v) continue;
    const id = kind === "note" ? v : shortId(v);
    const dedupe = `${kind}:${id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ kind, id });
  }
  return out;
}

// ── The plain sentence ──────────────────────────────────────────────────────────────────────────
/** A sentence in three parts so the UI can set the object (an id, a key) in mono. Plain text only. */
export interface McpSentence { lead: string; object: string; tail: string }

const shortId = (v: unknown): string => {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(s) ? s.slice(0, 8) : s;
};
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const quoted = (v: unknown, max = 48): string => {
  const s = str(v).replace(/\s+/g, " ").trim();
  if (!s) return "";
  return `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`;
};
/** A board column key as a reader would say it: "in_progress" → "In progress". */
export function columnLabel(key: string): string {
  const s = key.replace(/[_-]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : key;
}

/** [past tense, infinitive, object, tail] — the infinitive is what an error or an unanswered call reads as. */
type Phrase = [string, string, string, string];

function phrase(call: McpCall): Phrase {
  const a = call.args;
  const id = shortId(a.id ?? a.taskId);
  const worker = shortId(a.sessionId ?? a.workerId);
  switch (call.tool) {
    case "tasks_update":
      if (str(a.columnKey)) return ["Moved card", "move card", id, `to ${columnLabel(str(a.columnKey))}`];
      if (a.held === true) return ["Held card", "hold card", id, ""];
      if (a.held === false) return ["Released card", "release card", id, ""];
      if (str(a.appendBody)) return ["Added a note to card", "add a note to card", id, ""];
      return ["Updated card", "update card", id, ""];
    case "tasks_get": return ["Read card", "read card", id, ""];
    case "tasks_list":
      return ["Listed the board", "list the board", "", str(a.columnKey) ? `· ${columnLabel(str(a.columnKey))}` : ""];
    case "tasks_create": return ["Filed a new card", "file a new card", "", quoted(a.title)];
    case "tasks_defer_item": return ["Deferred an item onto card", "defer an item onto card", shortId(a.toTaskId), ""];
    case "tasks_defer_item_ack": return ["Answered a deferred item on card", "answer a deferred item on card", id, ""];
    case "task_requests_list": return ["Read the requests on card", "read the requests on card", id, ""];
    case "task_request_get": return ["Read request", "read request", shortId(a.requestId ?? a.id), ""];
    case "question_ask": return ["Asked the owner", "ask the owner", "", quoted(a.title ?? a.question)];
    case "worker_spawn": return ["Spawned a worker for card", "spawn a worker for card", id, ""];
    case "worker_status": return ["Checked worker", "check worker", worker, ""];
    case "worker_list": return ["Listed the fleet", "list the fleet", "", ""];
    case "worker_message": return ["Messaged worker", "message worker", worker, ""];
    case "worker_redirect": return ["Redirected worker", "redirect worker", worker, ""];
    case "worker_stop": return ["Stopped worker", "stop worker", worker, ""];
    case "worker_recycle": return ["Recycled worker", "recycle worker", worker, ""];
    case "worker_flush": return ["Flushed worker", "flush worker", worker, ""];
    case "worker_report":
      return ["Reported", "report", str(a.status), ""];
    case "worker_merge": return ["Reviewed the diff of worker", "review the diff of worker", worker, ""];
    case "worker_merge_confirm": return ["Queued a merge for worker", "queue a merge for worker", worker, ""];
    case "merge_batch": return ["Queued a batch merge", "queue a batch merge", "", ""];
    case "run_gate": return ["Ran the gate", "run the gate", "", ""];
    case "gate_queue": return ["Read the gate queue", "read the gate queue", "", ""];
    case "gate_status": return ["Checked gate op", "check gate op", str(a.opId), ""];
    case "gate_cancel": return ["Cancelled gate op", "cancel gate op", str(a.opId), ""];
    case "memory_read": return ["Read memory note", "read memory note", str(a.key), ""];
    case "memory_write": return ["Wrote memory note", "write memory note", str(a.key), ""];
    case "memory_list":
      return str(a.query) ? ["Searched memory for", "search memory for", `"${str(a.query)}"`, ""]
        : ["Listed memory", "list memory", "", ""];
    case "memory_history": return ["Read the history of note", "read the history of note", str(a.key), ""];
    case "memory_forget": return ["Forgot memory note", "forget memory note", str(a.key), ""];
    case "decisions_for": return ["Looked up decisions for", "look up decisions for", str(a.path ?? a.id), ""];
    case "my_context": return ["Checked its own context", "check its own context", "", ""];
    case "directive_status": return ["Checked its delivery history", "check its delivery history", "", ""];
    case "idle_report": return ["Reported idle", "report idle", str(a.state), ""];
    case "wake_me": {
      const mins = str(a.minutes);
      return ["Scheduled a wake", "schedule a wake", mins ? `in ${mins}m` : "", ""];
    }
    case "wake_cancel": return ["Cancelled a wake", "cancel a wake", "", ""];
    case "wake_list": return ["Listed its wakes", "list its wakes", "", ""];
    case "recycle_me": return ["Asked to be recycled", "ask to be recycled", "", ""];
    case "daemon_restart": return ["Restarted the daemon", "restart the daemon", "", ""];
    default: return ["Called", "call", call.tool, ""];
  }
}

/** The call as a sentence. An error or a refusal reads "Tried to …", an unanswered call "Asking Loom to …". */
export function sentenceOf(call: McpCall): McpSentence {
  const [past, inf, object, tail] = phrase(call);
  const lead = call.outcome === "error" || call.outcome === "refused" ? `Tried to ${inf}`
    : call.outcome === "pending" ? `Asking Loom to ${inf}`
    : past;
  return { lead, object, tail };
}

export const sentenceText = (call: McpCall): string => {
  const s = sentenceOf(call);
  return [s.lead, s.object, s.tail].filter(Boolean).join(" ");
};

// ── Filtering ───────────────────────────────────────────────────────────────────────────────────
export interface McpFilter {
  subsystems: ReadonlySet<McpSubsystem>;
  outcomes: ReadonlySet<McpOutcome>;
  tool: string;
  router: string;
  query: string;
}

export const emptyFilter = (): McpFilter =>
  ({ subsystems: new Set(), outcomes: new Set(), tool: "", router: "", query: "" });

export const filterActive = (f: McpFilter): boolean =>
  f.subsystems.size > 0 || f.outcomes.size > 0 || !!f.tool || !!f.router || !!f.query.trim();

export function applyFilter(calls: readonly McpCall[], f: McpFilter): McpCall[] {
  const q = f.query.trim().toLowerCase();
  return calls.filter((c) =>
    (!f.subsystems.size || f.subsystems.has(c.subsystem))
    && (!f.outcomes.size || f.outcomes.has(c.outcome))
    && (!f.tool || c.tool === f.tool)
    && (!f.router || c.router === f.router)
    && (!q || `${c.tool} ${JSON.stringify(c.args)} ${sentenceText(c)}`.toLowerCase().includes(q)));
}

// ── How often the strip polls ───────────────────────────────────────────────────────────────────
// Each poll fetches only the transcript tail (lib/transcriptTail.ts), but a rotated or shrunk transcript
// falls back to the whole thing, so the strip still polls as little as it can.
export const MCP_POLL_ACTIVE_MS = 5_000;
export const MCP_POLL_IDLE_MS = 15_000;

export interface McpPollState {
  /** document.hidden: the browser tab is in the background. */
  hidden: boolean;
  expanded: boolean;
  busy: boolean;
}

/**
 * The strip's refetchInterval (false = no timer). It shares the Transcript tab's query key on purpose:
 * react-query re-arms EVERY observer's interval after each fetch of a key (QueryObserver.onQueryUpdate),
 * so observers on one key poll together at the shortest interval and never double-fetch. A separate
 * key would give the same URL two independent timers.
 */
export function mcpPollInterval(s: McpPollState): number | false {
  if (s.hidden) return false;
  return s.expanded || s.busy ? MCP_POLL_ACTIVE_MS : MCP_POLL_IDLE_MS;
}

/** Count of calls per value of `key`, most frequent first (ties alphabetical). */
export function tally<K extends "tool" | "router" | "subsystem" | "outcome">(
  calls: readonly McpCall[], key: K,
): Array<[McpCall[K], number]> {
  const m = new Map<McpCall[K], number>();
  for (const c of calls) m.set(c[key], (m.get(c[key]) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}
