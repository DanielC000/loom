# d25e4ea7 — unify the reserved-project and operational-home predicates behind one `managerSessionBarredFrom`

## Background

`ced4285e`'s "Predicate divergence" section (see that record) found two DIFFERENT predicates guarding the
same hazard — a manager-role agent/session landing somewhere a manager session can never actually start:

- The create/clone/reassign/template guards (`reservedProjectManagerProfileError`,
  `reservedProjectAgentBoundToProfile`, both `agents/clone-core.ts`) key on `project.reserved` alone.
- The session-start guard (`refuseManagerIntoReservedHome`, `sessions/service.ts`) keys on
  `isLoomHomeOrAncestor(project.repoPath)` alone (`vault/versioner.ts`).

These agree for the two boot-seeded reserved homes today (both hard-code `repoPath === LOOM_HOME`), but
can diverge in EITHER direction once a `repoPath` is rebound:

- **Over-refusal**: a RESERVED project's `repoPath` rebound away from `LOOM_HOME` — `project.reserved`
  stays `true` forever, so the clone-core guards keep refusing even though `isLoomHomeOrAncestor` is now
  `false` (session-start would actually allow a manager there).
- **Under-protection**: an ORDINARY (non-reserved) project's `repoPath` rebound TO `LOOM_HOME` or an
  ancestor of it — `project.reserved` is `false`, so none of the clone-core guards fire, but
  `isLoomHomeOrAncestor` is `true`, so session-start WOULD still refuse a manager there — recreating the
  stranded-row hazard through a door the clone-core guards can't see.

## Fix

- `managerSessionBarredFrom(project)` (`agents/clone-core.ts`) — THE one predicate: `project.reserved ===
  true || isLoomHomeOrAncestor(project.repoPath)`. Every existing reserved-project-shaped guard now calls
  this instead of re-deriving either half on its own:
  - `reservedProjectManagerProfileError` / `reservedProjectAgentBoundToProfile` (`agents/clone-core.ts`) —
    both callers of `createAgentCore`, `agent_update`/`profile_assign`/`profile_update` (`mcp/platform.ts`
    and, for `profile_update`, `mcp/setup.ts`), and `applyWorkflowTemplate` (`setup/templates.ts`) inherit
    the fix for free — no call-site edits needed there.
  - `refuseManagerIntoReservedHome` (`sessions/service.ts`) — the session-start chokepoint, called from
    both `startManager` and `startNew`'s profile-resolved-role path.
  - `assignAgentProfile` (`sessions/service.ts`, the manager surface's `agent_assign_profile`) — newly
    ALSO checked via `reservedProjectManagerProfileError`. Not reachable via a live manager spawn today
    (`requireOwnProject` + the now-unified session-start guard already keep a manager from ever running
    inside a barred project), but added for defense-in-depth per this card's added scope.
- `checkRepoRebind` (`projects/rebind.ts`, the ONE shared chokepoint for both the Platform Lead's
  agent-facing `project_update` and the human REST PATCH path) now refuses rebinding `repoPath` for a
  reserved project, unless `opts.humanAuthorized` — same family pattern as `3de74275`'s field check. The
  Platform Lead's call site (`mcp/platform.ts`) passes no flag (fail-closed — this is the actual gap this
  card closes: before this fix, `mcp/platform.ts`'s `project_update` had NO reserved check at all before
  calling `checkRepoRebind`). The REST PATCH call site (`gateway/server.ts`) now passes
  `humanAuthorized: true`.
  - **Finding**: `gateway/server.ts`'s PATCH route ALREADY carried its own, independent, UNCONDITIONAL
    `if (p.reserved) return ...` refusal (pre-existing, before this card), placed BEFORE it ever reaches
    `checkRepoRebind`. So passing `humanAuthorized: true` from REST is a no-op today — the earlier inline
    check always fires first for a reserved project. The flag is still passed, for consistency with the
    `3de74275` family pattern and so `checkRepoRebind` stays correct in isolation if that inline REST
    check is ever refactored away. The REST PATCH path's OBSERVABLE behavior is unchanged by this card —
    it already refused a reserved rebind, for everyone, before and after.
  - `setup.ts`'s own `project_update` tool cannot reach `checkRepoRebind` at all — its `inputSchema`
    (`strictShape`) never accepts `repoPath` (human/REST-only field, per that tool's own description).
    Nothing to change there.
- Grepped for every `db.updateProject` call site in the daemon (5 total, the only writer of this field):
  `gateway/server.ts` (REST, covered above), `mcp/platform.ts` (Platform Lead, covered above),
  `setup/seed.ts`'s `seedSetupProjectRename` ("Getting Started" → "Platform" rename backfill — patches
  `name` only, never `repoPath`), `mcp/setup.ts`'s own `project_update` (`name`/`vaultPath` only), and
  `sessions/service.ts`'s manager `project_configure` (`name`/`vaultPath` only, via
  `assignAgentProfile`'s sibling `updateAgentPreset`-shaped method). No boot migration, seed, or any other
  non-tool writer ever rewrites an existing project's `repoPath` — the two reserved homes' `repoPath` is
  set once, at `insertProject` time, in `platform/seed.ts` / `setup/seed.ts`.

