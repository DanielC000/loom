# ced4285e — refuse binding a manager-role profile to an agent in a reserved project, at every reassignment route, not just at mint time

## Background

Card `73c16ec8` added a guard in `createAgentCore` (`packages/daemon/src/agents/clone-core.ts`):
refuse minting (or cloning) an agent with a manager-role profile into a reserved/system project (the
Setup/Platform home). The reason: `37e15c26`'s session-start guard (`sessions/service.ts`) refuses any
session whose resolved role is `"manager"` when `isLoomHomeOrAncestor(project.repoPath)` is true — this
is a PATH-based check (is `repoPath` itself `LOOM_HOME`, or an ancestor of `LOOM_HOME`/`WORKTREES_DIR`),
**not** a check of `project.reserved`. For the two boot-seeded reserved homes this reads the same, because
both hard-code `repoPath = LOOM_HOME` (`platform/seed.ts`, `setup/seed.ts`) — so in practice, today, a
manager-role agent minted into a reserved project is indeed a permanently dangling row. See "Predicate
divergence" below for where the two checks can disagree.

That guard only fires at CREATE/CLONE time. The same stranded-row state is reachable by three other
routes that never go through `createAgentCore`:

1. **Reassigning an existing agent's profile** — the Platform Lead's `agent_update` and `profile_assign`
   (`mcp/platform.ts`) write `profileId` directly via `db.updateAgent`, with no reserved-project check.
   An agent already living in a reserved project could be reassigned a manager-role profile.
2. **Flipping an existing profile's role** — `profile_update` (`mcp/platform.ts`) can patch a profile's
   `role` to `"manager"`. A profile is a shared, cross-project record: if it's already bound to an agent
   in a reserved project, the role flip strands that agent without ever touching the agent row at all.
3. **Moving an agent to a different project** — investigated and found NOT reachable: `Agent.projectId`
   is set once at insert; `db.updateAgent`'s patch type, `agents/validate.ts`'s `AgentPatch`/
   `validateAgentPatch` (shared by the human REST `POST /api/agents/:id` and the platform/setup MCP
   `agent_update` tools), and the manager-surface `updateAgentPreset` all omit `projectId` entirely —
   there is no write path anywhere in the daemon that can change an existing agent's project.

The manager-surface (`mcp/orchestration.ts`) and setup-surface (`mcp/setup.ts`) equivalents of routes 1
and 2 were checked and found already safe: a manager session can never itself run inside a reserved
project (`37e15c26`), so its own `agent_assign_profile`/`agent_update` can never reach an agent there;
and `setupMayTouchAgentError` (`mcp/setup.ts`) already refuses ANY edit to an agent in a reserved project
regardless of role.

## Fix

- `reservedProjectManagerProfileError(project, profile)` (`clone-core.ts`) — the ONE predicate for route
  1 and for the original create/clone guard. `createAgentCore` now calls it instead of its own inline
  check; the Platform Lead's `agent_update` and `profile_assign` call it before writing `profileId`.
