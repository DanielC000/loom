# 158cb01a — the re-pin grants button reads a counts-only dry-run, never a client-side compare

A live session's connections and capabilities are pinned on its row at spawn and stay frozen across resume, fork and recycle (owner ruling 298b826e). The human-only `POST /api/sessions/:id/repin-grants` (54e9299) re-pins them from the agent's current grants, and had no UI. This card adds the button and a drift badge.

## What shipped

- `GET /api/sessions/:id/grant-drift` — a read-only dry-run of the POST. `SessionService.sessionGrantDrift` shares `loadRepinTarget` (the refusals) and `resolveRepinSurface` (the resolution) with `repinSessionGrants`, so what the badge reports is what the re-pin applies. It writes nothing and files no event.
- The response is `SessionGrantDrift` (`packages/shared`): counts and booleans only.
- `components/RepinGrants.tsx` — `canRepinGrants` + `RepinGrantsControl`, mounted in `SessionActions`, the Atlas `SessionNode` and the Atlas `AgentActions` cluster. Not on roster rows, not on companions.
- The route is in no `TIER_1_ROUTES` entry, so it is Tier 0 (loopback-only) like the POST it mirrors, and `repin-grants-no-mcp-surface.mjs` also refuses any MCP tool named for a grant drift.

## Do not

- Do not compute drift in the browser by comparing `agent.connections` to `session.connections`. The re-pin resolves through `resolveAgentSpawn` with the session's own role and the project config, so a raw compare can show a badge the re-pin then fails to clear.
- Do not add connection or capability ids, names or hosts to the `grant-drift` response. It is counts-only on purpose; the UI never needs more, and a richer payload widens what a read can reveal about credential reach.
- Do not give this an MCP tool, and do not move it to Tier 1. Re-pinning is human-only, the same trust class as the grant writes themselves.
- Do not make recycle or resume re-pin on their own. The freeze is deliberate (298b826e); the button is the only way a pinned set moves.
- Do not hide the badge for a session pinned to zero connections. It is the most common real shape: such a session registers no `ssh_exec` / `authenticated_request` tool, so it has no in-session signal that a grant was added later.
- Do not claim a re-pin makes a first-time grant callable. The row write does not re-list an already-connected engine's tools; the session needs its next resume (record 1a048349). The UI says so.
