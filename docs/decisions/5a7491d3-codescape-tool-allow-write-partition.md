# 5a7491d3 — Codescape's read/write tool partition, and how each newly-classified tool was verified

## Narrative

`CODESCAPE_TOOL_ALLOW` (card C2 + card 5a7491d3 DoD-1/DoD-3) is the `--allowedTools` contribution for a mounted Codescape MCP entry — ONLY the 9 read tools (`list_flows`/`trace_flow`/`what_touches`/`describe_symbol`/`render_tree`/`boundary_map`/`scenario_space`/`overview`/`declared_actions`), NEVER the control/write tools in `CODESCAPE_WRITE_TOOLS`.

`overview` was added by card 5a7491d3: it was mounted and advertised (it's the orientation entry point Loom's own `/codescape` skill teaches agents to call FIRST) but sat in neither list — a pure read/orientation tool, same shape as `list_flows`, so it belongs here, not on the write side.

`declared_actions` was ALSO added by card 5a7491d3, after initially being placed fail-closed on the write side pending confirmation: the peer project (who own the server) confirmed it is registered as a tool in their `src/mcp/server.ts`, through the SAME `logged(...)` wrapper as their other read tools, and its handler (`src/mcp/walk.ts`) only projects a field already stamped at ingest — it mutates nothing.

NAME-COLLISION TRAP: `declared_actions` is ALSO a member of `open_view`'s VIEW enum in their `src/mcp/control.ts` (a control-surface concern, unrelated to the tool) — grepping the peer repo for the bare name lands mostly in THAT file and reads like a write tool. The discriminator is which file registers the name AS A TOOL (`server.ts`), never where the string merely appears. Read-only "agent orients itself" integration (Q4). Named per-tool, not the whole `mcp__codescape` server prefix, so the write surface stays unreachable even though the server itself exposes it.

`CODESCAPE_WRITE_TOOLS` (card C2 hardening, post-hoc CR blocker + card 5a7491d3 DoD-2) is the control/write Codescape tools — NEVER allowlisted, but the mounted `codescape` MCP entry still ADVERTISES every tool it registers to the model regardless — this array and `CODESCAPE_TOOL_ALLOW` TOGETHER are meant to partition that full advertised set; don't quote a fixed total anywhere (see `codescapeUnclassifiedTools` for the drift check that keeps the partition honest instead of a hardcoded count going stale the moment either list changes). Under `--permission-mode acceptEdits`, a tool that's mounted but not allowlisted is NOT auto-approved — it PROMPTS. A Loom-driven role (worker/setup/auditor/workspace-auditor, stdin owned by its manager, `AskUserQuestion` disallowed) can never answer that prompt, so a stray call wedges the turn until the busy-stuck watchdog fires. These names are unioned into `--disallowedTools` (see `disallowedToolsForSpawn`) whenever the codescape MCP is actually mounted, so the write surface is structurally unreachable rather than merely un-allowlisted.

`clear_annotations` (card 5a7491d3) is `annotate`'s own counterpart — clearing annotations mutates the graph's view state exactly like setting them does, so it belongs on this side for the same reason `annotate` does.

## Do not

- Do not classify a new Codescape tool by grepping the peer repo for its bare name — a name can collide with an unrelated enum member (e.g. `declared_actions` in `open_view`'s VIEW enum). The discriminator is which file registers the name AS A TOOL (`server.ts`).
- Do not quote a fixed total for the partition anywhere — use `codescapeUnclassifiedTools`'s drift check instead of a hardcoded count that goes stale the moment either list changes.
- Do not add a tool to `CODESCAPE_TOOL_ALLOW` without confirming it mutates nothing — a Loom-driven role can never answer an unexpected permission prompt, so an unclassified write tool wedges the turn until the busy-stuck watchdog fires.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`CODESCAPE_TOOL_ALLOW` and `CODESCAPE_WRITE_TOOLS`'s top-of-const docs), as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415` (tranche 2 on `pty/host.ts`); no wording changed, wrapped source lines joined into flowing paragraphs and the `*` comment markers stripped.
