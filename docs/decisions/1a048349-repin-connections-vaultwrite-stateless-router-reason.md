# 1a048349 — Re-pin `connections`/`vaultWrite` here for a stateless-router reason, not a respawn one

## Narrative

Force role "assistant" (the row's own, immutable role) rather than trusting session.role blindly — mirrors composeCompanionReinjectPrompt's explicitRole pattern. Model/prompt are discarded here (only the capability surface matters); resume() below never threads --model or injects a startup prompt. `connections`/`vaultWrite` ARE re-pinned in the row write below (card 1a048349), same as every other field here — but for a DIFFERENT reason than the rest of the surface. Every other field is a spawn-time property (argv/`--allowedTools`) that needs the RESPAWN below to take live effect. `connections`/`vaultWrite` are the opposite: `mcp/server.ts`'s TaskMcpRouter is stateless and re-resolves them off THIS ROW fresh on every request, never threading either through `pty.spawn` or `resume()` at all — so the row write alone already takes effect on the companion's very next tool call, respawn or not. They're written here anyway (not via a separate live-effect-only path) purely because this is the one place that re-pins the whole surface from a single `resolveAgentSpawn` call — sourced from the human-set Profile, never from agent input, same as every other field here.

## Do not

- Do not read `connections`/`vaultWrite` off `session.role`, or assume they need the respawn below to take effect — `mcp/server.ts`'s TaskMcpRouter re-resolves them fresh off the row on every request, so the row write alone already takes effect on the companion's very next tool call.
- Do not skip re-pinning them here just because they're not spawn-time argv properties — they're written here anyway because this is the one place that re-pins the whole capability surface from a single `resolveAgentSpawn` call.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`upgradeCompanionCapabilities`): lines 4048-4059, as of commit `7a20d971f1c5d3d098b36030b5cc5feebd8be930`. Relocated by card `6065685c`; no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
