# 05153988 — a `profile_update` role CHANGE must not silently carry a human-set capability onto the new role

## Narrative

Found in the `8c27ae8e` review (reviewer `14bdf2cf`), as a question rather than a reproduced defect: the
LOOM_DEV Platform Lead's `profile_update` (`mcp/platform.ts`) can change a profile's `role` while leaving
its `AGENT_FORBIDDEN_PROFILE_KEYS`-class fields (`browserTesting`/`documentConversion`/`allowDelta`/
`connections`/`capabilities`/`vaultWrite`/`harness`) untouched. Example: patching a QA-Tester-shaped rig
(`role:"worker", browserTesting:true`) to `role:"assistant"` (plus `restrictedTools`) yields a
companion-role rig with browser automation that no human ever granted for an assistant. The old
`browserTesting` rationale (see `8c27ae8e`) was exactly to keep assistant-role browser access human-only.

The mechanism: `agentProfileKeyError` (`profiles/validate.ts`) only rejects a forbidden key when it
appears in the AGENT's own RAW patch — by design, so an unrelated patch to a profile that already has
e.g. `connections` set (via human REST) passes through untouched. A bare `{role:"assistant"}` patch never
names a forbidden key, so it sails through that check, then `validateProfile({...existing, ...patch})`
merges the existing row's `browserTesting:true` forward into the new, role-changed profile, and
`db.updateProfile` persists it.

Lead ruling (gen 384): on an AGENT `profile_update`, refuse a `role` change outright when the STORED
(pre-patch) profile carries any `AGENT_FORBIDDEN_PROFILE_KEYS`-class human-set capability, naming the
offending keys in the error ("ask the human to change the role in the Profiles UI"). Implemented as
`roleChangeCapabilityCarryoverError` (`profiles/validate.ts`), called from `profile_update`
(`mcp/platform.ts`) after the merged patch validates, before `db.updateProfile`.

### Round 2: the setup surface reaches a narrower instance of this too

Round 1 read "the setup surface can't reach this" because `SETUP_ALLOWED_PROFILE_ROLES` locks the
RESOLVED role to `manager`/`worker`/`null`, so it can never reach the `role:"assistant"` example above —
that part is still true. But Code Review `0fa4e90b` (round 2) found the SAME mechanism reachable there in
a narrower form: a worker-shaped rig carrying a human-set capability (e.g. QA Tester's `browserTesting`)
can still flip `role` to `manager` through `mcp/setup.ts`'s own `profile_update` — manager and worker are
both inside that surface's allowed set, so the capability rides along into a manager-role rig nobody
reviewed it for. The ungated setup surface ships to ALL users, so `roleChangeCapabilityCarryoverError` is
now called there too, right after `validateProfile`, mirroring `platform.ts`.

### Why this INCLUDES `browserTesting`, unlike the assign-time checks

`agentAssignableProfileError`'s field checks (used by `profile_assign`/`agent_update`/`agent_create`/
`agent_clone`) deliberately EXCLUDE `browserTesting` — the `3de74275` decision record's bundled-rig
carve-out exists because the bundled "QA Tester"/"Web Designer" profiles (role `worker`) ship with
`browserTesting:true`, and those profiles must remain assignable onto worker/manager-role agents.

That carve-out does not apply here, because the hazard is a different kind. `profile_assign`/
`agent_update`/`agent_create`/`agent_clone` all bind an EXISTING profile to an agent wholesale — the
profile's `role` and its capability fields travel together, exactly as a human last set them. Reusing an
already-vetted (role, capability) pair across many agents introduces no new combination nobody reviewed.
A `profile_update` role patch is the one surface that can vary the role axis ALONE while the capability
axis is left untouched by construction (the agent's own patch can never touch a forbidden key) —
decoupling a pairing a human decided together. So the role-change gate needs to check `browserTesting`
too, even though the assign-time gate deliberately does not.

### Why `profile_assign` (and `agent_update`/`agent_create`/`agent_clone`'s profileId-binding) is still not the right chokepoint — corrected (round 2)

Round 1 claimed a session's role is resolved ENTIRELY from `agent.profileId → profile.role`, so "there is
no such independent role to carry." **That premise is false** — Round 2 (Code Review `0fa4e90b`) verified
against `resolveAgentSpawn` (`sessions/service.ts` ~2793): `const role = explicitRole ?? profileRole ??
undefined`. An EXPLICIT caller role (`worker_spawn`, REST, the scheduler, `startManager`/`startAuditor`/
`startPlatformLead`, a companion's `explicitRole:"assistant"`) always wins over the bound profile's own
`role` — a session's role absolutely CAN diverge from its profile's `role` field.

What does NOT diverge is the capability grants: `resolveProfile` reads `browserTesting`/
`documentConversion`/`connections`/`capabilities`/`vaultWrite`/`harness`/`allowDelta` straight off the
bound profile regardless of which role the session actually spawns under. So a profile shaped
`role:"worker", browserTesting:true`, bound to an agent that is then spawned with an explicit
`role:"assistant"`, carries `browserTesting:true` onto that session anyway — the exact shape this card's
hazard describes, just produced at SPAWN time via `explicitRole`, not at BIND time via `profile_assign`.

`profile_assign` (and the other profileId-binding surfaces) are still not the right chokepoint for that
hazard, but for a different reason than round 1 gave: binding itself never decouples role from capability
— it moves the profile wholesale, exactly as a human last set it. The decoupling happens later, at
`resolveAgentSpawn`, when an explicit caller role is layered over the bound profile's grants; a bind-time
check can't see a divergence that is only introduced at spawn time. The spawn-time question — whether an
explicit-role spawn should carry a bound profile's grants onto a role nobody reviewed them for — is
tracked by the discovered follow-up card `acd3c688` ("stop an explicit-role spawn from carrying profile
grants onto another role"), not by this one.

## Do not

- Do not check the carry-over gate against the MERGED result instead of the stored (pre-patch) profile —
  they read identically today (an agent's own patch can never introduce/change a forbidden key), but the
  card's own framing ("while the STORED profile carries...") is the stated contract; don't optimize that
  away speculatively.
- Do not add this same refusal to `profile_assign`/`agent_update`/`agent_create`/`agent_clone`'s
  profileId-binding checks — binding itself never decouples role from capability (it moves the profile
  wholesale); the real decoupling happens later, at `resolveAgentSpawn`, when an explicit caller role is
  layered over the bound profile's grants (see the analysis above). That spawn-time hazard belongs on
  card `acd3c688`, not on a bind-time check here.
- Do not assume a session's role always equals its bound profile's `role` field — `resolveAgentSpawn`
  resolves `explicitRole ?? profileRole`, so an explicit caller role can diverge from the profile's own
  role while still inheriting that profile's capability grants (round 1 of this record asserted the
  opposite; it was never verified against `resolveAgentSpawn` and was wrong).
- Do not drop `browserTesting` from this role-change check to mirror `agentAssignableProfileError`'s
  assign-time exclusion — the two checks guard different hazards (see "Why this INCLUDES
  `browserTesting`" above); the `3de74275` bundled-rig carve-out is about ASSIGN, not about independently
  varying a profile's own role while leaving its capabilities alone.

## Source

`roleChangeCapabilityCarryoverError` in `packages/daemon/src/profiles/validate.ts`, called from
`profile_update` in both `packages/daemon/src/mcp/platform.ts` and `packages/daemon/src/mcp/setup.ts`.
