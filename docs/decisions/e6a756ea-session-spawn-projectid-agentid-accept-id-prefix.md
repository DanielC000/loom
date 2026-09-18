# e6a756ea — `spawnSessionAsPlatform`'s `projectId`/`agentId` accept a full id OR an id-prefix

## The defect

`session_spawn({projectId: "c348c3b5", ...})` returned `{"error":"project not found"}` for a project
that demonstrably existed — the same 8-char prefix had just worked on `project_task_update` and
`list_all_tasks` seconds earlier. The message asserted the wrong thing: *"project not found"* is a claim
about existence; the real condition was *"this tool requires a full id."* Filed by the Platform Lead,
first-hand, while spawning the codex pilot manager (2026-09-18).

Root cause: `spawnSessionAsPlatform` did an exact-id-only `db.getProject(projectId)` /
`db.getAgent(agentId)` lookup, while every sibling `*_get` tool (`project_get`, `agent_get`,
`project_task_get`, `profile_get`, …) already accepts the full id OR an unambiguous 8-char id-prefix via
the shared `getByIdPrefix` resolver (`id-prefix.ts`). `session_spawn` was the one MCP tool that silently
differed, and its description never said so.

## The decision

Accept prefixes (not reject with an honest message) — reusing the SAME `getByIdPrefix` resolver every
sibling tool uses, never a hand-rolled second resolution. An ambiguous prefix stays an explicit error
naming the candidate ids, exactly as `project_get` does (that behavior comes for free from
`getByIdPrefix`/`resolveIdPrefix`).

`agentId` resolution is scoped to the RESOLVED project's own agents (`db.listAgents(project.id)`), not
cross-project like `agent_get`'s own resolution — deliberate: the caller already named a project, so
narrowing the candidate pool there gives a tighter, more specific "agent not found" instead of a spurious
cross-project ambiguity. The exact-id fast path (`db.getAgent`) inside `getByIdPrefix` is NOT
project-scoped though, so the pre-existing `agent.projectId !== project.id` "agent does not belong to the
given project" check stays load-bearing for a full agentId belonging to a different project.

## One fix, three surfaces

`spawnSessionAsPlatform` is called by all THREE `session_spawn` MCP tool registrations:
`mcp/platform.ts` (loom-platform, the Platform Lead), `mcp/setup.ts` (loom-setup, byte-identical call),
and the companion `session-spawn` capability lever (`companion/capabilities.ts` → `mcp/orchestration.ts`'s
`spawnSession` wiring). Fixing the one shared method fixes all three call sites — no router-level
duplication was needed or added.

The companion lever's own `project` param is separately gated by an exact-match
`ctx.scope.projectIds.has(project)` check BEFORE it ever reaches this method, so a project-prefix typed
into that lever still fails there first, with `scopeDenialMessage` (a different, correctly-worded error —
out of scope for this card, not touched).

## Do not

- Do not hand-roll a second prefix-resolution scheme for `projectId`/`agentId` here — reuse
  `getByIdPrefix` (`id-prefix.ts`), or a fourth call site will drift from the other `*_get` tools again.
- Do not silently drop the `agent.projectId !== project.id` check on the theory that scoping
  `listAgents` to the project makes it redundant — the exact-id fast path bypasses that scoping.