- `reservedProjectAgentBoundToProfile(db, profileId)` (`clone-core.ts`) — for route 2. Scans every live
  project (a reserved project can never be archived — `mcp/setup.ts`'s `project_archive` refuses it) for
  an agent already bound to the profile being edited. `profile_update` calls it whenever the resolved new
  role is `"manager"` and refuses the whole patch if a stranding agent is found.

## Round 2 (Code Review `04e0e82c` — CHANGES)

Round 1 missed two further reachable routes to the same stranded-row hazard, and left the `profile_update`
guard gated too broadly.

1. **`template_apply` can mint a manager-role agent into a reserved project.** `template_apply`
   (`mcp/platform.ts`/`mcp/setup.ts`) calls `applyWorkflowTemplate` (`setup/templates.ts`), which writes
   agent rows via `db.insertAgent` directly — never through `createAgentCore` — so round 1's guard there
   never fired for it. The "Software team (orchestrated)" / "Solo builder" templates both include an
   "Orchestrator" agent bound to the manager-role "Orchestrator" profile, so applying either template to
   a reserved project minted exactly the dangling row this card exists to prevent (reproduced). Fixed
   INSIDE `applyWorkflowTemplate`'s own all-or-nothing pre-flight (not at either MCP call site): every
   resolved `{spec, profile}` pair is also checked via `reservedProjectManagerProfileError(project,
   profile)`, skippable only by `opts.humanAuthorized` — the SAME opt-out `agentAssignableProfileError`'s
   field check already uses there (`@decision 3de74275`), so the human REST template-apply route
   (`gateway/server.ts` ~3894, `humanAuthorized: true`) is exempt, matching that route's established
   trust posture; the Platform Lead's `template_apply` is NOT exempt and is refused. The setup surface's
   own `template_apply` already refused ANY reserved `projectId` outright before ever calling
   `applyWorkflowTemplate` (`mcp/setup.ts` ~628, card `4d70cc06`) — this fix is a backstop there, not its
   only defense, and does not change its behavior (a reserved `projectId` was already rejected earlier).
2. **Setup's own `profile_update` had the same gap as round 1's `profile_update` fix (route 2 above), unfixed.**
   The original "already safe" survey (see "Background" above) covered setup's `agent_update`/
   `profile_assign` (routes 1-shaped) but never checked setup's `profile_update` — which CAN flip a
   profile's role to `"manager"` (`setupRoleError` allows manager/worker/null) and is shipped to every
   user, not just the dev-gated Platform Lead. Fixed identically to the platform.ts version: calls
   `reservedProjectAgentBoundToProfile` under the same condition.
3. **Both `profile_update` guards (platform.ts and setup.ts) are now gated on a role FLIP, not the
   resolved role.** Round 1 checked `v.value.role === "manager"` unconditionally, which refused an
   unrelated patch to a profile that was ALREADY `"manager"` — a profile that is already manager-role can
   still be bound to a reserved-project agent (a human REST write path has no such guard, and nothing
   stops a direct `db.insertAgent`/`db.updateAgent` from creating that binding outside any MCP guard), so
   round 1's check could wrongly refuse a same-role patch on exactly that profile. Both now check
   `existing.role !== "manager" && v.value.role === "manager"` — a genuine role transition — so a
   same-role patch is never incorrectly refused.

### Predicate divergence (reserved vs. path-based) — stated, not fixed here

This card's guards key on `project.reserved`. `37e15c26`'s session-start guard keys on
`isLoomHomeOrAncestor(project.repoPath)` (see "Background" above, corrected in round 2). These are TWO
DIFFERENT predicates that happen to agree for the two boot-seeded homes today, but can diverge in EITHER
direction once a project's `repoPath` is rebound — `project_update` (`mcp/platform.ts` ~2542) rebinds
`repoPath` for "any project by id" with no reserved-project exclusion of its own:

- **Over-refusal:** a reserved project's `repoPath` is rebound away from `LOOM_HOME` (to an ordinary git
  repo). `project.reserved` stays `true` forever (it is set once, at boot-seed, and never otherwise
  written), so this card's guards keep refusing a manager-role bind there — even though
  `isLoomHomeOrAncestor` is now `false` and `37e15c26` would actually let a manager session start.
- **Under-protection (the sharper direction):** an ORDINARY (non-reserved) project's `repoPath` is rebound
  to `LOOM_HOME` itself, or to a path that is an ancestor of `LOOM_HOME`/`WORKTREES_DIR`. `project.reserved`
  is `false`, so none of this card's guards fire — a manager-role agent can be freely minted or reassigned
  there. But `37e15c26` WOULD still refuse that manager session from ever starting, on the path check
  alone. This recreates the exact stranded-row hazard this card exists to close, through a door this
  card's own guards cannot see.

Not fixed here: unifying the two predicates into one shared "may a manager session ever start here" check
is carded separately (`d25e4ea7`, discovered from this card) — a larger refactor than this round's scope.
This section exists so a future reader does not mistake `project.reserved` for a complete proxy of
`isLoomHomeOrAncestor`, or vice versa.

## Do not

- Do not re-implement the reserved-project/manager-role condition inline at a new call site — call
  `reservedProjectManagerProfileError` (agent/profile pair already in hand) or
  `reservedProjectAgentBoundToProfile` (profile-role-change — scans for bound agents) instead, so this
  check cannot drift the way the create-time-only version did.
- Do not assume `agent_update`/`profile_assign`/`profile_update`'s existing `agentAssignableProfileError`
  call covers this — that predicate checks locked ROLES (platform/auditor/etc.) and human-only FIELDS; it
  has no project context and does not treat `"manager"` as locked (manager/worker are the two
  assignable-by-default roles).
- Do not add a projectId-move check "for completeness" — there is no code path that moves an agent
  between projects today; if one is ever added, route it through `reservedProjectManagerProfileError`
  first.
- Do not add a NEW agent-row writer (templates, bulk-import, anything else that calls `db.insertAgent`
  directly instead of going through `createAgentCore`) without also routing it through
  `reservedProjectManagerProfileError` — `template_apply`/`applyWorkflowTemplate` is exactly this gap,
  found in round 2.
- Do not gate a `profile_update` reserved-project check on the RESOLVED role alone — gate it on a FLIP
  (`existing.role !== "manager" && new role === "manager"`), or an unrelated patch to an already-manager
  profile is wrongly refused (round 2, MINOR).
- Do not treat `project.reserved` and `isLoomHomeOrAncestor(repoPath)` as the same check, or assume
  fixing one surface for one predicate closes the other — see "Predicate divergence" above. A new
  reserved-project-shaped guard should state which of the two it means.
