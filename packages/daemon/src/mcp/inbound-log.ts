import { createHash } from "node:crypto";

/**
 * @decision 98c4a651 — one `[mcp]` line per inbound MCP request, identity-only, matching the existing
 * `[hook]`/`[pty-write]` log shape (`Grep '\[mcp\]' packages/daemon/src` / the daemon log). Don't remove
 * as "redundant" — MCP calls were previously undecidable ("delivered twice" vs "called twice").
 *
 * Card 16c93a50 (content-in-durable-logs policy) is OPEN/unanswered — this logs identity/SHAPE only
 * (tool name, args length, `shortHash`), never the tool arguments or message text. Conform this to
 * 16c93a50 if/when it settles a different policy.
 *
 * ⛔ `shortHash` is a commitment, NOT a secrecy mechanism — one-way but brute-forceable over low-entropy
 * args (a small enum, a boolean, `{}`), esp. combined with the `tool=` name on the same line. It tells
 * identical args from different args; it does not make logging the args themselves safe.
 *
 * Called from gateway/server.ts, once per `/mcp*` route, BEFORE the request is handed to that router's
 * own `handle()` — mirrors the existing `deps.pty.markMcpSeen(sessionId)` call on `/mcp-orch`, which
 * records contact before dispatch for the same "count what arrived, not just what succeeded" reason.
 * One shared function so all routers (there are now EIGHT — /mcp, /mcp-orch, /mcp-platform, /mcp-setup,
 * plus /mcp-audit, /mcp-user-audit, /mcp-operator, /mcp-run added after this card was filed) log the
 * SAME shape from ONE definition, instead of four-plus independent, driftable call sites.
 *
 * Cheap by construction: no I/O beyond the one `console.log`, and the JSON.stringify of `arguments` (for
 * the length/hash) is bounded by whatever the MCP transport already parsed into memory for this request.
 *
 * `attribute` (@decision cd0c7fee) piggybacks sub-agent correlation (`attribution=confirmed-subagent`
 * etc.) onto this SAME line/reader — observation only; nothing enforces a sub-agent's call yet.
 *
 * `onRepeatedCall` (@decision 2d8d2e42) reuses this loop's already-computed `argsHash` rather than
 * recomputing it, and fires for EVERY tool call (wider than `attribute`'s `WATCHED_TOOL_NAMES` scope) —
 * advisory only, never gates the call.
 */

let mcpLogSeq = 0;

function shortHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 10);
}

interface JsonRpcRequestLike {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown };
}

/** Card cd0c7fee: the sub-agent-call correlation classification for one tool call — see tool-attribution.ts. */
interface ToolAttributionLike {
  state: string;
  agentId?: string;
  agentType?: string;
  candidateCount?: number;
}

/**
 * Logs ONE line per JSON-RPC request in `body` (a streamable-HTTP body may be a single request or a batch
 * array). `attribute` (card cd0c7fee) is an OPTIONAL per-entry callback — called with (sessionId, tool)
 * for each entry that names a real tool, letting a caller piggyback its own correlation lookup onto the
 * SAME line without this module knowing anything about PtyHost. Returning `undefined`/null appends
 * nothing (byte-identical line to before this param existed) — the default for every existing call site
 * that doesn't pass it.
 */
export function logInboundMcpRequest(
  router: string,
  sessionId: string,
  body: unknown,
  attribute?: (sessionId: string, tool: string) => ToolAttributionLike | null | undefined,
  onRepeatedCall?: (sessionId: string, tool: string, argsHash: string) => void,
): void {
  const at = new Date().toISOString();
  const entries = Array.isArray(body) ? body : [body];
  for (const entry of entries) {
    const seq = ++mcpLogSeq;
    const rpc = entry as JsonRpcRequestLike | undefined;
    const method = typeof rpc?.method === "string" ? rpc.method : "-";
    const tool = typeof rpc?.params?.name === "string" ? rpc.params.name : "-";
    const rpcId = rpc?.id === undefined || rpc?.id === null ? "-" : String(rpc.id);
    let shape = "";
    if (rpc?.params?.arguments !== undefined) {
      const argsText = JSON.stringify(rpc.params.arguments);
      const hash = shortHash(argsText);
      shape = ` argsLen=${argsText.length} argsHash=${hash}`;
      if (onRepeatedCall && tool !== "-") onRepeatedCall(sessionId, tool, hash);
    }
    let attribution = "";
    if (attribute && tool !== "-") {
      const result = attribute(sessionId, tool);
      if (result) {
        const who = result.agentId ? ` agentId=${result.agentId}${result.agentType ? ` agentType=${result.agentType}` : ""}` : "";
        const candidates = result.candidateCount !== undefined ? ` candidates=${result.candidateCount}` : "";
        attribution = ` attribution=${result.state}${who}${candidates}`;
      }
    }
    console.log(`[mcp] ${sessionId} router=${router} method=${method} tool=${tool} rpcId=${rpcId}${shape}${attribution} seq=${seq} at=${at}`);
  }
}
