# 3cc3b726 — a tool's correlation-queue key must be the FULL qualified `mcp__<server>__<tool>` name, never bare

## Narrative

Card 3cc3b726: `toolName` passed into `consumeToolAttribution`/`ToolAttributionTracker` must be the FULL qualified `mcp__<server>__<tool>` form, matching what `deliverHook`'s `PreToolUse` case records it under — never the bare tool name. Two different MCP routers can register a tool sharing the same BARE name (`memory_write`: loom-tasks' project memory vs. loom-orchestration's companion-private memory), and a companion session mounts BOTH routers on the SAME sessionId — a bare-name key would let one router's call destructively consume the other's pending correlation entry.

`gateway/server.ts`'s `computeAttributions` reconstructs this qualified form itself, from the SAME `LOOM_TASKS_SERVER_ID`/`LOOM_ORCHESTRATION_SERVER_ID` constants (`tool-attribution.ts`) that `pty/host.ts`'s own `buildMcpServers` mints the client's servers under — never pass a bare name here. Don't take a comment's word that the two sides agree: `test/tool-attribution-join.mjs` drives a real `PreToolUse` hook through `deliverHook` and then consumes through the REAL `/mcp/:sessionId` HTTP route (so `gateway/server.ts`'s own reconstruction is what actually runs), with a mismatched-server-id negative control — that test is what pins the join.

## Do not

- Do not key the correlation queue by a tool's bare name — reconstruct the full `mcp__<server>__<tool>` form from the same server-id constants both sides share.
- Do not trust that the hook-recording side and the MCP-consuming side agree just because a comment says so — `test/tool-attribution-join.mjs` (with its mismatched-server-id negative control) is what actually pins it.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`consumeToolAttribution`'s JSDoc), as of `main` `952cca04`. Extracted by card `819edb48` (tranche 27 on `pty/host.ts`). Closely overlapping content already exists at `docs/decisions/cd0c7fee-attribution-map-single-consume-per-request.md` (same card, cited from `gateway/server.ts`'s `computeAttributions`) — that file predates this one and duplicates part of this narrative from a different site; a future tranche should consider folding the two rather than maintaining both.
