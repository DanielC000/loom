# 4d70cc06 — the ungated setup surface may never touch an already-elevated/locked agent or profile

## Narrative

Full review lane 4 (card `486d4238`) surfaced three related gaps in `packages/daemon/src/mcp/setup.ts`
(the ungated "Platform" operator that ships to every user):

- B2: `profile_assign` and `agent_update({profileId})` checked only the NEW profile's role
  (`setupRoleError`), never the target agent's CURRENT rig. The ungated operator could rebind the
  Companion to a plain profile, or clear its profile assignment entirely, silently dropping the
  Companion's human-only `restrictedTools` — the chat-reachable, untrusted-input Companion would then
  regain Bash/Edit/Write on its next spawn (`resolveAgentSpawn` sources `restrictedTools` only from the
  profile). This broke `profiles/validate.ts`'s "a companion can never self-widen" posture and the
  `8feb55b8` decision (a companion's blast radius must be a recorded human choice).
- M1: `agent_update` could edit ANY agent's `startupPrompt` across projects — the Workspace Auditor
  (unattended, scheduled), the Companion, the Elevated Operator (whose brief is injected into a session
  holding `git_commit`/`git_push`/`vault_write`), and under `LOOM_DEV` the Platform Lead/Audit briefs. A
  confused-deputy escalation. `profile_update` could also edit setup's own "Setup Assistant" profile
  (self-modification) — and, more subtly, could downgrade any locked-role profile by patching its `role`
  to `null` in the SAME call that also stripped another field (e.g. `restrictedTools`): the RESOLVED
  role passed `setupRoleError` (null is always allowed) while the write still landed.
- M2: `agent_create` never applied `setupRoleError` to its `profileId` — a two-path asymmetry with
  `agent_update`/`profile_assign`. It accepted an assistant-role profile on a brand-new agent.

## Code review follow-ups (folded into the same fix, same branch)

A Code Reviewer pass on the first version of this fix (commit `2112d553`) came back HEALTHY (no bypass
of the checks above), but raised three further findings that shaped the CURRENT shape of the guard:

- **Setup-role mint ratchet.** `SETUP_ALLOWED_PROFILE_ROLES` used to include `"setup"`, so
  `profile_create({role:"setup"})` succeeded while `profile_update` on that same row was immediately
  refused (it's in `SETUP_LOCKED_ROLES`) — a one-way ratchet with no legitimate use on the far side,
  since `PROFILE_SPAWNABLE_ROLES` (`sessions/service.ts`) already drops `"setup"` at spawn, making any
  such rig dead weight. `"setup"` is now excluded from `SETUP_ALLOWED_PROFILE_ROLES` too, closing the
  ratchet at mint time.
- **`SETUP_LOCKED_ROLES` is now DERIVED, not hand-listed** — "every `PROFILE_ROLE_SCHEMA` role except
  manager/worker" (profiles/validate.ts), so a future role added to that enum is locked here
  automatically, fail-closed, instead of silently staying touchable until someone remembers to add it.
- **Reserved-home name hijack.** The ungated surface could rename the real "Companion" agent away (a
  bare rename was deliberately EXEMPT from the lock in the first version of this fix) and then
  `agent_create` an impostor named "Companion" in the same reserved home — `gateway/server.ts`'s default-
  companion resolution is BY NAME, so this DoSes the human's "New companion" flow. Fixed two ways:
  `agent_update` now runs `setupMayTouchAgentError` unconditionally, BEFORE parsing the patch, so a bare
  rename of a locked/reserved-home agent is refused exactly like a profile/prompt edit; `agent_create`
  and `template_apply` now both refuse a reserved/system `projectId` outright (the same `project.reserved`
  read `setupMayTouchAgentError` uses), so no agent — impostor or otherwise — can be created there at all.

## Do not

- Do not let `profile_assign` or `agent_update` (ANY edit, a bare rename included) proceed on an agent
  whose CURRENT rig role is anything but manager/worker/null, or that lives in a reserved/system project
  — regardless of what NEW role/name the caller is trying to assign. Route through
  `setupMayTouchAgentError` (`mcp/setup.ts`).
- Do not let `profile_update` apply ANY patch (including a `role`-clearing one) to a profile whose
  EXISTING role is anything but manager/worker/null — check `existing.role` via `setupLockedRoleError`
  before merging the patch, not just the post-merge resolved role.
- Do not let `agent_create` accept a `profileId` without running `setupRoleError` on its resolved role,
  or let it (or `template_apply`) write into a reserved/system project — keep all three writers
  (`agent_create`, `agent_update`, `profile_assign`) symmetric, and keep the reserved-project check
  wherever an agent can be minted.
- Do not re-add `"setup"` to `SETUP_ALLOWED_PROFILE_ROLES` — it is caller-locked at spawn
  (`PROFILE_SPAWNABLE_ROLES`) and locked against edits (`SETUP_LOCKED_ROLES`), so minting one through this
  surface has no legitimate use.
- Do not hand-list `SETUP_LOCKED_ROLES` again — derive it from `PROFILE_ROLE_SCHEMA.options`.

## Source

`packages/daemon/src/mcp/setup.ts` — `SETUP_ALLOWED_PROFILE_ROLES`, `SETUP_LOCKED_ROLES`,
`setupLockedRoleError`, `setupMayTouchAgentError`, and their call sites in `profile_assign`,
`agent_update`, `agent_create`, `template_apply`, and `profile_update`. `PROFILE_ROLE_SCHEMA`
(`packages/daemon/src/profiles/validate.ts`) is the shared enum `SETUP_LOCKED_ROLES` derives from.
