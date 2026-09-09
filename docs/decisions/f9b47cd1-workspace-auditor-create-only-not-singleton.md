# f9b47cd1 — `startWorkspaceAuditor` is CREATE-ONLY, not a singleton, and locks the session role explicitly

## Narrative

Card f9b47cd1: `startWorkspaceAuditor` starts a new END-USER WORKSPACE-AUDITOR session in an agent (End-User Platform tier B5). It mirrors `startAuditor` exactly — including its CREATE-ONLY (NON-singleton) shape — but passes callerRole `"workspace-auditor"`, so the session role is LOCKED to `"workspace-auditor"` regardless of the agent's profile role (an EXPLICIT caller role always wins in `resolveAgentSpawn`). The locked role — not the profile role — drives the de-privileged `loom-user-audit` surface (`buildMcpServers`, B3): a workspace-auditor session gets `loom-tasks` + `loom-user-audit` ONLY and 404s on `/mcp-platform`, `/mcp-orch`, `/mcp-audit` and `/mcp-setup`, so a hostile transcript can never escape the read-and-suggest box.

CREATE-ONLY, NOT a singleton (design gotcha #9): each on-demand "Review my workspace" run is a fresh ephemeral read-and-file session, exactly like the dev Auditor (`startAuditor`).

HUMAN-REST only (gateway `POST /api/agents/:id/sessions {role:"workspace-auditor"}`) — no agent/MCP path mints one (`session_spawn` refuses everything but `manager|plain`; the role is absent from the mintable profile enum + `setupRoleError`). The Workspace Auditor agent lives in the reserved "Getting Started" home (B4).

`prompt` is an OPTIONAL per-schedule custom task description (mirrors `startManager`/`startAuditor`) — appended via `appendScheduledPrompt` AFTER the agent's own `startupPrompt`. Undefined/null ⇒ byte-identical to today.

## Do not

- Do not copy `startSetup`'s live-reuse guard into `startWorkspaceAuditor` — that would attach a repeated "Review my workspace" click to a stale, already-finished run; each click must start a fresh ephemeral session.
- Do not expose a `session_spawn`/agent-MCP path that can mint a `"workspace-auditor"` role session — it is HUMAN-REST only.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `startWorkspaceAuditor`. Relocated by card `f05ca65c` (tranche 8); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
