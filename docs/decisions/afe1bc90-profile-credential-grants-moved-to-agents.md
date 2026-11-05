# afe1bc90 — profile credential grants fanned out onto agents; resolution is agent-only

Card `afe1bc90` (Card B of the `caca806c` split) moved every PROFILE `connections`/`capabilities` grant onto the
agents bound to that profile and made spawn resolution agent-only. `caca806c` (Card A) had added the agent-level
fields and resolved the UNION of profile + agent so no landed commit ever stopped honouring a profile grant.

## What shipped

- **Fan-out (data) — Db constructor chain** (`db.ts` `backfillProfileCredentialGrantsToAgentsOnce`, after
  `migrateConnections`): one transaction, one `app_meta` one-shot marker stamped LAST, plus a durable JSON
  summary (`profile_credential_grants_fanout_summary`). The new agent value is exactly the old resolution
  (`unionConnections`/`unionCapabilities`, profile first, slug-only capability dedup) so effective reach is
  identical. It depends on nothing but the DB — no reserved home, no seeding — which is why it lives in the
  constructor chain: resolution is agent-only from this card on, so a boot where it did not run would leave every
  agent grant-less.
- **Dead grants** (a connection scoped to a different project than the agent's): a plain `connections` entry is
  dropped and recorded, never an error (inert: the use-time scope check never let it through). A CAPABILITY on such
  a connection is NOT dropped (R10): its slug is kept and only the `connectionId` is stripped, so the spawn is
  byte-identical (the MCP server still mounts, with no env); the stripped binding is recorded
  (`strippedCapabilityBindings`) and the notice says "kept, binding removed". **Dangling** connection ids (deleted connection) are
  carried over unchanged and recorded — they fail closed at use time, and the agent write guard treats an
  unknown id the same way. **Orphan** profiles (grants, zero agents) are recorded.
- **Notice (card) — `index.ts` / `setup/seed.ts` `fileCredentialGrantFanoutNoticeOnce`**: its OWN marker,
  filed once ever on the reserved Platform/Setup home from the stored summary; if the home is missing it files
  nothing and stamps nothing (retried on a later boot) without touching grants.
- **Resolution** (`shared/config.ts` `resolveProfile`) reads the agent row only. `profiles.connections`/
  `profiles.capabilities` columns stay DORMANT (never read; `profile-credential-columns-dormant.mjs`).
- **Profile API** rejects either key with an error naming the agent endpoint (`retiredProfileCredentialKeysError`).
- **Pending bindings** are keyed on the REQUESTING agent (`filed_by_session_id` → `sessions.agent_id`, the
  immutable filer, decision `e54996a4`): `alreadyGranted` = that agent's row has the connection;
  `markBindingsAppliedForAgent` replaces the profile-keyed reconcile.
- **Codex stdio** (`7fa73e2c` extended to the agent row): agent-level `capabilities` are refused when the bound
  profile resolves to `harness:"codex"` — on the agent write, on a rebind onto a codex profile, and on a REST
  profile flip to codex under a bound capability-carrying agent. Agent-facing rebinds onto a codex profile were
  already refused by `agentAssignableProfileError`.
- `agentCapabilityProfileCollisionError` is removed: a profile can no longer grant a slug, so there is no collision.

## Behaviour change accepted (lead ruling R3)

Reach is unchanged. What changed is that a former profile grant is now an AGENT grant, so the agent-row guards
(`agentCredentialGrantRoleChangeOnRebindError`, `boundAgentCredentialGrantRoleChangeError`,
`explicitRoleGrantCarryoverError`) now apply to those agents: agent-facing tools can no longer change those
agents' roles; a human can, over REST (agent editor). The notice card says so.

## The null→worker spawn exemption survives for fanned-out grants (R9, `acd3c688`)

A grant fanned out from a `role:null` profile keeps the exemption it had (a manager's `worker_spawn` of that
agent still works); a grant the agent row ALREADY carried (caca806c era) or gets later keeps the refusal. The
record is DURABLE provenance, not inference: the fan-out transaction writes `profile_credential_grants_fanout_exempt`
(per agent: connection ids + capability slugs that arrived from a null-role profile and were not already on the
row) BEFORE the marker. `explicitRoleGrantCarryoverError`'s null→worker leg subtracts it
(`Db.getFanoutExemption`; absent/corrupt ⇒ no exemption, fail closed); no other leg reads it. It is per grant,
so a connection added after the migration is refused even on a fanned-out agent.

Accepted reach (R12): the record is keyed on connection id / capability slug, so a human RE-ADD of the same
connection id, or a re-point of a fanned-out slug, stays exempt. Both writes are human-only and match the
pre-migration posture (editing a null-role profile stayed exempt). Deliberately not re-keyed.

## Do not

- Do not read `profiles.connections`/`profiles.capabilities` anywhere except the fan-out migration — the columns
  are dormant until a later release drops them.
- Do not move the fan-out out of the Db constructor chain or make it depend on the reserved home — a boot where it
  has not run leaves every agent with zero grants.
- Do not clear the profile columns in the migration; do not re-run the fan-out (the marker is the guard).
- Do not make a pending binding grant to the whole profile — least privilege: the requesting agent only.
- Do not write `profile_credential_grants_fanout_exempt` outside the fan-out transaction.
- Do not read it outside the null→worker leg of `explicitRoleGrantCarryoverError`.
- Do not re-add a profile-level grant field "for convenience"; the profile API rejects them on purpose.
