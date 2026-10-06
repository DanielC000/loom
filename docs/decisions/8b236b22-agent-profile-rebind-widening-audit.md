# 8b236b22 — auditing (and, on two surfaces, guarding) an agent REBIND that widens its profile reach

Discovered from the Code Review of `be447b3f` (reviewer `db13ad3d`). `be447b3f` extended the
`profile_grant_reach` audit mechanism to `role`/`restrictedTools` on every PROFILE-field-edit write
path, but explicitly carved agent REBIND out of scope: moving an already-bound agent onto a DIFFERENT,
already-existing profile (`agent_update(profileId)` / `profile_assign` on setup+platform,
`agent_assign_profile` on the manager surface, and the human REST `POST /api/agents/:id`) widens what
that ONE agent can do without ever touching either profile's own fields — `profileWideningsOf` applied
to a single profile sees nothing, because the profile itself never changes.

Reachable call sites traced and fixed, all five:
- `packages/daemon/src/mcp/setup.ts` — `agent_update`'s profileId branch, `profile_assign`.
- `packages/daemon/src/mcp/platform.ts` — `agent_update`'s profileId branch, `profile_assign`.
- `packages/daemon/src/sessions/service.ts` — `assignAgentProfile` (manager's `agent_assign_profile`).
- `packages/daemon/src/gateway/server.ts` — `POST /api/agents/:id` (human REST).

`agentAssignableProfileError` (`profiles/validate.ts`) already blocks every LOCKED_PROFILE_ROLES role
and every `AGENT_FORBIDDEN_PROFILE_KEYS` grant field at every one of these call sites unconditionally
(`browserTesting` is deliberately exempt everywhere, per `3de74275`) — those axes were never a live gap.
Two axes escaped every existing check: `restrictedTools` true→false (no branch for it at all — `8c27ae8e`
keeps the FIELD itself agent-writable, which is a different question from REBINDING onto a pre-existing
profile that already has it off), and a role flip into `"manager"` (not locked by design — manager/worker
are "the two assignable-by-default roles", `ced4285e`). `restrictedTools` is NOT companion-only: it
restricts the real `RESTRICTED_NATIVE_TOOLS` set for ANY role (`pty/host.ts`'s `disallowedToolsForSpawn`).

**These rulings are LEAD decisions** (orchestrator approval on the worker's plan checkpoint for this
card), not owner decisions — the owner was not consulted on this card.

## What was decided

1. **A new durable event, `agent_profile_rebind`** (`packages/shared/src/types.ts`), the REBIND twin of
   `profile_grant_reach` — kept as its OWN kind/computation rather than folded into
   `recordProfileGrantReach`, per `be447b3f`'s own "do not conflate two distinct hazards" ruling.
   `detail` carries `{agentId, agentName, projectId, source, addedKeys, roleChange?}`, and — like
   `profile_grant_reach` — is filed with `managerSessionId: ""` (no owning session), not the rebound
   agent's own session. It joins `DURABLE_AUDIT_EVENT_KINDS` anyway, matching the Lead's ruling and
   `9f7f2b50`'s posture for an event that carries a real, single `projectId`. **Verified** (card
   `8b236b22`'s own test, section "durability"): this membership is actually INERT for THIS kind, for a
   more fundamental reason than the membership itself — `deleteAgent`'s cascade (`db.ts`) only deletes
   events keyed by `manager_session_id`/`worker_session_id` matching one of the deleted agent's OWN
   session ids, and `""` never matches a real session id, so the row survives BOTH `deleteAgent`'s and
   `deleteProject`'s cascades regardless of `DURABLE_AUDIT_EVENT_KINDS` membership — the exact same
   structural reason `profile_grant_reach` gives for staying OUT of that set. The membership is kept
   anyway (harmless, and consistent should a future change ever make this event session-keyed), but do
   not cite it as the thing that makes this event survive deletion — it doesn't need to.
2. **A new shared helper**, `recordAgentProfileRebindReach` (`profiles/grantReach.ts`) — reuses
   `profileWideningsOf` (the pure function), `before`/`after` being the agent's OLD/NEW bound profile's
   widening fields, with `PROFILE_DELETE_BACKSTOP_FIELDS` substituted for either side when that side's
   `profileId` is/was `null` (mirrors `recordProfileDeleteGrantReach`'s own backstop substitution).
3. **Manager keeps its existing `manager_manage`/`agent_assign_profile` audit row AND files the new
   event** — two rows, same shape as `profile_delete`'s existing dual-event precedent
   (`sessions/service.ts`). The reach is NOT also embedded in `manager_manage`'s detail — one source of
   truth for the computed widening, not two copies that could drift.
4. **Response field `rebindReach`** (`{addedKeys, roleChange?}`, present only when non-empty) on
   `agent_update`/`profile_assign` (setup+platform) and `agent_assign_profile` (manager) — mirrors
   `profile_update`'s `grantReach`. Each tool's description tells the calling agent to relay it to the
   human; it is the only signal they get on a surface with no interactive pre-save confirm.
5. **Guards — asymmetric, by surface. FINAL state after the round-2 revision below — Setup is audit-only, NOT guarded:**
   - **Setup**: audit only, no guard. (Originally guarded in round 1 — see "Revision" below for why that
     was reversed.)
   - **Manager** (`agent_assign_profile`): REFUSES a `restrictedTools` removal — it is the manager's
     ONLY route to that axis (no `profile_update`/`profile_create` tool exists on this surface, and
     round 2 confirmed this is genuinely true, unlike Setup), and there is no interactive confirm on it
     either. A role flip into `"manager"` stays allowed (`ced4285e`'s own "two assignable-by-default
     roles" ruling) and is audited.
   - **Platform**: audit only, no guard — this surface administers its own elevated rigs by design
     (`3de74275`, `ad098631`), and its identical-shaped FIELD-edit path (`profile_update`) already does
     exactly this unguarded today; guarding rebind more tightly than field-edit on the same surface would
     be the inconsistency this card avoids.
   - **REST**: audit only, never a guard — matches the established `humanAuthorized` posture everywhere
     else (a human is already trusted to do this via the UI).
   - Refusal text (Manager only) names the axis and the human route: *"rebinding would remove this
     agent's tool restriction (restrictedTools); ask the human to do it in the Profiles UI"*
     (`agentRebindRestrictedToolsWideningError`, `profiles/validate.ts`).
6. **Deliberately NOT in scope**: `agent_create`/`agent_clone`/`agent_clone_batch`/`template_apply` —
   fresh mints, no "before" to widen from (same framing `be447b3f` already used for why rebind itself
   needed its own card rather than folding into that one).
7. **One shared helper, `rebindWideningFields(db, oldProfileId, newProfileOrNull)`** (`profiles/
   grantReach.ts`, round 2 Code Review nit) — the before/after resolution (OLD bound profile, or
   `PROFILE_DELETE_BACKSTOP_FIELDS` when null/dangling, vs. the NEW profile or the same backstop when
   clearing) had been re-derived inline at every one of the six call sites; all six now call this one
   function instead.

## Revision — round 2 Code Review (`c5b05701`), LEAD RULING

**Setup's `restrictedTools` guard (item 5 above, round 1) is REMOVED. This revises the Lead's own round-1
ruling — not an owner decision.** The Code Review showed Setup can already reach the IDENTICAL widening
through a route this card never touched: `profile_update` (also on the setup surface) can flip
`restrictedTools` true→false directly on a profile — agent-writable and audit-only by design, per
`8c27ae8e` — either on the profile already bound to the target agent, or via
`profile_create(restrictedTools:false)` → `profile_assign` → (no `profile_update` even needed, since the
new profile was never restricted in the first place). So the round-1 rebind guard was bypassable friction,
not a real boundary — the SAME widening Setup was blocked from reaching through the rebind tool was one
call away through a sibling tool that already shipped as audit-only. Round 1's own "Do not" section had
already named the general shape of this mistake (guarding rebind tighter than field-edit on the SAME
surface) as the reason Platform has no guard; round 2 found Setup was making that exact mistake. The
round-1 refusal text (*"...ask the human to do it in the Profiles UI"*) was also substantively false for
Setup — a human was never the only route; Setup itself always was.

**Setup now matches Platform/REST: audit-only, every axis, via `rebindReach`.** The MANAGER guard is
UNCHANGED and stays — the manager surface genuinely has no `profile_create`/`profile_update` tool at all
(confirmed: only `profile_delete`), so `agent_assign_profile` really is its ONLY route to the
`restrictedTools` axis, and the bypass that sank Setup's guard does not exist there.

## Do not

- Do not fold `recordAgentProfileRebindReach` into `recordProfileGrantReach`, or give `agent_profile_rebind`
  the same event kind as `profile_grant_reach` — they are different computations over different inputs
  (one profile's fields changing vs. one agent moving between two static profiles); collapsing them loses
  the ability to tell which hazard a given row describes.
- Do not add `agent_profile_rebind` to `DURABLE_AUDIT_EVENT_KINDS` without stamping `detail.projectId` at
  every call site — `9f7f2b50`'s own rule. All five call sites here already do.
- Do not add a `restrictedTools` guard to Setup's, Platform's, or REST's rebind path "for consistency"
  with Manager — that was considered (Setup even shipped it in round 1) and rejected; see "Revision"
  above for why Setup's own attempt was reversed, and the per-surface reasoning for Platform/REST. If
  this is ever revisited, it needs its own argument, not an appeal to symmetry — and for Setup
  specifically, it needs to ALSO close the `profile_update`/`profile_create`→`profile_assign` bypass, or
  it reintroduces the exact bypassable-friction defect round 2 removed.
- Do not add a role-flip-into-`"manager"` guard to Setup's rebind path — `agent_create` already allows
  minting a manager-role agent there directly; gating only the rebind route is inconsistent and was
  explicitly rejected.
- Do not re-derive the before/after widening-field pair inline at a new (or existing) rebind call site —
  call `rebindWideningFields` (`profiles/grantReach.ts`, item 7 above) instead.
- Do not embed `rebindReach` inside `manager_manage`'s own `detail` — the shared `agent_profile_rebind`
  event is the one source of truth for the computed widening; a second copy in `manager_manage` would be
  exactly the kind of drift-prone duplication this card's own mechanism exists to avoid elsewhere.
- Do not read `agentRebindRestrictedToolsWideningError`'s silence on grant keys (connections/
  capabilities/vaultWrite/documentConversion/harness/allowDelta) as an oversight — those are already
  structurally blocked at every one of these call sites by `agentAssignableProfileError`'s unconditional
  field checks; this guard only needed to cover the ONE axis that function doesn't.
- Do not treat this card as having changed `agentAssignableProfileError`, `setupMayTouchAgentError`,
  `reservedProjectManagerProfileError`, or `nonReservedElevatedProfileError` — all four are unchanged;
  this card adds a SEPARATE audit+guard layer alongside them, computed from the agent's OLD vs. NEW bound
  profile rather than from the profile being bound in isolation.
