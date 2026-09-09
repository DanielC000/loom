# be8be211 — `Profile.vaultWrite` is opt-in, confined, and HUMAN-set only

## Narrative

Card be8be211: opt-in confined vault-write capability. When true, a session under this rig may call the `vault_write` tool (loom-tasks MCP) to write (create/overwrite) a UTF-8 text note under its OWN project's vault root — the friction this solves is a research/Analyst rig whose deliverable IS a vault note, but which runs in an isolated worktree with no vault access otherwise.

Default OFF (absent/false) and fully additive — a rig without it spawns byte-identically to today (the tool is OMITTED from tools/list entirely, not merely denied — mirrors the `authenticated_request` gate on `connections`, not the browserTesting/documentConversion stdio-MCP pattern: no host process is launched, so this is never threaded into the spawn recipe). Confinement reuses `vault/writer.ts`'s existing path-traversal guard verbatim; the project is always SERVER-DERIVED from the session, never agent-passed.

HUMAN-set only, via the Profiles UI / REST `POST`/`PUT /api/profiles` — the SAME stricter posture as `connections`/`capabilities` (see `profiles/validate.ts`'s `AGENT_FORBIDDEN_PROFILE_KEYS`): a write capability into a human-reviewed corpus is exfil/tamper-adjacent, not a sandboxed read/convert tool, so it is rejected even on the Setup Assistant's / Platform Lead's own profile-writing MCP tools. Write-only by design (no delete) — a note-writer's job is to produce or update a note, not remove vault content.

## Do not

- Do not let `vaultWrite` be settable via any agent-facing profile-writing MCP tool (Setup Assistant, Platform Lead included) — it is REJECTED there like `connections`/`capabilities`, per `AGENT_FORBIDDEN_PROFILE_KEYS`.
- Do not give a `vaultWrite` session a delete path — it is write-only by design.

## Source

Inline comment in `packages/shared/src/types.ts` (`Profile.vaultWrite`'s field doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
