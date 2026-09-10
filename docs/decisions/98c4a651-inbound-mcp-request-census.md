# 98c4a651 — one `[mcp]` census line per inbound MCP request, identity-only

## Narrative

Before this card, MCP tool calls were the only inbound path with no log trace at all: pty writes
get `[pty-write]` (byte-level), hooks get `[hook]`/`[submit]` (event-level), MCP got nothing. That
silence made "was that `worker_report` delivered twice, or called twice?" undecidable even in
principle.

The fix (`packages/daemon/src/mcp/inbound-log.ts`, `logInboundMcpRequest`): one
`[mcp] <sessionId> router=... method=... tool=... rpcId=...` line per inbound MCP HTTP request,
matching the existing `[hook]`/`[pty-write]` `tag sessionId key=value…` shape so the same
log-census greps (`grep '\[mcp\]'`) keep working. Identity-only: no tool arguments or message text
(see card `16c93a50`, the content-in-durable-logs policy, on why).

Called from `gateway/server.ts`, once per `/mcp*` route, BEFORE the request reaches that router's
own `handle()` — mirrors the existing `deps.pty.markMcpSeen(sessionId)` call on `/mcp-orch`. One
shared function so every router (eight as of this writing: `/mcp`, `/mcp-orch`, `/mcp-platform`,
`/mcp-setup`, `/mcp-audit`, `/mcp-user-audit`, `/mcp-operator`, `/mcp-run`) logs the same shape
from one definition, instead of independent, driftable call sites.

## Who reads this, and when

Per project memory `shipping-a-detector-is-not-someone-reading-it`: the Loom lead reads `[mcp]`
lines in the daemon log WHEN ALREADY DIAGNOSING a suspected duplicate delivery (e.g. a
`worker_report` or `[loom:prompt-mismatch]` that appears to have arrived twice) — not on a
periodic check nobody will actually run. That diagnosis is exactly what this instrument exists to
make decidable: cross-reference the `[mcp]` census against the suspect event to tell "delivered
twice" from "called twice."

## Source

Inline comment in `packages/daemon/src/mcp/inbound-log.ts` (module header, lines 3-9 and 33-38 as
of commit `a9fa73d2`). Relocated by card `d6bd207b` (extraction tranche 1).
