# bcef7e48 — the per-call MCP log carries the sub-agent attribution that already exists, and nothing more

Extends `8ef582d0-mcp-call-log.md`. Code: `mcp/call-record.ts` (`instrumentServer` ctx `attributions`), `mcp_call_log.attribution/agent_id/agent_type` (`db.ts` `migrateMcpCallLog`), REST `GET /api/sessions/:id/mcp-calls`.

## What it records

`attribution` is the `ToolAttributionState` the gateway already computed for that request (`computeAttributions`, `gateway/server.ts`), read with a plain `get` from the map `handle()` threads into `buildServer`. `agentId`/`agentType` are set only for `confirmed-subagent`. Only the loom-tasks and loom-orchestration routers compute it, and only for the `WATCHED_TOOLS` write/action set, so every other row is `attribution: null`.

## Do not

- Do not render `null`, `unknown` or `ambiguous` as "session". `null` means NOT TRACKED (unwatched tool, or a router that never computes attribution); `unknown`/`ambiguous` mean the correlation could not decide. Only `confirmed-main` may ever be presented as "session" (cd0c7fee, aed28554: even that is "consistent with", a main-turn call can land in a live sub-agent window). Any UI built on this route inherits this rule.
- Do not call `consumeToolAttribution` (or `ToolAttributionTracker.consume`) from the recorder or any router: the gateway consumes once per request and a second consume reads "unknown" (cd0c7fee). The recorder only reads the map it was handed.
- Do not widen `WATCHED_TOOLS`/the PreToolUse matcher to get attribution on more rows: that is a synchronous hook process per MCP call fleet-wide (d15c9f36). The owner declined it for this card.
- Do not add the three columns to the base `CREATE TABLE`, or an index on them to the base SCHEMA. They are added by `migrateMcpCallLog()` after `exec(SCHEMA)`, so a fresh and an upgraded DB converge and an already-upgraded DB never hits a "no such column" at boot.
- Do not store anything beyond the bounded state and the hook-supplied `agent_id`/`agent_type` (same identity/shape-only rule as 8ef582d0).

## Known shape

A batched JSON-RPC body with two calls to the same watched tool shares one map entry (the map is keyed by bare tool name), so both rows carry the same attribution. loom-orchestration's companion-private `memory_write` shares a bare name with the loom-tasks one but the hook matcher only matches the loom-tasks key, so its rows read `unknown`.
