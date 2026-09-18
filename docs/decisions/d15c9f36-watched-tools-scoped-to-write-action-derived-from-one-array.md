# d15c9f36 — attribution's watched-tool set is scoped to WRITE/ACTION tools and derived from one `{tool, server}` array

## Narrative

Card d15c9f36 widened the sub-agent-call attribution detector (card cd0c7fee) past its original two tools (`worker_report`/`memory_write`) after an incident where a worker's engine-level fork filed `worker_report`s under the worker's own identity and the detector's narrow scope meant the same fork calling almost any other Loom tool would have produced no attribution at all.

The widened set is scoped to WRITE/ACTION tools only — a call that creates or mutates durable, trusted state (or takes a real, resource-consuming action) under the caller's identity — never read tools. The PreToolUse hook this list drives (`claude-settings.ts`'s `PRE_TOOL_USE_ATTRIBUTION_MATCHER`) spawns a real process SYNCHRONOUSLY before the matched tool call proceeds, and the hook is not role-scoped — every session hitting these two routers pays it, not just workers. Widening to a frequently-polled read tool (`tasks_list`, `gate_status`, `my_context`, …) would add real per-call latency fleet-wide for a tool category that can't mislead anyone: a read creates no durable state for a manager to wrongly trust the way a misattributed write can.

The set is exhaustive for the worker role's own tool surface (verified against the worker's real, live MCP tool list, not guessed from tool names) but deliberately does not cover manager/companion-only write tools on the same two routers (`worker_spawn`, `worker_message`, `question_ask`, …) — that is a different incident class (a manager's own sub-agent risk, not this card's worker-fork incident).

Both `WATCHED_TOOL_NAMES` (`tool-attribution.ts`) and `PRE_TOOL_USE_ATTRIBUTION_MATCHER` (`claude-settings.ts`) are derived from one `WATCHED_TOOLS: {tool, server}[]` array instead of being independently hand-maintained. This closes a real gap in the pre-widening regression test (`test/tool-attribution.mjs`'s "matcher/WATCHED_TOOL_NAMES agree" block): that test strips server prefixes before comparing the two sides, so it could not catch a tool wired under the WRONG server — which is silently inert (the PreToolUse hook never matches the client's real qualified tool name, so `consume` reads "unknown" for it forever), the exact silent-failure shape this whole module exists to avoid. Pairing tool and server in one array makes that mispairing impossible to express, not merely tested for after the fact.

## Do not

- Do not widen `WATCHED_TOOL_NAMES` by editing it directly — add to `WATCHED_TOOLS` in `tool-attribution.ts`; `WATCHED_TOOL_NAMES` and `claude-settings.ts`'s matcher are both derived from it.
- Do not add a read-only tool to `WATCHED_TOOLS` — the PreToolUse hook it drives is a synchronous, fleet-wide, per-call cost; reserve it for tools whose misattribution could mislead a reader into trusting durable state that isn't real.
- Do not treat this set as covering manager/companion-only write tools — it is scoped to the worker role's own tool surface only.

## Source

Inline comment in `packages/daemon/src/pty/tool-attribution.ts` (`WATCHED_TOOLS`'s own doc), as of worker branch for card `d15c9f36`.
