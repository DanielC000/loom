# 3b0c4aef — GitHub was seeded as an ordinary `capability_defs` row, not a hardcoded builtin slug

## Narrative

Board card `3b0c4aef` (agent-tooling P4 follow-on) added Loom's first real credential-tied capability, GitHub, and used it to prove the `requiresConnection`/`{slug, connectionId}` connection-bind path end-to-end.

The decision made there: seed GitHub as an ordinary `capability_defs` row rather than a third/fourth hardcoded builtin slug like `browser-testing`/`document-conversion` — those two bypass the credential-tie injection entirely (see `buildMcpServers` in `pty/host.ts`). Going the generic-row route meant binding GitHub exercises the same generic node-package/python-venv/bundled/command/github-binary dispatch plus spawn-time secret-env-injection that any later owner-added row would get.

The outcome validated the approach: nothing in `pty/host.ts` needed to change to support it — `getCapabilityCatalog`/`resolveConnectionSecret` already read every `capability_defs` row generically. That validation is what let a second capability, image-gen (`b93cfd10`), reuse the same generic path rather than growing a second hardcoded special case.

## Source

Inline comment in `packages/daemon/src/capabilities/seed.ts` (module header, lines 2-11 as of commit `88e764ef`). Extraction-program tranche, card `1e8c2e16`.
