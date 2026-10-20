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

## Loading is not an error (card `586a0efe`)

The original gate had ONE unloaded state. `GET /api/agents` is cross-project and runs on the editor's first mount, so a human who clicks Save inside that cold window hit the "Loom could not load the agent list" confirm with Save disabled — a failure message, and a dead button, for a list that was merely a few hundred milliseconds late. The fail-closed property was right; the thing the human was told was not.

The split is in the planner, not the page: `planGrantSave` takes an `agentsLoading` flag and returns a fourth plan, `kind: "wait"` — hold the save, show one cyan status line (`grant-reach-checking`) with Save disabled and relabelled `Checking…`, and no confirm panel, because this state carries no decision. `confirm-unknown` is untouched. Both fail closed: nothing is written while the reach is unknown, and `null` still never reads as "0 agents bound".

The discriminator in `Profiles.tsx` is `isPending && failureCount === 0`, NOT `isPending` alone — react-query stays PENDING across its whole retry backoff, so `isPending` alone would park a broken request under "checking…" for seconds before admitting anything was wrong. Resolving the hold re-runs `submit()` against LIVE form state, the opposite of the `pendingGrant` snapshot beside it: that freezes a patch the human has already reviewed, while a held save is one nobody has been shown anything about.

### Do not (this section)

- **Do not give `agentsLoading` a truthy default, and do not let it reach a non-null `agents`.** Either turns "could not load" into a hold, which hides a real outage behind "checking…" with nothing left to wait for. The default-false parameter is itself the safety property: a caller that forgets it lands on the error confirm, never on a silent save.
- **Do not hoist the hold into the caller.** `planGrantSave` returns `save` for a non-widening edit BEFORE it consults the reach at all. Checking "is the list loading" in `submit()` instead would hold a rename during an outage, so one failing cross-project query would block every unrelated profile edit.
- **Do not resolve the hold from a captured patch.** The human can edit while it is held — including the very field being granted — so a snapshot saves a value they can no longer see. `submit()` reads only live state, which is why re-running it IS the re-plan and there is no second code path to keep in step.
- **Do not let Cancel merely hide the hint.** It must clear the held flag, or the save fires anyway the moment the list lands.

## Scope

The CONFIRM is the editor's (`PUT /api/profiles/:id`) only. The event and the `grantReach` response field also cover **adopt** (`POST /api/profiles/:id/adopt`) and **reset** (`POST /api/profiles/:id/reset`) — both are human clicks that can pull in a shipped `browserTesting` / `capabilities` the profile had dropped. Those two have no pre-save confirm yet; that is a deliberate follow-up, not an oversight.

Deliberately NOT placed at the `db.updateProfile` chokepoint: boot-time seeding also writes through it, and Loom shipping its own defaults is not a human grant.

**Extended by card `be447b3f`** to two non-grant keys (`role`, `restrictedTools`) and to the two agent-facing `profile_update` MCP tools (Setup Assistant, Platform Lead) — see `docs/decisions/be447b3f-profile-widening-reach-role-restrictedtools.md` for that extension's own decision record (including why two OTHER paths it audited — a Connection's host/secret, a capability-catalog definition's command — were accepted as out of scope instead). This record's "Do not" list above still governs the original seven grant keys unchanged.
