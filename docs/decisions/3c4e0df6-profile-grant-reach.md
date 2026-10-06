# Profile grant blast radius — showing (and recording) who a human grant already reaches

Card `3c4e0df6`, discovered from the `a06650d2` security review.

## The gap

Profiles are GLOBAL — platform-level, no `projectId`. Card `a06650d2` stopped an *agent* from BINDING a profile that already carries `connections` / `capabilities` / `vaultWrite`. It cannot cover the other direction: a grant a HUMAN adds to a profile **later** reaches every agent already bound to it, in every project — including agents that an agent bound earlier, perfectly legitimately, back when the profile was harmless. The human got no signal about that reach at all.

## What was decided

Three surfaces, one shared computation:

1. **A pre-save CONFIRM in the Profiles editor**, shown only when the pending save ADDS a human-only grant. It names the grants, the count, and each "Project / Agent" already bound. This is a trust-boundary widening, so the human sees it BEFORE it takes effect, not after.
2. **A `grantReach` field on the save response**, for a caller that got no prompt.
3. **A durable `profile_grant_reach` orchestration event**, the backstop for a REST-only save — which cannot be prompted at all.

The key list, the "what did this save add" computation and the "who is bound" computation all live in `packages/shared/src/profileGrants.ts`, consumed by both the daemon and the web.

## Do not

- **Do not re-spell `AGENT_FORBIDDEN_PROFILE_KEYS` in the web package.** It moved to `@loom/shared` precisely so the editor's pre-save decision and the daemon's recorded fact come from one array. A second copy drifts the moment an eighth key is added, and the web's copy would drift *silently* — nothing on the daemon side type-checks it.
- **Do not collapse `addedProfileGrants`'s `GRANT_ADDED` record into `validate.ts`'s `AGENT_FORBIDDEN_PROFILE_KEY_CARRIED`.** They answer different questions. `_CARRIED` is a non-empty check ("does this profile hold the capability at all"), which is right for refusing an agent role-change. `GRANT_ADDED` is value-level, because adding a SECOND connection to a profile that already had one is a new secret reaching every bound agent — and a non-empty check cannot see it.
- **Do not count a pending-binding row as a binding.** `agent.profileId` is the whole binding surface: `profile_id` exists on exactly one table (`agents`), and `resolveProfile(agent, db.getProfile(agent.profileId))` is the only resolution shape in the daemon. A pending-binding row (card `12dc7fc9`) also carries a `profileId`, but it is an UNANSWERED REQUEST for a grant. Counting it would report reach that does not exist.
- **Do not write UI copy implying a grant reaches LIVE sessions.** Every profile-resolved capability is pinned onto the session row at spawn (`sessions.browser_testing` / `document_conversion` / `connections` / `vault_write` / …), and the gates read that row — `mcp/server.ts`'s vault-write gate is `if (session?.vaultWrite)`, not a live profile lookup. A grant added now reaches each bound agent's **next** session.
- **Do not suppress the event when the reach is zero.** The row records the GRANT; reach is a field on it. Filing at `agentCount: 0` is what makes an absent row unambiguously mean "no grant was added", rather than something a reader has to disambiguate from "a grant was added but happened to reach nobody".
- **Do not add `profile_grant_reach` to `DURABLE_AUDIT_EVENT_KINDS`.** That list's own standing comment forbids adding a kind without also stamping `detail.projectId` for it, and a GLOBAL profile has no single project to stamp. It needs no membership there to survive: both event-deletion sites (`deleteAgent`'s cascade, `deleteProject`'s) are session-keyed, so a `managerSessionId: ""` row is reached by neither.
- **Do not derive "how many agents" from `detail.agents.length`.** That array is capped at `GRANT_REACH_AGENTS_CAP` so a widely-bound profile cannot bloat an append-only row. `agentCount` is always the true total.
- **Do not let the editor's confirm fail OPEN.** The bound list comes from a query. An unresolved or failed `GET /api/agents` must never read as "0 agents bound" and skip the prompt — that saves a trust-boundary widening silently, which is the whole defect this card exists to remove. The reach is typed `… | null` (`null` = not loaded, distinct from an empty list), gated on `isSuccess`, and an unknown reach still shows the confirm, worded as unknown.

## Scope

The CONFIRM is the editor's (`PUT /api/profiles/:id`) only. The event and the `grantReach` response field also cover **adopt** (`POST /api/profiles/:id/adopt`) and **reset** (`POST /api/profiles/:id/reset`) — both are human clicks that can pull in a shipped `browserTesting` / `capabilities` the profile had dropped. Those two have no pre-save confirm yet; that is a deliberate follow-up, not an oversight.

Deliberately NOT placed at the `db.updateProfile` chokepoint: boot-time seeding also writes through it, and Loom shipping its own defaults is not a human grant.

**Extended by card `be447b3f`** to two non-grant keys (`role`, `restrictedTools`) and to the two agent-facing `profile_update` MCP tools (Setup Assistant, Platform Lead) — see `docs/decisions/be447b3f-profile-widening-reach-role-restrictedtools.md` for that extension's own decision record (including why two OTHER paths it audited — a Connection's host/secret, a capability-catalog definition's command — were accepted as out of scope instead). This record's "Do not" list above still governs the original seven grant keys unchanged.
