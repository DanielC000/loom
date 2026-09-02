import { createHash } from "node:crypto";

/**
 * Card 98c4a651: MCP tool calls were the only inbound path with NO log trace at all — pty writes get
 * `[pty-write]` (byte-level), hooks get `[hook]`/`[submit]` (event-level), MCP got nothing. That silence
 * is what made a "was that `worker_report` delivered twice, or called twice?" question undecidable even
 * in principle. This is the fix: one `[mcp]` line per inbound MCP HTTP request, identity-only, matching
 * the existing `[hook]`/`[pty-write]` `tag sessionId key=value…` shape so the same log-census greps keep
 * working (`Grep '\[mcp\]' packages/daemon/src` / the daemon log).
 *
 * ⚠️ Card 16c93a50 (content-in-durable-logs policy) is still OPEN/unanswered as of this card — so this
 * logs identity and SHAPE only (tool name, args length, `shortHash` — a truncated SHA-1 COMMITMENT over
 * the args), never the tool arguments or message text themselves. If 16c93a50 settles a different policy
 * later, conform this to it.
 *
 * ⛔ `shortHash` is a commitment, NOT a secrecy mechanism — it is one-way, but brute-forceable by
 * enumeration over a low-entropy input (a small enum, a boolean, `{}`), especially combined with the
 * `tool=` name on the same line (e.g. `tool=idle_report` narrows the guesses to a handful of known
 * states). It is sufficient for its actual job — telling identical args from different args when
 * correlating a suspected duplicate call — but it does NOT make logging the arguments themselves safe,
 * and it is not a substitute for 16c93a50 settling.
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
 * ⭐ WHO READS THIS, AND WHEN (per project memory `shipping-a-detector-is-not-someone-reading-it`): the
 * Loom lead reads `[mcp]` lines in the daemon log WHEN ALREADY DIAGNOSING a suspected duplicate delivery
 * (e.g. a `worker_report` or `[loom:prompt-mismatch]` that appears to have arrived twice) — NOT on a
 * periodic check nobody will actually run. That diagnosis is exactly what this instrument exists to make
 * decidable: cross-reference the `[mcp]` census against the suspect event to tell "delivered twice" from
 * "called twice."
 *
 * Card cd0c7fee's `attribute` param piggybacks the sub-agent-call correlation state onto this SAME line
 * and SAME reader — no new surface, because there wasn't a reader for a new one. ⚠️ THIS IS STILL ONLY AN
 * OBSERVATION, not enforcement: nothing refuses a sub-agent's call yet. The honest state today is "the
 * Loom lead can see `attribution=confirmed-subagent` on this line if and when they go looking for a
 * specific incident" — there is no periodic reader and no alert. Per
 * `shipping-a-detector-is-not-someone-reading-it`: a card whose last step is an observation isn't closed
 * by merging this — the follow-up enforcement card is what turns this from visible-but-inert into acted-on.
 *
 * Card 2d8d2e42's `onRepeatedCall` param piggybacks a SECOND signal onto this SAME per-entry loop, for the
 * SAME reason `attribute` does: it needs the identical `argsHash` already computed here for the `[mcp]`
 * line, and adding a second, independent hash computation elsewhere would risk the two silently drifting.
 * Unlike `attribute` (which is scoped to `WATCHED_TOOL_NAMES`), this fires for EVERY tool call that carries
 * an `argsHash` — see `pty/repeated-call-tracker.ts`'s own doc for why the wider scope is deliberate and
 * costs nothing in false positives. This does NOT gate or refuse the call; it is advisory, same posture as
 * `attribute`.
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
