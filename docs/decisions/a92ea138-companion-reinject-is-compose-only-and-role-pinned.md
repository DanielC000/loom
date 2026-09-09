# a92ea138 — the companion `/new` reinject is compose-only and reads the pinned role, not the current profile

## Narrative

`composeCompanionReinjectPrompt` composes the fresh-spawn-EQUIVALENT persona+recall prompt for an already-live companion session — the "/new" reinject (`chat-gateway.ts`'s `resetConversation`). Compose-only / side-effect-free: it reuses `resolveAgentSpawn` purely to extract the composed startup-prompt STRING (that method only reads `db.getProfile`, no writes) and appends the SAME memory-recall digest a fresh spawn/resume gets (`buildFramedMemoryRecall`/`appendMemoryRecallToStartupPrompt`) — this never spawns, writes, or re-arms anything; it is called from a raw-enqueue reinject path, never a spawn path. Returns undefined for anything that isn't a live, still-assistant-role companion session (nothing to reinject).

`companionName` — baked into the ORIGINAL startup prompt at creation-time only (`startNew`'s `opts.companionName`) and never stored on the session/agent row — is re-sourced here from the durable `companion_config.name` column (the provision endpoint persists it there, `gateway/server.ts`) rather than threaded through some new session-row field, so a re-inject years after provisioning still gets the same name. `explicitRole:"assistant"` is passed (not re-resolved from the agent's CURRENT profile) mirroring `resume()`'s "carry `session.role` forward" pattern — a profile edited after this companion was created must not change what a reinject composes for it.

## Do not

- Do not have this reinject path spawn, write, or re-arm anything — it is compose-only, called from a raw-enqueue reinject path, never a spawn path.
- Do not re-resolve the agent's CURRENT profile role for a reinject — pass `explicitRole:"assistant"` (mirroring `resume()`'s carry-forward pattern) so a profile edit after companion creation can't change what a reinject composes.
- Do not thread `companionName` through a new session-row field — re-source it from the durable `companion_config.name` column so a reinject years after provisioning still gets the same name.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`composeCompanionReinjectPrompt`'s doc): originally lines 2430-2446, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
