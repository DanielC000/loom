# ad131671 — the Setup Assistant singleton means "never two LIVE", not "one row ever"

## Narrative

`startSetup` starts a NEW SETUP-ASSISTANT session in an agent (Setup Assistant E1-5). Shaped like `startManager` but passes callerRole "setup" so the session is LOCKED to the curated, ungated `loom-setup` MCP surface. Because an EXPLICIT caller role ALWAYS wins in `resolveAgentSpawn`, the session role is "setup" regardless of the agent's profile role — the gate is keyed off the SESSION role, never the profile role.

Singleton guarantee = "never two LIVE setup sessions" (NOT "one row ever"). Unlike the Platform Lead (`startPlatformLead` is now create-only — multiple live Leads may coexist), the Setup operator stays a singleton: if a setup session is already LIVE, reuse it as-is (its pty outlived the viewer) — never mint a 2nd. Otherwise fall through and INSERT+spawn a brand-new setup session (never resume an exited one here). Uses `db.liveSessions` (the canonical live-over-recency query — filters to LIVE before any `.find`, so a recently-STOPPED setup session can't sort ahead of an idle-but-LIVE one).

## Do not

- Do not mint a second live setup session while one is already live — reuse it as-is; the singleton is "never two LIVE", not "one row ever" (an exited row is fine to leave behind and never resumed here).
- Do not sort/find a candidate to reuse without filtering to LIVE first — a recently-stopped setup session must never sort ahead of an idle-but-live one (`db.liveSessions`'s own contract).

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`startSetup`'s doc, minus the "HUMAN-REST only / no agent-MCP mint path" guard sentence, which stays inline at the source): originally lines 2966-2981, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
