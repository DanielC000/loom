# f900237d — `resume()`/`forkSession()` must pass `forcePlain` for a row pinned to plain, not just `session.role ?? undefined`

## Narrative

`resolveAgentSpawn(agent, config, explicitRole?, forcePlain?)` reads `explicitRole === undefined` as
"no explicit role was given, consult the agent's profile role" — the mechanism `startNew`'s own
role-omitted "+New" path relies on. `resume()` and `forkSession()` both called it as
`resolveAgentSpawn(agent, config, row.role ?? undefined)`, which collapses a row EXPLICITLY pinned to
plain (`role === null` — a human "+New -> force plain" session) into the SAME `undefined` that means "no
opinion, ask the profile". For an agent whose profile confers `worker`/`assistant`
(`PROFILE_SPAWNABLE_ROLES`), this silently WIDENED a plain row on resume/fork: it picked up the profile's
`permission.allow` delta and the worker/assistant `startupModeCycles` -> `auto` pin
(`withRolePermissionModeCyclesPin`) — permission and mode the human never asked for when they chose plain.

Audit finding, full review lane 2 (card `b14d3441`), fixed under card `f900237d`.

## Do not

- Do not call `resolveAgentSpawn(agent, config, row.role ?? undefined)` without ALSO passing
  `forcePlain: row.role === null` at any spawn-adjacent call site that re-derives permission/mode from a
  session row's own pinned role (today: `resume()` and `forkSession()` in `sessions/service.ts`) — the
  `?? undefined` collapse silently re-admits the agent's profile role for an explicitly-plain row.
- Do not "fix" this by keying the forcePlain decision off anything but the row's own `role` column
  (e.g. the profile's role, or an explicit caller param) — the row is the one source of truth for what a
  human actually chose at this session's original start.
- Do not extend this to `harnessDrainStatus()` — it shares the same `s.role ?? undefined` pattern but only
  reads `.harness` off the result, never `.permission`, so it is a read-only diagnostic with no permission
  widening to fix; left alone deliberately (full review lane 2).

## Source

`packages/daemon/src/sessions/service.ts`, `resume()` (`resolvedSpawn` local, just above the agent lookup)
and `forkSession()` (`forkPermission` local).
