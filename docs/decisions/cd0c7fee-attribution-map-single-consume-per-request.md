# cd0c7fee — tool-call attribution is computed at most once per (session, tool) per request

## Narrative

Cards `cd0c7fee`/`8d158088`: `computeAttributions` is shared by both MCP routes that can carry a watched tool — `worker_report` (orchestration-only) and `memory_write` (task-only) — because one helper is simpler than two near-duplicates. `consumeToolAttribution` (`pty/host.ts`) is DESTRUCTIVE/single-shot — this computes each watched tool's attribution AT MOST ONCE per request, into a `Map`, and that same `Map` is threaded to BOTH the `[mcp]` log line AND the router's `handle()` call, which passes it on to the enforcing tool handler (`mcp/server.ts` `memory_write`, `mcp/orchestration.ts` `worker_report`). Do NOT re-derive attribution a second time anywhere downstream — a second `consumeToolAttribution` call for the same (session, tool) always reads "unknown" (the entry is already gone), which would silently fail open FOREVER while looking fully operational.

`deps.pty.consumeToolAttribution` is optional-chained: several existing tests wire a minimal `{ markMcpSeen }`-only `deps.pty` stub, and a stub without the method stays a harmless no-op (empty `Map`) rather than a 500 — the real `PtyHost` always implements it.

Card `3cc3b726`: `server` is the route's own MCP server id (`LOOM_TASKS_SERVER_ID` / `LOOM_ORCHESTRATION_SERVER_ID` — the SAME constants `host.ts`'s `buildMcpServers` registers the client's servers under, one shared definition rather than two independently-typed literal lists) — used to reconstruct the FULL `mcp__<server>__<tool>` key that `consumeToolAttribution` expects. Two different routers can each register a tool with the same BARE name (`memory_write`: loom-tasks' project memory vs. loom-orchestration's companion-private memory), and a companion session mounts both routers on the SAME sessionId — a bare-name key let one router's call destructively consume the other's pending correlation entry. `test/tool-attribution-join.mjs` pins that this reconstruction actually agrees with what `deliverHook` records, across the two real routes, with a mismatched-server-id negative control. The returned `Map` stays keyed by the BARE tool name — every downstream reader is router-scoped by construction, so it never needs the qualifier.

## Do not

- Do not call `consumeToolAttribution` more than once for the same (session, tool) per request — the second call reads "unknown" and silently fails open, not loud.
- Do not key the attribution `Map` by anything other than the bare tool name reconstructed with the route's own server id — a bare-name-only key across two mounted routers lets one destructively consume the other's entry.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`computeAttributions`, lines 726-751 as of commit `a9b55042`). Relocated by card `c57868e5`; wording condensed, no substantive detail dropped.
