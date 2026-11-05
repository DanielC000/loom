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

## Round 5 — the restrictedTools axis (card `6baaa83d`, found by Code Review #4; manager-approved design)

The guards above keyed on ROLE only. For a grant-carrying agent, relaxing `restrictedTools` true→false
reached the same end state as Round 4 item 1 (role-null, unrestricted, holding agent-only grants):
`profile_update` (Setup, Platform), `profile_delete` (Platform, manager — a role-null restricted profile is
null→null on role, and the delete backstop is unrestricted), and a rebind onto an unrestricted profile or a
clear to `profileId: null` (Setup/Platform `agent_update` + `profile_assign`). Fix: ONE core,
`agentGrantWideningAxes(before, after)` (`profiles/validate.ts`) — role changed, or restrictedTools
true→false — behind the two existing predicates, which now take before/after `{role, restrictedTools}`
instead of two role strings. Deletes pass (existing fields, `PROFILE_DELETE_BACKSTOP_FIELDS`); rebinds pass
`rebindWideningFields`' pair; updates pass `grantFieldsOf(existing)` / `grantFieldsOf(merged)`. Hard refusal
on every agent-facing path, human REST still exempt, role-bearing restricted profiles guarded on this axis
too. The manager's `agent_assign_profile` already refused any restrictedTools removal regardless of grants
(`agentRebindRestrictedToolsWideningError`, untouched; regression-tested). Test:
`agent-grant-restricted-tools-guard.mjs` asserts the END STATE through `resolveAgentSpawn`, not just the text.

**Supersedes** the Do-not below about restrictedTools guards on Setup's rebind path: its premise was that
Setup's rebind had no grant-bearing agent to protect; an agent-row grant makes the restriction part of the
context the grant was approved in. The `8b236b22` axis is still unguarded for agents WITHOUT their own grant.

**Fan-out grants ARE counted (deliberate).** Agent-row grants that `afe1bc90`'s fan-out wrote
(`Db.getFanoutExemption`) count as the agent's own grant for the new guard, unlike
`explicitRoleGrantCarryoverError`, which exempts them on the null→worker leg. Reason: fail-closed, and
consistent with the Round 3/4 role-axis guards (which also count them). A human can still relax it via REST.
Final round also replaced the old source-text grep of `gateway/server.ts` with a behavioural REST-exemption
check (real `buildServer` + `app.inject`: human profile DELETE and agent rebind to `profileId:null` succeed),
and added a capabilities-only fixture and a pre-dangling-`profileId` fixture to the test.

## Do not

- Do not widen the null→worker check beyond `connections`/`capabilities` — with no bound profile, every
  other forbidden key already backstops to false/null (`resolveProfile`'s backstop).
- Do not apply the rebind role-change refusal to the human-only REST rebind path — human intent on a
  human-only surface is the accepted exemption shape everywhere in `8b236b22`/`acd3c688`.
- Do not revert `unionCapabilities`'s dedup key to `capabilityGrantKey` (slug + connectionId) — two
  connections could race for one mounted slug. Since `afe1bc90` only the fan-out migration calls the
  union; spawn resolution reads the agent row alone.
- Do not reintroduce `agentCapabilityProfileCollisionError`: removed by `afe1bc90` — a profile can no
  longer grant a slug, so there is nothing for an agent grant to collide with.
- Do not gate the null→worker check on `agentHasNoProfile`/`!profile` again — that is the exact Round 3
  item 1 bypass; read the agent row's own raw grants unconditionally.
- Do not fold `boundAgentCredentialGrantRoleChangeError` into `roleChangeCapabilityCarryoverError` — they
  check different data; keep two calls.
- ~~Do not add a `restrictedTools`/role-flip-into-`manager` guard to Setup's REBIND path citing this card
  (`8b236b22`'s axis).~~ **SUPERSEDED by Round 5** for the `restrictedTools` axis, and only when the agent
  carries its own connections/capabilities grant; a role flip into `manager` for a grant-free agent stays
  unguarded.
- Do not add a second, parallel restrictedTools check beside `agentGrantWideningAxes`; extend that core.
- Do not make the human REST profile/agent routes call either predicate (human intent, exempt).
- Do not hand-copy the delete backstop for the `profile_delete` guards; pass `PROFILE_DELETE_BACKSTOP_FIELDS`.
- Do not strip the agent row's grants per caller on a plain spawn, or refuse it — `resolveAgentSpawn` only.
