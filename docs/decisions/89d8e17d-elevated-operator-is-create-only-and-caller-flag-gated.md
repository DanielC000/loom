# 89d8e17d — the Bounded Elevated Operator is create-only, and gated at the caller, not internally

## Narrative

`startOperator` starts a NEW ELEVATED OPERATOR session in an agent (Bucket 2b "Bounded Elevated Operator"). Shaped like `startSetup` but passes callerRole "operator" so the session is LOCKED to the curated, own-workspace-confined `loom-operator` MCP surface. Because an EXPLICIT caller role ALWAYS wins in `resolveAgentSpawn`, the session role is "operator" regardless of the agent's profile role — the gate is keyed off the SESSION role (+ the LIVE `platform.operatorEnabled` flag, re-checked by the router itself on every request), never the profile role.

Create-only, NOT a singleton (mirrors `startWorkspaceAuditor`'s shape, deliberately NOT `startSetup`'s live-reuse guard): an operator is a bounded, human-invoked tool session, not a standing assistant — the human may want several independent operator sessions live in the same agent (e.g. one per task), so this never collapses a fresh spawn into an already-live row.

Flag-gated at the CALLER (gateway REST — see `isOperatorEnabled`), not here: this method itself does NOT re-check `platform.operatorEnabled`, mirroring `startWorkspaceAuditor`/`startSetup` (neither re-checks their own gating condition internally either — the REST route is the single enforcement point for "may this spawn happen at all"; the router's `resolveRole` is the SEPARATE, LIVE-read enforcement point for "may this session's surface be reached right now").

## Do not

- Do not collapse a fresh operator spawn into an already-live row — this is create-only, deliberately NOT `startSetup`'s live-reuse guard; the human may want several independent operator sessions at once.
- Do not re-check `platform.operatorEnabled` inside this method — the REST route is the single enforcement point for whether the spawn may happen at all; the router's `resolveRole` separately, live-reads whether the surface may be reached right now.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`startOperator`'s doc, minus the "HUMAN-REST only / no agent-MCP mint path" guard sentence, which stays inline at the source): originally lines 3051-3075, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
