# caca806c — agent-level credential grants: union with the profile, never a silent bypass of its own checks

Card `caca806c` moved credential-bearing grants (`connections`/`capabilities`) onto the AGENT, additive on
top of the pre-existing profile-level grant (`resolveProfile`'s `unionConnections`/`unionCapabilities`,
`shared/src/config.ts`) until card `afe1bc90`'s fan-out migration retires the profile-level fields.

## Round 1 — three gaps (Code Review of worker `fe20de6c`, reviewer `4d21eb2e`)

1. **Rebind-time role-change refusal.** `agentCredentialGrantRoleChangeOnRebindError` (`profiles/validate.ts`)
   refuses a rebind when the AGENT ROW carries a non-empty `connections`/`capabilities` grant AND the
   resolved role would change — at all FIVE agent-facing rebind sites (setup/platform
   `agent_update`+`profile_assign`, the manager's `assignAgentProfile`). Human-only REST
   `POST /api/agents/:id` is deliberately EXEMPT (human intent on a human-only surface, `8b236b22`/`acd3c688`).
2. **The null→worker spawn exemption** (`explicitRoleGrantCarryoverError`, decision `acd3c688`) originally
   covered a case it shouldn't — superseded by Round 3 item 1 below; read that for current behavior.
3. **Capability dedup** let a same-slug agent grant race the profile's mount — `unionCapabilities` now
   dedupes by SLUG ALONE (profile entry first), and `agentCapabilityProfileCollisionError`
   (`agents/validate.ts`) refuses a same-slug agent-level write at save time.
4. **The widening audit** (`rebindWideningFields`, `profiles/grantReach.ts`) folds the agent's OWN grant
   into BOTH `before`/`after` via an optional `agentGrants` param — the five agent-facing sites all pass
   the agent row; the REST site's gap is closed by Round 3 item 3.

## Round 3 — second Code Review (NEEDS-FIX), LEAD RULINGS

1. **CRITICAL, reproduced end to end.** Round 1 item 2's carried-grant check was gated on
   `agentHasNoProfile` (`!profile`) — rebinding a grant-carrying, profile-less agent onto a grant-free
   `role:null` profile (or granting an agent already bound to one) skipped the check, and the agent's own
   grant rode into a `worker_spawn` unauthorized. Fixed: the check now keys on the AGENT ROW's OWN
   non-empty grant (`agentOwnGrants`, replacing `agentHasNoProfile`), regardless of whether a profile is
   bound. A BOUND role-less profile's OWN grant stays fully exempt (`acd3c688`'s design) — never folded
   into `agentOwnGrants`; only the agent row's raw fields are.
2. **MAJOR.** `profile_update`'s role lever was unguarded against an AGENT-level grant — only the
   PROFILE's own fields were checked, so flipping a grant-free profile's role under a grant-carrying bound
   agent (directly, or via Setup's create+assign+update) carried that grant into the new role unseen.
   Fixed: `boundAgentCredentialGrantRoleChangeError`, ONE shared predicate in `profiles/validate.ts`
   called from both Setup's and Platform's `profile_update`, refuses a role CHANGE when ANY bound agent
   carries its own grant. Narrows `05153988`'s "do not add this refusal to profile_assign/agent_update" —
   its premise ("binding never decouples role from capability") holds for the PROFILE's own fields but
   not an AGENT-level grant, which didn't exist when `05153988` was written. Not in tension with `8b236b22`'s
   absent Setup-rebind role-flip guard (a different axis; this one is covered by Round 1 item 1).
3. **MINOR.** REST rebind now passes `existing` as `agentGrants` to `rebindWideningFields`.
4. **MINOR.** The same route's same-slug collision check now uses the POST-patch `profileId`.
5. **Web.** `AgentEditor`'s `grantsError` is scoped inside the component (`grantsErrorAgentId === agent.id`).

## Round 4 — third Code Review, LEAD RULINGS

1. **CRITICAL.** `forcePlain` dropped the profile but `resolveProfile`'s no-profile backstop still returned
   the AGENT ROW's connections/capabilities, so a plain spawn (Platform/Setup `session_spawn`, the companion
   lever, REST `role:"plain"`) was a role-null, unrestricted session holding agent-only grants. Fixed at the
   one chokepoint, `resolveAgentSpawn`: under `forcePlain` BOTH sources are emptied. The spawn is not refused.
2. `profile_delete` (Platform tool, manager `deleteProfileAsManager`) runs
   `boundAgentCredentialGrantRoleChangeError(…, existing.role, null)`: deleting a role-bearing profile drops
   bound agents to role null, so it is refused when any carries its own grant. Human REST delete stays exempt.

## Do not

- Do not widen the null→worker check beyond `connections`/`capabilities` — with no bound profile, every
  other forbidden key already backstops to false/null (`resolveProfile`'s backstop).
- Do not apply the rebind role-change refusal to the human-only REST rebind path — human intent on a
  human-only surface is the accepted exemption shape everywhere in `8b236b22`/`acd3c688`.
- Do not revert `unionCapabilities`'s dedup key to `capabilityGrantKey` (slug + connectionId) — two
  connections could race for one mounted slug. `profileGrants.ts`'s `hasNewEntry` keeps that key.
- Do not read `agentCapabilityProfileCollisionError` as checking anything beyond the slug — different
  slugs coexist fine.
- Do not gate the null→worker check on `agentHasNoProfile`/`!profile` again — that is the exact Round 3
  item 1 bypass; read the agent row's own raw grants unconditionally.
- Do not fold `boundAgentCredentialGrantRoleChangeError` into `roleChangeCapabilityCarryoverError` — they
  check different data; keep two calls.
- Do not add a `restrictedTools`/role-flip-into-`manager` guard to Setup's REBIND path citing this card
  (`8b236b22`'s axis).
- Do not strip the agent row's grants per caller on a plain spawn, or refuse it — `resolveAgentSpawn` only.
