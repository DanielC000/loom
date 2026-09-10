# cd0c7fee — tool-call attribution is computed at most once per (session, tool) per request

## Narrative

Cards `cd0c7fee`/`8d158088`: `computeAttributions` is shared by both MCP routes that can carry a watched tool — `worker_report` (orchestration-only) and `memory_write` (task-only) — because one helper is simpler than two near-duplicates. `consumeToolAttribution` (`pty/host.ts`) is DESTRUCTIVE/single-shot — this computes each watched tool's attribution AT MOST ONCE per request, into a `Map`, and that same `Map` is threaded to BOTH the `[mcp]` log line AND the router's `handle()` call, which passes it on to the enforcing tool handler (`mcp/server.ts` `memory_write`, `mcp/orchestration.ts` `worker_report`). Do NOT re-derive attribution a second time anywhere downstream — a second `consumeToolAttribution` call for the same (session, tool) always reads "unknown" (the entry is already gone), which would silently fail open FOREVER while looking fully operational.

`deps.pty.consumeToolAttribution` is optional-chained: several existing tests wire a minimal `{ markMcpSeen }`-only `deps.pty` stub, and a stub without the method stays a harmless no-op (empty `Map`) rather than a 500 — the real `PtyHost` always implements it.

Card `3cc3b726`: `server` is the route's own MCP server id (`LOOM_TASKS_SERVER_ID` / `LOOM_ORCHESTRATION_SERVER_ID` — the SAME constants `host.ts`'s `buildMcpServers` registers the client's servers under, one shared definition rather than two independently-typed literal lists) — used to reconstruct the FULL `mcp__<server>__<tool>` key that `consumeToolAttribution` expects. Two different routers can each register a tool with the same BARE name (`memory_write`: loom-tasks' project memory vs. loom-orchestration's companion-private memory), and a companion session mounts both routers on the SAME sessionId — a bare-name key let one router's call destructively consume the other's pending correlation entry. `test/tool-attribution-join.mjs` pins that this reconstruction actually agrees with what `deliverHook` records, across the two real routes, with a mismatched-server-id negative control. The returned `Map` stays keyed by the BARE tool name — every downstream reader is router-scoped by construction, so it never needs the qualifier.

## Narrative (tool-attribution.ts module design)

Neither the `PreToolUse` hook nor the MCP request carries a shared correlation id: `mcp/server.ts`'s `handle()` binds identity by URL path only, and Claude Code sends no protocol-level marker to the MCP server for a subagent call (confirmed against code.claude.com/docs/en/hooks — no `_meta`/header carries `agent_id`). So correlation happens ENTIRELY daemon-side, by session + tool name + timing.

Ordering guarantee this relies on (Claude Code blocks a tool call until its own PreToolUse hook process exits): for one invocation X, the daemon receives X's PreToolUse POST strictly before X's MCP request. This is PER-INVOCATION ONLY — it says nothing about relative order between two invocations of the SAME tool on the SAME session (a parallel tool-call batch can fire both hooks and both MCP requests interleaved either way). That's the "ambiguous" state — handled by refusing to guess an order the guarantee doesn't cover, never by trusting FIFO across invocations.

Fail-open by design, owner-approved 2026-08-24: "unknown" and "ambiguous" are distinct, honestly-labelled states, never silently folded into "confirmed-main" the way `x ?? false` folded unknown into a reassuring definite answer elsewhere (project memory `unknown-folded-into-a-definite-answer`). The module only classifies; enforcement (refusing a sub-agent's `worker_report`/`memory_write`) is a separate, not-yet-built follow-up landing in `mcp/orchestration.ts`.

Ambiguous entries stay queued rather than drained or FIFO-guessed at consume time — draining would degrade a genuinely in-flight second invocation to "unknown" for no reason, guessing risks mis-attributing a main-thread call as a sub-agent's. Every entry ages out lazily via `ATTRIBUTION_TTL_MS` on the NEXT access, bounding the window to the TTL, not forever. Not persisted across a daemon restart (in-memory, per-process only) — a hook that fired just before a restart degrades to "unknown", the safe fail-open direction: a lost entry can only under-attribute, never over-attribute.

`consume()`'s "confirmed-main" is a positive assertion built on an absence (a fresh entry with no `agentId`), with no version floor (deliberate): if a future Claude Code stops populating `agent_id`, every call would read "confirmed-main" — a confident false "all clear", not a visible gap, since the queue stays non-empty and never degrades to "unknown". At enforcement time (not built yet) that would silently permit every sub-agent call instead of failing open honestly.

## Do not

- Do not call `consumeToolAttribution` more than once for the same (session, tool) per request — the second call reads "unknown" and silently fails open, not loud.
- Do not key the attribution `Map` by anything other than the bare tool name reconstructed with the route's own server id — a bare-name-only key across two mounted routers lets one destructively consume the other's entry.
- Do not trust FIFO order across two invocations of the same (session, tool) — the PreToolUse-before-MCP ordering guarantee is per-invocation only.
- Do not fold "unknown"/"ambiguous" into "confirmed-main" — fail-open must keep them honest and distinct.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`computeAttributions`, lines 726-751 as of commit `a9b55042`). Relocated by card `c57868e5`; wording condensed, no substantive detail dropped.

Also `packages/daemon/src/pty/tool-attribution.ts` (module header comment, and `consume()`'s "confirmed-main" doc) — relocated by the `tool-attribution.ts, tranche 1` extraction card.
