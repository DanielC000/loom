# 8d158088 — one shared parse of the MCP body computes attribution once per request

## Narrative

`extractWatchedToolCalls` (`pty/tool-attribution.ts`) is the enforcement half of card `cd0c7fee`: it parses the tool name(s) out of an inbound MCP JSON-RPC request body, restricted to a `watched` set. It mirrors `mcp/inbound-log.ts`'s own inline body-parsing exactly (a streamable-HTTP body may be a single request or a batch array) — pulled out here as ONE shared definition so `gateway/server.ts` can compute each watched tool's attribution ONCE per request and thread that SAME result to both the `[mcp]` log line and the tool handler that enforces it, instead of parsing the body a second, independently-driftable way. See card `cd0c7fee`'s own record for why a second, independent `consume()` call would silently read "unknown" forever (`consume()` is destructive/single-shot).

`method === "tools/call"` gated (card `e6ef5062` nitpick): a JSON-RPC request carrying `params.name` under some OTHER method would otherwise still be treated as a watched tool call and destructively consume a pending correlation entry. Not reachable today — the only client is Claude Code's own MCP transport, which always sends `tools/call` for a tool invocation — but the guard makes the intent exact rather than relying on that being true forever.

## Do not

- Do not parse the MCP request body a second, independent way anywhere downstream — `gateway/server.ts` computes it once via this function and threads the same result to both the log line and the enforcing handler.
- Do not drop the `method === "tools/call"` gate even though no client currently sends anything else — it keeps the intent exact rather than relying on that staying true forever.

## Source

Relocated from `packages/daemon/src/pty/tool-attribution.ts` (`extractWatchedToolCalls`'s doc comment) by the `tool-attribution.ts, tranche 1` extraction card. Cited in `pty/host.ts` too (not live at the time of this tranche) — a future `host.ts` extraction tranche adds its own section here rather than a second file for this id.
