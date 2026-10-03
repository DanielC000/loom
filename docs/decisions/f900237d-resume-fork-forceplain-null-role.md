# f900237d — `resume()`/`forkSession()` must pass `forcePlain` for a row pinned to plain, not just `session.role ?? undefined`

## Narrative

`resolveAgentSpawn(agent, config, explicitRole?, forcePlain?)` reads `explicitRole === undefined` as
"no explicit role was given, consult the agent's profile role" — the mechanism `startNew`'s own
role-omitted "+New" path relies on. `resume()` and `forkSession()` both called it as
`resolveAgentSpawn(agent, config, row.role ?? undefined)`, which collapses a row EXPLICITLY pinned to
plain (`role === null` — a human "+New -> force plain" session) into the SAME `undefined` that means "no
opinion, ask the profile". For an agent whose profile confers `manager`/`worker`/`assistant`
(`PROFILE_SPAWNABLE_ROLES` — all three members, not just worker/assistant), this silently WIDENED a
plain row on resume/fork: it picked up the profile's `permission.allow` delta (every member) and, for a
worker/assistant profile specifically, the `startupModeCycles` -> `auto` pin
(`withRolePermissionModeCyclesPin`, which pins only those two roles, not manager) — permission and mode
the human never asked for when they chose plain.

Audit finding, full review lane 2 (card `b14d3441`), fixed under card `f900237d`.

## Round 2 (Code Review `7fd9a414` — CHANGES-REQUESTED, 1 Major)

Round 1's blanket `forcePlain: row.role === null` is ITSELF a fail-closed narrowing regression:
`role === null` does not only mean "a human forced plain". `startNew` WITHOUT `forcePlain` also writes a
role-null row when (a) the agent's profile itself has `role: null` (its allowDelta still applies — the
`resolveProfile` role-clamp only ever touches the *role* field, read before the clamp) or (b) the
profile's role is clamped out of `PROFILE_SPAWNABLE_ROLES` (platform/auditor/setup/run ⇒ `profileRole`
undefined; same story — the allowDelta is layered before the clamp). Both (a) and (b) legitimately
booted WITH the profile's allowDelta, and round 1 stripped it on every resume/fork.

**Interim ruling (no schema change):** pass `forcePlain` for a role-null row ONLY when the agent's
CURRENT profile would itself confer a `PROFILE_SPAWNABLE` role (`manager`, `worker`, or `assistant` —
all three members) — i.e. `resolveAgentSpawn` without `forcePlain` would set a non-null role. That is
exactly the widening this card names (a plain row on a manager/worker/assistant-profile agent); cases (a)
and (b) keep their allowDelta. Implemented as `profileConfersSpawnableRole(agent)`, reusing
`resolveProfile` + the shared `profileSpawnRole` clamp predicate (round 3 minor 1, also used by
`resolveAgentSpawn`'s own `profileRole` computation so the two can never independently drift) — the same
precedence `resolveAgentSpawn` itself uses.

**Accepted residual:** a human's ACTUAL `forcePlain` start on an agent whose profile itself has role
null or a clamped role is INDISTINGUISHABLE, by row inspection alone, from cases (a)/(b) above — the row
carries no discriminator for *why* its role is null. Such a session regains that profile's allowDelta on
resume/fork, exactly as if it had never been forced plain (pre-existing behaviour, not newly introduced
by round 2). The SAME residual also covers a `forcePlain` start on a profile that WAS spawnable at start
time but is LATER edited to a null/clamped role, or whose `profileId` is reassigned to a null/clamped
profile — `profileConfersSpawnableRole` re-resolves the CURRENT profile live on every resume/fork, so
such a session regains the NEW profile's allowDelta exactly as main does today (round 3 minor 2).
Exact handling needs a persisted discriminator (a real `forcedPlain` column) — carded separately as
`963462f5` ("persist a forced-plain flag so resume keeps a human's plain choice exactly"), which fixes
both the original-profile and the later-edited/reassigned case.

## Do not

- Do not call `resolveAgentSpawn(agent, config, row.role ?? undefined)` without ALSO passing
  `forcePlain` at any spawn-adjacent call site that re-derives permission/mode from a session row's own
  pinned role (today: `resume()` and `forkSession()` in `sessions/service.ts`) — the `?? undefined`
  collapse silently re-admits the agent's profile role for an explicitly-plain row.
- Do not key that `forcePlain` decision off the row's `role === null` alone (round 1's bug) — a role-null
  row is NOT a complete record of "a human forced plain"; it is also what a role-omitted start legitimately
  writes when the profile itself confers no spawnable role (profile role null, or clamped out of
  `PROFILE_SPAWNABLE_ROLES`). Key it off `row.role === null && profileConfersSpawnableRole(agent)` instead
  (the agent's CURRENT profile, re-resolved live — never a persisted guess). The accepted residual this
  still leaves open (a genuine forced-plain start on a null/clamped-role profile) is tracked by `963462f5`,
  not by this record.
- Do not extend this to `harnessDrainStatus()` — it shares the same `s.role ?? undefined` pattern but only
  reads `.harness` off the result, never `.permission`, so it is not a permission issue; any analogous
  question there is tracked separately, not by this record.

## Source

`packages/daemon/src/sessions/service.ts`, `resume()` (`resolvedSpawn` local, just above the agent lookup),
`forkSession()` (`forkPermission` local), and the shared `profileConfersSpawnableRole()` and
`profileSpawnRole()` helpers just above `resolveAgentSpawn`.
