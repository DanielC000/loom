# 95f40ee0 — `usesOrchestrationMcp` is the ONE shared copy of a role list two layers hand-roll separately

## Narrative

Card 95f40ee0: the roles that mount the loom-orchestration MCP server (manager/worker get the full coordination surface, assistant/Companion gets only `my_context` + `chat_reply`). Shared here, in the one module both `sessions/service.ts` (`usesOrchestrationMcp`'s former home) and `pty/host.ts` (`scheduleKickoffGuarantee`'s `gateOnMcp`) already import, so the two no longer maintain independently-typed copies of the same three-role list that could silently drift — `PtyHost` deliberately has no access to `SessionService`, so this predicate (not a shared class/method) is the layering-safe way to give both sides one source.

`usesOrchestrationMcp` is NOT the only copy of this role list, though. `pty/host.ts` still hand-rolls the identical `role === "manager" || role === "worker" || role === "assistant"` comparison in TWO more places this card deliberately left untouched (out of scope — they decide a different concern, actual MCP mounting/allowlisting, not the kickoff `mcpSeen` gate this predicate serves): `buildMcpServers`'s `wantsOrch` (which servers get mounted for a spawn) and the spawn-arg allowlist's own `wantsOrch` (which MCP server names get allowlisted). Adding a role to `usesOrchestrationMcp` does NOT update either of them — that must be done separately, in lockstep, or a role can end up gated on this predicate for an MCP that `buildMcpServers` never actually mounts. That drift direction is a hazard, not a measured behaviour (traced from the code, not executed): a role added only here would wait on `waitForMcpSeen` for a handshake that can never fire, since nothing mounted the server it's waiting on — unlike this card's own now-closed drift, which was fail-safe.

## Do not

- Do not assume adding a role to `usesOrchestrationMcp` alone is sufficient — `buildMcpServers`'s `wantsOrch` and the spawn-arg allowlist's own `wantsOrch` in `pty/host.ts` must be updated in lockstep, or the new role can wait forever on an MCP handshake that never fires.
- Do not fold `usesOrchestrationMcp` into `SessionService` or any daemon-side class — it lives in `packages/shared` specifically because `PtyHost` has no access to `SessionService`, and a shared function is the layering-safe way to give both sides one source.

## Source

Inline comment in `packages/shared/src/types.ts` (`usesOrchestrationMcp`'s function doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
