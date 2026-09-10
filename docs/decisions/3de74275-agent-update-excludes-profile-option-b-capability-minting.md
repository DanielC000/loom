# 3de74275 — `agent_update`/`updateAgentPreset` excludes profile fields: Option B keeps capability-minting human-only

## Narrative

Card `3de74275` ("[CAPABILITY — design-first] Manager/dedicated-role MCP surface to manage agents, projects, schedules, profiles, skills") was the owner-directed design task behind the whole manager self-service management surface (`agent_assign_profile`, `agent_update`, `project_update`, `project_archive`, `schedule_create`/`schedule_update`), landed by commit `14e1c340f0` ("feat(daemon): manager self-service management surface (Option B)").

The design problem: a manager/lead already had partial MCP access to structural entities (create a project, create an agent) but nothing that let it self-provision the things that actually confer capability — assigning a profile to an agent, creating/editing profiles, editing skills, setting `gateCommand`. The card was explicitly flagged design-first because widening this is a TRUST-BOUNDARY change: a profile confers role + allowlist + `browserTesting` (a navigate-anywhere capability) + model/skills, so an agent able to create or freely assign profiles could escalate its own or another agent's capability. `gateCommand` is host-RCE by design.

**Option B** (the chosen answer): profile CREATE/edit, skill CREATE/edit, and `gateCommand` all stay human-only. What a manager DOES get is `agent_assign_profile` — attach an EXISTING, human-authored profile (or clear it) — never mint one. Because every assignable `profileId` was created by a human who already intended it assignable, assignment itself cannot escalate beyond what a human already blessed; no additional `⊆`-capabilities subset check is needed on top.

`updateAgentPreset` (the `agent_update` MCP tool) is the structural half of this split: it edits an agent's `name` and `startupPrompt` only. The profile field is deliberately absent from its patch shape — not an oversight, the load-bearing half of Option B. Routing capability-conferring changes through the separate, human-blessed-profile-only `assignAgentProfile` path (see that method's own doc comment) is what keeps a manager's self-service surface additive and posture-preserving: every existing spawn stays byte-identical, and a manager can restructure its own agents' identity/instructions without ever being able to grant them anything it doesn't already hold.

## Do not

- Do not add `profileId`, `allowlist`, `gateCommand`, or any other capability-conferring field to `updateAgentPreset`'s patch shape — that would let a manager self-escalate capability through the "structural edit" surface instead of the validated `assignAgentProfile` path.
- Do not treat `agent_assign_profile`'s lack of a `⊆`-capabilities check as a gap to close — it's correct under Option B specifically because profile CREATE/edit stays human-only, so every assignable `profileId` is already human-blessed.

## Source

JSDoc comment above `updateAgentPreset` in `packages/daemon/src/sessions/service.ts`: originally lines 10767-10770 (the profile-exclusion sentence), as of this tranche's HEAD. Introduced by commit `14e1c340f0`, which cites "Phase-2 of Task `3de74275`" in its own commit body — the design task quoted above. Card `3de74275` itself: `columnKey: done`, no `merged` sha recorded (a design-only card whose deliverable was the decision, not a commit) — `14e1c340f0` is Phase-2's implementing commit, verified via the commit body's own citation, not via `tasks_get.merged`.
