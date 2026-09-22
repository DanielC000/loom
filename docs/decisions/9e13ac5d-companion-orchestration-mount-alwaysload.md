# 9e13ac5d — the companion's `loom-orchestration` mount sets `alwaysLoad:true`; nothing else does

## Narrative

`buildMcpServers` (`pty/host.ts`) mounts `loom-orchestration` on the byte-identical `{type:"http", url}`
transport for manager, worker, AND the companion (`role:"assistant"`) — `wantsOrch` doesn't distinguish
them. Claude Code defers a `type:"http"` server's tools behind tool search by default; card `4fc458c1`
traced a real incident (113 turns, zero outbound bytes, the owner typing "Hello?" into a void) to exactly
this: the companion's only outbound rail, `chat_reply`, sat behind that same deferral with no structural
opt-out — Loom's only mitigation was a natural-language pre-warm sentence in `ASSISTANT_BASE_BRIEF`,
delivered once, never verified, never retried.

Card `9e13ac5d`'s DoD-1 verified (via the CLI's own embedded zod schema + its operative deferral function,
extracted from the shipped `claude.exe` binary) that `alwaysLoad:true` on a `type:"http"` MCP server entry
forces its tools to load immediately, never deferred — "equivalent to setting `defer_loading: false` on
the API." Anthropic's own internal bot-relay (`hearthbot`, a structurally similar first-party
reply-tool-bearing http MCP) already ships with `alwaysLoad:true` hardcoded on itself.

**Why assistant-only, not manager/worker too:** a manager/worker that hits a deferred tool pays a
ToolSearch round-trip and carries on — recoverable, bounded, cheap. The companion has no such fallback:
`reply-watch.ts` is PULL-only by ruled-on design (no in-turn backstop), so a missed pre-warm is not a
slow turn, it's *total, unobservable-from-inside outbound silence*. That asymmetry — recoverable
round-trip vs. unrecoverable silence — is the entire justification for treating the companion specially.

**Why not also `loom-tasks`:** `loom-tasks` is mounted unconditionally for every role before any `wants*`
branch runs. Setting `alwaysLoad` there would hit every session on every project — exactly the blast
radius the additivity constraint (byte-identical map for every other role) exists to prevent — and
`loom-tasks` isn't on the critical path for the silence failure; `chat_reply` lives on `loom-orchestration`.

**Why not widen to manager/worker too, for a nicer fleet-wide UX:** `alwaysLoad:true` always-loads the
WHOLE mounted server's tool surface into the prompt, every turn. The companion's orchestration surface is
narrow by design (the role-gated `assistant` branch in `mcp/orchestration.ts`'s `buildServer` — just
`my_context` + `chat_reply`), so always-loading it is cheap. A manager's orchestration surface is large;
always-loading it on every turn would spend real prompt budget on every manager/worker session, fleet-wide
— a genuinely different trade (fleet efficiency vs. per-spawn latency) that must not ride in silently on a
p1 companion bugfix. Not decided here; left to a future card if someone wants to make that case.

**The accepted cost:** `alwaysLoad:true` also blocks session startup until that MCP server connects
(capped at Claude Code's standard 5s connect timeout), since the tools must be present when the turn-1
prompt is built — normally MCP startup is non-blocking. Accepted as a bounded, one-time cost per companion
spawn/resume: Loom's MCP endpoint is loopback on a daemon that's already running by definition when a
session spawns, so the real connect should be near-instant in practice; the worst case (a slow/contended
daemon) trades a few seconds of spawn latency against the alternative of silent, total outbound loss on an
owner-facing session. Deliberately accepted, not overlooked.

## Do not

- Do not set `alwaysLoad` on the `loom-tasks` mount, or on `loom-orchestration` for any role other than
  `"assistant"`, without a fresh decision — the unconditional-mount and prompt-budget arguments above are
  the reasons, not an oversight.
- Do not treat the ~5s connect-block as free — it's an accepted, bounded trade against total outbound
  silence, not a cost-free change.

## Source

`buildMcpServers`'s `wantsOrch` block, `packages/daemon/src/pty/host.ts` (near line 1707, as of this
card). Card `9e13ac5d`, filed from `4fc458c1`'s DoD-4.