## Follow-up (code review `6fff4ba4`): session-start refusal text

Unifying the predicate in `refuseManagerIntoReservedHome` left its THROWN TEXT unchanged:
`OPERATIONAL_HOME_GIT_WRITE_ERROR` ("...the repo path resolves to Loom's own operational home directory —
nothing was written"). That's accurate for cases (a)/(b)/(f) above (repoPath really does resolve to
`LOOM_HOME` or an ancestor), but FALSE for case (h) — a truly reserved project whose `repoPath` has
drifted to an ordinary repo: it's a session start, not a git write, and in that case the path isn't the
home either. Fixed by throwing a new, dedicated `MANAGER_SESSION_BARRED_ERROR` (`agents/clone-core.ts`,
next to `managerSessionBarredFrom`) that names BOTH halves disjunctively — "a reserved/system project, or
its repoPath is the workspace home or an ancestor of it" — so it's true regardless of which half actually
matched. Wording mirrors `reservedProjectManagerProfileError`'s existing text for consistency.
`OPERATIONAL_HOME_GIT_WRITE_ERROR` itself is untouched and keeps its original meaning at every GIT-WRITE
chokepoint (`GitWriter`, `createWorktree`, `confirmWorkerMerge`'s own re-resolved-repoPath guard,
companion git-push) — those really are refusing a git write whose target resolves to the operational
home, so that text stays correct there. Only the SESSION-START chokepoint's message changed.

## Do not

- Do not re-derive `project.reserved` or `isLoomHomeOrAncestor(project.repoPath)` separately at a new
  reserved-project-shaped guard — call `managerSessionBarredFrom` (or, when a profile is already in hand,
  `reservedProjectManagerProfileError`) instead, so the two checks cannot drift apart again.
- Do not throw `OPERATIONAL_HOME_GIT_WRITE_ERROR` from `refuseManagerIntoReservedHome` (or any other
  session-start-only refusal) — that text asserts the repoPath itself resolves to the operational home,
  which is false for a reserved-but-drifted project. Use `MANAGER_SESSION_BARRED_ERROR` instead, which
  names both halves disjunctively and stays true no matter which one actually matched.
- Do not read the `checkRepoRebind` `humanAuthorized` flag as having changed the human REST PATCH path's
  observable behavior — it already refused a reserved-project `repoPath` rebind unconditionally, via its
  own pre-existing inline check in `gateway/server.ts`, before this card. The flag only closes the
  Platform Lead's (`mcp/platform.ts`) `project_update` gap, which had no reserved check at all.
- Do not remove or loosen `gateway/server.ts`'s own inline reserved-project `repoPath`-rebind refusal to
  "simplify" onto `checkRepoRebind` alone — it predates this card and was deliberately left in place.
- Do not add a guard preventing an ORDINARY (non-reserved) project from being created or rebound to a
  `repoPath` that IS `LOOM_HOME`-or-an-ancestor — out of scope for this card. `managerSessionBarredFrom`
  already closes the actual hazard (a manager-role profile landing somewhere a manager can never start)
  regardless of how such a `repoPath` arises; blocking the create/rebind itself is a separate, broader
  behavior change this card deliberately does not make.
