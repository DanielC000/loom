# 8ef582d0 — per-call MCP latency and outcome class, recorded at the answering router

Code: `packages/daemon/src/mcp/call-record.ts`, table `mcp_call_log` (`db.ts`), REST `GET /api/sessions/:id/mcp-calls`.

## Shape

- `instrumentServer(server, {router, sessionId})` wraps `server.registerTool` once per router `buildServer` (8 routers). Registration args pass through untouched; only the callback is wrapped, so `tools/list` is unchanged.
- Outcome is decided from the handler's RETURN value, not response bytes: throw or `isError:true` is `error`; a first text block starting `{"error":` is `refused`; else `ok`. The check examines a 64-char prefix only (O(1), no parse).
- `refused` means "returned an `{error}` envelope". That includes some genuine errors; it is not a policy verdict.
- Rows are buffered in memory (bounded, drop-and-count on overflow) and flushed in batches; a write failure is swallowed and counted.
- Retention: newest 500 rows per session, 14-day age prune, and an explicit delete in `cascadeSessionForeignKeyChildren` (the table deliberately has no FK to `sessions`).
- Codex sessions hit the same `/mcp*` routes, so they are covered identically.

## Do not

- Do not store or log arguments, results or error text. Only the bounded `errClass` vocabulary.
- Do not add an agent MCP tool that reads this table; the read is human-only loopback REST, Tier 0 (not in `TIER_1_ROUTES`), which is stricter than the Tier-1 transcript route. Do not change the tier.
- Do not move the final flush out of index.ts's shared `flushVaultsAndStopCodescape` cleanup: it is what makes `daemon_restart`'s exit-75 path flush too (`mcp-call-record-wiring.mjs` pins it).
- Do not infer outcome from response bytes at the gateway; the answering router's return value is the source.
- Do not add an FK from `mcp_call_log` to `sessions`, or the session-delete cascade test's FK enumeration drifts.

## Not covered

- SDK-level failures that never reach a handler (input-schema rejection, unknown tool) have no transport hook and are not recorded.
- Per-session stdio MCPs (codescape, Playwright, markitdown, the capability registry) never pass through the gateway routers and are not recorded.
- A crash (no graceful shutdown or `daemon_restart` exit) can still lose up to one flush interval (2 s) of buffered rows.
