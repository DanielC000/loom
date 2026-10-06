# ad098631 — confine elevated/locked-role profile binds to reserved/system projects

## Background

Decision `3de74275` lets the Platform Lead's `agent_create`/`agent_update`/`profile_assign`
(`mcp/platform.ts`) bind an elevated/locked-role profile (`platform`/`auditor`/`workspace-auditor`/
`assistant`/`operator`/`setup` — `LOCKED_PROFILE_ROLES`, `profiles/validate.ts`) via
`allowElevatedRoles: true`, framed as "administering its own home's standing agents." Nothing confined
such a bind to the Lead's reserved home — it could attach an elevated profile to an agent in ANY
ordinary project.

A read-only checkpoint (manager-approved before any edit) found FIVE reachable write sites, not three:

1. `agent_create` → `createAgentCore` (`agents/clone-core.ts`), called with `{allowElevatedRoles:true}`.
2. `agent_update`'s profileId-reassignment branch (`mcp/platform.ts`).
3. `profile_assign` (`mcp/platform.ts`).
4. `profile_update`'s role-flip branch — only ever checked a flip INTO `"manager"` (`ced4285e`); a flip
   into any OTHER locked role was completely unchecked.
5. `agent_clone`/`agent_clone_batch` → `cloneAgentCore` → `clonedProfileRoleError` — this role check only
   ever covered `"operator"` and `isPlatformProfile` (`"platform"`/`"auditor"`); `"setup"` and
   `"workspace-auditor"` were never checked, so cloning one of those cross-project was unguarded.

NOT a gap: `applyWorkflowTemplate`/`template_apply` calls `agentAssignableProfileError` at its TRUE
DEFAULT (no `allowElevatedRoles`, `3de74275`'s "Fix round 2") — templates can never bind a locked role.

**Why this isn't cosmetic:** session-start for these roles (`startPlatformLead`, `startAuditor`,
`startSetup`, `startWorkspaceAuditor`, `startOperator`, `sessions/service.ts`) has no reserved-project
check of its own — each spawns in whatever project the target agent resolves to. A mis-bound profile plus
a later explicit human-REST session-start (already legitimate today) produces a LIVE elevated-MCP-surface
session whose cwd/repoPath is the wrong project.

**Why a non-reserved bind is never legitimately needed:** every bundled rig carrying one of these roles
is seeded into one of the two reserved projects — `platform`/`auditor` into the `LOOM_DEV`-gated "Loom
Platform" project (`platform/seed.ts`), `setup`/`operator`/`workspace-auditor` into the shipped
"Platform" setup home (`setup/seed.ts`; both `reserved:true`, boot-seed only). No seeder, test, or the
platform-lead skill doctrine shows a legitimate bind of any of these five roles outside a reserved home.

## Fix

One new shared predicate, `nonReservedElevatedProfileError(project, profile)` (`agents/clone-core.ts`) —
the structural inverse of `reservedProjectManagerProfileError`: refuses when `profile.role` is in
`LOCKED_PROFILE_ROLES`, is NOT `"assistant"`, and the target project's `reserved` flag is not `true`.

Wired:
- Inside `createAgentCore`, unconditionally, right after the existing `reservedProjectManagerProfileError`
  call — covers BOTH site 1 (`agent_create`) AND site 5 (clone, via `cloneAgentCore`), closing the
  `"setup"`/`"workspace-auditor"` clone gap with no separate change to `clonedProfileRoleError`.
- At `agent_update`'s and `profile_assign`'s existing `reservedErr` call sites (2 and 3).
- A new reverse-scan, `nonReservedAgentBoundToProfile(db, profileId)` — the inverse of
  `reservedProjectAgentBoundToProfile` — in `profile_update`'s role-flip branch (4): when the patch flips
  the role INTO a locked role other than `"assistant"` (and the role actually changes), scan for an agent
  already bound to this profile in a non-reserved project and refuse if found.

**The `"assistant"` exclusion is structural, not a convenience choice.** `createAgentCore` is ALSO the
companion auto-clone's create path (`gateway/server.ts`'s `/api/companion/provision`, human-REST-only,
`humanAuthorized:true`) — a shipped flow that mints `"assistant"`-role agents into ordinary projects by
design (every real per-project companion). The new check runs UNCONDITIONALLY inside `createAgentCore`
(same placement as `reservedProjectManagerProfileError`, no opt-out), so excluding `"assistant"` is what
keeps that flow working — not the safer default. Mirrors why `3de74275` excludes `browserTesting` from
its field check: a real shipped flow depends on the exclusion, not an absence of counter-examples.

**Known, deliberate limitation (not fixed here):** the predicate checks "is this project reserved," never
WHICH one — a `"platform"`-role bind into the Setup home (or `"setup"` into the Loom Platform project)
passes. Manager notified at design time; may card a follow-up for per-role targeting. Today's fix only
closes the sharper "any ordinary project at all" hole.

## Do not

- Do not add `"assistant"` back into the checked role set without auditing the companion auto-clone
  (`gateway/server.ts`) — it is the one caller this exclusion exists to keep working.
- Do not move `nonReservedElevatedProfileError`'s call out of `createAgentCore` into just the three MCP
  call sites "for symmetry" — the unconditional core placement is what closes the clone gap (site 5)
  without a second, separately-drifting check.
- Do not read this record as confining a bind to one SPECIFIC reserved project — see "Known, deliberate
  limitation" above.
- Do not re-implement either predicate's condition inline at a new call site — call the shared predicate
  instead, so the check cannot drift the way the create-time-only manager-role guard once did (`ced4285e`).

## Source

Card `ad098631`. Checkpoint + manager approval preceded any edit (fix all five sites with one shared
predicate; `"assistant"` carve-out approved for the structural reason above; "which reserved project"
noted but not carded yet).
